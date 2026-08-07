// @vitest-environment jsdom
// useModelDownloadState 单测
// 覆盖：进度回调、百分比 >= 100 终态、modelId 过滤、pushed flag 防竞态、无订阅时 idle 初始态。
// 使用 jsdom 环境（renderHook 依赖 DOM）；core 包默认 node 环境，用 docblock 覆盖。

import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import type { LocalAsrModelProgress, LocalAsrModelId } from "../asr/local-models";
import { useModelDownloadState } from "./useModelDownloadState";
import { CoreProvider } from "../provider";
import React from "react";

// 构造最小 mock bridge
function makeBridge(opts: {
  onLocalAsrDownloadProgress?: DesktopBridge["onLocalAsrDownloadProgress"];
  getLocalAsrModelStatus?: DesktopBridge["getLocalAsrModelStatus"];
}): DesktopBridge {
  return {
    loadChat: async () => [],
    saveChat: async () => {},
    ...opts,
  } as unknown as DesktopBridge;
}

const MODEL_ID = "sensevoice-small-q8" as LocalAsrModelId;

function makeProgress(
  modelId: LocalAsrModelId,
  downloadedBytes: number,
  totalBytes: number,
  percent?: number,
): LocalAsrModelProgress {
  return { modelId, downloadedBytes, totalBytes, percent };
}

// wrapper：注入 bridge
function makeWrapper(bridge: DesktopBridge | null) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      CoreProvider,
      { wsId: "w", identity: { userId: "u", name: "n" }, desktopBridge: bridge, children },
    );
  };
}

describe("useModelDownloadState", () => {
  it("进度回调 → state 变为 downloading，percent 正确", () => {
    let capturedCb: ((p: LocalAsrModelProgress) => void) | undefined;
    const bridge = makeBridge({
      onLocalAsrDownloadProgress: (cb) => {
        capturedCb = cb;
        return () => {};
      },
    });

    const { result } = renderHook(() => useModelDownloadState(MODEL_ID), {
      wrapper: makeWrapper(bridge),
    });

    expect(result.current.status).toBe("idle");

    act(() => {
      capturedCb?.(makeProgress(MODEL_ID, 50_000_000, 190_085_487, 26));
    });

    expect(result.current.status).toBe("downloading");
    if (result.current.status === "downloading") {
      expect(result.current.progress.downloadedBytes).toBe(50_000_000);
      expect(result.current.progress.percent).toBe(26);
    }
  });

  it("percent >= 100 → state 变为 done", () => {
    let capturedCb: ((p: LocalAsrModelProgress) => void) | undefined;
    const bridge = makeBridge({
      onLocalAsrDownloadProgress: (cb) => {
        capturedCb = cb;
        return () => {};
      },
    });

    const { result } = renderHook(() => useModelDownloadState(MODEL_ID), {
      wrapper: makeWrapper(bridge),
    });

    act(() => {
      capturedCb?.(makeProgress(MODEL_ID, 190_085_487, 190_085_487, 100));
    });

    expect(result.current.status).toBe("done");
  });

  it("modelId 不匹配 → 进度事件被忽略，状态保持 idle", () => {
    let capturedCb: ((p: LocalAsrModelProgress) => void) | undefined;
    const bridge = makeBridge({
      onLocalAsrDownloadProgress: (cb) => {
        capturedCb = cb;
        return () => {};
      },
    });

    const { result } = renderHook(() => useModelDownloadState(MODEL_ID), {
      wrapper: makeWrapper(bridge),
    });

    act(() => {
      // 发送不同 modelId 的进度事件
      capturedCb?.(makeProgress("different-model" as LocalAsrModelId, 10_000, 59_707_625, 0));
    });

    expect(result.current.status).toBe("idle");
  });

  it("pushed flag：推送事件已到，晚到的 getWhisperModelStatus resolve 不覆盖已推送的更新进度", async () => {
    let capturedCb: ((p: LocalAsrModelProgress) => void) | undefined;
    // 模拟延迟 resolve 的快照（返回 50%，但推送已到 80%）
    let resolveStatus!: (v: Awaited<ReturnType<NonNullable<DesktopBridge["getLocalAsrModelStatus"]>>>) => void;
    const statusPromise = new Promise<Awaited<ReturnType<NonNullable<DesktopBridge["getLocalAsrModelStatus"]>>>>((res) => {
      resolveStatus = res;
    });

    const bridge = makeBridge({
      onLocalAsrDownloadProgress: (cb) => {
        capturedCb = cb;
        return () => {};
      },
      getLocalAsrModelStatus: () => statusPromise as ReturnType<NonNullable<DesktopBridge["getLocalAsrModelStatus"]>>,
    });

    const { result } = renderHook(() => useModelDownloadState(MODEL_ID), {
      wrapper: makeWrapper(bridge),
    });

    // 先触发推送事件（80%）
    act(() => {
      capturedCb?.(makeProgress(MODEL_ID, 152_000_000, 190_085_487, 80));
    });

    expect(result.current.status).toBe("downloading");
    if (result.current.status === "downloading") {
      expect(result.current.progress.downloadedBytes).toBe(152_000_000);
    }

    // 再 resolve 补拉（旧快照，50%）——应被 pushed flag 拦截
    await act(async () => {
      resolveStatus({
        modelId: MODEL_ID,
        label: "SenseVoiceSmall",
        fileName: "sensevoice-small-q8.gguf",
        sha256: "4ae4",
        sizeBytes: 254_208_320,
        maxBytes: 300 * 1024 * 1024,
        resourceEstimate: { memory: "约 500-900 MB", cpuThreads: "4-8" },
        qualityTier: "balanced",
        recommended: true,
        state: "downloading",
        downloadedBytes: 95_000_000, // 旧值 50%
        totalBytes: 190_085_487,
      });
    });

    // 状态应仍为 80% 的推送结果（152M），不被旧快照覆盖
    expect(result.current.status).toBe("downloading");
    if (result.current.status === "downloading") {
      expect(result.current.progress.downloadedBytes).toBe(152_000_000);
    }
  });

  it("bridge 无 onLocalAsrDownloadProgress → 返回 idle 初始态", () => {
    // bridge 没有订阅方法
    const bridge = makeBridge({});

    const { result } = renderHook(() => useModelDownloadState(MODEL_ID), {
      wrapper: makeWrapper(bridge),
    });

    expect(result.current.status).toBe("idle");
  });
});
