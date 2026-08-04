// STT（语音转文字）IPC handler。
// 注册 stt:* IPC 通道，连接主进程 Whisper 模型管理实现与渲染端 bridge。
//
// IPC 通道清单（供 U6 UI / U8 转写复用）：
//   stt:listModels      → LocalWhisperModelStatus[]
//   stt:modelStatus     → LocalWhisperModelStatus（单个）
//   stt:downloadModel   → WhisperDownloadResult（下载，互斥）
//   stt:cancelDownload  → WhisperDownloadResult（幂等）
//   stt:deleteModel     → WhisperDownloadResult
//   stt:checkSources    → LocalWhisperSourcesResult
//   stt:transcribe      → AsrTranscribeResponse（U8 新增：按 AsrSettings.protocol 分发）
//
// 进度推送通道（主进程 → 渲染端，单向推送）：
//   stt:downloadProgress  payload: LocalWhisperModelProgress
//
// KTD5：进度经 webContents.send 推送，不写 Zustand；
//       渲染端 bridge.onWhisperDownloadProgress 订阅 + 挂载补拉（useModelDownloadState.ts）。

import { ipcMain, BrowserWindow } from "electron";
import {
  getModelStatus,
  downloadModel,
  cancelDownload,
  deleteModel,
  checkSources,
  setWhisperProgressEmitter,
} from "../capabilities/whisper/models";
import { transcribeLocal } from "../capabilities/whisper/transcribe";
import { transcribeOnline, ASR_MAX_BYTES } from "../capabilities/whisper/online-transcribe";
import { isLocalWhisperModelId } from "@cortex-work/core/whisper/models";
import type { LocalWhisperModelProgress } from "@cortex-work/core/whisper/models";
import type { AsrTranscribeRequest, AsrTranscribeResponse, AsrSettings } from "./types";

/** 向所有未销毁窗口广播下载进度。*/
function broadcastProgress(progress: LocalWhisperModelProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("stt:downloadProgress", progress);
    }
  }
}

export function registerSttHandlers(): void {
  // 注入进度推送 emitter（模块加载即绑定）
  setWhisperProgressEmitter(broadcastProgress);

  // 列出所有模型状态
  ipcMain.handle("stt:listModels", async () => {
    return getModelStatus(undefined);
  });

  // 单个模型状态（需提供 modelId）
  ipcMain.handle("stt:modelStatus", async (_e, modelId: unknown) => {
    return getModelStatus(modelId);
  });

  // 下载模型（互斥，进度通过 stt:downloadProgress 广播）
  ipcMain.handle(
    "stt:downloadModel",
    async (_e, args: { modelId: unknown; sourceId?: unknown }) => {
      return downloadModel({
        modelId: args?.modelId,
        sourceId: args?.sourceId ?? "huggingface",
      });
    },
  );

  // 取消正在进行的下载（幂等）
  ipcMain.handle("stt:cancelDownload", async (_e, modelId: unknown) => {
    return cancelDownload(modelId);
  });

  // 删除已下载模型文件
  ipcMain.handle("stt:deleteModel", async (_e, modelId: unknown) => {
    return deleteModel(modelId);
  });

  // 检测下载源可达性
  ipcMain.handle("stt:checkSources", async (_e, modelId?: unknown) => {
    return checkSources(modelId);
  });

  // ── U8：统一转写入口（按 AsrSettings.protocol 分发） ───────────────────────
  // 调用方（U9 ComposerShell）传入完整的 asrSettings，由此 handler 路由到：
  //   local-whisper          → transcribeLocal（spawn whisper-cli）
  //   openai-transcriptions  → transcribeOnline（OpenAI 兼容 API）
  //   mimo-asr               → transcribeOnline（MIMO ASR，同 OpenAI 兼容接口形状）
  //
  // MAX_BYTES 在入口统一检查，两条路径均不重复判断。
  ipcMain.handle(
    "stt:transcribe",
    async (
      _e,
      req: AsrTranscribeRequest & { asrSettings: AsrSettings },
    ): Promise<AsrTranscribeResponse> => {
      const { asrSettings, ...audioReq } = req;

      // ── 统一 MAX_BYTES 检查 ─────────────────────────────────────────────────
      if (audioReq.audio.byteLength > ASR_MAX_BYTES) {
        throw new Error(
          `音频文件超过大小限制（${Math.round(audioReq.audio.byteLength / 1024 / 1024)} MB > ${Math.round(ASR_MAX_BYTES / 1024 / 1024)} MB）`,
        );
      }

      const protocol = asrSettings?.protocol ?? "openai-transcriptions";

      if (protocol === "local-whisper") {
        // ── 本地 whisper-cli 路径 ─────────────────────────────────────────────
        // 取模型的磁盘路径：modelId 从 asrSettings.model 读取，经 getModelStatus 查 ready 状态。
        const modelId = asrSettings.model;

        // 白名单校验：getModelStatus 对非白名单 modelId 会抛异常（而非返回 undefined），
        // 先做前置判断，转为用户友好的错误信息，避免 IPC 层收到通用异常。
        if (!isLocalWhisperModelId(modelId)) {
          throw new Error(
            `请先在设置中选择有效的本地模型（当前值: ${String(modelId)}）。`,
          );
        }

        const statusResult = await getModelStatus(modelId);
        // getModelStatus(modelId) 返回单个状态或 undefined
        const status = Array.isArray(statusResult) ? statusResult[0] : statusResult;
        if (!status || status.state !== "ready" || !status.path) {
          throw new Error(
            `本地 Whisper 模型「${modelId}」尚未就绪（当前状态: ${status?.state ?? "未找到"}）。` +
            `请先在设置中下载该模型。`,
          );
        }
        const result = await transcribeLocal({
          audio: audioReq.audio,
          mimeType: audioReq.mimeType,
          language: asrSettings.language ?? "",
          // prompt 由听写词典等 renderer 输入携带；主进程只透传，不在此处拼接或持久化口述内容。
          prompt: audioReq.prompt,
          modelPath: status.path,
        });
        return { text: result.text };
      }

      // ── 在线路径（openai-transcriptions / mimo-asr） ──────────────────────
      // asrSettings 提供 baseUrl / apiKey / model / language；
      // audioReq 提供 audio / mimeType / fileName。
      return transcribeOnline({
        ...audioReq,
        baseUrl: asrSettings.baseUrl,
        apiKey: asrSettings.apiKey,
        model: asrSettings.model,
        language: asrSettings.language || undefined,
      });
    },
  );
}
