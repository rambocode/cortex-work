// minimax.test.ts — MiniMax 协议实现单测
// 全用 vi.stubGlobal('fetch') mock，不发真实网络请求。

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  minimaxGenerateImage,
  minimaxGenerateVideo,
  minimaxGenerateMusic,
  minimaxGenerateTts,
} from "./minimax";
import type { ResolvedMediaGenConfig } from "../resolve";

// ── vi.hoisted：确保 mock fn 可在 vi.mock factory 内引用 ──────────────────────

const { mockCreateWriteStreamMinimax, mockUnlinkMinimax } = vi.hoisted(() => {
  const writeStream = {
    write: vi.fn((_chunk: unknown, cb: (err?: Error | null) => void) => { cb(null); return true; }),
    end: vi.fn((cb: (err?: Error | null) => void) => { cb(null); }),
    destroy: vi.fn(),
    once: vi.fn(),
  };
  const mockCreateWriteStreamMinimax = vi.fn(() => writeStream);
  const mockUnlinkMinimax = vi.fn(
    (_path: string, cb: (err: NodeJS.ErrnoException | null) => void) => cb(null)
  );
  return { mockCreateWriteStreamMinimax, mockUnlinkMinimax };
});

// ── mock node:fs（createWriteStream / unlink，用于视频流式写盘） ──────────────

vi.mock("node:fs", () => ({
  createWriteStream: mockCreateWriteStreamMinimax,
  unlink: mockUnlinkMinimax,
}));

// ── mock node:fs/promises（mkdir） ────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// ── 辅助工厂 ──────────────────────────────────────────────────────────────────

function makeConfig(override?: Partial<ResolvedMediaGenConfig>): ResolvedMediaGenConfig {
  return {
    baseUrl: "https://api.minimax.chat",
    apiKey: "minimax-key",
    protocol: "minimax-image",
    model: "image-01",
    timeoutMs: 280_000,
    pollIntervalMs: 100, // 测试时用极短间隔加速轮询
    ...override,
  };
}

function makeSignal() {
  return new AbortController().signal;
}

// ── mock fetch ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 图片生成 ──────────────────────────────────────────────────────────────────

describe("minimaxGenerateImage", () => {
  it("成功解析 data.image_base64[0]", async () => {
    const fakeBase64 = Buffer.from("minimax-image").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        data: { image_base64: [fakeBase64] },
      }),
    });

    const buffer = await minimaxGenerateImage(
      { prompt: "a cat", model: "image-01" },
      makeConfig(),
      makeSignal(),
    );

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString()).toBe("minimax-image");
  });

  it("成功解析 data.image_urls[0]（流式下载模式）", async () => {
    const imageUrl = "https://cdn.minimax.chat/img/test.png";
    const fakeChunk = new Uint8Array(Buffer.from("image-from-url"));

    // 第一次 fetch：图片生成接口
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        data: { image_urls: [imageUrl] },
      }),
    });
    // 第二次 fetch：流式下载图片（mock ReadableStream body）
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: fakeChunk })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: vi.fn(),
          cancel: vi.fn(),
        }),
      },
    });

    const buffer = await minimaxGenerateImage(
      { prompt: "a dog", model: "image-01" },
      makeConfig(),
      makeSignal(),
    );

    expect(buffer.toString()).toBe("image-from-url");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("base_resp.status_code !== 0 时抛出含状态码的错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 1002, status_msg: "Rate limit exceeded" },
        data: {},
      }),
    });

    await expect(
      minimaxGenerateImage({ prompt: "x", model: "image-01" }, makeConfig(), makeSignal()),
    ).rejects.toThrow(/status_code=1002/);
  });

  it("base_resp.status_code !== 0 时错误信息包含 status_msg", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 1002, status_msg: "Rate limit exceeded" },
        data: {},
      }),
    });

    await expect(
      minimaxGenerateImage({ prompt: "x", model: "image-01" }, makeConfig(), makeSignal()),
    ).rejects.toThrow(/Rate limit exceeded/);
  });

  it("HTTP 错误时抛出含状态码的 Error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    });

    await expect(
      minimaxGenerateImage({ prompt: "x", model: "image-01" }, makeConfig(), makeSignal()),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("Authorization 头正确传入", async () => {
    const fakeBase64 = Buffer.from("x").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        data: { image_base64: [fakeBase64] },
      }),
    });

    await minimaxGenerateImage(
      { prompt: "test", model: "image-01" },
      makeConfig({ apiKey: "my-minimax-key" }),
      makeSignal(),
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer my-minimax-key");
  });
});

// ── 视频生成（异步轮询） ──────────────────────────────────────────────────────

const DEST_PATH = "/tmp/test-video.mp4";

