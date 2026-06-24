// 在线 ASR 转写共享函数（OQ4 抽取）。
// 原逻辑在 ipc/llm.ts 的 asr:transcribe handler 内联；
// 抽为共享函数后，asr:transcribe（旧入口）与 stt:transcribe 在线分支（新入口）
// 均调用此函数，确保行为一致、MAX_BYTES 约束统一生效。
//
// 两条调用路径：
//   asr:transcribe  — 旧入口（llm.ts），保持向后兼容
//   stt:transcribe  — 新统一入口（stt.ts），按 AsrSettings.protocol 分发
//
// MAX_BYTES：防止超大音频文件（录音意外过长）占满 IPC + 网络带宽，
// 与本地转写路径统一在 stt:transcribe 入口处检查（llm.ts 原路径一并补上）。

import { audioTranscriptionsUrl, authHeaders } from "./transcribe-auth";
import type { AsrTranscribeRequest, AsrTranscribeResponse } from "../../ipc/types";

// ── 超时常量（与 ipc/llm.ts 原值对齐） ──────────────────────────────────────
export const ASR_ONLINE_TIMEOUT_MS = 180_000;

// ── 文件大小上限 ──────────────────────────────────────────────────────────────
// 25 MB：与 OpenAI Whisper API 官方文件大小限制一致；
// 本地路径也用同一阈值，避免 spawn 侧内存压力。
export const ASR_MAX_BYTES = 25 * 1024 * 1024;

/**
 * 调用 OpenAI 兼容 /v1/audio/transcriptions 接口进行在线转写。
 *
 * @throws 若 HTTP 非 2xx、或响应体不含 text 字段。
 */
export async function transcribeOnline(req: AsrTranscribeRequest): Promise<AsrTranscribeResponse> {
  const form = new FormData();
  form.append("file", new Blob([req.audio], { type: req.mimeType || "application/octet-stream" }), req.fileName);
  form.append("model", req.model);
  form.append("response_format", "verbose_json");
  if (req.language) form.append("language", req.language);

  const res = await fetch(audioTranscriptionsUrl(req.baseUrl), {
    method: "POST",
    headers: {
      ...(await authHeaders(req.baseUrl, req.apiKey)),
    },
    body: form,
    signal: AbortSignal.timeout(ASR_ONLINE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ASR 接口 HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }

  const data = (await res.json()) as AsrTranscribeResponse;
  if (typeof data.text !== "string" || !data.text.trim()) {
    throw new Error("ASR 未返回转写文本");
  }
  return { ...data, text: data.text.trim() };
}
