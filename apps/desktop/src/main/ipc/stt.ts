// STT IPC：SenseVoiceSmall 模型管理、实时 PCM 会话、整段转写与在线 ASR 分流。

import { BrowserWindow, ipcMain } from "electron";

import {
  cancelLocalAsrDownload,
  checkLocalAsrSources,
  deleteLocalAsrModel,
  downloadLocalAsrModel,
  getLocalAsrModelStatus,
  setLocalAsrProgressEmitter,
} from "../capabilities/sensevoice/models";
import { senseVoiceClient } from "../capabilities/sensevoice/client";
import { extractPcm16FromWav } from "../capabilities/sensevoice/pcm";
import { ASR_MAX_BYTES, transcribeOnline } from "../capabilities/asr/online-transcribe";
import { polishTranscriptIfEnabled } from "../capabilities/asr/polish";
import type { LocalAsrModelProgress, LocalAsrModelStatus } from "@cortex-work/core/asr/local-models";
import type { AsrSettings, AsrTranscribeRequest, AsrTranscribeResponse } from "./types";

function broadcastProgress(progress: LocalAsrModelProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("stt:local:downloadProgress", progress);
  }
}

async function readyModelPath(modelId: unknown): Promise<string> {
  const statusResult = await getLocalAsrModelStatus(modelId);
  const status = (Array.isArray(statusResult) ? statusResult[0] : statusResult) as LocalAsrModelStatus | undefined;
  if (!status || status.state !== "ready" || !status.path) {
    throw new Error(
      `本地 SenseVoiceSmall 模型尚未就绪（当前状态: ${status?.state ?? "未找到"}），请先在设置中下载。`,
    );
  }
  return status.path;
}

function assertAudioBuffer(value: unknown): ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) throw new Error("音频 payload 必须是 ArrayBuffer");
  return value;
}

export function registerSttHandlers(): void {
  setLocalAsrProgressEmitter(broadcastProgress);

  ipcMain.handle("stt:local:listModels", async () => getLocalAsrModelStatus(undefined));
  ipcMain.handle("stt:local:modelStatus", async (_event, modelId: unknown) => getLocalAsrModelStatus(modelId));
  ipcMain.handle("stt:local:downloadModel", async (_event, args: { modelId?: unknown; sourceId?: unknown }) =>
    downloadLocalAsrModel({ modelId: args?.modelId, sourceId: args?.sourceId ?? "huggingface" }));
  ipcMain.handle("stt:local:cancelDownload", async (_event, modelId: unknown) => cancelLocalAsrDownload(modelId));
  ipcMain.handle("stt:local:deleteModel", async (_event, modelId: unknown) => {
    // Windows 不允许删除仍被进程映射的 GGUF；所有平台都先停 sidecar，行为保持一致。
    senseVoiceClient.shutdown();
    return deleteLocalAsrModel(modelId);
  });
  ipcMain.handle("stt:local:checkSources", async (_event, modelId?: unknown) => checkLocalAsrSources(modelId));

  ipcMain.handle("stt:stream:start", async (_event, args: {
    requestId?: unknown;
    modelId?: unknown;
    language?: unknown;
  }): Promise<void> => {
    if (typeof args?.requestId !== "string" || !args.requestId.trim()) throw new Error("requestId 不能为空");
    const modelPath = await readyModelPath(args.modelId);
    await senseVoiceClient.startStream({
      requestId: args.requestId,
      modelPath,
      language: typeof args.language === "string" ? args.language : "auto",
    });
  });
  ipcMain.handle("stt:stream:audio", async (_event, args: { requestId?: unknown; audio?: unknown }): Promise<void> => {
    if (typeof args?.requestId !== "string") throw new Error("requestId 不能为空");
    const audio = assertAudioBuffer(args.audio);
    await senseVoiceClient.appendAudio(args.requestId, Buffer.from(audio));
  });
  ipcMain.handle("stt:stream:finish", async (_event, requestId: unknown): Promise<AsrTranscribeResponse> => {
    if (typeof requestId !== "string") throw new Error("requestId 不能为空");
    return { text: await senseVoiceClient.finishStream(requestId) };
  });
  ipcMain.handle("stt:stream:cancel", async (_event, requestId: unknown): Promise<void> => {
    if (typeof requestId !== "string") return;
    await senseVoiceClient.cancelStream(requestId).catch(() => undefined);
  });

  ipcMain.handle("stt:polish", async (_event, text: unknown): Promise<string> =>
    typeof text === "string" ? polishTranscriptIfEnabled(text) : "");

  ipcMain.handle(
    "stt:transcribe",
    async (_event, req: AsrTranscribeRequest & { asrSettings: AsrSettings }): Promise<AsrTranscribeResponse> => {
      const { asrSettings, ...audioReq } = req;
      const audio = assertAudioBuffer(audioReq.audio);
      if (audio.byteLength > ASR_MAX_BYTES) throw new Error("音频文件超过 25 MB 大小限制");
      const protocol = asrSettings?.protocol;
      if (protocol === "local-sensevoice") {
        const modelPath = await readyModelPath(asrSettings.model);
        const pcm = extractPcm16FromWav(Buffer.from(audio));
        return {
          text: await senseVoiceClient.transcribePcm({
            modelPath,
            language: asrSettings.language || "auto",
            pcm16le: pcm,
          }),
        };
      }
      if (protocol !== "openai-transcriptions" && protocol !== "mimo-asr") {
        throw new Error(`不支持的 ASR 协议: ${String(protocol)}`);
      }
      return transcribeOnline({
        ...audioReq,
        audio,
        baseUrl: asrSettings.baseUrl,
        apiKey: asrSettings.apiKey,
        model: asrSettings.model,
        language: asrSettings.language || undefined,
      });
    },
  );
}

export function shutdownLocalAsrRuntime(): void {
  setLocalAsrProgressEmitter(null);
  senseVoiceClient.shutdown();
}
