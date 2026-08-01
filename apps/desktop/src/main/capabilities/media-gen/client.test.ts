// client.test.ts — 媒体生成客户端单测
// mock: node:fs/promises（mkdir/writeFile）、fetch、protocols
// 测试：路径安全校验、响应大小限制、超时触发、产物目录结构

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateImage,
  generateSpeech,
  generateMusic,
  generateVideo,
  assertWithinWorkspace,
  MAX_RESPONSE_BYTES,
  resolveAudioFormat,
} from "./client";
import type { ResolvedMediaGenConfig } from "./resolve";

// ── vi.hoisted：确保 mock fn 可在 vi.mock factory 内引用 ──────────────────────

const { mockMkdir, mockWriteFile, mockRealpath, mockReadFile, mockCreateWriteStreamClient, mockUnlinkClient } = vi.hoisted(() => {
  const mockMkdir = vi.fn().mockResolvedValue(undefined);
  const mockWriteFile = vi.fn().mockResolvedValue(undefined);
  // realpath mock：恒等返回（模拟无 symlink 的真实文件系统）。symlink 逃逸场景
  // 用真实 fs 在 workspace-guard.test.ts 覆盖（本文件全局 mock 了 fs，无法造真 symlink）。
  const mockRealpath = vi.fn((p: string) => Promise.resolve(p));
  const mockReadFile = vi.fn().mockResolvedValue(Buffer.alloc(0));
  const writeStream = {
    write: vi.fn((_chunk: unknown, cb: (err?: Error | null) => void) => { cb(null); return true; }),
    end: vi.fn((cb: (err?: Error | null) => void) => { cb(null); }),
    destroy: vi.fn(),
    once: vi.fn(),
  };
  const mockCreateWriteStreamClient = vi.fn(() => writeStream);
  const mockUnlinkClient = vi.fn(
    (_path: string, cb: (err: NodeJS.ErrnoException | null) => void) => cb(null)
  );
  return { mockMkdir, mockWriteFile, mockRealpath, mockReadFile, mockCreateWriteStreamClient, mockUnlinkClient };
});

// ── mock node:fs/promises ──────────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  realpath: mockRealpath,
  readFile: mockReadFile,
}));

// ── mock node:fs（createWriteStream / unlink，用于视频流式写盘） ──────────────

vi.mock("node:fs", () => ({
  createWriteStream: mockCreateWriteStreamClient,
  unlink: mockUnlinkClient,
}));

// ── mock node:crypto（固定随机 id） ────────────────────────────────────────────

vi.mock("node:crypto", () => ({
  randomBytes: () => Buffer.from([0xab, 0xcd, 0xef, 0x12]),
}));

// ── mock fetch（协议层会调用） ─────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── 辅助工厂 ──────────────────────────────────────────────────────────────────

function makeImageConfig(override?: Partial<ResolvedMediaGenConfig>): ResolvedMediaGenConfig {
  return {
    baseUrl: "https://api.openai.com",
    apiKey: "sk-test",
    protocol: "openai-images",
    model: "dall-e-3",
    timeoutMs: 30_000,
    ...override,
  };
}

function makeMinimaxImageConfig(override?: Partial<ResolvedMediaGenConfig>): ResolvedMediaGenConfig {
  return {
    baseUrl: "https://api.minimax.chat",
    apiKey: "minimax-key",
    protocol: "minimax-image",
    model: "image-01",
    timeoutMs: 30_000,
    ...override,
  };
}

function makeSpeechConfig(): ResolvedMediaGenConfig {
  return {
    baseUrl: "https://api.openai.com",
    apiKey: "sk-test",
    protocol: "openai-speech",
    model: "tts-1",
    timeoutMs: 30_000,
    voice: "alloy",
    format: "mp3",
  };
}

function makeMusicConfig(): ResolvedMediaGenConfig {
  return {
    baseUrl: "https://api.minimax.chat",
    apiKey: "minimax-key",
    protocol: "minimax-music",
    model: "music-01",
    timeoutMs: 30_000,
    format: "mp3",
  };
}

function makeVideoConfig(): ResolvedMediaGenConfig {
  return {
    baseUrl: "https://api.minimax.chat",
    apiKey: "minimax-key",
    protocol: "minimax-video",
    model: "video-01",
    timeoutMs: 30_000,
    pollIntervalMs: 100,
    defaultDuration: 6,
    defaultResolution: "1080P",
  };
}

