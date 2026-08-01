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

  it("grok-imagine-image 协议 dispatch → api.x.ai 载荷（aspect_ratio/resolution）", async () => {
    const fakeB64 = Buffer.from("grok-img").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ data: [{ b64_json: fakeB64 }] }),
    });

    const result = await generateImage(
      { prompt: "a rocket", aspectRatio: "16:9", size: "2048x1152" },
      makeImageConfig({ protocol: "grok-imagine-image", baseUrl: "https://api.x.ai", model: "grok-2-image" }),
      { workspaceRoot: WORKSPACE },
    );

    expect(result.files).toHaveLength(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.x.ai/v1/images/generations");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.aspect_ratio).toBe("16:9");
    expect(body.resolution).toBe("2k");
  });

  it("volcengine-ark-image 协议 dispatch → Seedream 载荷（默认 size 2K）", async () => {
    const fakeB64 = Buffer.from("ark-img").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    const result = await generateImage(
      { prompt: "a mountain" },
      makeImageConfig({
        protocol: "volcengine-ark-image",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        model: "doubao-seedream-4-0",
      }),
      { workspaceRoot: WORKSPACE },
    );

    expect(result.files).toHaveLength(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ark.cn-beijing.volces.com/api/v3/images/generations");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.size).toBe("2K");
    expect(body.watermark).toBe(false);
  });

  // ── 尺寸兜底与 quality 透传 ─────────────────────────────────────────────────

  it("size 缺省时按 defaultSize > defaultResolution 经 mapImageSize 兜底", async () => {
    const fakeB64 = Buffer.from("x").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    await generateImage(
      { prompt: "cat" },
      makeImageConfig({ defaultResolution: "2K" }),
      { workspaceRoot: WORKSPACE },
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.size).toBe("2048x2048");
  });

  it("defaultResolution 缺失且无比例 → 不上送 size（旧行为兼容）", async () => {
    const fakeB64 = Buffer.from("x").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    await generateImage({ prompt: "cat" }, makeImageConfig(), { workspaceRoot: WORKSPACE });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.size).toBeUndefined();
  });

  it("config.quality 透传到 openai-images 请求体（非 auto）", async () => {
    const fakeB64 = Buffer.from("x").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    await generateImage(
      { prompt: "cat" },
      makeImageConfig({ quality: "high" }),
      { workspaceRoot: WORKSPACE },
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.quality).toBe("high");
  });

  // ── 参考图（edits）路由与门控 ────────────────────────────────────────────────

  // PNG 魔数头（collectReferenceImages 按魔数校验参考图格式）
  const PNG_BYTES = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("payload"),
  ]);

  it("openai-images + 参考图 → 走 /images/edits FormData", async () => {
    mockReadFile.mockResolvedValueOnce(PNG_BYTES);
    const fakeB64 = Buffer.from("edited").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeB64 }] }),
    });

    const result = await generateImage(
      { prompt: "edit it", referenceImagePaths: ["ref.png"] },
      makeImageConfig(),
      { workspaceRoot: WORKSPACE },
    );

    expect(result.files).toHaveLength(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/images/edits");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("不支持编辑的协议（minimax/grok）收到参考图 → 网络调用前抛 edits_unsupported", async () => {
    for (const config of [
      makeMinimaxImageConfig(),
      makeImageConfig({ protocol: "grok-imagine-image", model: "grok-2-image" }),
    ]) {
      mockReadFile.mockResolvedValueOnce(PNG_BYTES);
      await expect(
        generateImage(
          { prompt: "x", referenceImagePaths: ["ref.png"] },
          config,
          { workspaceRoot: WORKSPACE },
        ),
      ).rejects.toThrow(/edits_unsupported/);
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

  it("新协议占位分支（grok/volcengine）→ 明确「未实现」错误且不发网络请求", async () => {
    for (const protocol of ["grok-imagine-video", "volcengine-ark-video"]) {
      await expect(
        generateVideo(
          { prompt: "x" },
          { ...makeVideoConfig(), protocol },
          { workspaceRoot: WORKSPACE },
        ),
      ).rejects.toThrow(/协议客户端未实现/);
    }
    expect(mockFetch).not.toHaveBeenCalled();
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
