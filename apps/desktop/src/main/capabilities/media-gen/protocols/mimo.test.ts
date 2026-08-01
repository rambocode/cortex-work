// mimo.test.ts — MiMo（Xiaomi）chat/completions 形态 TTS 协议单测。
// 全用 vi.stubGlobal('fetch') mock，不发真实网络请求。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mimoGenerateSpeech } from "./mimo";
import type { ResolvedMediaGenConfig } from "../resolve";

// ── 辅助工厂 ──────────────────────────────────────────────────────────────────

function makeConfig(override?: Partial<ResolvedMediaGenConfig>): ResolvedMediaGenConfig {
  return {
    baseUrl: "https://api.mimo.example",
    apiKey: "mimo-key",
    protocol: "mimo-tts",
    model: "mimo-audio",
    timeoutMs: 30_000,
    ...override,
  };
}

function makeSignal() {
  return new AbortController().signal;
}

/** 构造一个成功的 MiMo 响应（choices[0].message.audio.data 为 base64）。*/
function okResponse(content: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { audio: { data: Buffer.from(content).toString("base64") } } }],
    }),
  };
}

/** 解析最近一次 fetch 的 JSON body 与 init。*/
function lastCall(): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const [url, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) as Record<string, unknown> };
}

// ── mock fetch ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 测试 ──────────────────────────────────────────────────────────────────────

describe("mimoGenerateSpeech", () => {
  it("成功解码 choices[0].message.audio.data（base64）", async () => {
    mockFetch.mockResolvedValueOnce(okResponse("mimo-audio-bytes"));

    const buffer = await mimoGenerateSpeech(
      { text: "你好", model: "mimo-audio", format: "mp3" },
      makeConfig(),
      makeSignal(),
    );

    expect(buffer.toString()).toBe("mimo-audio-bytes");
  });

  it("载荷形状：text 为 assistant 消息、audio{format,voice}；URL 为 /v1/chat/completions", async () => {
    mockFetch.mockResolvedValueOnce(okResponse("x"));

    await mimoGenerateSpeech(
      { text: "朗读这段", model: "mimo-audio", voice: "female-1", format: "wav" },
      makeConfig(),
      makeSignal(),
    );

    const { url, body } = lastCall();
    expect(url).toBe("https://api.mimo.example/v1/chat/completions");
    expect(body.model).toBe("mimo-audio");
    expect(body.messages).toEqual([{ role: "assistant", content: "朗读这段" }]);
    expect(body.audio).toEqual({ format: "wav", voice: "female-1" });
  });

  it("style 作为 user 消息在 assistant 文本之前（顺序契约）", async () => {
    mockFetch.mockResolvedValueOnce(okResponse("x"));

    await mimoGenerateSpeech(
      { text: "正文", model: "mimo-audio", style: "用温柔的语气朗读" },
      makeConfig(),
      makeSignal(),
    );

    const { body } = lastCall();
    expect(body.messages).toEqual([
      { role: "user", content: "用温柔的语气朗读" },
      { role: "assistant", content: "正文" },
    ]);
  });

  it("鉴权同时带 Authorization Bearer 与 api-key 两个头", async () => {
    mockFetch.mockResolvedValueOnce(okResponse("x"));

    await mimoGenerateSpeech(
      { text: "x", model: "mimo-audio" },
      makeConfig(),
      makeSignal(),
    );

    const { init } = lastCall();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mimo-key");
    expect(headers["api-key"]).toBe("mimo-key");
  });

  it("format 缺省回落 mp3，voice 缺省时不进 audio 载荷", async () => {
    mockFetch.mockResolvedValueOnce(okResponse("x"));

    await mimoGenerateSpeech(
      { text: "x", model: "mimo-audio" },
      makeConfig(),
      makeSignal(),
    );

    const { body } = lastCall();
    expect(body.audio).toEqual({ format: "mp3" });
  });

  it("baseUrl 已带 /v1 时不重复拼接（apiUrl 容错）", async () => {
    mockFetch.mockResolvedValueOnce(okResponse("x"));

    await mimoGenerateSpeech(
      { text: "x", model: "mimo-audio" },
      makeConfig({ baseUrl: "https://api.mimo.example/v1" }),
      makeSignal(),
    );

    const { url } = lastCall();
    expect(url).toBe("https://api.mimo.example/v1/chat/completions");
  });

  it("响应缺 audio.data 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "no audio" } }] }),
    });

    await expect(
      mimoGenerateSpeech({ text: "x", model: "mimo-audio" }, makeConfig(), makeSignal()),
    ).rejects.toThrow(/audio\.data/);
  });

  it("HTTP 非 2xx 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    });

    await expect(
      mimoGenerateSpeech({ text: "x", model: "mimo-audio" }, makeConfig(), makeSignal()),
    ).rejects.toThrow(/HTTP 403/);
  });
});
