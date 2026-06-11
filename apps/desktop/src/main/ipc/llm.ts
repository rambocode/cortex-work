// 自定义 OpenAI 兼容端点一次性补全（本地大模型生成日报用）。
// 在主进程发请求：规避 renderer CORS,且 apiKey 不出 main。

import { ipcMain } from "electron";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type {
  AsrTranscribeRequest,
  AsrTranscribeResponse,
  TtsListVoicesRequest,
  TtsSynthesizeRequest,
  TtsVoiceOption,
} from "./types";
import { audioSpeechUrl, audioTranscriptionsUrl, audioVoiceUrls, chatCompletionsUrl } from "./push-sign";

interface OpenAiCompleteRequest {
  baseUrl: string;
  apiKey?: string;
  model: string;
  prompt: string;
}

const TIMEOUT_MS = 60_000;
const ASR_TIMEOUT_MS = 180_000;
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
    return typeof data.auth?.api_key === "string" && data.auth.api_key.trim() ? data.auth.api_key : undefined;
  } catch {
    return undefined;
  }
}

async function authHeaders(baseUrl: string, apiKey?: string): Promise<Record<string, string>> {
  const key = apiKey?.trim() || (await localOmlxApiKey(baseUrl));
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function voiceFromUnknown(item: unknown): TtsVoiceOption | null {
  if (typeof item === "string" && item.trim()) return { id: item.trim() };
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const id = obj.id ?? obj.voice ?? obj.name;
  if (typeof id !== "string" || !id.trim()) return null;
  const label = obj.label ?? obj.display_name ?? obj.name;
  const locale = obj.locale ?? obj.lang ?? obj.language;
  return {
    id: id.trim(),
    ...(typeof label === "string" && label.trim() && label !== id ? { label: label.trim() } : {}),
    ...(typeof locale === "string" && locale.trim() ? { locale: locale.trim() } : {}),
  };
}

function parseVoiceOptions(data: unknown): TtsVoiceOption[] {
  const source =
    Array.isArray(data)
      ? data
      : data && typeof data === "object" && Array.isArray((data as { voices?: unknown[] }).voices)
        ? (data as { voices: unknown[] }).voices
        : data && typeof data === "object" && Array.isArray((data as { data?: unknown[] }).data)
          ? (data as { data: unknown[] }).data
          : [];
  const seen = new Set<string>();
  const out: TtsVoiceOption[] = [];
  for (const item of source) {
    const voice = voiceFromUnknown(item);
    if (!voice || seen.has(voice.id)) continue;
    seen.add(voice.id);
    out.push(voice);
  }
  return out;
}

export function registerLlmHandlers(): void {
  ipcMain.handle("llm:openaiComplete", async (_e, req: OpenAiCompleteRequest) => {
    const url = chatCompletionsUrl(req.baseUrl);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders(req.baseUrl, req.apiKey)),
      },
      body: JSON.stringify({
        model: req.model,
        messages: [{ role: "user", content: req.prompt }],
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`模型接口 HTTP ${res.status}${body ? `:${body.slice(0, 200)}` : ""}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("模型未返回内容");
    return content.trim();
  });

  // TTS：OpenAI 兼容 /v1/audio/speech,返回音频字节流（mp3）。
  ipcMain.handle("tts:synthesize", async (_e, req: TtsSynthesizeRequest) => {
    const res = await fetch(audioSpeechUrl(req.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders(req.baseUrl, req.apiKey)),
      },
      body: JSON.stringify({
        model: req.model,
        input: req.text,
        voice: req.voice,
        ...(req.speed ? { speed: req.speed } : {}),
        ...(req.language ? { language: req.language } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`TTS 接口 HTTP ${res.status}${body ? `:${body.slice(0, 200)}` : ""}`);
    }
    return await res.arrayBuffer();
  });

  ipcMain.handle("tts:listVoices", async (_e, req: TtsListVoicesRequest): Promise<TtsVoiceOption[]> => {
    if (!req.baseUrl || !req.model) return [];
    const headers = await authHeaders(req.baseUrl, req.apiKey);
    for (const url of audioVoiceUrls(req.baseUrl, req.model)) {
      try {
        const res = await fetch(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) continue;
        const voices = parseVoiceOptions(await res.json());
        if (voices.length > 0) return voices;
      } catch {
        // 端点通常是厂商扩展；不支持时继续尝试下一个候选。
      }
    }
    return [];
  });

  // ASR：OpenAI 兼容 /v1/audio/transcriptions,返回转写文本。
  ipcMain.handle("asr:transcribe", async (_e, req: AsrTranscribeRequest): Promise<AsrTranscribeResponse> => {
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
      signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ASR 接口 HTTP ${res.status}${body ? `:${body.slice(0, 200)}` : ""}`);
    }
    const data = (await res.json()) as AsrTranscribeResponse;
    if (typeof data.text !== "string" || !data.text.trim()) throw new Error("ASR 未返回转写文本");
    return { ...data, text: data.text.trim() };
  });
}
