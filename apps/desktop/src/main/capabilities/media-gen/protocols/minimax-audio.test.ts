// minimax-audio.test.ts — MiniMax 音乐 + TTS 协议单测（对齐 Kun hex 载荷后版本）。
// 全用 vi.stubGlobal('fetch') mock，不发真实网络请求。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { minimaxGenerateMusic, minimaxGenerateTts } from "./minimax-audio";
import type { ResolvedMediaGenConfig } from "../resolve";

// ── 辅助工厂 ──────────────────────────────────────────────────────────────────

function makeConfig(override?: Partial<ResolvedMediaGenConfig>): ResolvedMediaGenConfig {
  return {
    baseUrl: "https://api.minimax.chat",
    apiKey: "minimax-key",
    protocol: "minimax-music",
    model: "music-01",
    timeoutMs: 280_000,
    ...override,
  };
}

function makeSignal() {
  return new AbortController().signal;
}

/** 把 mockFetch 最近一次调用的 JSON body 解析出来（载荷断言辅助）。*/
function lastRequestBody(): Record<string, unknown> {
  const [, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

/** 构造一个成功的 hex 音频响应（output_format:'hex' 的 data.audio）。*/
function hexResponse(content: string) {
  return {
    ok: true,
    json: async () => ({
      base_resp: { status_code: 0 },
      data: { audio: Buffer.from(content).toString("hex") },
    }),
  };
}

// ── mock fetch ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 音乐生成 ──────────────────────────────────────────────────────────────────

describe("minimaxGenerateMusic", () => {
  it("成功解析 data.audio（hex）并解码为二进制", async () => {
    mockFetch.mockResolvedValueOnce(hexResponse("music-data"));

    const buffer = await minimaxGenerateMusic(
      { prompt: "jazz music", model: "music-01", format: "mp3" },
      makeConfig(),
      makeSignal(),
    );

    expect(buffer.toString()).toBe("music-data");
  });

  it("载荷含 output_format:'hex' 与 audio_setting{44100/256000}（对齐 Kun）", async () => {
    mockFetch.mockResolvedValueOnce(hexResponse("x"));

    await minimaxGenerateMusic(
      { prompt: "jazz", model: "music-01", format: "mp3" },
      makeConfig(),
      makeSignal(),
    );

    const body = lastRequestBody();
    expect(body.output_format).toBe("hex");
    expect(body.audio_setting).toEqual({ format: "mp3", sample_rate: 44_100, bitrate: 256_000 });
    expect(body.prompt).toBe("jazz");
  });

  it("三选一：只给 prompt → 无 lyrics 且非器乐时 lyrics_optimizer 默认 true", async () => {
    mockFetch.mockResolvedValueOnce(hexResponse("x"));

    await minimaxGenerateMusic(
      { prompt: "upbeat pop", model: "music-01" },
      makeConfig(),
      makeSignal(),
    );

    const body = lastRequestBody();
    expect(body.lyrics_optimizer).toBe(true);
    expect(body).not.toHaveProperty("lyrics");
    expect(body).not.toHaveProperty("is_instrumental");
  });

  it("三选一：给 lyrics → lyrics 进载荷且 lyrics_optimizer 默认 false", async () => {
    mockFetch.mockResolvedValueOnce(hexResponse("x"));

    await minimaxGenerateMusic(
      { model: "music-01", lyrics: "hello world la la" },
      makeConfig(),
      makeSignal(),
    );

    const body = lastRequestBody();
    expect(body.lyrics).toBe("hello world la la");
    expect(body.lyrics_optimizer).toBe(false);
  });

  it("三选一：instrumental=true → is_instrumental 进载荷且 lyrics_optimizer 默认 false", async () => {
    mockFetch.mockResolvedValueOnce(hexResponse("x"));

    await minimaxGenerateMusic(
      { model: "music-01", instrumental: true },
      makeConfig(),
      makeSignal(),
    );

    const body = lastRequestBody();
    expect(body.is_instrumental).toBe(true);
    expect(body.lyrics_optimizer).toBe(false);
    // 空 prompt 不进载荷
    expect(body).not.toHaveProperty("prompt");
  });

  it("显式 lyricsOptimizer 覆盖默认推导；referenceAudioUrl → audio_url", async () => {
    mockFetch.mockResolvedValueOnce(hexResponse("x"));

    await minimaxGenerateMusic(
      {
        model: "music-01",
        lyrics: "verse one",
        lyricsOptimizer: true, // 有 lyrics 时默认 false，显式 true 应生效
        referenceAudioUrl: "https://example.com/ref.mp3",
      },
      makeConfig(),
      makeSignal(),
    );

    const body = lastRequestBody();
    expect(body.lyrics_optimizer).toBe(true);
    expect(body.audio_url).toBe("https://example.com/ref.mp3");
  });

  it("base_resp.status_code !== 0 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 2000, status_msg: "Content filtered" },
        data: {},
      }),
    });

    await expect(
      minimaxGenerateMusic(
        { prompt: "x", model: "music-01" },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(/status_code=2000/);
  });

  it("data.audio 为非法 hex 时抛出错误（bufferFromHex 校验）", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        data: { audio: "not-hex-zz!!" },
      }),
    });

    await expect(
      minimaxGenerateMusic(
        { prompt: "x", model: "music-01" },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(/非法的 hex/);
  });

  it("既无 audio 也无 audio_url 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ base_resp: { status_code: 0 }, data: {} }),
    });

    await expect(
      minimaxGenerateMusic(
        { prompt: "x", model: "music-01" },
        makeConfig(),
        makeSignal(),
      ),
    ).rejects.toThrow(/既无 audio/);
  });
});

