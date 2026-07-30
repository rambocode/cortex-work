import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { ProviderProfile } from "@cortex-work/core";
import type { ImageGenSettings } from "@cortex-work/core/desktop/types";

import { MediaGenSettingsSection } from "./MediaGenSettingsSection";

// ── 辅助函数 ────────────────────────────────────────────────────────────────

function renderUI(ui: ReactElement) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={null}>
      {ui}
    </CoreProvider>,
  );
}

/** 设置 image 子区状态 */
function setImageState(patch: Partial<ImageGenSettings>) {
  usePersonalStore.setState((s) => ({
    mediaGenSettings: {
      ...s.mediaGenSettings,
      image: { ...s.mediaGenSettings.image, ...patch },
    },
  }));
}

/** 设置 speech 子区 enabled */
function setSpeechEnabled(enabled: boolean) {
  usePersonalStore.setState((s) => ({
    mediaGenSettings: {
      ...s.mediaGenSettings,
      speech: { ...s.mediaGenSettings.speech, enabled },
    },
  }));
}

/** 注入已配置供应商 */
function setProviders(providers: ProviderProfile[]) {
  usePersonalStore.setState((s) => ({
    providerSettings: { ...s.providerSettings, providers },
  }));
}

const fakeProvider: ProviderProfile = {
  id: "test-provider",
  name: "TestProvider",
  baseUrl: "https://api.example.com",
  apiKey: "sk-test",
  endpointFormat: "chat_completions",
  models: [],
  enabled: true,
};

// ── 测试套件 ────────────────────────────────────────────────────────────────

