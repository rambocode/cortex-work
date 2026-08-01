// MiniMax 音频协议实现（主进程）：音乐生成 + TTS。
// 自原 minimax.ts 按模态拆出（纯移动，行为不变）；公共辅助改从 shared.ts 导入。
//
// 规格（KTD6）：
//   音乐：POST {baseUrl}/v1/music_generation
//   TTS：POST {baseUrl}/v1/t2a_v2
// ⚠️ 波次 1（WP3）将对齐 Kun 载荷：t2a 改 voice_setting + output_format:hex、
// music 补 lyrics_optimizer/is_instrumental/audio_url——属现网行为变更，本次拆分不做。

import type { ResolvedMediaGenConfig } from "../resolve";
import { streamDownloadToBuffer } from "../download";
import { MAX_RESPONSE_BYTES } from "../client";
import { checkMinimaxBaseResp } from "./shared";

// ── 音乐生成参数 ──────────────────────────────────────────────────────────────

export interface MinimaxMusicArgs {
  prompt: string;
  model: string;
  lyrics?: string;
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

interface MinimaxMusicResponse {
  base_resp?: { status_code?: number; status_msg?: string };
  data?: {
    audio?: string; // base64
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
  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    ...(args.lyrics ? { lyrics: args.lyrics } : {}),
    ...(args.format ? { format: args.format } : {}),
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

  const data = (await res.json()) as MinimaxMusicResponse;
  checkMinimaxBaseResp(data.base_resp, "音乐生成");

  const base64 = data.data?.audio;
  if (base64) {
    return Buffer.from(base64, "base64");
  }

  // 回退 url：流式下载，边读边计数超限中止（KTD11 / ADV-006）。
  const audioUrl = data.data?.audio_url;
  if (audioUrl) {
    return streamDownloadToBuffer(audioUrl, {
      signal,
      maxBytes: MAX_RESPONSE_BYTES.music,
      modality: "music",
    });
  }

  throw new Error("MiniMax 音乐生成响应中既无 audio（base64）也无 audio_url");
}

// ── TTS 生成 ──────────────────────────────────────────────────────────────────

interface MinimaxTtsResponse {
  base_resp?: { status_code?: number; status_msg?: string };
  audio_file?: string; // base64
  data?: {
    audio?: string; // 某些版本把 audio 放在 data 下
  };
}

/**
 * 调用 MiniMax TTS 接口，返回音频二进制 Buffer。
 */
export async function minimaxGenerateTts(
  args: MinimaxTtsArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/t2a_v2`;
  const body: Record<string, unknown> = {
    model: args.model,
    text: args.text,
    ...(args.voice ? { voice_id: args.voice } : {}),
    ...(args.speed !== undefined ? { speed: args.speed } : {}),
    ...(args.format ? { audio_setting: { format: args.format } } : {}),
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

  const data = (await res.json()) as MinimaxTtsResponse;
  checkMinimaxBaseResp(data.base_resp, "TTS 生成");

  const base64 = data.audio_file ?? data.data?.audio;
  if (base64) {
    return Buffer.from(base64, "base64");
  }

  throw new Error("MiniMax TTS 响应中无 audio_file 字段（base64）");
}
