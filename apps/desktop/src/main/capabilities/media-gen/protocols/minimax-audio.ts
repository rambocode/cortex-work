// MiniMax 音频协议实现（主进程）：音乐生成 + TTS。
//
// 规格（对齐 Kun MiniMaxSpeechClient / MiniMaxMusicClient）：
//   音乐：POST {baseUrl}/v1/music_generation
//   TTS：POST {baseUrl}/v1/t2a_v2
//
// 为什么用 output_format:'hex'：MiniMax 默认返回带过期时间的公网产物 URL，
// hex 则把音频字节直接内联在响应 JSON 里——免二次下载、不依赖 URL 有效期，
// 也是 Kun 现网验证过的通路。响应 data.audio 为 hex 字符串，经 bufferFromHex 解码。
// ⚠️ 相对旧实现（top-level voice_id + base64 audio_file）是现网行为变更，需真 key 冒烟。

import type { ResolvedMediaGenConfig } from "../resolve";
import { streamDownloadToBuffer } from "../download";
import { MAX_RESPONSE_BYTES } from "../client";
import { bufferFromHex, checkMinimaxBaseResp } from "./shared";

// ── 音乐生成参数 ──────────────────────────────────────────────────────────────

export interface MinimaxMusicArgs {
  /** 风格/意图描述（与 lyrics / instrumental 三选一，可为空）。*/
  prompt?: string;
  model: string;
  lyrics?: string;
  /** 纯器乐（无人声）。*/
  instrumental?: boolean;
  /** 让供应商生成/润色歌词；缺省时按 Kun 规则推导（见 body 注释）。*/
  lyricsOptimizer?: boolean;
  /** 翻唱/参考音频公网 URL。*/
  referenceAudioUrl?: string;
  format?: string;
}

// ── TTS 参数 ──────────────────────────────────────────────────────────────────

export interface MinimaxTtsArgs {
  text: string;
  model: string;
  voice?: string;
  speed?: number;
  format?: string;
}

// ── 音乐生成 ──────────────────────────────────────────────────────────────────

interface MinimaxAudioResponse {
  base_resp?: { status_code?: number; status_msg?: string };
  data?: {
    audio?: string; // hex（output_format:'hex'）
    audio_url?: string;
  };
}

/**
 * 调用 MiniMax 音乐生成接口，返回音频二进制 Buffer。
 */
export async function minimaxGenerateMusic(
  args: MinimaxMusicArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/music_generation`;
  const format = args.format ?? "mp3";
  const body: Record<string, unknown> = {
    model: args.model,
    ...(args.prompt ? { prompt: args.prompt } : {}),
    ...(args.lyrics ? { lyrics: args.lyrics } : {}),
    output_format: "hex",
    // 音乐固定 44.1kHz/256kbps（对齐 Kun：音乐比 TTS 用更高码率）。
    audio_setting: { format, sample_rate: 44_100, bitrate: 256_000 },
    // lyrics_optimizer 缺省规则（对齐 Kun）：没给歌词且不是纯器乐时，必须让供应商
    // 自己写词，否则会产出无词的「歌曲」；显式传入 lyricsOptimizer 时以显式值为准。
    lyrics_optimizer: args.lyricsOptimizer ?? (!args.lyrics && args.instrumental !== true),
    ...(args.instrumental !== undefined ? { is_instrumental: args.instrumental } : {}),
    ...(args.referenceAudioUrl ? { audio_url: args.referenceAudioUrl } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`MiniMax 音乐生成接口 HTTP ${res.status}: ${errorBody.slice(0, 300)}`);
  }

  const data = (await res.json()) as MinimaxAudioResponse;
  checkMinimaxBaseResp(data.base_resp, "音乐生成");

  // output_format:'hex' 下 data.audio 为 hex 字符串（Kun 同路径）。
  const audioHex = data.data?.audio;
  if (audioHex) {
    return bufferFromHex(audioHex);
  }

  // 兜底：Kun 无此回退，但部分接口版本仍可能只回 audio_url——流式下载，
  // 边读边计数超限中止（KTD11 / ADV-006）。保留旧行为作兼容防御。
  const audioUrl = data.data?.audio_url;
  if (audioUrl) {
    return streamDownloadToBuffer(audioUrl, {
      signal,
      maxBytes: MAX_RESPONSE_BYTES.music,
      modality: "music",
    });
  }

  throw new Error("MiniMax 音乐生成响应中既无 audio（hex）也无 audio_url");
}

// ── TTS 生成 ──────────────────────────────────────────────────────────────────

/**
 * 调用 MiniMax TTS（t2a_v2）接口，返回音频二进制 Buffer。
 */
export async function minimaxGenerateTts(
  args: MinimaxTtsArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/t2a_v2`;
  const format = args.format ?? "mp3";
  const body: Record<string, unknown> = {
    model: args.model,
    text: args.text,
    output_format: "hex",
    voice_setting: {
      // Kun 缺省音色：male-qn-qingse（t2a_v2 必须给 voice_id，留空会被拒）。
      voice_id: args.voice || "male-qn-qingse",
      // Kun 固定 speed:1；cortex 工具入参允许 speed，故在此消费（对齐超集，不破坏契约）。
      speed: args.speed ?? 1,
      vol: 1,
      pitch: 0,
    },
    audio_setting: {
      format,
      // MiniMax t2a 对 mp3 的采样率上限为 32kHz，其它格式用 44.1kHz（对齐 Kun）。
      sample_rate: format === "mp3" ? 32_000 : 44_100,
      bitrate: 128_000,
      channel: 1,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`MiniMax TTS 接口 HTTP ${res.status}: ${errorBody.slice(0, 300)}`);
  }

  const data = (await res.json()) as MinimaxAudioResponse;
  checkMinimaxBaseResp(data.base_resp, "TTS 生成");

  // output_format:'hex' 下音频在 data.audio（hex 字符串），非法 hex 由 bufferFromHex 抛错。
  const audioHex = data.data?.audio;
  if (!audioHex) {
    throw new Error("MiniMax TTS 响应中无 data.audio（hex 音频）");
  }
  return bufferFromHex(audioHex);
}
