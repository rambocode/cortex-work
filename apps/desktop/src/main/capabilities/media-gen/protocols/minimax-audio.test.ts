// minimax-audio.test.ts — MiniMax 音乐 + TTS 协议单测（自原 minimax.test.ts 拆出）。
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

// ── mock fetch ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 音乐生成 ──────────────────────────────────────────────────────────────────

describe("minimaxGenerateMusic", () => {
  it("成功解析 data.audio（base64）", async () => {
    const fakeAudio = Buffer.from("music-data").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        data: { audio: fakeAudio },
      }),
    });

    const buffer = await minimaxGenerateMusic(
      { prompt: "jazz music", model: "music-01" },
      makeConfig(),
      makeSignal(),
    );

    expect(buffer.toString()).toBe("music-data");
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
});

// ── TTS 生成 ──────────────────────────────────────────────────────────────────

describe("minimaxGenerateTts", () => {
  it("成功解析 audio_file（base64）", async () => {
    const fakeAudio = Buffer.from("tts-audio").toString("base64");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        audio_file: fakeAudio,
      }),
    });

    const buffer = await minimaxGenerateTts(
      { text: "Hello world", model: "speech-01", voice: "Wise_Woman" },
      makeConfig({ protocol: "minimax-t2a" }),
      makeSignal(),
    );

    expect(buffer.toString()).toBe("tts-audio");
  });

  it("缺 audio_file 时抛出错误", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        base_resp: { status_code: 0 },
        // 无 audio_file
      }),
    });

    await expect(
      minimaxGenerateTts(
        { text: "x", model: "speech-01" },
        makeConfig({ protocol: "minimax-t2a" }),
        makeSignal(),
      ),
    ).rejects.toThrow(/audio_file/);
  });
});