const WORKSPACE = "/home/user/workspace";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── assertWithinWorkspace ─────────────────────────────────────────────────────

describe("assertWithinWorkspace", () => {
  it("workspace 内的相对路径通过校验", () => {
    const result = assertWithinWorkspace(WORKSPACE, "images/cat.png");
    expect(result).toBe(`${WORKSPACE}/images/cat.png`);
  });

  it("workspace 内的绝对路径通过校验", () => {
    const result = assertWithinWorkspace(WORKSPACE, `${WORKSPACE}/docs/readme.md`);
    expect(result).toBe(`${WORKSPACE}/docs/readme.md`);
  });

  it("路径越界（../）时抛出错误", () => {
    expect(() =>
      assertWithinWorkspace(WORKSPACE, "../outside/secret.txt"),
    ).toThrowError(/路径越界/);
  });

  it("路径越界（绝对路径跳出 workspace）时抛出错误", () => {
    expect(() =>
      assertWithinWorkspace(WORKSPACE, "/etc/passwd"),
    ).toThrowError(/路径越界/);
  });

  it("workspace 根路径本身通过校验", () => {
    const result = assertWithinWorkspace(WORKSPACE, WORKSPACE);
    expect(result).toBe(WORKSPACE);
  });
});

// ── generateImage ─────────────────────────────────────────────────────────────

describe("generateImage", () => {
  it("成功生成图片并落盘，返回正确 relativePath", async () => {
    const fakeB64 = Buffer.from("image-content").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    const result = await generateImage(
      { prompt: "a cat" },
      makeImageConfig(),
      { workspaceRoot: WORKSPACE },
    );

    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file.relativePath).toMatch(/^\.cortex\/media\/images\/.+\.png$/);
    expect(file.mimeType).toBe("image/png");
    expect(file.byteSize).toBeGreaterThan(0);
    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining(".cortex/media/images"),
      expect.objectContaining({ recursive: true }),
    );
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it("MiniMax 图片协议也能正确调用", async () => {
    const fakeB64 = Buffer.from("minimax-img").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        data: { image_base64: [fakeB64] },
      }),
    });

    const result = await generateImage(
      { prompt: "a dog" },
      makeMinimaxImageConfig(),
      { workspaceRoot: WORKSPACE },
    );

    expect(result.files).toHaveLength(1);
  });

  it("不支持的协议抛出错误", async () => {
    await expect(
      generateImage(
        { prompt: "x" },
        makeImageConfig({ protocol: "unsupported-protocol" }),
        { workspaceRoot: WORKSPACE },
      ),
    ).rejects.toThrow(/不支持的图片生成协议/);
  });

  it("新协议占位分支（grok/volcengine）→ 明确「未实现」错误且不发网络请求", async () => {
    for (const protocol of ["grok-imagine-image", "volcengine-ark-image"]) {
      await expect(
        generateImage(
          { prompt: "x" },
          makeImageConfig({ protocol }),
          { workspaceRoot: WORKSPACE },
        ),
      ).rejects.toThrow(/协议客户端未实现/);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── 路径越界拒绝 ────────────────────────────────────────────────────────────

  it("referenceImagePaths 含越界路径时抛出错误（不发请求）", async () => {
    await expect(
      generateImage(
        { prompt: "x", referenceImagePaths: ["../../outside.png"] },
        makeImageConfig(),
        { workspaceRoot: WORKSPACE },
      ),
    ).rejects.toThrow(/路径越界/);

    // 不应发任何网络请求
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── 超过 MAX_BYTES 时抛出 ────────────────────────────────────────────────────

  it("响应超过 MAX_RESPONSE_BYTES.image 时抛出大小限制错误", async () => {
    // 构造超过限制的 base64（50MB + 1byte）
    const oversized = Buffer.alloc(MAX_RESPONSE_BYTES.image + 1);
    const fakeB64 = oversized.toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    await expect(
      generateImage(
        { prompt: "huge" },
        makeImageConfig(),
        { workspaceRoot: WORKSPACE },
      ),
    ).rejects.toThrow(/大小限制/);
  });
});

// ── generateSpeech ────────────────────────────────────────────────────────────

describe("generateSpeech", () => {
  it("成功生成语音，产物落盘 .cortex/media/speech/", async () => {
    const audioChunk = new Uint8Array(Buffer.from("audio-content"));
    // openaiSpeechGenerate 直接读 res.body（流式），不再用 res.arrayBuffer()
    const mockBody = {
      getReader: () => ({
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: audioChunk })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        releaseLock: vi.fn(),
        cancel: vi.fn(),
      }),
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: mockBody,
    });

    const result = await generateSpeech(
      { prompt: "Hello world" },
      makeSpeechConfig(),
      { workspaceRoot: WORKSPACE },
    );

    expect(result.files[0].relativePath).toMatch(/^\.cortex\/media\/speech\//);
    expect(result.files[0].mimeType).toBe("audio/mpeg");
  });

  it("不支持的协议抛出错误", async () => {
    await expect(
      generateSpeech(
        { prompt: "x" },
        { ...makeSpeechConfig(), protocol: "unknown-tts" },
        { workspaceRoot: WORKSPACE },
      ),
    ).rejects.toThrow(/不支持的语音生成协议/);
  });
});

// ── generateMusic ─────────────────────────────────────────────────────────────

describe("generateMusic", () => {
  it("成功生成音乐，产物落盘 .cortex/media/music/", async () => {
    const fakeAudio = Buffer.from("music-content").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        data: { audio: fakeAudio },
      }),
    });

    const result = await generateMusic(
      { prompt: "jazz" },
      makeMusicConfig(),
      { workspaceRoot: WORKSPACE },
    );

    expect(result.files[0].relativePath).toMatch(/^\.cortex\/media\/music\//);
  });

  it("不支持的协议抛出错误", async () => {
    await expect(
      generateMusic(
        { prompt: "x" },
        { ...makeMusicConfig(), protocol: "unknown-music" },
        { workspaceRoot: WORKSPACE },
      ),
    ).rejects.toThrow(/不支持的音乐生成协议/);
  });
});

