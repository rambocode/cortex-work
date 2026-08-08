// 本地 ASR 模型下载状态订阅 hook。
// 与 useUpdateState 同模式：先订阅 onLocalAsrDownloadProgress 推送，
// 再补拉当前状态；pushed 标志防止晚到的补拉覆盖已到的推送。
//
// KTD5：进度走 bridge 回调，不进 Zustand。
// 使用场景：U6 模型管理 UI、下载进度条。

import { useEffect, useState } from "react";
import { useDesktopBridge } from "../provider";
import type { LocalAsrModelProgress } from "../asr/local-models";

/**
 * 进度的通用形状：SenseVoice 与流式 Zipformer 只在 modelId 取值域上不同。
 * fileName 仅流式模型有（它要下四个文件），SenseVoice 单文件时为 undefined。
 */
export type ModelDownloadProgressView = Omit<LocalAsrModelProgress, "modelId"> & {
  modelId: string;
  fileName?: string;
};

export type ModelDownloadState =
  | { status: "idle" }
  | { status: "downloading"; progress: ModelDownloadProgressView }
  | { status: "done" };

/**
 * 两条本地 ASR 模型通道：SenseVoice 走 stt:local:*，流式 Zipformer 走 stt:streaming:*。
 * 模型 id 取值域不同，订阅错通道会永远收不到进度，故由调用方显式指定。
 */
export type ModelDownloadChannel = "sensevoice" | "streaming";

/**
 * 订阅指定 modelId 的下载进度推送。
 * bridge 不可用（web 端）时返回 idle。
 *
 * @param modelId 要监听的模型 ID；undefined 表示监听任意模型
 * @param channel 模型通道，默认 sensevoice（保持既有调用方行为不变）
 */
export function useModelDownloadState(
  modelId?: string,
  channel: ModelDownloadChannel = "sensevoice",
): ModelDownloadState {
  const bridge = useDesktopBridge();
  const [state, setState] = useState<ModelDownloadState>({ status: "idle" });

  useEffect(() => {
    const streaming = channel === "streaming";
    const subscribe = streaming
      ? bridge?.onStreamingAsrDownloadProgress
      : bridge?.onLocalAsrDownloadProgress;
    if (!bridge || !subscribe) return;
    let alive = true;
    // 补拉的 Promise 可能晚于推送事件 resolve，pushed flag 防止旧状态覆盖已推送的新进度
    let pushed = false;

    const onProgress = (progress: ModelDownloadProgressView): void => {
      if (!alive) return;
      // 若指定了 modelId，则只响应对应模型的进度
      if (modelId && progress.modelId !== modelId) return;
      pushed = true;
      if (progress.percent !== undefined && progress.percent >= 100) {
        setState({ status: "done" });
      } else {
        setState({ status: "downloading", progress });
      }
    };
    // 分支写死而非取函数并集：两侧签名的 modelId 字面量类型互不兼容，联合后无法调用。
    const off = streaming
      ? bridge.onStreamingAsrDownloadProgress!(onProgress)
      : bridge.onLocalAsrDownloadProgress!(onProgress);

    // 补拉：挂载时检查一次当前状态
    const fetchStatus = streaming
      ? bridge.getStreamingAsrModelStatus
      : bridge.getLocalAsrModelStatus;
    if (fetchStatus && modelId) {
      (fetchStatus as (id: string) => Promise<{
        modelId: string;
        state: string;
        downloadedBytes?: number;
        totalBytes?: number;
        speedBytesPerSecond?: number;
      }>)
        .call(bridge, modelId)
        .then((s) => {
          if (!alive) return;
          // pushed flag：推送事件已到，补拉结果可能是旧快照，跳过以防止进度倒退
          if (pushed) return;
          if (s.state === "downloading") {
            setState({
              status: "downloading",
              progress: {
                modelId: s.modelId,
                downloadedBytes: s.downloadedBytes ?? 0,
                totalBytes: s.totalBytes,
                speedBytesPerSecond: s.speedBytesPerSecond,
              },
            });
          } else if (s.state === "ready") {
            setState({ status: "done" });
          }
        })
        .catch(() => {});
    }

    return () => {
      alive = false;
      off();
    };
  }, [bridge, modelId, channel]);

  return state;
}
