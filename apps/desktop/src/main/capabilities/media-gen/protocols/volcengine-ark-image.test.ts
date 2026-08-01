// volcengine-ark-image.test.ts — volcengineArkGenerateImage() 单测
// 全用 vi.stubGlobal('fetch') mock，不发真实网络请求（照 minimax-image.test.ts 模式）。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { volcengineArkGenerateImage, volcengineArkImageUrl } from "./volcengine-ark-image";
import type { ResolvedMediaGenConfig } from "../resolve";

// ── 辅助工厂 ──────────────────────────────────────────────────────────────────

function makeConfig(override?: Partial<ResolvedMediaGenConfig>): ResolvedMediaGenConfig {
  return {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKey: "ark-key",
    protocol: "volcengine-ark-image",
    model: "doubao-seedream-4-0",
    timeoutMs: 30_000,
    ...override,
  };
}

function makeSignal() {
  return new AbortController().signal;
}

function okB64Once(content = "ark-image") {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ data: [{ b64_json: Buffer.from(content).toString("base64") }] }),
  });
}

// ── mock fetch ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── URL 规整 ──────────────────────────────────────────────────────────────────

describe("volcengineArkImageUrl", () => {
  it("拼接 /images/generations，容忍已带完整路径与末尾斜杠", () => {
    expect(volcengineArkImageUrl("https://ark.cn-beijing.volces.com/api/v3")).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/images/generations",
    );
    expect(volcengineArkImageUrl("https://ark.cn-beijing.volces.com/api/v3/")).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/images/generations",
    );
    expect(
      volcengineArkImageUrl("https://ark.cn-beijing.volces.com/api/v3/images/generations"),
    ).toBe("https://ark.cn-beijing.volces.com/api/v3/images/generations");
  });
});

// ── 主函数 ────────────────────────────────────────────────────────────────────

describe("volcengineArkGenerateImage", () => {
  it("成功解析 b64_json，载荷含 Seedream 固定字段与默认 size '2K'", async () => {
    okB64Once("ark-image");

    const buffer = await volcengineArkGenerateImage(
      { prompt: "a mountain", model: "doubao-seedream-4-0" },
      makeConfig(),
      makeSignal(),
    );

    expect(buffer.toString()).toBe("ark-image");
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ark.cn-beijing.volces.com/api/v3/images/generations");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.size).toBe("2K");
    expect(body.output_format).toBe("png");
    expect(body.response_format).toBe("b64_json");
    expect(body.sequential_image_generation).toBe("disabled");
    expect(body.stream).toBe(false);
    expect(body.watermark).toBe(false);
    expect(body.image).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ark-key");
  });

  it("显式 size（WxH 档位映射结果）覆盖默认 '2K'", async () => {
    okB64Once();
    await volcengineArkGenerateImage(
      { prompt: "x", model: "doubao-seedream-4-0", size: "4096x2304" },
      makeConfig(),
      makeSignal(),
    );
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.size).toBe("4096x2304");
  });

  it("参考图 → image 字段为 dataUri 数组（图生图同端点）", async () => {
    okB64Once();
    const refData = Buffer.from("ref-bytes");
    await volcengineArkGenerateImage(
      {
        prompt: "x",
        model: "doubao-seedream-4-0",
        referenceImages: [{ name: "ref.png", mimeType: "image/png", data: refData }],
      },
      makeConfig(),
      makeSignal(),
    );
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.image).toEqual([`data:image/png;base64,${refData.toString("base64")}`]);
  });

  it("url 通道 → 流式下载二进制", async () => {
    const imageUrl = "https://ark-cdn.volces.com/img/out.png";
    const chunk = new Uint8Array(Buffer.from("ark-from-url"));
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ url: imageUrl }] }),
    });
    mockFetch.mockResolvedValueOnce({
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
    });

    const buffer = await volcengineArkGenerateImage(
      { prompt: "x", model: "doubao-seedream-4-0" },
      makeConfig(),
      makeSignal(),
    );

    expect(buffer.toString()).toBe("ark-from-url");
    expect(mockFetch.mock.calls[1][0]).toBe(imageUrl);
  });

  it("HTTP 错误 → 抛 MediaGenHttpError（含 status）", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "invalid api key",
    });
    await expect(
      volcengineArkGenerateImage(
        { prompt: "x", model: "doubao-seedream-4-0" },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("无图片数据时把 error.message 带进报错", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [],
        error: { code: "SensitiveContent", message: "输出内容未通过审核" },
      }),
    });
    await expect(
      volcengineArkGenerateImage(
        { prompt: "x", model: "doubao-seedream-4-0" },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(/输出内容未通过审核/);
  });

  it("无图片数据且无 error → 通用报错", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });
    await expect(
      volcengineArkGenerateImage(
        { prompt: "x", model: "doubao-seedream-4-0" },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(/未返回图片数据/);
  });
});