describe("minimaxGenerateVideo", () => {
  it("完整轮询流程：提交 → 轮询 Success → retrieve → 流式写盘", async () => {
    const videoChunk = new Uint8Array(Buffer.from("video-binary-data"));
    const downloadUrl = "https://cdn.minimax.chat/video/test.mp4";

    // 1. 提交任务
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        task_id: "task-abc123",
      }),
    });
    // 2. 轮询第一次：Processing
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        status: "Processing",
      }),
    });
    // 3. 轮询第二次：Success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        status: "Success",
        file_id: "file-xyz456",
      }),
    });
    // 4. retrieve 文件信息
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        file: { file_id: "file-xyz456", download_url: downloadUrl },
      }),
    });
    // 5. 下载视频（流式写盘，mock ReadableStream body）
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

    const byteSize = await minimaxGenerateVideo(
      { prompt: "a flying bird", model: "video-01", destPath: DEST_PATH },
      makeConfig({ protocol: "minimax-video" }),
      makeSignal(),
    );

    // 返回写入字节数（而非 Buffer）
    expect(byteSize).toBe(videoChunk.byteLength);
    expect(mockFetch).toHaveBeenCalledTimes(5);

    // 校验 query 请求含 task_id
    const [queryUrl] = mockFetch.mock.calls[1] as [string];
    expect(queryUrl).toContain("task_id=task-abc123");
  });

  it("任务状态为 Fail 时抛出错误", async () => {
    // 提交
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        task_id: "task-fail",
      }),
    });
    // 轮询：Fail
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        status: "Fail",
      }),
    });

    await expect(
      minimaxGenerateVideo(
        { prompt: "x", model: "video-01", destPath: DEST_PATH },
        makeConfig({ protocol: "minimax-video" }),
        makeSignal(),
      ),
    ).rejects.toThrow(/Fail/);
  });

  it("轮询超时时抛出超时错误", async () => {
    // 提交成功
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        task_id: "task-timeout",
      }),
    });
    // 所有轮询均返回 Processing（永不完成）
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        status: "Processing",
      }),
    });

    // 设置极短超时（比 pollIntervalMs 还短）让第一次轮询前就超时
    await expect(
      minimaxGenerateVideo(
        { prompt: "x", model: "video-01", destPath: DEST_PATH },
        makeConfig({ protocol: "minimax-video", timeoutMs: 50, pollIntervalMs: 200 }),
        makeSignal(),
      ),
    ).rejects.toThrow(/超时/);
  });

  it("提交接口返回空 task_id 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        // task_id 缺失
      }),
    });

    await expect(
      minimaxGenerateVideo(
        { prompt: "x", model: "video-01", destPath: DEST_PATH },
        makeConfig({ protocol: "minimax-video" }),
        makeSignal(),
      ),
    ).rejects.toThrow(/task_id/);
  });
});

// ── 音乐生成 ──────────────────────────────────────────────────────────────────

describe("minimaxGenerateMusic", () => {
  it("成功解析 data.audio（base64）", async () => {
    const fakeAudio = Buffer.from("music-data").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        data: { audio: fakeAudio },
      }),
    });

    const buffer = await minimaxGenerateMusic(
      { prompt: "jazz music", model: "music-01" },
      makeConfig({ protocol: "minimax-music" }),
      makeSignal(),
    );

    expect(buffer.toString()).toBe("music-data");
  });

  it("base_resp.status_code !== 0 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 2000, status_msg: "Content filtered" },
        data: {},
      }),
    });

    await expect(
      minimaxGenerateMusic(
        { prompt: "x", model: "music-01" },
        makeConfig({ protocol: "minimax-music" }),
        makeSignal(),
      ),
    ).rejects.toThrow(/status_code=2000/);
  });
});

// ── delay 预中止漏判（ADV-007 修复验证） ─────────────────────────────────────
//
// 若 signal 在调用 delay() 时已是 aborted 状态，abort 事件不会再触发，
// 定时器会跑满整个 pollInterval。修复后应立即 reject。

describe("minimaxGenerateVideo — delay 预中止", () => {
  it("signal 已 aborted 时，delay 立即 reject，不等待 pollInterval", async () => {
    // 提交成功
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        task_id: "task-preabort",
      }),
    });

    // 创建已中止的 signal
    const ctrl = new AbortController();
    ctrl.abort();
    const abortedSignal = ctrl.signal;

    const start = Date.now();
    await expect(
      minimaxGenerateVideo(
        { prompt: "x", model: "video-01", destPath: DEST_PATH },
        // pollIntervalMs 很长（2s），若 delay 预中止失效，会等 2s 才报错
        makeConfig({ protocol: "minimax-video", timeoutMs: 5000, pollIntervalMs: 2000 }),
        abortedSignal,
      ),
    ).rejects.toThrow();

    // 已中止时应立即抛出（远小于 pollInterval 的 2000ms）
    expect(Date.now() - start).toBeLessThan(500);
  });
});

// ── TTS 生成 ──────────────────────────────────────────────────────────────────

describe("minimaxGenerateTts", () => {
  it("成功解析 audio_file（base64）", async () => {
    const fakeAudio = Buffer.from("tts-audio").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        audio_file: fakeAudio,
      }),
    });

    const buffer = await minimaxGenerateTts(
      { text: "Hello world", model: "speech-01", voice: "Wise_Woman" },
      makeConfig({ protocol: "minimax-t2a" }),
      makeSignal(),
    );

    expect(buffer.toString()).toBe("tts-audio");
  });

  it("缺 audio_file 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        // 无 audio_file
      }),
    });

    await expect(
      minimaxGenerateTts(
        { text: "x", model: "speech-01" },
        makeConfig({ protocol: "minimax-t2a" }),
        makeSignal(),
      ),
    ).rejects.toThrow(/audio_file/);
  });
});
