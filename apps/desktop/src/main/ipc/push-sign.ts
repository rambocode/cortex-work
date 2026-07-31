// 推送相关纯函数（不依赖 electron,便于单测）。

import { createHmac } from "crypto";
import type { TtsSynthesizeRequest } from "./types";

// 钉钉加签：timestamp + "\n" + secret 做 HMAC-SHA256,Base64 后 URL 编码。
export function dingtalkSignedUrl(webhookUrl: string, secret: string, timestamp: number): string {
  const sign = createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
  const sep = webhookUrl.includes("?") ? "&" : "?";
  return `${webhookUrl}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

// 飞书加签：与钉钉「相反」—— 以 `${timestampSec}\n${secret}` 为 HMAC-SHA256 的 key、
// 空字符串为 data,Base64。timestamp 用「秒」,且 sign 与 timestamp 一同放进请求体
// (不进 URL query)。返回 base64 sign 字符串,timestamp 由调用方一并写入 body。
export function feishuSign(secret: string, timestampSec: number): string {
  return createHmac("sha256", `${timestampSec}\n${secret}`).update("").digest("base64");
}

// ── 音频端点 URL 拼接（TTS / ASR 专用） ───────────────────────────────────────
//
// 阶段③·4.1 之前，这里还有一个文本补全的 URL 拼接函数，与下面的音频拼接共用同一段
// 「兼容带/不带 /vN 与结尾斜杠」的归一化逻辑。文本补全收编进 Pi Model Gateway 后，
// **文本侧不再有任何 URL 拼接**（寻址变成 `{providerId, modelId}`，见 providers/gateway.ts），
// 故那个函数已删除。
//
// 音频（`/v1/audio/*`）**刻意不收编**（计划 §0 / §4.1 排除项）：pi 的 `Models` 只覆盖文本
// 补全，没有 TTS/ASR 对应物；强行收编等于让音频链路无端点可用。所以先把两侧解耦、再删文本
// 侧的旧路径 —— 顺序反了就会连带把还在服役的音频链路一起拆掉。
// 静态检查（providers/no-direct-endpoint.test.ts）对本文件的音频函数有显式豁免。

/** baseUrl 归一化：去掉结尾斜杠，没有 `/vN` 版本段就补 `/v1`。音频三个端点共用。 */
function audioApiBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

// OpenAI 兼容 TTS：统一拼到 /audio/speech。
export function audioSpeechUrl(baseUrl: string): string {
  return `${audioApiBase(baseUrl)}/audio/speech`;
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
  return `${audioApiBase(baseUrl)}/audio/transcriptions`;
}

// OpenAI 兼容生态没有统一 voices 标准；返回常见扩展 endpoint 候选。
export function audioVoiceUrls(baseUrl: string, model: string): string[] {
  const versioned = audioApiBase(baseUrl);
  const encodedModel = encodeURIComponent(model);
  return [
    `${versioned}/audio/voices?model=${encodedModel}`,
    `${versioned}/models/${encodedModel}/voices`,
    `${versioned}/voices?model=${encodedModel}`,
  ];
}
