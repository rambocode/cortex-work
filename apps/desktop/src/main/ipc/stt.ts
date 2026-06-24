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
import type { LocalWhisperModelProgress } from "@cortex-work/core/whisper/models";

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
}
