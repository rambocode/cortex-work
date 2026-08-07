// 自定义 OpenAI 兼容端点一次性补全（本地大模型生成日报用）。
// 在主进程发请求：规避 renderer CORS,且 apiKey 不出 main。

import { ipcMain } from "electron";
import type {
  AsrTranscribeRequest,
  AsrTranscribeResponse,
  EdgeTtsSynthesizeRequest,
  TtsListVoicesRequest,
  TtsSynthesizeStreamRequest,
  TtsSynthesizeRequest,
  TtsStreamEvent,
  TtsVoiceOption,
} from "./types";
import { audioSpeechPayload, audioSpeechUrl, audioVoiceUrls } from "./push-sign";
import { postChatCompletion } from "./openai-chat";
// OQ4：在线转写逻辑已抽取为共享函数（capabilities/asr/online-transcribe.ts），
// asr:transcribe（旧入口）与 stt:transcribe 在线分支（新入口）均调用它，
// 确保 MAX_BYTES 约束与行为一致。
import { transcribeOnline, ASR_MAX_BYTES } from "../capabilities/asr/online-transcribe";
import { authHeaders } from "../capabilities/asr/transcribe-auth";
import { synthesizeEdgeTts } from "../capabilities/edge-tts/client";
import { listEdgeTtsVoices } from "../capabilities/edge-tts/voices";

/**
 * `llm:openaiComplete` 的入参（Timeline / 日报的一次性补全）。
 * ⚠️ 与 `packages/core/desktop/types.ts` 的 `OpenAiCompleteRequest` 逐字镜像。
 *
 * 阶段③·4.1 收编：寻址从 `{baseUrl, apiKey, model}` 改成 Catalog 引用 `{providerId, modelId}`，
 * 明文 apiKey 不再过桥。两段都是必填 —— 缺任一段就是**悬空引用**，
 * 由 Gateway 判成 `config` 并进阻断态，而不是回退任何模型（计划 §5）。
 */
interface OpenAiCompleteRequest {
  providerId: string;
  modelId: string;
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

// 在途 TTS 流式请求(streamId → 中止句柄):tts:cancelStreams 据此把取消传导到上游服务。
const activeTtsStreams = new Map<string, AbortController>();

export function registerLlmHandlers(): void {
  ipcMain.handle("llm:openaiComplete", async (_e, req: OpenAiCompleteRequest) => {
    // 请求/错误契约收敛在 openai-chat.ts（现已改架在 Pi Model Gateway 之上）；
    // 本入口保持旧行为：单 user 消息、不传 temperature、60s 超时、trim 后返回。
    const content = await postChatCompletion({
      providerId: req.providerId,
      modelId: req.modelId,
      messages: [{ role: "user", content: req.prompt }],
      timeoutMs: TIMEOUT_MS,
    });
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

  // Edge TTS 也接入同一个取消注册表，停止播放必须关闭其 WSS，不能留下悬挂合成连接。
  ipcMain.handle("tts:synthesizeEdge", async (_e, req: EdgeTtsSynthesizeRequest) => {
    const streamId = `edge-${crypto.randomUUID()}`;
    const controller = new AbortController();
    activeTtsStreams.set(streamId, controller);
    try {
      return await synthesizeEdgeTts({ ...req, signal: AbortSignal.any([AbortSignal.timeout(TTS_STREAM_TIMEOUT_MS), controller.signal]) });
    } finally {
      activeTtsStreams.delete(streamId);
    }
  });

  ipcMain.handle("tts:synthesizeStream", async (event, req: TtsSynthesizeStreamRequest) => {
    const sender = event.sender;
    const send = (streamEvent: TtsStreamEvent) => {
      if (!sender.isDestroyed()) sender.send("tts:stream", { streamId: req.streamId, event: streamEvent });
    };

    // 可取消:renderer 停止播放时经 tts:cancelStreams 中止 fetch——否则本地 TTS 服务会
    // 继续满负荷生成整段文本,并把后续请求堵在其串行队列后面。
    const controller = new AbortController();
    activeTtsStreams.set(req.streamId, controller);
    try {
      const res = await fetch(audioSpeechUrl(req.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await authHeaders(req.baseUrl, req.apiKey)),
        },
        body: JSON.stringify(audioSpeechPayload({ ...req, stream: true })),
        signal: AbortSignal.any([AbortSignal.timeout(TTS_STREAM_TIMEOUT_MS), controller.signal]),
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
    } finally {
      activeTtsStreams.delete(req.streamId);
    }
  });

  // 停止播放时中止全部在途合成流(逻辑上同时最多一条;按 Map 全清防御竞态残留)。
  ipcMain.handle("tts:cancelStreams", async (): Promise<void> => {
    for (const controller of activeTtsStreams.values()) controller.abort();
    activeTtsStreams.clear();
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

  ipcMain.handle("tts:listEdgeVoices", async (): Promise<TtsVoiceOption[]> => listEdgeTtsVoices());

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
