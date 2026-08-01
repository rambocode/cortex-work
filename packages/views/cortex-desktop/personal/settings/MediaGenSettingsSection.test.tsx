// 媒体生成设置分区测试（拆分为 media-gen/ 子目录后的壳 + 四卡集成回归）。
//
// 数据源已从旧 providerSettings.providers 切换到 core 的 MEDIA_PROVIDER_DIRECTORY，
// 认证态经 useProviderAuth 取主进程快照——测试用假 desktopBridge 注入
// providerAuthStatus / providerAuthSetSecrets（与 ProviderManager.test.tsx 同款做法）。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type {
  ImageGenSettings,
  VideoGenSettings,
} from "@cortex-work/core/desktop/types";
import type { ProviderAuthStatus } from "@cortex-work/core/desktop/provider-catalog";

import { MediaGenSettingsSection } from "./MediaGenSettingsSection";

// ── 辅助 ────────────────────────────────────────────────────────────────────

function makeBridge(o: { statuses?: ProviderAuthStatus[]; storageAvailable?: boolean } = {}): DesktopBridge {
  return {
    providerAuthStatus: vi.fn(async () => ({
      statuses: o.statuses ?? [],
      health: o.storageAvailable === false ? { available: false, reason: "safeStorage 缺失" } : { available: true },
      hiddenProviderIds: [],
    })),
    providerAuthSetSecrets: vi.fn(async () => ({ ok: true })),
  } as unknown as DesktopBridge;
}

function renderUI(ui: ReactElement, bridge: DesktopBridge | null = makeBridge()) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      {ui}
    </CoreProvider>,
  );
}

function setImageState(patch: Partial<ImageGenSettings>) {
  usePersonalStore.setState((s) => ({
    mediaGenSettings: {
      ...s.mediaGenSettings,
      image: { ...s.mediaGenSettings.image, ...patch },
    },
  }));
}

function setVideoState(patch: Partial<VideoGenSettings>) {
  usePersonalStore.setState((s) => ({
    mediaGenSettings: {
      ...s.mediaGenSettings,
      video: { ...s.mediaGenSettings.video, ...patch },
    },
  }));
}

/** 找到「包含指定 option 文本」的 select（页面上 combobox 很多，按内容定位）。*/
function selectWithOption(optionText: string): HTMLSelectElement {
  const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
  const found = selects.find((sel) =>
    Array.from(sel.querySelectorAll("option")).some((opt) => opt.textContent === optionText),
  );
  if (!found) throw new Error(`select containing option "${optionText}" not found`);
  return found;
}

/** 切到指定模态 tab（壳改为 Kun 式四 tab 分页后，非激活模态卡不渲染）。*/
function switchTab(label: string) {
  fireEvent.click(screen.getByRole("tab", { name: label }));
}

// ── 测试套件 ────────────────────────────────────────────────────────────────

