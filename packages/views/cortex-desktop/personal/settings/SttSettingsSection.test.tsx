// SttSettingsSection + SttLocalWhisperPanel 单测。
// 覆盖：供应商切换 / 模型四态按钮 / 健康检查展示 / 进度更新 / 语言默认值。

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type {
  LocalWhisperModelStatus,
  LocalWhisperModelProgress,
  LocalWhisperSourceStatus,
} from "@cortex-work/core/whisper/models";
import { defaultAsrSettings } from "@cortex-work/core/desktop/media-gen-types";

import { SttSettingsSection } from "./SttSettingsSection";

// ── 渲染辅助 ─────────────────────────────────────────────────────────────────

function renderUI(ui: ReactElement, bridge: Partial<DesktopBridge> | null = null) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge as DesktopBridge | null}>
      {ui}
    </CoreProvider>,
  );
}

function resetAsr() {
  usePersonalStore.setState({ asrSettings: defaultAsrSettings() });
}

// ── bridge mock 工厂 ──────────────────────────────────────────────────────────

type ProgressCb = (p: LocalWhisperModelProgress) => void;

function makeBridge(overrides: Partial<DesktopBridge> = {}): Partial<DesktopBridge> {
  // 进度订阅回调收集器（测试用于触发 push）
  let progressCb: ProgressCb | null = null;

  return {
    listWhisperModels: vi.fn(async (): Promise<LocalWhisperModelStatus[]> => []),
    getWhisperModelStatus: vi.fn(async (modelId: string): Promise<LocalWhisperModelStatus> => ({
      modelId: modelId as LocalWhisperModelStatus["modelId"],
      label: modelId,
      fileName: `${modelId}.bin`,
      sha256: "abc",
      sizeBytes: 1000,
      maxBytes: 2000,
      resourceEstimate: { memory: "100 MB", cpuThreads: "1" },
      qualityTier: "basic",
      recommended: false,
      state: "missing",
    })),
    downloadWhisperModel: vi.fn(async () => ({
      ok: true,
      status: undefined,
    })),
    cancelWhisperDownload: vi.fn(async () => ({ ok: true, status: undefined })),
    deleteWhisperModel: vi.fn(async () => ({ ok: true, status: undefined })),
    checkWhisperSources: vi.fn(async () => ({
      modelId: "whisper-small-q5_1" as LocalWhisperModelStatus["modelId"],
      sources: [
        { sourceId: "huggingface", label: "Hugging Face", state: "available", responseTimeMs: 120 } as LocalWhisperSourceStatus,
        { sourceId: "hf-mirror", label: "HF-Mirror", state: "available", responseTimeMs: 80 } as LocalWhisperSourceStatus,
        { sourceId: "hf-sufy", label: "HF CDN (Sufy)", state: "unavailable", message: "timeout" } as LocalWhisperSourceStatus,
      ],
    })),
    onWhisperDownloadProgress: vi.fn((cb: ProgressCb) => {
      progressCb = cb;
      return () => { progressCb = null; };
    }),
    // 暴露 pushProgress 给测试用于触发 push 事件
    __pushProgress: (p: LocalWhisperModelProgress) => {
      progressCb?.(p);
    },
    ...overrides,
  } as Partial<DesktopBridge> & { __pushProgress: (p: LocalWhisperModelProgress) => void };
}

// ── 测试套件 ──────────────────────────────────────────────────────────────────

