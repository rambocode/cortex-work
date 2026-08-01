// MiMo（Xiaomi）TTS 协议实现（主进程）。
// 对应接口：{baseUrl}/v1/chat/completions（chat 形态的 TTS）
//
// 路由修复背景：mimo-tts 此前在 client.ts 被错误路由到 MiniMax t2a_v2——两者的
// 载荷与响应结构完全不同（chat messages vs text/voice_setting），现网必然失败。
// 本文件按 Kun MimoSpeechClient 提供独立实现。
//
// 规格（对齐 Kun MimoSpeechClient）：
//   - messages 顺序有约定：style 作为 user 消息在前（风格指令），text 作为
//     assistant 消息在后——MiMo 的 chat 形态 TTS 中 assistant 消息内容即待合成文本。
//   - audio: {format, voice?}
//   - 鉴权同时带 Authorization: Bearer 与 api-key 两个头（MiMo 不同部署各认一种）。
//   - 响应：choices[0].message.audio.data（base64）→ Buffer。

import type { ResolvedMediaGenConfig } from "../resolve";
import { apiUrl } from "./shared";

// ── 参数类型 ──────────────────────────────────────────────────────────────────

export interface MimoSpeechArgs {
  text: string;
  model: string;
  voice?: string;
  /** 语音风格指令（MiMo 独有：以 user 消息形式注入）。*/
  style?: string;
  format?: string;
}

// ── 响应体类型（宽松，实际字段由 API 返回） ────────────────────────────────────

interface MimoSpeechResponse {
  choices?: Array<{
    message?: {
      audio?: {
        data?: string; // base64
      };
    };
  }>;
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * 调用 MiMo chat/completions 形态的 TTS 接口，返回音频二进制 Buffer。
 */
export async function mimoGenerateSpeech(
  args: MimoSpeechArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = apiUrl(config.baseUrl, "/v1/chat/completions");

  // 消息顺序不可颠倒（对齐 Kun）：style 是给模型的朗读风格指令（user），
  // text 是待合成文本本体（assistant）——颠倒会把风格指令读出来。
  const messages = [
    ...(args.style ? [{ role: "user", content: args.style }] : []),
    { role: "assistant", content: args.text },
  ];

  const body: Record<string, unknown> = {
    model: args.model,
    messages,
    audio: {
      format: args.format ?? "mp3",
      ...(args.voice ? { voice: args.voice } : {}),
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      // MiMo 部分部署只认 api-key 头，与 Bearer 并存发送（对齐 Kun）。
      "api-key": config.apiKey,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`MiMo TTS 接口 HTTP ${res.status}: ${errorBody.slice(0, 300)}`);
  }

  const data = (await res.json()) as MimoSpeechResponse;
  const audio = data.choices?.[0]?.message?.audio?.data;
  if (!audio) {
    throw new Error("MiMo TTS 响应中无 choices[0].message.audio.data（base64 音频）");
  }
  return Buffer.from(audio, "base64");
}
