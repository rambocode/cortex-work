// openai-speech.test.ts — OpenAI 兼容 TTS 协议单测（自 client.ts 迁出后独立测试）。
// 全用 vi.stubGlobal('fetch') mock，不发真实网络请求。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { openaiSpeechGenerate } from "./openai-speech";
import type { ResolvedMediaGenConfig } from "../resolve";

// ── 辅助工厂 ──────────────────────────────────────────────────────────────────

function makeConfig(override?: Partial<ResolvedMediaGenConfig>): ResolvedMediaGenConfig {
  return {
    baseUrl: "https://api.openai.com",
    apiKey: "sk-test",
    protocol: "openai-speech",
    model: "tts-1",
    timeoutMs: 30_000,
    ...override,
  };
}

function makeSignal() {
  return new AbortController().signal;
}

/** 构造流式二进制响应 body（模拟音频流）。*/
function makeBody(...contents: string[]) {
  const reads = contents.map((c) => ({ done: false, value: new Uint8Array(Buffer.from(c)) }));
  const read = vi.fn();
  for (const r of reads) read.mockResolvedValueOnce(r);
  read.mockResolvedValueOnce({ done: true, value: undefined });
  return {
    getReader: () => ({ read, releaseLock: vi.fn(), cancel: vi.fn() }),
  };
}

/** 解析最近一次 fetch 的 JSON body。*/
function lastRequestBody(): Record<string, unknown> {
  const [, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

// ── mock fetch ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 测试 ──────────────────────────────────────────────────────────────────────

describe("openaiSpeechGenerate", () => {
  it("成功流式读取二进制音频并拼接为 Buffer", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, body: makeBody("audio-", "content") });

    const buffer = await openaiSpeechGenerate(
      { text: "Hello", model: "tts-1", voice: "alloy", format: "mp3" },
      makeConfig(),
      makeSignal(),
    );

    expect(buffer.toString()).toBe("audio-content");
  });

  it("载荷形状：model/input/voice/speed/response_format；URL 为 /v1/audio/speech", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, body: makeBody("x") });

    await openaiSpeechGenerate(
      { text: "Hi there", model: "tts-1", voice: "nova", speed: 1.5, format: "wav" },
      makeConfig(),
      makeSignal(),
    );

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(lastRequestBody()).toEqual({
      model: "tts-1",
      input: "Hi there",
      voice: "nova",
      speed: 1.5,
      response_format: "wav",
    });
  });

  it("voice/speed/format 缺省时对应字段不进载荷（行为保持迁出前语义）", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, body: makeBody("x") });

    await openaiSpeechGenerate(
      { text: "Hi", model: "tts-1" },
      makeConfig(),
      makeSignal(),
    );

    const body = lastRequestBody();
    expect(body).toEqual({ model: "tts-1", input: "Hi" });
  });

  it("HTTP 非 2xx 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });

    await expect(
      openaiSpeechGenerate({ text: "x", model: "tts-1" }, makeConfig(), makeSignal()),
    ).rejects.toThrow(/HTTP 429/);
  });

  it("响应缺少 body 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, body: null });

    await expect(
      openaiSpeechGenerate({ text: "x", model: "tts-1" }, makeConfig(), makeSignal()),
    ).rejects.toThrow(/缺少 body/);
  });
});
