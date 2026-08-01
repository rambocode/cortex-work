// OpenAI 兼容语音（TTS）协议实现（主进程）。
// 对应接口：{baseUrl}/v1/audio/speech
// 自 client.ts 内联实现迁出为独立协议文件（行为保持，与其它协议文件同构）。
//
// 规格（对齐 Kun OpenAiCompatSpeechClient）：
//   - body: {model, input, voice?, speed?, response_format?}
//   - Authorization: Bearer {apiKey}
//   - 响应为音频二进制流（非 JSON），流式读取并按 MAX_RESPONSE_BYTES.speech 限流
//   - style 参数在本协议中**刻意忽略**（对齐 Kun）：OpenAI /v1/audio/speech 无
//     风格指令字段，只有 MiMo（protocols/mimo.ts）消费 style。

import type { ResolvedMediaGenConfig } from "../resolve";
import { MAX_RESPONSE_BYTES } from "../client";

// ── 参数类型 ──────────────────────────────────────────────────────────────────

export interface OpenAISpeechArgs {
  text: string;
  model: string;
  voice?: string;
  speed?: number;
  format?: string;
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * 调用 OpenAI 兼容 /v1/audio/speech 接口，返回音频二进制 Buffer。
 */
export async function openaiSpeechGenerate(
  args: OpenAISpeechArgs,
  config: ResolvedMediaGenConfig,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/audio/speech`;
  const body: Record<string, unknown> = {
    model: args.model,
    input: args.text,
    ...(args.voice ? { voice: args.voice } : {}),
    ...(args.speed !== undefined ? { speed: args.speed } : {}),
    ...(args.format ? { response_format: args.format } : {}),
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
    throw new Error(`OpenAI Speech 接口 HTTP ${res.status}: ${errorBody.slice(0, 300)}`);
  }

  // 语音响应直接是二进制流（非 JSON），流式读取（KTD11 / ADV-006）：
  // 边读边计数，超过 MAX_RESPONSE_BYTES.speech（200MB）时立即中止，不等全量进堆。
  if (!res.body) {
    throw new Error("OpenAI Speech 响应缺少 body（ReadableStream）");
  }
  const chunks: Uint8Array[] = [];
  const reader = res.body.getReader();
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES.speech) {
        await reader.cancel();
        throw new Error(
          `[speech] 响应体超过大小限制（已读 ${bytesRead} > ${MAX_RESPONSE_BYTES.speech} bytes），下载已中止`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