// ── generateVideo ─────────────────────────────────────────────────────────────

describe("generateVideo", () => {
  it("成功生成视频，产物落盘 .cortex/media/video/", async () => {
    const videoChunk = new Uint8Array(Buffer.from("video-content"));

    // 提交
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ base_resp: { status_code: 0 }, task_id: "task-1" }),
    });
    // 轮询 Success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        status: "Success",
        file_id: "file-1",
      }),
    });
    // retrieve
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        file: { download_url: "https://cdn.minimax.chat/v.mp4" },
      }),
    });
    // 下载（视频走流式写盘，mock ReadableStream body）
    const mockBody = {
      getReader: () => ({
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: videoChunk })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        releaseLock: vi.fn(),
        cancel: vi.fn(),
      }),
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: mockBody,
    });

    const result = await generateVideo(
      { prompt: "a bird flying" },
      makeVideoConfig(),
      { workspaceRoot: WORKSPACE },
    );

    expect(result.files[0].relativePath).toMatch(/^\.cortex\/media\/video\//);
    expect(result.files[0].mimeType).toBe("video/mp4");
    expect(result.files[0].byteSize).toBe(videoChunk.byteLength);
    // 不调用 writeFile（视频走 createWriteStream 写盘）
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("firstFrameImagePath 越界时抛出错误", async () => {
    await expect(
      generateVideo(
        { prompt: "x", firstFrameImagePath: "../../secret.jpg" },
        makeVideoConfig(),
        { workspaceRoot: WORKSPACE },
      ),
    ).rejects.toThrow(/路径越界/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("不支持的协议抛出错误", async () => {
    await expect(
      generateVideo(
        { prompt: "x" },
        { ...makeVideoConfig(), protocol: "unknown-video" },
        { workspaceRoot: WORKSPACE },
      ),
    ).rejects.toThrow(/不支持的视频生成协议/);
  });

  // ── 帧图片集成：collectFrameImage → dataUri 进协议载荷 ──────────────────────

  it("firstFrameImagePath 经 collectFrameImage 转 dataUri 进 minimax 提交载荷", async () => {
    // readFile 返回带 PNG 魔数的内容（collectFrameImage 会做魔数校验）
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    mockReadFile.mockResolvedValueOnce(pngBytes);

    const videoChunk = new Uint8Array(Buffer.from("v"));
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ base_resp: { status_code: 0 }, task_id: "task-f" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ base_resp: { status_code: 0 }, status: "Success", file_id: "file-f" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        file: { download_url: "https://cdn.minimax.chat/v.mp4" },
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: videoChunk })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: vi.fn(),
          cancel: vi.fn(),
        }),
      },
    });

    await generateVideo(
      { prompt: "x", firstFrameImagePath: "frames/first.png" },
      makeVideoConfig(),
      { workspaceRoot: WORKSPACE },
    );

    const [, genInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const genBody = JSON.parse(genInit.body as string);
    expect(genBody.first_frame_image).toBe(`data:image/png;base64,${pngBytes.toString("base64")}`);
  });

  it("帧图片非 png/jpeg/webp（魔数校验失败）时抛错且不发请求", async () => {
    mockReadFile.mockResolvedValueOnce(Buffer.from("not-an-image"));
    await expect(
      generateVideo(
        { prompt: "x", firstFrameImagePath: "frames/fake.png" },
        makeVideoConfig(),
        { workspaceRoot: WORKSPACE },
      ),
    ).rejects.toThrow(/png\/jpeg\/webp/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── 新协议 dispatch 分支 ────────────────────────────────────────────────────

  function makeStreamBody(chunk: Uint8Array) {
    return {
      getReader: () => ({
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: chunk })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        releaseLock: vi.fn(),
        cancel: vi.fn(),
      }),
    };
  }

  it("grok-imagine-video 协议路由到 grok 客户端（/videos/generations + aspectRatio 透传）", async () => {
    const videoChunk = new Uint8Array(Buffer.from("grok-v"));
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ request_id: "req-1" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "done", video: { url: "https://cdn.x.ai/v.mp4" } }),
    });
    mockFetch.mockResolvedValueOnce({ ok: true, body: makeStreamBody(videoChunk) });

    const result = await generateVideo(
      { prompt: "a bird", aspectRatio: "16:9" },
      {
        ...makeVideoConfig(),
        protocol: "grok-imagine-video",
        baseUrl: "https://api.x.ai/v1",
        defaultDuration: 6,
        defaultResolution: "720P",
      },
      { workspaceRoot: WORKSPACE },
    );

    expect(result.files[0].relativePath).toMatch(/^\.cortex\/media\/video\//);
    expect(result.files[0].byteSize).toBe(videoChunk.byteLength);

    const [genUrl, genInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(genUrl).toBe("https://api.x.ai/v1/videos/generations");
    const genBody = JSON.parse(genInit.body as string);
    // config 默认值消费：duration/resolution；工具入参消费：aspect_ratio。
    expect(genBody).toMatchObject({ duration: 6, resolution: "720p", aspect_ratio: "16:9" });
  });

  it("grok 协议收到尾帧时防御性报错（协议层红线，schema 之外的兜底）", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    mockReadFile.mockResolvedValueOnce(pngBytes);

    await expect(
      generateVideo(
        { prompt: "x", lastFrameImagePath: "frames/last.png" },
        { ...makeVideoConfig(), protocol: "grok-imagine-video", baseUrl: "https://api.x.ai/v1" },
        { workspaceRoot: WORKSPACE },
      ),
    ).rejects.toThrow(/末帧/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("volcengine-ark-video 协议路由到 ark 客户端（tasks 端点 + ratio 透传）", async () => {
    const videoChunk = new Uint8Array(Buffer.from("ark-v"));
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "task-1" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "succeeded",
        content: { video_url: "https://ark-cdn.volces.com/v.mp4" },
      }),
    });
    mockFetch.mockResolvedValueOnce({ ok: true, body: makeStreamBody(videoChunk) });

    const result = await generateVideo(
      { prompt: "a bird", aspectRatio: "adaptive" },
      {
        ...makeVideoConfig(),
        protocol: "volcengine-ark-video",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      },
      { workspaceRoot: WORKSPACE },
    );

    expect(result.files[0].byteSize).toBe(videoChunk.byteLength);

    const [genUrl, genInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(genUrl).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");
    expect(JSON.parse(genInit.body as string).ratio).toBe("adaptive");
  });
});

