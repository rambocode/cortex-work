// 供应商连接测试：按 endpointFormat 选鉴权头探测 {baseUrl}/models,返回可用模型 id。
// 在主进程发请求：规避 renderer CORS,apiKey 不出 main。鉴权头对齐 kun provider-connection：
//   chat_completions / responses → Authorization: Bearer
//   messages → x-api-key + anthropic-version
//   custom → 不支持探测（提示手动填模型）

import { ipcMain } from "electron";
import type { ProviderProbeInput, ProviderProbeResult } from "./types";

const PROBE_TIMEOUT_MS = 10_000;
const ANTHROPIC_VERSION = "2023-06-01";

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// 解析 OpenAI 兼容 {data:[{id}]} 或 Anthropic {data:[{id}]} / 裸数组 为模型 id 列表（去重排序）。
function parseModelIds(data: unknown): string[] {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { data?: unknown[] }).data)
      ? (data as { data: unknown[] }).data
      : [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const id =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? (item as { id?: unknown }).id
          : undefined;
    if (typeof id === "string" && id.trim() && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids.sort((a, b) => a.localeCompare(b));
}

// 候选模型列表 URL:
// - chat_completions / responses:先试 {base}/models;若 base 带版本前缀（/v1 等）,补一个
//   去掉前缀的候选（部分供应商如 DeepSeek 的 /models 在版本前缀之外,/v1/models 会 404）。
// - messages:遵循 Anthropic 约定（base 不含 /v1,SDK 自行拼接 /v1/messages),
//   base 不带版本前缀时首选 {base}/v1/models（如 https://api.kimi.com/coding）,
//   再回退 {base}/models;base 已带 /v\d+ 时保持 {base}/models 优先。
function modelsUrlCandidates(baseUrl: string, endpointFormat: ProviderProbeInput["endpointFormat"]): string[] {
  const base = baseUrl.replace(/\/+$/, "");
  const hasVersionPrefix = /\/v\d+$/i.test(base);
  if (endpointFormat === "messages") {
    if (!hasVersionPrefix) return [`${base}/v1/models`, `${base}/models`];
    return [`${base}/models`];
  }
  const urls = [`${base}/models`];
  const stripped = base.replace(/\/v\d+$/i, "");
  if (stripped !== base) urls.push(`${stripped}/models`);
  return urls;
}

async function fetchOnce(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; statusText: string; ok: boolean; json?: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    return { status: res.status, statusText: res.statusText, ok: res.ok, json: res.ok ? await res.json() : undefined };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeProvider(input: ProviderProbeInput): Promise<ProviderProbeResult> {
  const baseUrl = input.baseUrl?.trim();
  if (!baseUrl) return { ok: false, error: "请填写 Base URL" };
  if (!isHttpUrl(baseUrl)) return { ok: false, error: "Base URL 必须以 http:// 或 https:// 开头" };
  if (input.endpointFormat === "custom") {
    return { ok: false, error: "自定义端点不支持探测,请手动填写模型 id" };
  }
  const key = input.apiKey?.trim();
  const headers: Record<string, string> =
    input.endpointFormat === "messages"
      ? key
        ? { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION }
        : { "anthropic-version": ANTHROPIC_VERSION }
      : key
        ? { Authorization: `Bearer ${key}` }
        : {};

  let lastErr = "";
  for (const url of modelsUrlCandidates(baseUrl, input.endpointFormat)) {
    try {
      const res = await fetchOnce(url, headers);
      if (res.ok) return { ok: true, models: parseModelIds(res.json) };
      lastErr = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
      // 仅 404 才尝试下一个候选 URL；401/403/5xx 等直接返回（重试无意义）。
      if (res.status !== 404) return { ok: false, error: lastErr };
    } catch (err) {
      const msg = err instanceof Error ? (err.name === "AbortError" ? "连接超时" : err.message) : String(err);
      return { ok: false, error: msg };
    }
  }
  return { ok: false, error: `${lastErr}（未找到 /models 接口,请检查 Base URL）` };
}

export function registerProviderHandlers(): void {
  ipcMain.handle("provider:probe", (_e, input: ProviderProbeInput) => probeProvider(input));
}
