// volcengine-ark-video.test.ts — 火山方舟（Seedance）视频协议单测。
// 全用 vi.stubGlobal('fetch') mock，不发真实网络请求；轮询用极小 pollIntervalMs 加速。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { volcengineArkGenerateVideo } from "./volcengine-ark-video";
import type { ResolvedMediaGenConfig } from "../resolve";

// ── vi.hoisted：确保 mock fn 可在 vi.mock factory 内引用 ──────────────────────

const { mockCreateWriteStreamArk, mockUnlinkArk, mockWriteFileArk } = vi.hoisted(() => {
  const writeStream = {
    write: vi.fn((_chunk: unknown, cb: (err?: Error | null) => void) => { cb(null); return true; }),
    end: vi.fn((cb: (err?: Error | null) => void) => { cb(null); }),
    destroy: vi.fn(),
    once: vi.fn(),
  };
  const mockCreateWriteStreamArk = vi.fn(() => writeStream);
  const mockUnlinkArk = vi.fn(
    (_path: string, cb: (err: NodeJS.ErrnoException | null) => void) => cb(null)
  );
  const mockWriteFileArk = vi.fn().mockResolvedValue(undefined);
  return { mockCreateWriteStreamArk, mockUnlinkArk, mockWriteFileArk };
});

// ── mock node:fs（createWriteStream / unlink，用于 URL 通道流式写盘） ──────────

vi.mock("node:fs", () => ({
  createWriteStream: mockCreateWriteStreamArk,
  unlink: mockUnlinkArk,
}));

// ── mock node:fs/promises（mkdir + writeFile，writeFile 用于 b64 通道） ───────

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: mockWriteFileArk,
}));

// ── 辅助工厂 ──────────────────────────────────────────────────────────────────

function makeConfig(override?: Partial<ResolvedMediaGenConfig>): ResolvedMediaGenConfig {
  return {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKey: "ark-key",
    protocol: "volcengine-ark-video",
    model: "seedance-1-0-pro",
    timeoutMs: 280_000,
    pollIntervalMs: 10, // 测试用极短间隔加速轮询
    ...override,
  };
}

function makeSignal() {
  return new AbortController().signal;
}

/** 构造流式下载响应（ReadableStream body mock）。*/
function makeDownloadResponse(chunk: Uint8Array) {
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: chunk })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        releaseLock: vi.fn(),
        cancel: vi.fn(),
      }),
    },
  };
}

// ── mock fetch ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

const DEST_PATH = "/tmp/test-ark-video.mp4";
const TASKS_URL = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks";

