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

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
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

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(modelsUrl(baseUrl), { headers, signal: ctrl.signal });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}` };
    }
    const json = (await res.json()) as unknown;
    return { ok: true, models: parseModelIds(json) };
  } catch (err) {
    const msg =
      err instanceof Error ? (err.name === "AbortError" ? "连接超时" : err.message) : String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export function registerProviderHandlers(): void {
  ipcMain.handle("provider:probe", (_e, input: ProviderProbeInput) => probeProvider(input));
}
