import { afterEach, describe, expect, it, vi } from "vitest";
import { probeProvider } from "./provider";

function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeProvider", () => {
  it("OpenAI 兼容 {data:[{id}]} → ok + 模型列表（去重排序）", async () => {
    mockFetch(() => jsonResponse({ data: [{ id: "m2" }, { id: "m1" }, { id: "m1" }] }));
    const out = await probeProvider({ baseUrl: "https://x.com/v1", apiKey: "sk", endpointFormat: "chat_completions" });
    expect(out).toEqual({ ok: true, models: ["m1", "m2"] });
  });

  it("末尾多斜杠规范化为 {baseUrl}/models", async () => {
    const fn = mockFetch(() => jsonResponse({ data: [] }));
    await probeProvider({ baseUrl: "https://x.com/", endpointFormat: "chat_completions" });
    expect(fn.mock.calls[0]?.[0]).toBe("https://x.com/models");
  });

  it("chat_completions 用 Authorization: Bearer", async () => {
    const fn = mockFetch(() => jsonResponse({ data: [] }));
    await probeProvider({ baseUrl: "https://x.com", apiKey: "sk-1", endpointFormat: "chat_completions" });
    const headers = (fn.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-1");
  });

  it("messages 用 x-api-key + anthropic-version（非 Bearer）", async () => {
    const fn = mockFetch(() => jsonResponse({ data: [] }));
    await probeProvider({ baseUrl: "https://x.com", apiKey: "sk-2", endpointFormat: "messages" });
    const headers = (fn.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-2");
    expect(headers["anthropic-version"]).toBeTruthy();
    expect(headers.Authorization).toBeUndefined();
  });

  it("custom 不发请求,返回不支持探测", async () => {
    const fn = mockFetch(() => jsonResponse({ data: [] }));
    const out = await probeProvider({ baseUrl: "https://x.com", endpointFormat: "custom" });
    expect(out.ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("非 http(s) scheme 被拒,不发请求", async () => {
    const fn = mockFetch(() => jsonResponse({ data: [] }));
    const out = await probeProvider({ baseUrl: "file:///etc/passwd", endpointFormat: "chat_completions" });
    expect(out.ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("空 baseUrl 返回校验错误", async () => {
    const out = await probeProvider({ baseUrl: "", endpointFormat: "chat_completions" });
    expect(out.ok).toBe(false);
  });

  it("HTTP 401 → ok:false 带状态,不抛", async () => {
    mockFetch(() => jsonResponse({}, { ok: false, status: 401, statusText: "Unauthorized" }));
    const out = await probeProvider({ baseUrl: "https://x.com", apiKey: "bad", endpointFormat: "chat_completions" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("401");
  });

  it("超时（AbortError）→ ok:false 不挂起", async () => {
    mockFetch(() => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    const out = await probeProvider({ baseUrl: "https://x.com", endpointFormat: "chat_completions" });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("连接超时");
  });
});
