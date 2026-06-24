// openai-images.test.ts — openaiImagesGenerate() 单测
// 全用 vi.stubGlobal('fetch') mock，不发真实网络请求。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { openaiImagesGenerate } from "./openai-images";
import type { ResolvedMediaGenConfig } from "../resolve";

// ── 辅助工厂 ──────────────────────────────────────────────────────────────────

function makeConfig(override?: Partial<ResolvedMediaGenConfig>): ResolvedMediaGenConfig {
  return {
    baseUrl: "https://api.openai.com",
    apiKey: "sk-test",
    protocol: "openai-images",
    model: "dall-e-3",
    timeoutMs: 30_000,
    ...override,
  };
}

function makeArgs() {
  return {
    prompt: "a beautiful sunset",
    model: "dall-e-3",
    size: "1024x1024",
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

// ── b64_json 解析 ─────────────────────────────────────────────────────────────

describe("openaiImagesGenerate", () => {
  it("成功解析 data[0].b64_json 返回 Buffer", async () => {
    const fakeBase64 = Buffer.from("fake-image-data").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeBase64 }] }),
    });

    const buffer = await openaiImagesGenerate(makeArgs(), makeConfig(), makeSignal());

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString()).toBe("fake-image-data");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // 校验请求 URL 格式
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/images/generations");
  });

  it("请求包含正确的 Authorization 头", async () => {
    const fakeBase64 = Buffer.from("x").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeBase64 }] }),
    });

    await openaiImagesGenerate(makeArgs(), makeConfig({ apiKey: "sk-abc123" }), makeSignal());

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-abc123");
  });

  // ── url 下载 ─────────────────────────────────────────────────────────────────

  it("响应含 data[0].url 时下载二进制", async () => {
    const imageUrl = "https://images.openai.com/generated/test.png";
    const fakeImageBytes = Buffer.from("png-image-bytes");
    // 使用独立的 ArrayBuffer，避免共享底层 buffer 导致数据污染
    const isolatedBuffer = fakeImageBytes.buffer.slice(
      fakeImageBytes.byteOffset,
      fakeImageBytes.byteOffset + fakeImageBytes.byteLength,
    );

    // 第一次 fetch：生成接口
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ url: imageUrl }] }),
    });
    // 第二次 fetch：下载图片
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => isolatedBuffer,
    });

    const buffer = await openaiImagesGenerate(makeArgs(), makeConfig(), makeSignal());

    expect(buffer.toString()).toBe("png-image-bytes");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe(imageUrl);
  });

  // ── 4xx + response_format 自动重试 ────────────────────────────────────────────

  it("4xx 含 response_format 字样 → 去字段重试一次", async () => {
    const fakeBase64 = Buffer.from("retry-success").toString("base64");

    // 首次请求：4xx 含 response_format
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'response_format is not supported',
    });
    // 重试请求：成功
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeBase64 }] }),
    });

    const buffer = await openaiImagesGenerate(makeArgs(), makeConfig(), makeSignal());

    expect(buffer.toString()).toBe("retry-success");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // 重试请求的 body 不应含 response_format
    const [, retryInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    const retryBody = JSON.parse(retryInit.body as string) as Record<string, unknown>;
    expect(retryBody.response_format).toBeUndefined();
  });

  it("4xx 不含 response_format 字样 → 直接抛出错误（不重试）", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    await expect(openaiImagesGenerate(makeArgs(), makeConfig(), makeSignal())).rejects.toThrow(
      /HTTP 401/,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("重试后仍然 4xx → 抛出错误", async () => {
    // 两次都 4xx 含 response_format
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "response_format not supported",
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "response_format not supported",
    });

    await expect(openaiImagesGenerate(makeArgs(), makeConfig(), makeSignal())).rejects.toThrow(
      /重试后仍失败/,
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // ── 响应解析失败 ──────────────────────────────────────────────────────────────

  it("响应中 data 为空数组时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await expect(openaiImagesGenerate(makeArgs(), makeConfig(), makeSignal())).rejects.toThrow(
      /data 数组为空/,
    );
  });

  it("响应中既无 b64_json 也无 url 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{}] }),
    });

    await expect(openaiImagesGenerate(makeArgs(), makeConfig(), makeSignal())).rejects.toThrow(
      /b64_json.*url|url.*b64_json/i,
    );
  });

  // ── baseUrl 末尾斜杠处理 ──────────────────────────────────────────────────────

  it("baseUrl 末尾带斜杠时正确拼接 URL", async () => {
    const fakeBase64 = Buffer.from("x").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeBase64 }] }),
    });

    await openaiImagesGenerate(
      makeArgs(),
      makeConfig({ baseUrl: "https://api.example.com/" }),
      makeSignal(),
    );

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    // 不应出现双斜杠
    expect(url).toBe("https://api.example.com/v1/images/generations");
  });
});