describe("SttSettingsSection — 总开关与供应商切换", () => {
  beforeEach(resetAsr);

  it("默认关闭时隐藏详细配置", () => {
    renderUI(<SttSettingsSection />);
    expect(screen.queryByText("供应商")).toBeNull();
  });

  it("打开总开关后显示供应商区", () => {
    renderUI(<SttSettingsSection />);
    fireEvent.click(screen.getByRole("switch", { name: "启用语音转文字" }));
    expect(usePersonalStore.getState().asrSettings.enabled).toBe(true);
    expect(screen.getByText("供应商")).toBeInTheDocument();
  });

  it("默认 protocol=openai-transcriptions 显示自定义 API 表单", () => {
    usePersonalStore.setState({
      asrSettings: { ...defaultAsrSettings(), enabled: true, providerId: "custom" },
    });
    renderUI(<SttSettingsSection />);
    expect(screen.getByText("API 地址")).toBeInTheDocument();
    expect(screen.getByText("API 密钥")).toBeInTheDocument();
  });

  it("切换到本地 Whisper 时显示 Whisper 面板（需 bridge）", async () => {
    const bridge = makeBridge();
    usePersonalStore.setState({
      asrSettings: { ...defaultAsrSettings(), enabled: true },
    });
    renderUI(<SttSettingsSection />, bridge);

    // 在供应商下拉中选择本地 Whisper
    const select = screen.getByDisplayValue("自定义 API");
    fireEvent.change(select, { target: { value: "__local__" } });

    expect(usePersonalStore.getState().asrSettings.protocol).toBe("local-whisper");
    // 等待面板出现（健康检查异步）
    await waitFor(() => expect(screen.getByText("下载源")).toBeInTheDocument());
  });

  it("切换到自定义 API 时显示协议/baseUrl/密钥", () => {
    usePersonalStore.setState({
      asrSettings: { ...defaultAsrSettings(), enabled: true, providerId: "custom" },
    });
    renderUI(<SttSettingsSection />);
    expect(screen.getByText("协议")).toBeInTheDocument();
    expect(screen.getByText("API 密钥")).toBeInTheDocument();
  });

  it("识别语言默认 auto", () => {
    usePersonalStore.setState({
      asrSettings: { ...defaultAsrSettings(), enabled: true },
    });
    renderUI(<SttSettingsSection />);
    // 默认显示「自动检测」
    const langSelect = screen.getByDisplayValue("自动检测");
    expect(langSelect).toBeInTheDocument();
  });

  it("识别语言切换写 asrSettings.language", () => {
    usePersonalStore.setState({
      asrSettings: { ...defaultAsrSettings(), enabled: true },
    });
    renderUI(<SttSettingsSection />);
    const langSelect = screen.getByDisplayValue("自动检测");
    fireEvent.change(langSelect, { target: { value: "zh" } });
    expect(usePersonalStore.getState().asrSettings.language).toBe("zh");
  });
});

describe("SttLocalWhisperPanel — 健康检查", () => {
  beforeEach(resetAsr);

  it("挂载时调 checkWhisperSources 并展示各源状态", async () => {
    const bridge = makeBridge();
    usePersonalStore.setState({
      asrSettings: { ...defaultAsrSettings(), enabled: true, protocol: "local-whisper" },
    });
    renderUI(<SttSettingsSection />, bridge);

    await waitFor(() => {
      expect(bridge.checkWhisperSources).toHaveBeenCalled();
      // 可用源展示「可用」文字
      expect(screen.getByText(/Hugging Face.*可用/)).toBeInTheDocument();
    });
  });

  it("不可达源展示错误信息", async () => {
    const bridge = makeBridge();
    usePersonalStore.setState({
      asrSettings: { ...defaultAsrSettings(), enabled: true, protocol: "local-whisper" },
    });
    renderUI(<SttSettingsSection />, bridge);

    await waitFor(() => {
      expect(screen.getByText(/HF CDN.*不可用/)).toBeInTheDocument();
    });
  });

  it("所有源不可用时显示重试健康检查按钮", async () => {
    const bridge = makeBridge({
      checkWhisperSources: vi.fn(async () => ({
        modelId: "whisper-small-q5_1" as LocalWhisperModelStatus["modelId"],
        sources: [
          { sourceId: "huggingface", label: "Hugging Face", state: "unavailable", message: "timeout" } as LocalWhisperSourceStatus,
          { sourceId: "hf-mirror", label: "HF-Mirror", state: "unavailable", message: "timeout" } as LocalWhisperSourceStatus,
          { sourceId: "hf-sufy", label: "HF CDN (Sufy)", state: "unavailable", message: "timeout" } as LocalWhisperSourceStatus,
        ],
      })),
    });
    usePersonalStore.setState({
      asrSettings: { ...defaultAsrSettings(), enabled: true, protocol: "local-whisper" },
    });
    renderUI(<SttSettingsSection />, bridge);

    await waitFor(() => {
      expect(screen.getByText("重试健康检查")).toBeInTheDocument();
    });
  });

  it("重试健康检查按钮点击后重新调用 checkWhisperSources", async () => {
    const checkFn = vi.fn(async () => ({
      modelId: "whisper-small-q5_1" as LocalWhisperModelStatus["modelId"],
      sources: [
        { sourceId: "huggingface", label: "Hugging Face", state: "unavailable", message: "err" } as LocalWhisperSourceStatus,
        { sourceId: "hf-mirror", label: "HF-Mirror", state: "unavailable", message: "err" } as LocalWhisperSourceStatus,
        { sourceId: "hf-sufy", label: "HF CDN (Sufy)", state: "unavailable", message: "err" } as LocalWhisperSourceStatus,
      ],
    }));
    const bridge = makeBridge({ checkWhisperSources: checkFn });
    usePersonalStore.setState({
      asrSettings: { ...defaultAsrSettings(), enabled: true, protocol: "local-whisper" },
    });
    renderUI(<SttSettingsSection />, bridge);

    await waitFor(() => expect(screen.getByText("重试健康检查")).toBeInTheDocument());
    fireEvent.click(screen.getByText("重试健康检查"));
    await waitFor(() => expect(checkFn).toHaveBeenCalledTimes(2));
  });
});