// ── TTS 生成 ──────────────────────────────────────────────────────────────────

describe("minimaxGenerateTts", () => {
  it("成功解析 data.audio（hex）并解码为二进制", async () => {
    mockFetch.mockResolvedValueOnce(hexResponse("tts-audio"));

    const buffer = await minimaxGenerateTts(
      { text: "Hello world", model: "speech-01", voice: "Wise_Woman", format: "mp3" },
      makeConfig({ protocol: "minimax-t2a" }),
      makeSignal(),
    );

    expect(buffer.toString()).toBe("tts-audio");
  });

  it("载荷为 voice_setting 形状 + output_format:'hex'（对齐 Kun，非旧版 top-level voice_id）", async () => {
    mockFetch.mockResolvedValueOnce(hexResponse("x"));

    await minimaxGenerateTts(
      { text: "hi", model: "speech-01", voice: "Wise_Woman", speed: 1.2, format: "mp3" },
      makeConfig({ protocol: "minimax-t2a" }),
      makeSignal(),
    );

    const body = lastRequestBody();
    expect(body.output_format).toBe("hex");
    expect(body.voice_setting).toEqual({ voice_id: "Wise_Woman", speed: 1.2, vol: 1, pitch: 0 });
    // mp3 采样率上限 32000（对齐 Kun）
    expect(body.audio_setting).toEqual({ format: "mp3", sample_rate: 32_000, bitrate: 128_000, channel: 1 });
    // 旧版 top-level 字段不得再出现
    expect(body).not.toHaveProperty("voice_id");
    expect(body).not.toHaveProperty("speed");
  });

  it("非 mp3 格式采样率 44100；voice 缺省回落 male-qn-qingse", async () => {
    mockFetch.mockResolvedValueOnce(hexResponse("x"));

    await minimaxGenerateTts(
      { text: "hi", model: "speech-01", format: "wav" },
      makeConfig({ protocol: "minimax-t2a" }),
      makeSignal(),
    );

    const body = lastRequestBody();
    expect((body.audio_setting as Record<string, unknown>).sample_rate).toBe(44_100);
    expect((body.voice_setting as Record<string, unknown>).voice_id).toBe("male-qn-qingse");
    expect((body.voice_setting as Record<string, unknown>).speed).toBe(1);
  });

  it("缺 data.audio 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        // 无 data.audio
      }),
    });

    await expect(
      minimaxGenerateTts(
        { text: "x", model: "speech-01" },
        makeConfig({ protocol: "minimax-t2a" }),
        makeSignal(),
      ),
    ).rejects.toThrow(/data\.audio/);
  });

  it("data.audio 为非法 hex 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        data: { audio: "xyz" },
      }),
    });

    await expect(
      minimaxGenerateTts(
        { text: "x", model: "speech-01" },
        makeConfig({ protocol: "minimax-t2a" }),
        makeSignal(),
      ),
    ).rejects.toThrow(/非法的 hex/);
  });

  it("HTTP 非 2xx 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    });

    await expect(
      minimaxGenerateTts(
        { text: "x", model: "speech-01" },
        makeConfig({ protocol: "minimax-t2a" }),
        makeSignal(),
      ),
    ).rejects.toThrow(/HTTP 401/);
  });
});