describe("volcengineArkGenerateVideo", () => {
  it("完整轮询流程：提交 → running → succeeded → URL 通道流式写盘，载荷映射正确", async () => {
    const videoChunk = new Uint8Array(Buffer.from("ark-video-binary"));

    // 1. 提交任务
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "task-ark-1" }),
    });
    // 2. 轮询第一次：running（非终态继续）
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "running" }),
    });
    // 3. 轮询第二次：succeeded + video_url
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "succeeded",
        content: { video_url: "https://ark-cdn.volces.com/v.mp4" },
      }),
    });
    // 4. 下载视频
    mockFetch.mockResolvedValueOnce(makeDownloadResponse(videoChunk));

    const firstFrame = "data:image/png;base64,Rk9P";
    const lastFrame = "data:image/jpeg;base64,QkFS";
    const byteSize = await volcengineArkGenerateVideo(
      {
        prompt: "a flying bird",
        model: "seedance-1-0-pro",
        firstFrameImage: firstFrame,
        lastFrameImage: lastFrame,
        duration: 8,
        resolution: "1080P",
        aspectRatio: "16:9",
        destPath: DEST_PATH,
      },
      makeConfig(),
      makeSignal(),
    );

    expect(byteSize).toBe(videoChunk.byteLength);
    expect(mockFetch).toHaveBeenCalledTimes(4);

    // 提交端点（tasksUrl 规整）与内容数组载荷：text + 首末帧 image_url 带 role。
    const [genUrl, genInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(genUrl).toBe(TASKS_URL);
    const genBody = JSON.parse(genInit.body as string);
    expect(genBody.content).toEqual([
      { type: "text", text: "a flying bird" },
      { type: "image_url", image_url: { url: firstFrame }, role: "first_frame" },
      { type: "image_url", image_url: { url: lastFrame }, role: "last_frame" },
    ]);
    // duration 原样、resolution 转小写、aspect_ratio 走 ratio 字段、音频/水印默认值。
    expect(genBody).toMatchObject({
      model: "seedance-1-0-pro",
      duration: 8,
      resolution: "1080p",
      ratio: "16:9",
      generate_audio: true,
      watermark: false,
    });
    expect((genInit.headers as Record<string, string>).Authorization).toBe("Bearer ark-key");

    // 轮询端点：{tasksUrl}/{id}
    const [pollUrl] = mockFetch.mock.calls[1] as [string];
    expect(pollUrl).toBe(`${TASKS_URL}/task-ark-1`);
  });

  it("baseUrl 已带完整 tasks 路径时不重复拼接（URL 规整）", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "task-norm" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "succeeded", content: { video_url: "https://ark-cdn.volces.com/v.mp4" } }),
    });
    mockFetch.mockResolvedValueOnce(makeDownloadResponse(new Uint8Array([1])));

    await volcengineArkGenerateVideo(
      { prompt: "x", model: "m", destPath: DEST_PATH },
      makeConfig({ baseUrl: `${TASKS_URL}/` }),
      makeSignal(),
    );

    const [genUrl] = mockFetch.mock.calls[0] as [string];
    expect(genUrl).toBe(TASKS_URL);
  });

  it("adaptive 比例原样透传进 ratio 字段", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "task-adaptive" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "succeeded", content: { video_url: "https://ark-cdn.volces.com/v.mp4" } }),
    });
    mockFetch.mockResolvedValueOnce(makeDownloadResponse(new Uint8Array([1])));

    await volcengineArkGenerateVideo(
      { prompt: "x", model: "m", aspectRatio: "adaptive", destPath: DEST_PATH },
      makeConfig(),
      makeSignal(),
    );

    const [, genInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(genInit.body as string).ratio).toBe("adaptive");
  });

  it("succeeded 无 video_url 时回落 b64 通道解码写盘", async () => {
    const videoBytes = Buffer.from("ark-b64-video-content");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "task-b64" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "succeeded",
        content: { binary_data_base64: [videoBytes.toString("base64")] },
      }),
    });

    const byteSize = await volcengineArkGenerateVideo(
      { prompt: "x", model: "m", destPath: DEST_PATH },
      makeConfig(),
      makeSignal(),
    );

    expect(byteSize).toBe(videoBytes.byteLength);
    // b64 通道走 writeFile（非流式），写入解码后的完整 Buffer。
    expect(mockWriteFileArk).toHaveBeenCalledWith(DEST_PATH, expect.any(Buffer));
    const written = mockWriteFileArk.mock.calls[0][1] as Buffer;
    expect(written.equals(videoBytes)).toBe(true);
    // 无下载请求（fetch 只有提交 + 轮询两次）
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it.each(["failed", "expired", "cancelled", "canceled"])(
    "终态 %s 时抛出错误并携带 error 诊断",
    async (status) => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "task-fail" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status,
          error: { code: "InternalError", message: "GPU 资源不足" },
        }),
      });

      await expect(
        volcengineArkGenerateVideo(
          { prompt: "x", model: "m", destPath: DEST_PATH },
          makeConfig(),
          makeSignal(),
        ),
      ).rejects.toThrow(/GPU 资源不足/);
    },
  );

  it("succeeded 但既无 video_url 也无 b64 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "task-empty" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "succeeded", content: {} }),
    });

    await expect(
      volcengineArkGenerateVideo(
        { prompt: "x", model: "m", destPath: DEST_PATH },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(/既无 video_url 也无 b64/);
  });

  it("提交接口未返回任务 id 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    await expect(
      volcengineArkGenerateVideo(
        { prompt: "x", model: "m", destPath: DEST_PATH },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(/任务 id/);
  });

  it("轮询超时时抛出超时错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "task-timeout" }),
    });
    // 所有轮询均 running（永不完成）
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: "running" }),
    });

    await expect(
      volcengineArkGenerateVideo(
        { prompt: "x", model: "m", destPath: DEST_PATH },
        makeConfig({ timeoutMs: 30, pollIntervalMs: 100 }),
        makeSignal(),
      ),
    ).rejects.toThrow(/超时/);
  });
});
