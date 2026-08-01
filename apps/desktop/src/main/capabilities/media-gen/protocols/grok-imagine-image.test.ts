// grok-imagine-image.test.ts — grokImagineGenerateImage() 单测
// 全用 vi.stubGlobal('fetch') mock，不发真实网络请求（照 minimax-image.test.ts 模式）。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { grokImagineGenerateImage, grokImagineResolution } from "./grok-imagine-image";
import type { ResolvedMediaGenConfig } from "../resolve";

// ── 辅助工厂 ──────────────────────────────────────────────────────────────────

function makeConfig(override?: Partial<ResolvedMediaGenConfig>): ResolvedMediaGenConfig {
  return {
    baseUrl: "https://api.x.ai",
    apiKey: "xai-key",
    protocol: "grok-imagine-image",
    model: "grok-2-image",
    timeoutMs: 30_000,
    ...override,
  };
}

function makeSignal() {
  return new AbortController().signal;
}

function okB64Once(content = "grok-image") {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: async () =>
      JSON.stringify({ data: [{ b64_json: Buffer.from(content).toString("base64") }] }),
  });
}

// ── mock fetch ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── grokImagineResolution 档位映射 ────────────────────────────────────────────

describe("grokImagineResolution", () => {
  it("长边 ≥2048 → '2k'，否则 '1k'；无 size / 非法 size 回落 '1k'", () => {
    expect(grokImagineResolution("2048x1152")).toBe("2k");
    expect(grokImagineResolution("1152x2048")).toBe("2k");
    expect(grokImagineResolution("1024x1024")).toBe("1k");
    expect(grokImagineResolution(undefined)).toBe("1k");
    expect(grokImagineResolution("not-a-size")).toBe("1k");
  });
});

// ── 主函数 ────────────────────────────────────────────────────────────────────

describe("grokImagineGenerateImage", () => {
  it("成功解析 data[0].b64_json 返回 Buffer，URL 拼到 /v1/images/generations", async () => {
    okB64Once("grok-image");

    const buffer = await grokImagineGenerateImage(
      { prompt: "a rocket", model: "grok-2-image" },
      makeConfig(),
      makeSignal(),
    );

    expect(buffer.toString()).toBe("grok-image");
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.x.ai/v1/images/generations");
  });

  it("载荷包含 aspect_ratio（缺省 'auto'）与 resolution 档", async () => {
    okB64Once();
    await grokImagineGenerateImage(
      { prompt: "x", model: "grok-2-image" },
      makeConfig(),
      makeSignal(),
    );
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.aspect_ratio).toBe("auto");
    expect(body.resolution).toBe("1k");
    expect(body.response_format).toBe("b64_json");
    expect(body.n).toBe(1);
  });

  it("Grok 扩展比例（19.5:9）与 2K 尺寸正确映射", async () => {
    okB64Once();
    await grokImagineGenerateImage(
      { prompt: "x", model: "grok-2-image", aspectRatio: "19.5:9", size: "2048x896" },
      makeConfig(),
      makeSignal(),
    );
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.aspect_ratio).toBe("19.5:9");
    expect(body.resolution).toBe("2k");
  });

  it("config.headers 透传且 Authorization 不被覆盖", async () => {
    okB64Once();
    await grokImagineGenerateImage(
      { prompt: "x", model: "grok-2-image" },
      makeConfig({
        headers: { "X-Custom": "yes", Authorization: "Bearer hijacked" },
      }),
      makeSignal(),
    );
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Custom"]).toBe("yes");
    // 自定义 headers 不得覆盖凭证
    expect(headers["Authorization"]).toBe("Bearer xai-key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("HTTP 错误 → 抛 MediaGenHttpError（含 status）", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });
    await expect(
      grokImagineGenerateImage(
        { prompt: "x", model: "grok-2-image" },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(/HTTP 429/);
  });

  it("非法 JSON → 明确报错", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => "<html>gateway error</html>",
    });
    await expect(
      grokImagineGenerateImage(
        { prompt: "x", model: "grok-2-image" },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(/非法 JSON/);
  });

  it("响应无 b64_json → 明确报错（grok 无 url 通道）", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ data: [{}] }),
    });
    await expect(
      grokImagineGenerateImage(
        { prompt: "x", model: "grok-2-image" },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(/未返回图片数据/);
  });
});
