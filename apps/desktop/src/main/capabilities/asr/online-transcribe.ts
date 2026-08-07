// 在线 ASR 转写共享函数（与本地 SenseVoice 运行时解耦）。
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
// 25 MB：与 OpenAI Transcriptions API 文件大小限制一致；
// 本地路径也用同一阈值，避免 spawn 侧内存压力。
export const ASR_MAX_BYTES = 25 * 1024 * 1024;

// ── 本地地址白名单（与 transcribe-auth.ts 的 LOCAL_OMLX_BASE_URLS 保持同步） ─
// 放行 localhost/127.0.0.1/::1 的原因：omlx 本地推理服务仅绑定 loopback，
// 不经公网，无需 HTTPS；强制 HTTPS 会导致本地调试完全不可用。
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * 断言 baseUrl 使用 HTTPS，本地地址（localhost/127.0.0.1/::1）豁免。
 *
 * 安全背景：transcribeOnline 会把 API key（最多 API key + 25 MB 音频）发往该地址；
 * 若允许 HTTP，网络中间人可明文截获两者。
 * 豁免本地地址：loopback 不出网，HTTP 无明文泄露风险。
 *
 * @throws 若非 HTTPS 且非本地地址。
 */
export function assertHttpsOrLocal(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`ASR baseUrl 格式无效: ${baseUrl}`);
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && LOCAL_HOSTNAMES.has(parsed.hostname)) return;
  throw new Error(
    `ASR baseUrl 必须使用 HTTPS（当前: ${parsed.protocol}//${parsed.host}）。` +
    `本地地址（localhost/127.0.0.1/::1）可使用 HTTP。`,
  );
}

/**
 * 调用 OpenAI 兼容 /v1/audio/transcriptions 接口进行在线转写。
 *
 * @throws 若 baseUrl 非 HTTPS（本地地址除外）、HTTP 非 2xx、或响应体格式错误。
 *         静音音频（API 返回空 text）不报错，返回 { text: '' }。
 */
export async function transcribeOnline(req: AsrTranscribeRequest): Promise<AsrTranscribeResponse> {
  // 安全：防止 API key + 音频通过 HTTP 明文传输（本地地址豁免）
  assertHttpsOrLocal(req.baseUrl);

  const form = new FormData();
  form.append("file", new Blob([req.audio], { type: req.mimeType || "application/octet-stream" }), req.fileName);
  form.append("model", req.model);
  form.append("response_format", "verbose_json");
  if (req.language) form.append("language", req.language);
  // 与本地 --prompt 语义对齐：词典仅影响模型解码偏置，不能替代音频内容。
  if (req.prompt?.trim()) form.append("prompt", req.prompt);

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

  // 区分格式错误（text 字段缺失）与静音（text 为空串）：
  //   - text 字段不是字符串 → API 格式异常，抛出错误
  //   - text.trim() === '' → 静音音频，正常返回空结果（不报错，让调用方决策）
  if (typeof data.text !== "string") {
    throw new Error("ASR 接口响应格式错误：缺少 text 字段");
  }
  return { ...data, text: data.text.trim() };
}