describe("MediaGenSettingsSection（U3）", () => {
  beforeEach(() => {
    // 每次测试前重置为默认值（all disabled, custom provider）
    usePersonalStore.setState((s) => ({
      mediaGenSettings: {
        image: { ...s.mediaGenSettings.image, enabled: false, providerId: "", apiKey: "", baseUrl: "" },
        speech: { ...s.mediaGenSettings.speech, enabled: false, providerId: "", apiKey: "", baseUrl: "" },
        music: { ...s.mediaGenSettings.music, enabled: false, providerId: "", apiKey: "", baseUrl: "" },
        video: { ...s.mediaGenSettings.video, enabled: false, providerId: "", apiKey: "", baseUrl: "" },
      },
      providerSettings: { providers: [] },
    }));
  });

  // ── 开关隐藏/显示详细字段 ────────────────────────────────────────────────

  it("图片模态关闭时隐藏详细字段", () => {
    setImageState({ enabled: false });
    renderUI(<MediaGenSettingsSection />);
    // 供应商行不可见
    expect(screen.queryByText("供应商")).toBeNull();
    // 模型 placeholder 不可见
    expect(screen.queryByPlaceholderText("如 dall-e-3")).toBeNull();
  });

  it("图片模态开启时显示详细字段", () => {
    setImageState({ enabled: true });
    renderUI(<MediaGenSettingsSection />);
    expect(screen.getByText("供应商")).toBeInTheDocument();
  });

  it("点击图片启用开关写入 store", () => {
    setImageState({ enabled: false });
    renderUI(<MediaGenSettingsSection />);
    fireEvent.click(screen.getByLabelText("启用图片生成"));
    expect(usePersonalStore.getState().mediaGenSettings.image.enabled).toBe(true);
  });

  it("关闭语音模态时隐藏语音详细字段", () => {
    setSpeechEnabled(false);
    renderUI(<MediaGenSettingsSection />);
    expect(screen.queryByText("语音角色")).toBeNull();
  });

  it("开启语音模态时显示语音角色字段", () => {
    setSpeechEnabled(true);
    renderUI(<MediaGenSettingsSection />);
    expect(screen.getByText("语音角色")).toBeInTheDocument();
  });

  // ── 供应商选择联动 ────────────────────────────────────────────────────────

  it("无已配置供应商时下拉只有「自定义」", () => {
    setProviders([]);
    setImageState({ enabled: true });
    renderUI(<MediaGenSettingsSection />);
    // 图片区的第一个 select 是供应商下拉
    const selects = screen.getAllByRole("combobox");
    const providerSelect = selects[0] as HTMLSelectElement;
    const options = Array.from(providerSelect.querySelectorAll("option"));
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toBe("自定义");
  });

  it("有已配置供应商时下拉包含供应商 + 自定义", () => {
    setProviders([fakeProvider]);
    setImageState({ enabled: true });
    renderUI(<MediaGenSettingsSection />);
    const selects = screen.getAllByRole("combobox");
    const providerSelect = selects[0] as HTMLSelectElement;
    const options = Array.from(providerSelect.querySelectorAll("option"));
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).toBe("TestProvider");
    expect(options[1]?.textContent).toBe("自定义");
  });

  it("选「自定义」时显示协议/baseUrl/密钥字段", () => {
    setImageState({ enabled: true, providerId: "" });
    renderUI(<MediaGenSettingsSection />);
    // providerId 为空 = 自定义，应显示 baseUrl 输入 + SecretField
    expect(screen.getByText("API 地址")).toBeInTheDocument();
    expect(screen.getByText("API 密钥")).toBeInTheDocument();
  });

  it("选已配置供应商时隐藏 key/baseUrl 行，显示「使用 X 密钥」提示", () => {
    setProviders([fakeProvider]);
    setImageState({ enabled: true, providerId: "test-provider" });
    renderUI(<MediaGenSettingsSection />);
    // 不显示 API 地址行和 API 密钥行
    expect(screen.queryByText("API 地址")).toBeNull();
    expect(screen.queryByText("API 密钥")).toBeNull();
    // 显示「使用 X 的密钥」提示
    expect(screen.getByText("使用 TestProvider 的密钥")).toBeInTheDocument();
  });

  it("切换供应商到「自定义」时写入 store providerId=custom 并保留自填值不清空", () => {
    setProviders([fakeProvider]);
    setImageState({
      enabled: true,
      providerId: "test-provider",
      apiKey: "my-own-key",
      baseUrl: "https://my-endpoint.com",
    });
    renderUI(<MediaGenSettingsSection />);
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0] as HTMLElement, { target: { value: "custom" } });
    // store 更新为 custom，自填值保留
    const imageState = usePersonalStore.getState().mediaGenSettings.image;
    expect(imageState.providerId).toBe("custom");
    expect(imageState.apiKey).toBe("my-own-key");
    expect(imageState.baseUrl).toBe("https://my-endpoint.com");
  });

  // ── 协议切换 ──────────────────────────────────────────────────────────────

  it("切换图片协议 OpenAI Images → MiniMax 后 store 更新", () => {
    setImageState({ enabled: true, providerId: "" });
    renderUI(<MediaGenSettingsSection />);
    // 初始协议 openai-images
    expect(usePersonalStore.getState().mediaGenSettings.image.protocol).toBe("openai-images");
    // 供应商下拉 + 协议下拉（自定义时才出现）
    const selects = screen.getAllByRole("combobox");
    // selects[0] = 供应商, selects[1] = 协议
    fireEvent.change(selects[1] as HTMLElement, { target: { value: "minimax-image" } });
    expect(usePersonalStore.getState().mediaGenSettings.image.protocol).toBe("minimax-image");
  });

  // ── 编辑字段写 store ─────────────────────────────────────────────────────

  it("编辑图片 baseUrl 写入 store", () => {
    setImageState({ enabled: true, providerId: "" });
    renderUI(<MediaGenSettingsSection />);
    const urlInputs = document.querySelectorAll('input[type="url"]');
    expect(urlInputs.length).toBeGreaterThan(0);
    fireEvent.change(urlInputs[0] as Element, { target: { value: "https://custom-api.com" } });
    expect(usePersonalStore.getState().mediaGenSettings.image.baseUrl).toBe("https://custom-api.com");
  });

  it("编辑图片模型输入写入 store", () => {
    setImageState({ enabled: true });
    renderUI(<MediaGenSettingsSection />);
    const modelInput = screen.getByPlaceholderText("如 dall-e-3");
    fireEvent.change(modelInput, { target: { value: "dall-e-3" } });
    expect(usePersonalStore.getState().mediaGenSettings.image.model).toBe("dall-e-3");
  });

  // ── SecretField 显隐 ──────────────────────────────────────────────────────

  it("SecretField 默认遮蔽（password 类型），点击「显示」切换为明文", () => {
    setImageState({ enabled: true, providerId: "" });
    renderUI(<MediaGenSettingsSection />);
    // 密钥输入默认为 password 类型
    const secretInputs = document.querySelectorAll('input[type="password"]');
    expect(secretInputs.length).toBeGreaterThan(0);
    // 点击显示按钮（SecretField 内的「显示」按钮）
    const showBtns = screen.getAllByText("显示");
    fireEvent.click(showBtns[0] as HTMLElement);
    // 切换后该 input 变为 text 类型（密钥已明文）
    const textInputs = document.querySelectorAll('input[type="text"]');
    expect(textInputs.length).toBeGreaterThan(0);
  });

  // ── 视频子区特有字段 ─────────────────────────────────────────────────────

  it("视频模态开启时显示时长/分辨率/轮询间隔字段", () => {
    usePersonalStore.setState((s) => ({
      mediaGenSettings: {
        ...s.mediaGenSettings,
        video: { ...s.mediaGenSettings.video, enabled: true },
      },
    }));
    renderUI(<MediaGenSettingsSection />);
    expect(screen.getByText("默认时长（秒）")).toBeInTheDocument();
    expect(screen.getByText("默认分辨率")).toBeInTheDocument();
    expect(screen.getByText("轮询间隔（ms）")).toBeInTheDocument();
  });

  // ── 总览说明卡 ────────────────────────────────────────────────────────────

  it("始终渲染总览说明卡", () => {
    renderUI(<MediaGenSettingsSection />);
    expect(screen.getByText("总览")).toBeInTheDocument();
  });
});
