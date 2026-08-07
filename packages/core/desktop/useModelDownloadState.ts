// 本地 ASR 模型下载状态订阅 hook。
// 与 useUpdateState 同模式：先订阅 onLocalAsrDownloadProgress 推送，
// 再补拉当前状态；pushed 标志防止晚到的补拉覆盖已到的推送。
//
// KTD5：进度走 bridge 回调，不进 Zustand。
// 使用场景：U6 模型管理 UI、下载进度条。

import { useEffect, useState } from "react";
import { useDesktopBridge } from "../provider";
import type { LocalAsrModelProgress } from "../asr/local-models";

export type ModelDownloadState =
  | { status: "idle" }
  | { status: "downloading"; progress: LocalAsrModelProgress }
  | { status: "done" };

/**
 * 订阅指定 modelId 的下载进度推送。
 * bridge 不可用（web 端）时返回 idle。
 *
 * @param modelId 要监听的模型 ID；undefined 表示监听任意模型
 */
export function useModelDownloadState(
  modelId?: string,
): ModelDownloadState {
  const bridge = useDesktopBridge();
  const [state, setState] = useState<ModelDownloadState>({ status: "idle" });

  useEffect(() => {
    if (!bridge?.onLocalAsrDownloadProgress) return;
    let alive = true;
    // 补拉的 Promise 可能晚于推送事件 resolve，pushed flag 防止旧状态覆盖已推送的新进度
    let pushed = false;

    const off = bridge.onLocalAsrDownloadProgress((progress) => {
      if (!alive) return;
      // 若指定了 modelId，则只响应对应模型的进度
      if (modelId && progress.modelId !== modelId) return;
      pushed = true;
      if (progress.percent !== undefined && progress.percent >= 100) {
        setState({ status: "done" });
      } else {
        setState({ status: "downloading", progress });
      }
    });

    // 补拉：若 getLocalAsrModelStatus 可用，则挂载时检查一次当前状态
    if (bridge.getLocalAsrModelStatus && modelId) {
      bridge
        .getLocalAsrModelStatus(modelId)
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
  }, [bridge, modelId]);

  return state;
}
