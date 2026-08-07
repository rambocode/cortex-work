// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreProvider, usePersonalStore, type DesktopBridge } from "@cortex-work/core";
import {
  type LocalAsrModelProgress,
  type LocalAsrModelStatus,
} from "@cortex-work/core/asr/local-models";
import { defaultAsrSettings } from "@cortex-work/core/desktop/media-gen-types";
import { SttSettingsSection } from "./SttSettingsSection";

type ProgressCb = (progress: LocalAsrModelProgress) => void;

function status(state: LocalAsrModelStatus["state"]): LocalAsrModelStatus {
  return {
    modelId: "sensevoice-small-q8",
    label: "SenseVoiceSmall (Q8)",
    fileName: "sensevoice-small-q8.gguf",
    sha256: "4ae4",
    sizeBytes: 254_208_320,
    maxBytes: 300 * 1024 * 1024,
    resourceEstimate: { memory: "约 500-900 MB", cpuThreads: "4-8" },
    qualityTier: "balanced",
    recommended: true,
    state,
    downloadedBytes: state === "downloading" ? 127_104_160 : undefined,
    totalBytes: state === "downloading" ? 254_208_320 : undefined,
  };
}

function makeBridge(
  state: LocalAsrModelStatus["state"] = "missing",
  overrides: Partial<DesktopBridge> = {},
): Partial<DesktopBridge> & { push: (progress: LocalAsrModelProgress) => void } {
  let progressCb: ProgressCb | null = null;
  return {
    getLocalAsrModelStatus: vi.fn(async () => status(state)),
    downloadLocalAsrModel: vi.fn(async () => ({ ok: true, status: status("ready") })),
    cancelLocalAsrDownload: vi.fn(async () => ({ ok: true, status: status("missing") })),
    deleteLocalAsrModel: vi.fn(async () => ({ ok: true, status: status("missing") })),
    checkLocalAsrSources: vi.fn(async () => ({
      modelId: "sensevoice-small-q8",
      sources: [
        { sourceId: "huggingface", label: "Hugging Face", state: "available", responseTimeMs: 80 },
        { sourceId: "hf-mirror", label: "HF-Mirror", state: "available", responseTimeMs: 60 },
      ],
    })),
    onLocalAsrDownloadProgress: vi.fn((cb: ProgressCb) => {
      progressCb = cb;
      return () => { progressCb = null; };
    }),
    push: (progress) => progressCb?.(progress),
    ...overrides,
  } as Partial<DesktopBridge> & { push: (progress: LocalAsrModelProgress) => void };
}

function renderUI(ui: ReactElement, bridge: Partial<DesktopBridge> | null = null) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge as DesktopBridge | null}>
      {ui}
    </CoreProvider>,
  );
}

beforeEach(() => {
  usePersonalStore.setState({ asrSettings: defaultAsrSettings() });
});
afterEach(cleanup);

describe("SttSettingsSection", () => {
  it("默认禁用并隐藏详细配置", () => {
    renderUI(<SttSettingsSection />);
    expect(screen.queryByText("供应商")).toBeNull();
  });

  it("启用后默认展示本地 SenseVoiceSmall 模型", async () => {
    const bridge = makeBridge();
    usePersonalStore.setState({ asrSettings: { ...defaultAsrSettings(), enabled: true } });
    renderUI(<SttSettingsSection />, bridge);
    expect(screen.getByDisplayValue("本地 SenseVoiceSmall（离线）")).not.toBeNull();
    await waitFor(() => expect(screen.getByText("SenseVoiceSmall (Q8)")).not.toBeNull());
  });

  it("切换自定义 API 时协议回落在线且显示地址/密钥", () => {
    usePersonalStore.setState({ asrSettings: { ...defaultAsrSettings(), enabled: true } });
    renderUI(<SttSettingsSection />, makeBridge());
    fireEvent.change(screen.getByDisplayValue("本地 SenseVoiceSmall（离线）"), {
      target: { value: "custom" },
    });
    expect(usePersonalStore.getState().asrSettings.protocol).toBe("openai-transcriptions");
    expect(screen.getByText("API 地址")).not.toBeNull();
    expect(screen.getByText("API 密钥")).not.toBeNull();
  });

  it("模型 missing 时点击下载调用本地模型桥", async () => {
    const bridge = makeBridge("missing");
    usePersonalStore.setState({ asrSettings: { ...defaultAsrSettings(), enabled: true } });
    renderUI(<SttSettingsSection />, bridge);
    await waitFor(() => expect(screen.getByText("下载")).not.toBeNull());
    fireEvent.click(screen.getByText("下载"));
    await waitFor(() => expect(bridge.downloadLocalAsrModel).toHaveBeenCalledWith({
      modelId: "sensevoice-small-q8",
      sourceId: "huggingface",
    }));
  });

  it("模型 ready 时点击删除调用本地模型桥", async () => {
    const bridge = makeBridge("ready");
    usePersonalStore.setState({ asrSettings: { ...defaultAsrSettings(), enabled: true } });
    renderUI(<SttSettingsSection />, bridge);
    await waitFor(() => expect(screen.getByText("删除")).not.toBeNull());
    fireEvent.click(screen.getByText("删除"));
    await waitFor(() => expect(bridge.deleteLocalAsrModel).toHaveBeenCalledWith("sensevoice-small-q8"));
  });

  it("下载进度推送更新为 50%", async () => {
    const bridge = makeBridge("downloading");
    usePersonalStore.setState({ asrSettings: { ...defaultAsrSettings(), enabled: true } });
    renderUI(<SttSettingsSection />, bridge);
    await waitFor(() => expect(bridge.onLocalAsrDownloadProgress).toHaveBeenCalled());
    await act(async () => {
      bridge.push({
        modelId: "sensevoice-small-q8",
        downloadedBytes: 127_104_160,
        totalBytes: 254_208_320,
        percent: 50,
      });
    });
    expect(screen.getByText(/50%/)).not.toBeNull();
  });

  it("识别语言切换写入 store", () => {
    usePersonalStore.setState({ asrSettings: { ...defaultAsrSettings(), enabled: true } });
    renderUI(<SttSettingsSection />, makeBridge());
    fireEvent.change(screen.getByDisplayValue("自动检测"), { target: { value: "zh" } });
    expect(usePersonalStore.getState().asrSettings.language).toBe("zh");
  });
});