describe("SttLocalWhisperPanel — 模型卡片四态", () => {
  beforeEach(resetAsr);

  // 辅助：设置 listWhisperModels 返回特定状态
  function bridgeWithModelState(
    modelId: string,
    state: LocalWhisperModelStatus["state"],
    extra: Partial<LocalWhisperModelStatus> = {},
  ) {
    const status: LocalWhisperModelStatus = {
      modelId: modelId as LocalWhisperModelStatus["modelId"],
      label: "Test Model",
      fileName: "test.bin",
      sha256: "abc",
      sizeBytes: 100_000_000,
      maxBytes: 200_000_000,
      resourceEstimate: { memory: "300-600 MB", cpuThreads: "2-4" },
      qualityTier: "balanced",
      recommended: false,
      state,
      ...extra,
    };
    return makeBridge({
      listWhisperModels: vi.fn(async () => [status]),
      getWhisperModelStatus: vi.fn(async () => status),
    });
  }

  it("missing 态：显示下载按钮", async () => {
    const bridge = bridgeWithModelState("whisper-small-q5_1", "missing");
    usePersonalStore.setState({
      asrSettings: { ...defaultAsrSettings(), enabled: true, protocol: "local-whisper", model: "whisper-small-q5_1" },
    });
    renderUI(<SttSettingsSection />, bridge);

    // 等待模型列表加载
    await waitFor(() => expect(screen.getAllByText("下载").length).toBeGreaterThan(0));
    // 不应有删除按钮
    expect(screen.queryByText("删除")).toBeNull();
  });

  it("ready 态：显示删除按钮", async () => {
    const bridge = bridgeWithModelState("whisper-small-q5_1", "ready");
    usePersonalStore.setState({
      asrSettings: { ...defaultAsrSettings(), enabled: true, protocol: "local-whisper", model: "whisper-small-q5_1" },
    });
    renderUI(<SttSettingsSection />, bridge);

    // 3 个模型都会有删除按钮（因为 mock getWhisperModelStatus 对所有 id 返回 ready）
    await waitFor(() => expect(screen.getAllByText("删除").length).toBeGreaterThan(0));
    // 已下载徽标可见
    expect(screen.getAllByText("已下载").length).toBeGreaterThan(0);
  });

  it("downloading 态：显示取消按钮", async () => {
    const bridge = bridgeWithModelState("whisper-small-q5_1", "downloading", {
      downloadedBytes: 50_000_000,
      totalBytes: 100_000_000,
    });
    usePersonalStore.setState({
      asrSettings: { ...defaultAsrSettings(), enabled: true, protocol: "local-whisper", model: "whisper-small-q5_1" },
    });
    renderUI(<SttSettingsSection />, bridge);

    // 3 个模型都返回 downloading（mock 对所有 id 返回相同状态），故用 getAllByText
    await waitFor(() => expect(screen.getAllByText("取消下载").length).toBeGreaterThan(0));
  });

  it("error 态：显示失败文案和重试按钮", async () => {
    const bridge = bridgeWithModelState("whisper-small-q5_1", "error", {
      error: "network error",
    });
    usePersonalStore.setState({
      asrSettings: { ...defaultAsrSettings(), enabled: true, protocol: "local-whisper", model: "whisper-small-q5_1" },
    });
    renderUI(<SttSettingsSection />, bridge);

    await waitFor(() => {
      expect(screen.getByText("重试下载")).toBeInTheDocument();
    });
  });

  it("点下载按钮调 downloadWhisperModel", async () => {
    const bridge = bridgeWithModelState("whisper-small-q5_1", "missing");
    usePersonalStore.setState({
      asrSettings: { ...defaultAsrSettings(), enabled: true, protocol: "local-whisper", model: "whisper-small-q5_1" },
    });
    renderUI(<SttSettingsSection />, bridge);

    await waitFor(() => expect(screen.getAllByText("下载").length).toBeGreaterThan(0));
    // 点选中模型的下载按钮（第一个下载按钮）
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    fireEvent.click(screen.getAllByText("下载")[0]!);
    await waitFor(() => expect(bridge.downloadWhisperModel).toHaveBeenCalled());
  });

  it("点删除按钮调 deleteWhisperModel", async () => {
    const bridge = bridgeWithModelState("whisper-small-q5_1", "ready");
    usePersonalStore.setState({
      asrSettings: { ...defaultAsrSettings(), enabled: true, protocol: "local-whisper", model: "whisper-small-q5_1" },
    });
    renderUI(<SttSettingsSection />, bridge);

    await waitFor(() => expect(screen.getAllByText("删除").length).toBeGreaterThan(0));
    // 点第一个删除按钮（即 whisper-base 的删除，因为 mock 对所有模型返回 ready）
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    fireEvent.click(screen.getAllByText("删除")[0]!);
    await waitFor(() => expect(bridge.deleteWhisperModel).toHaveBeenCalled());
  });
});

