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

const { mockMkdir, mockWriteFile, mockCreateWriteStreamClient, mockUnlinkClient } = vi.hoisted(() => {
  const mockMkdir = vi.fn().mockResolvedValue(undefined);
  const mockWriteFile = vi.fn().mockResolvedValue(undefined);
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
  return { mockMkdir, mockWriteFile, mockCreateWriteStreamClient, mockUnlinkClient };
});

// ── mock node:fs/promises ──────────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
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
