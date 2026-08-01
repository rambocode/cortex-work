// minimax-video.test.ts — MiniMax 视频协议单测（自原 minimax.test.ts 拆出）。
// 全用 vi.stubGlobal('fetch') mock，不发真实网络请求。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { minimaxGenerateVideo } from "./minimax-video";
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
    protocol: "minimax-video",
    model: "video-01",
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
      makeConfig(),
      makeSignal(),
    );

    // 返回写入字节数（而非 Buffer）
    expect(byteSize).toBe(videoChunk.byteLength);
    expect(mockFetch).toHaveBeenCalledTimes(5);

    // 校验 query 请求含 task_id
    const [queryUrl] = mockFetch.mock.calls[1] as [string];
    expect(queryUrl).toContain("task_id=task-abc123");
  });

  it("首末帧 dataUri 进提交载荷（first_frame_image / last_frame_image）", async () => {
    const firstFrame = "data:image/png;base64,Rk9P";
    const lastFrame = "data:image/jpeg;base64,QkFS";

    // 提交
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ base_resp: { status_code: 0 }, task_id: "task-frames" }),
    });
    // 轮询 Success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ base_resp: { status_code: 0 }, status: "Success", file_id: "file-f" }),
    });
    // retrieve
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        file: { download_url: "https://cdn.minimax.chat/v.mp4" },
      }),
    });
    // 下载
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new Uint8Array([1]) })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: vi.fn(),
          cancel: vi.fn(),
        }),
      },
    });

    await minimaxGenerateVideo(
      {
        prompt: "x",
        model: "video-01",
        firstFrameImage: firstFrame,
        lastFrameImage: lastFrame,
        destPath: DEST_PATH,
      },
      makeConfig(),
      makeSignal(),
    );

    const [, genInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const genBody = JSON.parse(genInit.body as string);
    expect(genBody.first_frame_image).toBe(firstFrame);
    expect(genBody.last_frame_image).toBe(lastFrame);
  });

  it("未提供帧图片时载荷不含 first/last_frame_image 字段", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ base_resp: { status_code: 0 }, task_id: "task-noframe" }),
    });
    // 直接 Fail 终止流程（本用例只关心提交载荷）
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ base_resp: { status_code: 0 }, status: "Fail" }),
    });

    await expect(
      minimaxGenerateVideo(
        { prompt: "x", model: "video-01", destPath: DEST_PATH },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow();

    const [, genInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const genBody = JSON.parse(genInit.body as string);
    expect("first_frame_image" in genBody).toBe(false);
    expect("last_frame_image" in genBody).toBe(false);
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
        makeConfig(),
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
        makeConfig({ timeoutMs: 50, pollIntervalMs: 200 }),
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
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(/task_id/);
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
        makeConfig({ timeoutMs: 5000, pollIntervalMs: 2000 }),
        abortedSignal,
      ),
    ).rejects.toThrow();

    // 已中止时应立即抛出（远小于 pollInterval 的 2000ms）
    expect(Date.now() - start).toBeLessThan(500);
  });
});
