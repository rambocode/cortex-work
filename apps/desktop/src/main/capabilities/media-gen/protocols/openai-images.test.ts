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

  it("响应含 data[0].url 时流式下载二进制", async () => {
    const imageUrl = "https://images.openai.com/generated/test.png";
    const fakeImageChunk = new Uint8Array(Buffer.from("png-image-bytes"));

    // 第一次 fetch：生成接口
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ url: imageUrl }] }),
    });
    // 第二次 fetch：下载图片（流式，mock ReadableStream body）
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: fakeImageChunk })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: vi.fn(),
          cancel: vi.fn(),
        }),
      },
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

  it("重试后仍然 4xx → 抛出 MediaGenHttpError（HTTP 400）", async () => {
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
      /HTTP 400/,
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

// ── quality 参数与降级链 ──────────────────────────────────────────────────────

describe("openaiImagesGenerate - quality", () => {
  function okB64Once(content = "ok") {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: Buffer.from(content).toString("base64") }] }),
    });
  }

  it("quality 非 auto 时进入请求 body", async () => {
    okB64Once();
    await openaiImagesGenerate(
      { ...makeArgs(), quality: "high" },
      makeConfig(),
      makeSignal(),
    );
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.quality).toBe("high");
  });

  it("quality 为 auto 时不上送", async () => {
    okB64Once();
    await openaiImagesGenerate(
      { ...makeArgs(), quality: "auto" },
      makeConfig(),
      makeSignal(),
    );
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.quality).toBeUndefined();
  });

  it("4xx 含 quality 字样 → 去 quality 重试一次", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "quality parameter is not supported by this model",
    });
    okB64Once("no-quality-retry");

    const buffer = await openaiImagesGenerate(
      { ...makeArgs(), quality: "high" },
      makeConfig(),
      makeSignal(),
    );

    expect(buffer.toString()).toBe("no-quality-retry");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, retryInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    const retryBody = JSON.parse(retryInit.body as string) as Record<string, unknown>;
    expect(retryBody.quality).toBeUndefined();
    // response_format 仍保留（quality 与 response_format 独立降级）
    expect(retryBody.response_format).toBe("b64_json");
  });

  it("双级降级：quality 4xx → response_format 4xx → 第三次全裸成功", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "unknown parameter: quality",
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "response_format is not supported",
    });
    okB64Once("bare-retry");

    const buffer = await openaiImagesGenerate(
      { ...makeArgs(), quality: "medium" },
      makeConfig(),
      makeSignal(),
    );

    expect(buffer.toString()).toBe("bare-retry");
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const [, thirdInit] = mockFetch.mock.calls[2] as [string, RequestInit];
    const thirdBody = JSON.parse(thirdInit.body as string) as Record<string, unknown>;
    expect(thirdBody.quality).toBeUndefined();
    expect(thirdBody.response_format).toBeUndefined();
  });
});

// ── edits（图生图 FormData） ──────────────────────────────────────────────────

describe("openaiImagesGenerate - edits", () => {
  function makeRef(name: string) {
    return { name, mimeType: "image/png", data: Buffer.from(`png-bytes-${name}`) };
  }

  it("单参考图 → /v1/images/edits + FormData 字段名 'image'", async () => {
    const fakeBase64 = Buffer.from("edited").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeBase64 }] }),
    });

    const buffer = await openaiImagesGenerate(
      { ...makeArgs(), referenceImages: [makeRef("a.png")] },
      makeConfig(),
      makeSignal(),
    );

    expect(buffer.toString()).toBe("edited");
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/images/edits");
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("dall-e-3");
    expect(form.get("prompt")).toBe("a beautiful sunset");
    expect(form.get("size")).toBe("1024x1024");
    expect(form.get("response_format")).toBe("b64_json");
    expect(form.getAll("image")).toHaveLength(1);
    expect(form.getAll("image[]")).toHaveLength(0);
    // FormData 请求不得手写 Content-Type（boundary 由 fetch 生成）
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("多参考图 → FormData 字段名 'image[]'", async () => {
    const fakeBase64 = Buffer.from("multi").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeBase64 }] }),
    });

    await openaiImagesGenerate(
      { ...makeArgs(), referenceImages: [makeRef("a.png"), makeRef("b.png")] },
      makeConfig(),
      makeSignal(),
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const form = init.body as FormData;
    expect(form.getAll("image[]")).toHaveLength(2);
    expect(form.getAll("image")).toHaveLength(0);
  });

  it("edits 端点 404/405 → edits_unsupported 结构化错误", async () => {
    for (const status of [404, 405]) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status,
        text: async () => "Not Found",
      });
      await expect(
        openaiImagesGenerate(
          { ...makeArgs(), referenceImages: [makeRef("a.png")] },
          makeConfig(),
          makeSignal(),
        ),
      ).rejects.toThrow(/edits_unsupported/);
    }
  });

  it("edits 端点 501（5xx 路径）→ 同样 edits_unsupported", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 501,
      text: async () => "Not Implemented",
    });
    await expect(
      openaiImagesGenerate(
        { ...makeArgs(), referenceImages: [makeRef("a.png")] },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(/edits_unsupported/);
  });

  it("edits 4xx 含 quality 字样 → FormData 降级重试去掉 quality", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "quality not supported",
    });
    const fakeBase64 = Buffer.from("edit-no-quality").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeBase64 }] }),
    });

    const buffer = await openaiImagesGenerate(
      { ...makeArgs(), quality: "high", referenceImages: [makeRef("a.png")] },
      makeConfig(),
      makeSignal(),
    );

    expect(buffer.toString()).toBe("edit-no-quality");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, retryInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    const retryForm = retryInit.body as FormData;
    expect(retryForm.get("quality")).toBeNull();
    expect(retryForm.getAll("image")).toHaveLength(1);
  });

  it("baseUrl 已含完整 generations 路径时 edits 能正确改写端点", async () => {
    const fakeBase64 = Buffer.from("rewrite").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: fakeBase64 }] }),
    });

    await openaiImagesGenerate(
      { ...makeArgs(), referenceImages: [makeRef("a.png")] },
      makeConfig({ baseUrl: "https://api.example.com/v1/images/generations" }),
      makeSignal(),
    );

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/images/edits");
  });
});
