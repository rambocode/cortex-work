// minimax-image.test.ts — MiniMax 图片协议单测（自原 minimax.test.ts 拆出）。
// 全用 vi.stubGlobal('fetch') mock，不发真实网络请求。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { minimaxGenerateImage } from "./minimax-image";
import type { ResolvedMediaGenConfig } from "../resolve";

// ── 辅助工厂 ──────────────────────────────────────────────────────────────────

function makeConfig(override?: Partial<ResolvedMediaGenConfig>): ResolvedMediaGenConfig {
  return {
    baseUrl: "https://api.minimax.chat",
    apiKey: "minimax-key",
    protocol: "minimax-image",
    model: "image-01",
    timeoutMs: 280_000,
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