describe("MediaGenSettingsSection（拆分后）", () => {
  beforeEach(() => {
    usePersonalStore.setState((s) => ({
      mediaGenSettings: {
        image: { ...s.mediaGenSettings.image, enabled: false, providerId: "", apiKey: "", baseUrl: "", model: "", protocol: "openai-images", defaultResolution: "1K", defaultSize: "" },
        speech: { ...s.mediaGenSettings.speech, enabled: false, providerId: "", apiKey: "", baseUrl: "" },
        music: { ...s.mediaGenSettings.music, enabled: false, providerId: "", apiKey: "", baseUrl: "" },
        video: { ...s.mediaGenSettings.video, enabled: false, providerId: "", apiKey: "", baseUrl: "", protocol: "minimax-video", defaultResolution: "1080P", defaultDuration: 6 },
      },
      settingsTab: undefined,
    }));
  });
  afterEach(cleanup);

  // ── 开关显隐 ─────────────────────────────────────────────────────────────

  it("图片模态关闭时隐藏详细字段", () => {
    setImageState({ enabled: false });
    renderUI(<MediaGenSettingsSection />);
    expect(screen.queryByText("图片供应商")).toBeNull();
    expect(screen.queryByPlaceholderText("gpt-image-1")).toBeNull();
  });

  it("点击图片启用开关写入 store", () => {
    setImageState({ enabled: false });
    renderUI(<MediaGenSettingsSection />);
    fireEvent.click(screen.getByLabelText("启用图片生成"));
    expect(usePersonalStore.getState().mediaGenSettings.image.enabled).toBe(true);
  });

  it("渲染四个模态 tab,默认激活图片生成", () => {
    renderUI(<MediaGenSettingsSection />);
    const tabs = screen.getAllByRole("tab").map((el) => el.textContent);
    expect(tabs).toEqual(["图片生成", "语音生成", "音乐生成", "视频生成"]);
    expect(screen.getByRole("tab", { name: "图片生成" })).toHaveAttribute("aria-selected", "true");
    // 非激活模态卡不渲染
    expect(screen.queryByLabelText("启用视频生成")).toBeNull();
    switchTab("视频生成");
    expect(screen.getByLabelText("启用视频生成")).toBeInTheDocument();
  });

  // ── 供应商下拉 = 媒体供应商目录 ──────────────────────────────────────────

  it("图片供应商下拉列出目录条目 + 自定义", () => {
    setImageState({ enabled: true });
    renderUI(<MediaGenSettingsSection />);
    const providerSelect = selectWithOption("自定义图片 API");
    const labels = Array.from(providerSelect.querySelectorAll("option")).map((o) => o.textContent);
    // 目录 image 能力：minimax / minimax-cn / xai / volcengine（xiaomi 无 image 能力不出现）
    expect(labels).toEqual([
      "MiniMax",
      "MiniMax（中国）",
      "xAI（Grok Imagine）",
      "火山方舟（Volcengine Ark）",
      "自定义图片 API",
    ]);
  });

  it("选目录供应商写 providerId 并同步 protocol/model,隐藏协议/baseUrl/apiKey 三行", () => {
    setImageState({ enabled: true, providerId: "", model: "my-custom-model" });
    renderUI(<MediaGenSettingsSection />);
    const providerSelect = selectWithOption("自定义图片 API");
    fireEvent.change(providerSelect, { target: { value: "minimax" } });

    const image = usePersonalStore.getState().mediaGenSettings.image;
    expect(image.providerId).toBe("minimax");
    expect(image.protocol).toBe("minimax-image");
    // 自定义模型名不在目录列表 → 同步为目录首个模型（resolve 主进程侧以 settings.model 优先）
    expect(image.model).toBe("image-01");
  });

  it("目录态隐藏协议/API 地址/API 密钥三行,模型变下拉", () => {
    setImageState({ enabled: true, providerId: "minimax", protocol: "minimax-image", model: "image-01" });
    renderUI(<MediaGenSettingsSection />);
    expect(screen.queryByText("图片协议")).toBeNull();
    expect(screen.queryByText("API 地址")).toBeNull();
    expect(screen.queryByText("API 密钥")).toBeNull();
    // 模型下拉包含目录模型
    const modelSelect = selectWithOption("image-01-live");
    expect(modelSelect).toBeInTheDocument();
  });

  it("切换供应商不清空自填 baseUrl/apiKey（Kun bug 不搬）", () => {
    setImageState({
      enabled: true,
      providerId: "",
      apiKey: "${secret:media.image.custom}",
      baseUrl: "https://my-endpoint.com",
    });
    renderUI(<MediaGenSettingsSection />);
    const providerSelect = selectWithOption("自定义图片 API");
    fireEvent.change(providerSelect, { target: { value: "minimax" } });
    let image = usePersonalStore.getState().mediaGenSettings.image;
    expect(image.apiKey).toBe("${secret:media.image.custom}");
    expect(image.baseUrl).toBe("https://my-endpoint.com");
    // 切回自定义仍保留
    fireEvent.change(providerSelect, { target: { value: "custom" } });
    image = usePersonalStore.getState().mediaGenSettings.image;
    expect(image.providerId).toBe("custom");
    expect(image.apiKey).toBe("${secret:media.image.custom}");
    expect(image.baseUrl).toBe("https://my-endpoint.com");
  });

  // ── 配置状态提示 ─────────────────────────────────────────────────────────

  it("catalog 型未配置密钥 → 黄色警示 + 跳转 Provider 设置", async () => {
    setImageState({ enabled: true, providerId: "minimax", protocol: "minimax-image", model: "image-01" });
    renderUI(<MediaGenSettingsSection />, makeBridge({ statuses: [] }));
    expect(await screen.findByText("「MiniMax」尚未配置密钥,媒体生成调用会失败。")).toBeInTheDocument();
    fireEvent.click(screen.getByText("前往 Provider 设置"));
    // 经既有 settingsTab 导航跳到 Pi 分区（Provider 管理并入 Pi）
    expect(usePersonalStore.getState().settingsTab).toBe("pi");
  });

  it("catalog 型已配置 API Key → 灰字托管提示", async () => {
    setImageState({ enabled: true, providerId: "minimax", protocol: "minimax-image", model: "image-01" });
    renderUI(
      <MediaGenSettingsSection />,
      makeBridge({ statuses: [{ providerId: "minimax", configured: true, type: "api-key", source: "safe-storage" }] }),
    );
    expect(await screen.findByText("使用 MiniMax 的密钥（已在 Provider 设置配置）")).toBeInTheDocument();
  });

  it("catalog 型 OAuth 凭据 → 提示改配 API Key", async () => {
    setImageState({ enabled: true, providerId: "minimax", protocol: "minimax-image", model: "image-01" });
    renderUI(
      <MediaGenSettingsSection />,
      makeBridge({ statuses: [{ providerId: "minimax", configured: true, type: "oauth", source: "safe-storage" }] }),
    );
    expect(
      await screen.findByText("媒体生成暂不支持 OAuth 登录的密钥,请在 Provider 设置改配 API Key。"),
    ).toBeInTheDocument();
  });

  it("standalone 型（volcengine）→ 内联密钥字段,无协议/API 地址行", () => {
    setImageState({ enabled: true, providerId: "volcengine", protocol: "volcengine-ark-image", model: "doubao-seedream-5-0-pro-260628" });
    renderUI(<MediaGenSettingsSection />);
    // 内联 MediaSecretKeyField（API 密钥行存在）,但协议/API 地址仍隐藏
    expect(screen.getByText("API 密钥")).toBeInTheDocument();
    expect(screen.queryByText("图片协议")).toBeNull();
    expect(screen.queryByText("API 地址")).toBeNull();
  });

  // ── 图片动态选项 ─────────────────────────────────────────────────────────

  it("图片分辨率档位:volcengine → 2K/3K/4K,其余 → 自动/1K/2K", () => {
    setImageState({ enabled: true, providerId: "volcengine", protocol: "volcengine-ark-image", model: "doubao-seedream-5-0-pro-260628", defaultResolution: "1K" });
    renderUI(<MediaGenSettingsSection />);
    const resolutionSelect = selectWithOption("3K");
    const values = Array.from(resolutionSelect.querySelectorAll("option")).map((o) => o.getAttribute("value"));
    expect(values).toEqual(["2K", "3K", "4K"]);
    // 当前值 1K 不在火山档位 → 显示档位首项 2K（effective 值,不静默写回 store）
    expect(resolutionSelect.value).toBe("2K");
    expect(usePersonalStore.getState().mediaGenSettings.image.defaultResolution).toBe("1K");
  });

  it("图片画质下拉写入 store", () => {
    setImageState({ enabled: true, providerId: "" });
    renderUI(<MediaGenSettingsSection />);
    const qualitySelect = selectWithOption("高");
    fireEvent.change(qualitySelect, { target: { value: "high" } });
    expect(usePersonalStore.getState().mediaGenSettings.image.quality).toBe("high");
  });

  it("defaultSize 非法输入红框且不写入 store,合法输入写入", () => {
    setImageState({ enabled: true, providerId: "", defaultSize: "" });
    renderUI(<MediaGenSettingsSection />);
    const sizeInput = screen.getByPlaceholderText("如 1024x1024");
    fireEvent.change(sizeInput, { target: { value: "abc" } });
    expect(sizeInput).toHaveAttribute("aria-invalid", "true");
    expect(usePersonalStore.getState().mediaGenSettings.image.defaultSize).toBe("");
    fireEvent.change(sizeInput, { target: { value: "1024x1024" } });
    expect(sizeInput).toHaveAttribute("aria-invalid", "false");
    expect(usePersonalStore.getState().mediaGenSettings.image.defaultSize).toBe("1024x1024");
  });

  // ── 视频按协议动态档位 ───────────────────────────────────────────────────

  it("视频 minimax 协议:分辨率 768P/1080P,时长为 number 输入", () => {
    setVideoState({ enabled: true, providerId: "minimax", protocol: "minimax-video", model: "MiniMax-Hailuo-2.3" });
    renderUI(<MediaGenSettingsSection />);
    switchTab("视频生成");
    const resolutionSelect = selectWithOption("768P");
    const values = Array.from(resolutionSelect.querySelectorAll("option")).map((o) => o.getAttribute("value"));
    expect(values).toEqual(["768P", "1080P"]);
    // number 输入存在（min=1 max=30）
    const durationInput = document.querySelector('input[type="number"][min="1"][max="30"]');
    expect(durationInput).not.toBeNull();
  });

  it("视频 grok 协议:分辨率 480P/720P,时长变 6s/10s select,值不在档位回落默认", () => {
    // 当前 1080P/8s 都不在 grok 档位 → 显示 720P（回落默认）与 6s
    setVideoState({ enabled: true, providerId: "xai", protocol: "grok-imagine-video", model: "grok-imagine-video", defaultResolution: "1080P", defaultDuration: 8 });
    renderUI(<MediaGenSettingsSection />);
    switchTab("视频生成");
    const resolutionSelect = selectWithOption("480P");
    expect(Array.from(resolutionSelect.querySelectorAll("option")).map((o) => o.getAttribute("value"))).toEqual(["480P", "720P"]);
    expect(resolutionSelect.value).toBe("720P");
    const durationSelect = selectWithOption("6s");
    expect(Array.from(durationSelect.querySelectorAll("option")).map((o) => o.getAttribute("value"))).toEqual(["6", "10"]);
    expect(durationSelect.value).toBe("6");
    fireEvent.change(durationSelect, { target: { value: "10" } });
    expect(usePersonalStore.getState().mediaGenSettings.video.defaultDuration).toBe(10);
  });

  it("视频 volcengine 协议:分辨率含 4K,时长 number 4-15", () => {
    setVideoState({ enabled: true, providerId: "volcengine", protocol: "volcengine-ark-video", model: "doubao-seedance-2-0-260128" });
    renderUI(<MediaGenSettingsSection />);
    switchTab("视频生成");
    const resolutionSelect = selectWithOption("4K");
    expect(Array.from(resolutionSelect.querySelectorAll("option")).map((o) => o.getAttribute("value"))).toEqual(["480P", "720P", "1080P", "4K"]);
    const durationInput = document.querySelector('input[type="number"][min="4"][max="15"]');
    expect(durationInput).not.toBeNull();
  });

  // ── 自定义态 ─────────────────────────────────────────────────────────────

  it("自定义态显示协议下拉（i18n 查表标签）与 baseUrl/密钥行", () => {
    setImageState({ enabled: true, providerId: "" });
    renderUI(<MediaGenSettingsSection />);
    expect(screen.getByText("图片协议")).toBeInTheDocument();
    expect(screen.getByText("API 地址")).toBeInTheDocument();
    expect(screen.getByText("API 密钥")).toBeInTheDocument();
    // 协议标签查 i18n 表（含新协议）
    const protocolSelect = selectWithOption("Grok Imagine 图像");
    fireEvent.change(protocolSelect, { target: { value: "volcengine-ark-image" } });
    expect(usePersonalStore.getState().mediaGenSettings.image.protocol).toBe("volcengine-ark-image");
  });

  it("编辑图片 baseUrl 写入 store", () => {
    setImageState({ enabled: true, providerId: "" });
    renderUI(<MediaGenSettingsSection />);
    const urlInputs = document.querySelectorAll('input[type="url"]');
    expect(urlInputs.length).toBeGreaterThan(0);
    fireEvent.change(urlInputs[0] as Element, { target: { value: "https://custom-api.com" } });
    expect(usePersonalStore.getState().mediaGenSettings.image.baseUrl).toBe("https://custom-api.com");
  });

  it("编辑图片模型输入写入 store（自定义态）", () => {
    setImageState({ enabled: true, providerId: "" });
    renderUI(<MediaGenSettingsSection />);
    const modelInput = screen.getByPlaceholderText("gpt-image-1");
    fireEvent.change(modelInput, { target: { value: "dall-e-3" } });
    expect(usePersonalStore.getState().mediaGenSettings.image.model).toBe("dall-e-3");
  });
});
