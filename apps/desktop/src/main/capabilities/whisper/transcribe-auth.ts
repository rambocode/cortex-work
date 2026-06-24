// ASR/TTS 认证辅助（从 ipc/llm.ts 提取，供 online-transcribe.ts 复用）。
// 此模块纯函数，不依赖 electron，便于单测。
//
// 注：audioTranscriptionsUrl 本已在 ipc/push-sign.ts 导出；
// 此处 re-export 方便 capabilities/whisper/ 内部统一引入，不必跨层 import ipc/。

export { audioTranscriptionsUrl } from "../../ipc/push-sign";

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const LOCAL_OMLX_BASE_URLS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLocalOmlxUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return LOCAL_OMLX_BASE_URLS.has(url.hostname) && (!url.port || url.port === "8000");
  } catch {
    return false;
  }
}

async function localOmlxApiKey(baseUrl: string): Promise<string | undefined> {
  if (!isLocalOmlxUrl(baseUrl)) return undefined;
  try {
    const raw = await readFile(join(homedir(), ".omlx", "settings.json"), "utf8");
    const data = JSON.parse(raw) as { auth?: { api_key?: unknown } };
    return typeof data.auth?.api_key === "string" && data.auth.api_key.trim()
      ? data.auth.api_key
      : undefined;
  } catch {
    return undefined;
  }
}

/** 根据 baseUrl + apiKey 生成 Authorization 头（与 llm.ts 完全一致）。*/
export async function authHeaders(
  baseUrl: string,
  apiKey?: string,
): Promise<Record<string, string>> {
  const key = apiKey?.trim() || (await localOmlxApiKey(baseUrl));
  return key ? { Authorization: `Bearer ${key}` } : {};
}