describe("SttLocalWhisperPanel — 进度推送", () => {
  beforeEach(resetAsr);

  it("push 进度到达后更新显示（下载中 50%）", async () => {
    // 收集所有 onWhisperDownloadProgress 订阅者（3 个 ModelCard 各注册一个）
    const progressCbs: ((p: LocalWhisperModelProgress) => void)[] = [];

    const bridge = makeBridge({
      listWhisperModels: vi.fn(async (): Promise<LocalWhisperModelStatus[]> => []),
      onWhisperDownloadProgress: vi.fn((cb: (p: LocalWhisperModelProgress) => void) => {
        progressCbs.push(cb);
        return () => { progressCbs.splice(progressCbs.indexOf(cb), 1); };
      }),
    });

    usePersonalStore.setState({
      asrSettings: { ...defaultAsrSettings(), enabled: true, protocol: "local-whisper", model: "whisper-small-q5_1" },
    });
    renderUI(<SttSettingsSection />, bridge as unknown as Partial<DesktopBridge>);

    // 等待面板挂载（3 个 ModelCard 各注册一个订阅）
    await waitFor(() => expect(progressCbs.length).toBeGreaterThan(0));

    const progress: LocalWhisperModelProgress = {
      modelId: "whisper-small-q5_1",
      downloadedBytes: 50_000_000,
      totalBytes: 100_000_000,
      percent: 50,
      speedBytesPerSecond: 1_000_000,
    };

    // 向所有订阅者推送进度（模拟真实 bridge 行为）
    await act(async () => {
      for (const cb of [...progressCbs]) cb(progress);
    });

    await waitFor(() => {
      // 进度 50% 应在 UI 中可见（进度条标签）
      expect(screen.getAllByText(/50%/).length).toBeGreaterThan(0);
    });
  });
});
