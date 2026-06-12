// 推送相关纯函数（不依赖 electron,便于单测）。

import { createHmac } from "crypto";
import type { TtsSynthesizeRequest } from "./types";

// 钉钉加签：timestamp + "\n" + secret 做 HMAC-SHA256,Base64 后 URL 编码。
export function dingtalkSignedUrl(webhookUrl: string, secret: string, timestamp: number): string {
  const sign = createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
  const sep = webhookUrl.includes("?") ? "&" : "?";
  return `${webhookUrl}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

// baseUrl 兼容带/不带 /v1 与结尾斜杠：统一拼到 /chat/completions。
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

// OpenAI 兼容 TTS：统一拼到 /audio/speech。
export function audioSpeechUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/audio/speech` : `${trimmed}/v1/audio/speech`;
}

export function audioSpeechPayload(req: TtsSynthesizeRequest): Record<string, unknown> {
  return {
    model: req.model,
    input: req.text,
    voice: req.voice,
    ...(req.speed ? { speed: req.speed } : {}),
    ...(req.language ? { language: req.language } : {}),
    ...(typeof req.stream === "boolean" ? { stream: req.stream } : {}),
    ...(req.streamingInterval ? { streaming_interval: req.streamingInterval } : {}),
  };
}

// OpenAI 兼容 ASR：统一拼到 /audio/transcriptions。
export function audioTranscriptionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/audio/transcriptions` : `${trimmed}/v1/audio/transcriptions`;
}

// OpenAI 兼容生态没有统一 voices 标准；返回常见扩展 endpoint 候选。
export function audioVoiceUrls(baseUrl: string, model: string): string[] {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const versioned = /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  const encodedModel = encodeURIComponent(model);
  return [
    `${versioned}/audio/voices?model=${encodedModel}`,
    `${versioned}/models/${encodedModel}/voices`,
    `${versioned}/voices?model=${encodedModel}`,
  ];
}