// ── timeoutMs 触发 AbortController ────────────────────────────────────────────

describe("超时行为", () => {
  it("timeoutMs 极短时，fetch 接收到 AbortSignal 取消", async () => {
    // fetch 永不 resolve（模拟无响应接口）
    mockFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const sig = init?.signal;
          if (sig) {
            sig.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }
        }),
    );

    await expect(
      generateImage(
        { prompt: "slow" },
        makeImageConfig({ timeoutMs: 50 }), // 50ms 超时
        { workspaceRoot: WORKSPACE },
      ),
    ).rejects.toThrow();
  });
});

// ── resolveAudioFormat 白名单校验 ─────────────────────────────────────────────

describe("resolveAudioFormat", () => {
  it("白名单内的格式正确返回 ext 和 mimeType", () => {
    expect(resolveAudioFormat("mp3")).toEqual({ ext: "mp3", mimeType: "audio/mpeg" });
    expect(resolveAudioFormat("wav")).toEqual({ ext: "wav", mimeType: "audio/wav" });
    expect(resolveAudioFormat("ogg")).toEqual({ ext: "ogg", mimeType: "audio/ogg" });
    expect(resolveAudioFormat("flac")).toEqual({ ext: "flac", mimeType: "audio/flac" });
    expect(resolveAudioFormat("m4a")).toEqual({ ext: "m4a", mimeType: "audio/mp4" });
    expect(resolveAudioFormat("aac")).toEqual({ ext: "aac", mimeType: "audio/mp4" });
  });

  it("大写格式名规范化为小写", () => {
    expect(resolveAudioFormat("MP3")).toEqual({ ext: "mp3", mimeType: "audio/mpeg" });
    expect(resolveAudioFormat("WAV")).toEqual({ ext: "wav", mimeType: "audio/wav" });
  });

  it("非白名单格式回落到 mp3（防路径穿越）", () => {
    expect(resolveAudioFormat("../../etc/passwd")).toEqual({ ext: "mp3", mimeType: "audio/mpeg" });
    expect(resolveAudioFormat("exe")).toEqual({ ext: "mp3", mimeType: "audio/mpeg" });
    expect(resolveAudioFormat("../secret")).toEqual({ ext: "mp3", mimeType: "audio/mpeg" });
  });

  it("pcm/pcm16 → audio/L16，pcm16 扩展名归一为 pcm（对齐 Kun audioExtension）", () => {
    expect(resolveAudioFormat("pcm")).toEqual({ ext: "pcm", mimeType: "audio/L16" });
    expect(resolveAudioFormat("pcm16")).toEqual({ ext: "pcm", mimeType: "audio/L16" });
    expect(resolveAudioFormat("PCM16")).toEqual({ ext: "pcm", mimeType: "audio/L16" });
  });

  it("undefined 回落到 mp3", () => {
    expect(resolveAudioFormat(undefined)).toEqual({ ext: "mp3", mimeType: "audio/mpeg" });
  });

  it("空字符串回落到 mp3", () => {
    expect(resolveAudioFormat("")).toEqual({ ext: "mp3", mimeType: "audio/mpeg" });
  });
});

