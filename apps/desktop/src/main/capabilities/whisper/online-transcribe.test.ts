// online-transcribe.test.ts — transcribeOnline() + assertHttpsOrLocal() 单测
// mock: ./transcribe-auth（避免读 fs/依赖 push-sign.ts）
// 覆盖：成功、HTTP 错误、静音空串、language 透传、https 断言（localhost 放行）、AbortSignal 超时

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock ./transcribe-auth ─────────────────────────────────────────────────────
const mockAuthHeaders = vi.fn().mockResolvedValue({});
const mockAudioTranscriptionsUrl = vi.fn((baseUrl: string) => `${baseUrl}/v1/audio/transcriptions`);

vi.mock("./transcribe-auth", () => ({
  authHeaders: (baseUrl: string, apiKey?: string) => mockAuthHeaders(baseUrl, apiKey),
  audioTranscriptionsUrl: (baseUrl: string) => mockAudioTranscriptionsUrl(baseUrl),
}));

// ── 被测模块 ──────────────────────────────────────────────────────────────────
import { transcribeOnline, assertHttpsOrLocal } from "./online-transcribe";

// ── 辅助：构造最小请求 ─────────────────────────────────────────────────────────
function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    audio: new ArrayBuffer(100),
    mimeType: "audio/wav",
    fileName: "test.wav",
    baseUrl: "https://api.example.com",
    apiKey: "sk-test",
    model: "whisper-1",
    language: undefined as string | undefined,
    ...overrides,
  };
}

// ── fetch mock 辅助 ────────────────────────────────────────────────────────────
function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthHeaders.mockResolvedValue({});
  mockAudioTranscriptionsUrl.mockImplementation((baseUrl: string) => `${baseUrl}/v1/audio/transcriptions`);
});

// ── assertHttpsOrLocal ────────────────────────────────────────────────────────

describe("assertHttpsOrLocal", () => {
  it("HTTPS URL 通过", () => {
    expect(() => assertHttpsOrLocal("https://api.example.com")).not.toThrow();
  });

  it("HTTP localhost 通过", () => {
    expect(() => assertHttpsOrLocal("http://localhost:8000")).not.toThrow();
  });

  it("HTTP 127.0.0.1 通过", () => {
    expect(() => assertHttpsOrLocal("http://127.0.0.1:8000")).not.toThrow();
  });

  it("HTTP ::1 通过", () => {
    expect(() => assertHttpsOrLocal("http://[::1]:8000")).not.toThrow();
  });

  it("HTTP 公网地址被拒绝", () => {
    expect(() => assertHttpsOrLocal("http://api.example.com")).toThrow(/必须使用 HTTPS/);
  });

  it("HTTP 192.168.x.x（局域网）被拒绝（非白名单）", () => {
    // 只有 loopback 放行；局域网地址不在白名单内，也需要 HTTPS
    expect(() => assertHttpsOrLocal("http://192.168.1.100:8000")).toThrow(/必须使用 HTTPS/);
  });

  it("格式无效的 URL 被拒绝", () => {
    expect(() => assertHttpsOrLocal("not-a-url")).toThrow(/格式无效/);
  });
});

// ── transcribeOnline ──────────────────────────────────────────────────────────

describe("transcribeOnline", () => {
  it("成功返回 trim 后的 text", async () => {
    mockFetch({ text: "  Hello World  " });

    const result = await transcribeOnline(makeReq());

    expect(result.text).toBe("Hello World");
  });

  it("HTTP 非 2xx 时抛出含状态码的错误", async () => {
    mockFetch({ error: "Unauthorized" }, false, 401);

    await expect(transcribeOnline(makeReq())).rejects.toThrow(/HTTP 401/);
  });

  it("静音音频（API 返回空 text）返回 { text: '' }，不报错", async () => {
    // 静音时 Whisper API 返回 text: ''，不应视为错误
    mockFetch({ text: "" });

    const result = await transcribeOnline(makeReq());

    expect(result.text).toBe("");
  });

  it("text 只含空白字符时也返回 trim 空串（不报错）", async () => {
    mockFetch({ text: "   \n  " });

    const result = await transcribeOnline(makeReq());

    expect(result.text).toBe("");
  });

  it("响应缺少 text 字段（格式错误）时抛出错误", async () => {
    // text 字段类型不是 string，视为格式异常
    mockFetch({ segments: [] });

    await expect(transcribeOnline(makeReq())).rejects.toThrow(/格式错误|text 字段/);
  });

  it("language 参数透传给 FormData", async () => {
    const spy = mockFetch({ text: "你好" });

    await transcribeOnline(makeReq({ language: "zh" }));

    // 确认 fetch 被调用（language 透传在 FormData 内，通过 fetch 调用验证）
    expect(spy).toHaveBeenCalledTimes(1);
    const fetchCall = spy.mock.calls[0][1] as RequestInit;
    const body = fetchCall?.body as FormData;
    expect(body.get("language")).toBe("zh");
  });

  it("language 未传时 FormData 不含 language 字段", async () => {
    const spy = mockFetch({ text: "hello" });

    await transcribeOnline(makeReq({ language: undefined }));

    const fetchCall = spy.mock.calls[0][1] as RequestInit;
    const body = fetchCall?.body as FormData;
    expect(body.has("language")).toBe(false);
  });

  it("HTTP baseUrl 被拒绝（HTTPS 断言）", async () => {
    await expect(
      transcribeOnline(makeReq({ baseUrl: "http://api.example.com" })),
    ).rejects.toThrow(/HTTPS/);
  });

  it("HTTP localhost baseUrl 被放行", async () => {
    mockFetch({ text: "local result" });

    const result = await transcribeOnline(makeReq({ baseUrl: "http://localhost:8000" }));

    expect(result.text).toBe("local result");
  });

  it("AbortSignal 超时（fetch 抛出 AbortError）时向上抛出", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(abortError);

    await expect(transcribeOnline(makeReq())).rejects.toThrow(/aborted|AbortError/i);
  });

  it("透传 authHeaders 返回的 Authorization 头", async () => {
    mockAuthHeaders.mockResolvedValueOnce({ Authorization: "Bearer sk-test" });
    const spy = mockFetch({ text: "ok" });

    await transcribeOnline(makeReq());

    const fetchCall = spy.mock.calls[0][1] as RequestInit;
    expect((fetchCall?.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
  });
});
