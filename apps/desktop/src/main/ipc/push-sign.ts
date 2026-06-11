// 推送相关纯函数（不依赖 electron,便于单测）。

import { createHmac } from "crypto";

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