// ── generateSpeech format 白名单集成 ─────────────────────────────────────────

describe("generateSpeech - format 白名单集成", () => {
  function makeSpeechBodyMock(content: string) {
    const chunk = new Uint8Array(Buffer.from(content));
    return {
      getReader: () => ({
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: chunk })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        releaseLock: vi.fn(),
        cancel: vi.fn(),
      }),
    };
  }

  it("wav format → mimeType 为 audio/wav（而非 audio/mpeg）", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: makeSpeechBodyMock("wav-audio-content"),
    });

    const result = await generateSpeech(
      { prompt: "Test speech" },
      { ...makeSpeechConfig(), format: "wav" },
      { workspaceRoot: WORKSPACE },
    );

    expect(result.files[0].mimeType).toBe("audio/wav");
    expect(result.files[0].relativePath).toMatch(/\.wav$/);
  });

  it("非白名单 format（例如穿越字符）回落 mp3，mimeType 为 audio/mpeg", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: makeSpeechBodyMock("audio-content"),
    });

    const result = await generateSpeech(
      { prompt: "Test speech" },
      { ...makeSpeechConfig(), format: "../../etc" }, // 路径穿越尝试
      { workspaceRoot: WORKSPACE },
    );

    // 应回落到 mp3，不能用穿越字符作为文件扩展名
    expect(result.files[0].mimeType).toBe("audio/mpeg");
    expect(result.files[0].relativePath).toMatch(/\.mp3$/);
  });
});
