// 自定义 OpenAI 兼容端点一次性补全（本地大模型生成日报用）。
// 在主进程发请求：规避 renderer CORS,且 apiKey 不出 main。

import { ipcMain } from "electron";
import type {
  AsrTranscribeRequest,
  AsrTranscribeResponse,
  TtsListVoicesRequest,
  TtsSynthesizeStreamRequest,
  TtsSynthesizeRequest,
  TtsStreamEvent,
  TtsVoiceOption,
} from "./types";
import { audioSpeechPayload, audioSpeechUrl, audioVoiceUrls, chatCompletionsUrl } from "./push-sign";
// OQ4：在线转写逻辑已抽取为共享函数（capabilities/whisper/online-transcribe.ts），
// asr:transcribe（旧入口）与 stt:transcribe 在线分支（新入口）均调用它，
// 确保 MAX_BYTES 约束与行为一致。
import { transcribeOnline, ASR_MAX_BYTES } from "../capabilities/whisper/online-transcribe";
import { authHeaders } from "../capabilities/whisper/transcribe-auth";

interface OpenAiCompleteRequest {
  baseUrl: string;
  apiKey?: string;
  model: string;
  prompt: string;
}

const TIMEOUT_MS = 60_000;
const TTS_STREAM_TIMEOUT_MS = 10 * 60_000;

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
      body: JSON.stringify(audioSpeechPayload(req)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`TTS 接口 HTTP ${res.status}${body ? `:${body.slice(0, 200)}` : ""}`);
    }
    return await res.arrayBuffer();
  });

  ipcMain.handle("tts:synthesizeStream", async (event, req: TtsSynthesizeStreamRequest) => {
    const sender = event.sender;
    const send = (streamEvent: TtsStreamEvent) => {
      if (!sender.isDestroyed()) sender.send("tts:stream", { streamId: req.streamId, event: streamEvent });
    };

    try {
      const res = await fetch(audioSpeechUrl(req.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await authHeaders(req.baseUrl, req.apiKey)),
        },
        body: JSON.stringify(audioSpeechPayload({ ...req, stream: true })),
        signal: AbortSignal.timeout(TTS_STREAM_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`TTS 接口 HTTP ${res.status}${body ? `:${body.slice(0, 200)}` : ""}`);
      }
      if (!res.body) throw new Error("TTS 接口未返回可读取的音频流");

      const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "audio/mpeg";
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        send({ type: "chunk", chunk, mimeType });
      }
      send({ type: "done" });
    } catch (error) {
      send({ type: "error", error: error instanceof Error ? error.message : String(error) });
    }
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
  // OQ4：实际转写逻辑已委托给共享函数 transcribeOnline（含 MAX_BYTES 检查），
  // 此 handler 作为旧入口保持向后兼容（renderer 仍可直接调 asr:transcribe）。
  ipcMain.handle("asr:transcribe", async (_e, req: AsrTranscribeRequest): Promise<AsrTranscribeResponse> => {
    if (req.audio.byteLength > ASR_MAX_BYTES) {
      throw new Error(`音频文件超过大小限制（${Math.round(req.audio.byteLength / 1024 / 1024)} MB > ${Math.round(ASR_MAX_BYTES / 1024 / 1024)} MB）`);
    }
    return transcribeOnline(req);
  });
}
