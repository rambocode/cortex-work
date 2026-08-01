// grok-imagine-video.test.ts — Grok Imagine 视频协议单测。
// 全用 vi.stubGlobal('fetch') mock，不发真实网络请求；轮询用极小 pollIntervalMs 加速。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { grokImagineGenerateVideo } from "./grok-imagine-video";
import type { ResolvedMediaGenConfig } from "../resolve";

// ── vi.hoisted：确保 mock fn 可在 vi.mock factory 内引用 ──────────────────────

const { mockCreateWriteStreamGrok, mockUnlinkGrok } = vi.hoisted(() => {
  const writeStream = {
    write: vi.fn((_chunk: unknown, cb: (err?: Error | null) => void) => { cb(null); return true; }),
    end: vi.fn((cb: (err?: Error | null) => void) => { cb(null); }),
    destroy: vi.fn(),
    once: vi.fn(),
  };
  const mockCreateWriteStreamGrok = vi.fn(() => writeStream);
  const mockUnlinkGrok = vi.fn(
    (_path: string, cb: (err: NodeJS.ErrnoException | null) => void) => cb(null)
  );
  return { mockCreateWriteStreamGrok, mockUnlinkGrok };
});

// ── mock node:fs（createWriteStream / unlink，用于视频流式写盘） ──────────────

vi.mock("node:fs", () => ({
  createWriteStream: mockCreateWriteStreamGrok,
  unlink: mockUnlinkGrok,
}));

// ── mock node:fs/promises（mkdir） ────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// ── 辅助工厂 ──────────────────────────────────────────────────────────────────

function makeConfig(override?: Partial<ResolvedMediaGenConfig>): ResolvedMediaGenConfig {
  return {
    baseUrl: "https://api.x.ai/v1",
    apiKey: "xai-key",
    protocol: "grok-imagine-video",
    model: "grok-video-1",
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

const DEST_PATH = "/tmp/test-grok-video.mp4";

describe("grokImagineGenerateVideo", () => {
  it("完整轮询流程：提交 → pending → done → 流式写盘，参数映射正确", async () => {
    const videoChunk = new Uint8Array(Buffer.from("grok-video-binary"));

    // 1. 提交任务
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ request_id: "req-abc" }),
    });
    // 2. 轮询第一次：pending（非终态继续）
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "pending" }),
    });
    // 3. 轮询第二次：done + 下载 URL
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "done", video: { url: "https://cdn.x.ai/v.mp4" } }),
    });
    // 4. 下载视频
    mockFetch.mockResolvedValueOnce(makeDownloadResponse(videoChunk));

    const byteSize = await grokImagineGenerateVideo(
      {
        prompt: "a flying bird",
        model: "grok-video-1",
        duration: 10,
        resolution: "720P",
        aspectRatio: "16:9",
        destPath: DEST_PATH,
      },
      makeConfig(),
      makeSignal(),
    );

    expect(byteSize).toBe(videoChunk.byteLength);
    expect(mockFetch).toHaveBeenCalledTimes(4);

    // 提交端点与载荷映射：duration 原样、resolution 转小写、无首帧时 aspect_ratio 进载荷。
    const [genUrl, genInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(genUrl).toBe("https://api.x.ai/v1/videos/generations");
    const genBody = JSON.parse(genInit.body as string);
    expect(genBody).toMatchObject({
      model: "grok-video-1",
      prompt: "a flying bird",
      duration: 10,
      resolution: "720p",
      aspect_ratio: "16:9",
      reference_images: [],
    });
    // 鉴权头
    expect((genInit.headers as Record<string, string>).Authorization).toBe("Bearer xai-key");

    // 轮询端点带 request_id
    const [pollUrl] = mockFetch.mock.calls[1] as [string];
    expect(pollUrl).toBe("https://api.x.ai/v1/videos/req-abc");
  });

  it("有首帧时 image.url 进载荷且 aspect_ratio 被忽略（互斥语义）", async () => {
    const frameDataUri = "data:image/png;base64,QUJD";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ request_id: "req-frame" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "done", video: { url: "https://cdn.x.ai/v.mp4" } }),
    });
    mockFetch.mockResolvedValueOnce(makeDownloadResponse(new Uint8Array([1])));

    await grokImagineGenerateVideo(
      {
        prompt: "x",
        model: "grok-video-1",
        firstFrameImage: frameDataUri,
        aspectRatio: "9:16",
        destPath: DEST_PATH,
      },
      makeConfig(),
      makeSignal(),
    );

    const [, genInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const genBody = JSON.parse(genInit.body as string);
    expect(genBody.image).toEqual({ url: frameDataUri });
    expect(genBody.aspect_ratio).toBeUndefined();
  });

  it("收到末帧时防御性抛错且不发任何请求（grok 无末帧概念）", async () => {
    await expect(
      grokImagineGenerateVideo(
        {
          prompt: "x",
          model: "grok-video-1",
          lastFrameImage: "data:image/png;base64,QUJD",
          destPath: DEST_PATH,
        },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(/末帧/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("config.headers 透传进请求头，但不能覆盖 Authorization", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ request_id: "req-h" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "done", video: { url: "https://cdn.x.ai/v.mp4" } }),
    });
    mockFetch.mockResolvedValueOnce(makeDownloadResponse(new Uint8Array([1])));

    await grokImagineGenerateVideo(
      { prompt: "x", model: "grok-video-1", destPath: DEST_PATH },
      makeConfig({
        headers: { "X-Gateway-Token": "gw-1", Authorization: "Bearer stolen" },
      }),
      makeSignal(),
    );

    const [, genInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = genInit.headers as Record<string, string>;
    expect(headers["X-Gateway-Token"]).toBe("gw-1");
    // Authorization 始终由 apiKey 生成，透传项不可顶掉。
    expect(headers.Authorization).toBe("Bearer xai-key");
  });

  it.each(["failed", "expired"])("终态 %s 时抛出错误", async (status) => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ request_id: "req-fail" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status }),
    });

    await expect(
      grokImagineGenerateVideo(
        { prompt: "x", model: "grok-video-1", destPath: DEST_PATH },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(new RegExp(status));
  });

  it("提交接口未返回 request_id 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    await expect(
      grokImagineGenerateVideo(
        { prompt: "x", model: "grok-video-1", destPath: DEST_PATH },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(/request_id/);
  });

  it("done 但无下载 URL 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ request_id: "req-nourl" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "done" }),
    });

    await expect(
      grokImagineGenerateVideo(
        { prompt: "x", model: "grok-video-1", destPath: DEST_PATH },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(/下载 URL/);
  });

  it("轮询超时时抛出超时错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ request_id: "req-timeout" }),
    });
    // 所有轮询均 pending（永不完成）
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: "pending" }),
    });

    await expect(
      grokImagineGenerateVideo(
        { prompt: "x", model: "grok-video-1", destPath: DEST_PATH },
        makeConfig({ timeoutMs: 30, pollIntervalMs: 100 }),
        makeSignal(),
      ),
    ).rejects.toThrow(/超时/);
  });
});
