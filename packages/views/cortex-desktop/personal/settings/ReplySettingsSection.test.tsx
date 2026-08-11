// ReplySettingsSection（U9）单测：平台守卫、权限中心、触发键、记忆、渠道校验、调试记录。
// 断言优先落在 locale 无关的插值值（账号名/错误 detail）与结构角色上，静态文案按默认 locale（zh-Hans）。

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreProvider, resetProviderCatalogCache, usePersonalStore, useReplyStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { DEFAULT_REPLY_SETTINGS } from "@cortex-work/core/desktop/types";
import { emptyMemoryState } from "@cortex-work/core/reply/memory";

import { ReplySettingsSection, SHOW_REPLY_CHANNELS } from "./ReplySettingsSection";

// 组件平台守卫读 navigator.platform；jsdom 默认空串，需伪装成 mac 才渲染。
beforeAll(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

function renderUI(ui: ReactElement, bridge: DesktopBridge | null) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      {ui}
    </CoreProvider>,
  );
}

// 最小可用 bridge：只实现 reply* 方法，其余按需。
function makeBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    replyGetPermissions: vi.fn().mockResolvedValue({
      accessibility: "granted",
      screenRecording: "denied",
      calendar: "notDetermined",
      microphone: "unknown",
      speechRecognition: "granted",
    }),
    replyOpenPermissionSettings: vi.fn().mockResolvedValue(undefined),
    replyVerifyChannel: vi.fn().mockResolvedValue({ ok: false, errorKind: "invalidResponse" }),
    replyDisconnectChannel: vi.fn().mockResolvedValue(undefined),
    replyGetDebugLog: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as DesktopBridge;
}

// 带 Provider Catalog + 已认证状态的 bridge：新版模型选择器的候选完全来自这两个接口。
function makeCatalogBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return makeBridge({
    providerCatalogGet: vi.fn().mockResolvedValue({
      ok: true,
      catalog: {
        schemaVersion: 1,
        piVersion: "0.82.1",
        hash: "t",
        providers: [
          {
            id: "cat-p",
            name: "CatProvider",
            api: "openai-completions",
            auth: ["api-key"],
            models: [
              { id: "vision-model", name: "Vision", api: "openai-completions", input: ["text", "image"], reasoning: true, contextWindow: 200000, maxTokens: 8192 },
              { id: "text-model", name: "TextOnly", api: "openai-completions", input: ["text"], reasoning: false, contextWindow: 128000, maxTokens: 4096 },
            ],
          },
        ],
      },
    }),
    providerAuthStatus: vi.fn().mockResolvedValue({
      statuses: [{ providerId: "cat-p", configured: true, type: "api-key", source: "safe-storage" }],
      health: { available: true },
      hiddenProviderIds: [],
    }),
    providerCustomList: vi.fn().mockResolvedValue([]),
    ...overrides,
  });
}

// 开发模式 bridge（调试记录分区可见）。
function makeDevBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return makeBridge({
    appInfo: { version: "0.0.0", os: "macos", devMode: true },
    ...overrides,
  });
}

function expectedNavLabels(includeDebug: boolean): string[] {
  const labels = ["生成模型", "触发键", "权限", "记忆"];
  if (SHOW_REPLY_CHANNELS) labels.push("渠道");
  labels.push("数据");
  if (includeDebug) labels.push("调试");
  return labels;
}

beforeEach(() => {
  // 每例重置 store，避免用例间串态。
  useReplyStore.setState({
    hydrated: true,
    settings: { ...DEFAULT_REPLY_SETTINGS },
    memory: emptyMemoryState(),
    channels: { connections: {}, credentials: {}, notes: {} },
  });
  // 生成模型选择器读 usePersonalStore.providerSettings（跨测试单例）；每例复位为空，避免串态。
  usePersonalStore.setState({ providerSettings: { providers: [] } });
  // Provider Catalog 是模块级进程内缓存（见 core/personal/modelCapabilities），跨用例必须清。
  resetProviderCatalogCache();
});


describe("ReplySettingsSection 平台守卫", () => {
  it("bridge 缺 reply 能力（Web 端）→ 整分区返回 null", () => {
    const { container } = renderUI(<ReplySettingsSection />, null);
    expect(container).toBeEmptyDOMElement();
  });

  it("非 mac 平台 → 返回 null", () => {
    Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
    const { container } = renderUI(<ReplySettingsSection />, makeBridge());
    expect(container).toBeEmptyDOMElement();
    // 复位供后续用例
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  });
});

describe("ReplySettingsSection 分段导航", () => {
  it("渲染分区导航；点击立即高亮目标项", () => {
    // jsdom 未实现 scrollIntoView，打桩避免导航点击抛错。
    Element.prototype.scrollIntoView = vi.fn();
    const { container } = renderUI(<ReplySettingsSection />, makeBridge());
    const items = container.querySelectorAll(".pw-reply-nav-item");
    const expectedNav = expectedNavLabels(false);
    expect(Array.from(items).map((b) => b.textContent)).toEqual(expectedNav);
    // 默认高亮首项；点击「数据」后高亮切换（先亮再滚，spy 落位后收敛）。
    expect(items[0]!.className).toContain("is-active");
    const dataIdx = expectedNav.indexOf("数据");
    fireEvent.click(items[dataIdx]!);
    expect(items[dataIdx]!.className).toContain("is-active");
    expect(items[0]!.className).not.toContain("is-active");
  });

  it("开发模式下渲染调试导航项", () => {
    Element.prototype.scrollIntoView = vi.fn();
    const { container } = renderUI(<ReplySettingsSection />, makeDevBridge());
    const items = container.querySelectorAll(".pw-reply-nav-item");
    expect(Array.from(items).map((b) => b.textContent)).toEqual(expectedNavLabels(true));
  });

  it("每个导航项都有对应的锚点分区", () => {
    const { container } = renderUI(<ReplySettingsSection />, makeBridge());
    const sectionIds = ["model", "triggers", "permissions", "memory", ...(SHOW_REPLY_CHANNELS ? ["channels"] : []), "data"];
    for (const id of sectionIds) {
      expect(container.querySelector(`#pw-reply-sec-${id}`)).not.toBeNull();
    }
    expect(container.querySelector("#pw-reply-sec-logs")).toBeNull();
  });

  it("开发模式下存在调试记录锚点分区", () => {
    const { container } = renderUI(<ReplySettingsSection />, makeDevBridge());
    expect(container.querySelector("#pw-reply-sec-logs")).not.toBeNull();
  });
});

describe("ReplySettingsSection 权限中心", () => {
  it("渲染授权进度汇总（granted 计数 / 总数）", async () => {
    renderUI(<ReplySettingsSection />, makeBridge());
    // makeBridge 默认 5 项中 2 项 granted（accessibility/speechRecognition）。
    await waitFor(() => expect(screen.getByText("2 / 5 已授权")).toBeInTheDocument());
  });

  it("渲染五项状态；denied/notDetermined/unknown 项统一出现「去授权」", async () => {
    renderUI(<ReplySettingsSection />, makeBridge());
    // granted / denied / notDetermined / unknown 各态文案
    await waitFor(() => expect(screen.getAllByText("已授权").length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText("未授权")).toBeInTheDocument();
    expect(screen.getByText("未设置", { selector: ".pw-reply-perm-status" })).toBeInTheDocument();
    expect(screen.getByText("未知")).toBeInTheDocument();
    // denied（screen）/ notDetermined（calendar）/ unknown（mic）各出现一个「去授权」按钮——
    // unknown 只在查询失败时出现，不该把用户卡在「检查」死循环里，统一直达系统设置。
    expect(screen.getAllByText("去授权")).toHaveLength(3);
  });

  it("点击「去授权」调用 replyOpenPermissionSettings（含 unknown 态）", async () => {
    const bridge = makeBridge();
    renderUI(<ReplySettingsSection />, bridge);
    // 先等权限异步加载完成（denied 徽标出现），再取稳定的按钮节点点击，避免命中加载前会被替换的节点。
    await screen.findByText("未授权");
    fireEvent.click(screen.getAllByText("去授权")[0]!);
    expect(bridge.replyOpenPermissionSettings).toHaveBeenCalledTimes(1);
  });

  it("头部「刷新」按钮重新拉取权限状态", async () => {
    const bridge = makeBridge();
    renderUI(<ReplySettingsSection />, bridge);
    await waitFor(() => expect(bridge.replyGetPermissions).toHaveBeenCalledTimes(1));
    // 调试记录卡片头也有个「刷新」按钮（reply.debugRefresh），同页两处同文案——取第一个（权限中心先渲染）。
    fireEvent.click(screen.getAllByText("刷新")[0]!);
    await waitFor(() => expect(bridge.replyGetPermissions).toHaveBeenCalledTimes(2));
  });
});

describe("ReplySettingsSection 触发键与学习开关", () => {
  it("起草与语音触发键都可选择未设置并写入 store", () => {
    renderUI(<ReplySettingsSection />, makeBridge());
    const selects = screen.getAllByRole("combobox");

    for (const select of selects.slice(0, 2)) {
      expect(Array.from((select as HTMLSelectElement).options).map((option) => option.textContent)).toContain("未设置");
    }

    fireEvent.change(selects[0]!, { target: { value: "none" } });
    fireEvent.change(selects[1]!, { target: { value: "none" } });
    expect(useReplyStore.getState().settings.draftTrigger).toBe("none");
    expect(useReplyStore.getState().settings.voiceTrigger).toBe("none");
  });

  it("修改起草触发键写入 store", async () => {
    renderUI(<ReplySettingsSection />, makeBridge());
    // 生成模型已改为按钮式 ModelRefField（不再是 select），故起草触发键是第一个 combobox。
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0]!, { target: { value: "option" } });
    expect(useReplyStore.getState().settings.draftTrigger).toBe("option");
  });

  it("切换学习开关写入 store", async () => {
    renderUI(<ReplySettingsSection />, makeBridge());
    expect(useReplyStore.getState().settings.learningEnabled).toBe(true);
    const toggle = screen.getByRole("switch", { name: "从我发出的消息学习语气" });
    fireEvent.click(toggle);
    expect(useReplyStore.getState().settings.learningEnabled).toBe(false);
  });
});

describe("ReplySettingsSection 生成模型选择器（Catalog 驱动）", () => {
  it("模型说明与选择器使用统一的设置行布局", () => {
    renderUI(<ReplySettingsSection />, makeBridge());
    const modelButton = screen.getByText("未配置模型").closest("button");
    const modelRow = modelButton?.closest(".pw-srow");
    expect(modelRow).not.toBeNull();
    expect(modelRow?.querySelector(".pw-srow-c-end .pw-reply-model-control")).not.toBeNull();
  });

  it("未配置模型 → 阻断态：显示「未配置模型」而不是悄悄回退到某个默认模型", () => {
    renderUI(<ReplySettingsSection />, makeBridge());
    expect(screen.getByText("未配置模型")).toBeInTheDocument();
  });

  it("引用悬空（模型不在 Catalog 中）→ 阻断态 + 说明为什么不自动回退", async () => {
    useReplyStore.setState({
      settings: { ...DEFAULT_REPLY_SETTINGS, providerId: "gone-provider", model: "gone-model" },
    });
    renderUI(<ReplySettingsSection />, makeCatalogBridge());
    expect(await screen.findByText("模型未配置")).toBeInTheDocument();
    expect(screen.getByText(/不会替你回退到别的模型/)).toBeInTheDocument();
  });

  it("从选择器选中一个模型 → 写入 {providerId, modelId} 两个字段", async () => {
    renderUI(<ReplySettingsSection />, makeCatalogBridge());
    fireEvent.click(screen.getByText("未配置模型"));
    // 选择器只列「认证可用 ∧ 未隐藏」的 Provider 的模型。
    fireEvent.click(await screen.findByText("Vision"));
    expect(useReplyStore.getState().settings.providerId).toBe("cat-p");
    expect(useReplyStore.getState().settings.model).toBe("vision-model");
  });
});

describe("ReplySettingsSection 记忆管理", () => {
  it("展开手写笔记后编辑写入当前分区 manual", async () => {
    renderUI(<ReplySettingsSection />, makeBridge());
    fireEvent.click(screen.getByText("展开"));
    const memo = screen.getByPlaceholderText(/我是 X 项目的产品经理/);
    fireEvent.change(memo, { target: { value: "简短、无寒暄" } });
    // 默认分区 profile
    expect(useReplyStore.getState().memory.profile.manual).toBe("简短、无寒暄");
  });

  it("展示并可编辑分区 auto 学习要点", async () => {
    useReplyStore.setState((s) => ({
      memory: { ...s.memory, profile: { manual: "", auto: "- 语气随意" } },
    }));
    renderUI(<ReplySettingsSection />, makeBridge());
    const auto = screen.getByDisplayValue("- 语气随意");
    fireEvent.change(auto, { target: { value: "- 更正式" } });
    expect(useReplyStore.getState().memory.profile.auto).toBe("- 更正式");
  });
});

(SHOW_REPLY_CHANNELS ? describe : describe.skip)("ReplySettingsSection 渠道连接", () => {
  it("校验成功 → 显示账号名+团队，写入连接态", async () => {
    const bridge = makeBridge({
      replyVerifyChannel: vi
        .fn()
        .mockResolvedValue({ ok: true, accountName: "alice", accountDetail: "Acme", ciphertext: "xx" }),
    });
    renderUI(<ReplySettingsSection />, bridge);
    // 渠道顺序：lark / slack / gmail（CHANNEL_DESCRIPTORS messaging 顺序）
    const tokenInputs = screen.getAllByPlaceholderText("粘贴 token…");
    fireEvent.change(tokenInputs[1]!, { target: { value: "xoxp-token" } }); // slack
    const connectBtns = screen.getAllByText("连接");
    fireEvent.click(connectBtns[1]!);
    await waitFor(() => expect(screen.getByText("已连接:alice（Acme）")).toBeInTheDocument());
    const conn = useReplyStore.getState().channels.connections.slack;
    expect(conn?.isConnected).toBe(true);
    expect(useReplyStore.getState().channels.credentials.slack?.ciphertext).toBe("xx");
  });

  it("校验失败（apiError）→ 展示错误 detail，不写连接态", async () => {
    const bridge = makeBridge({
      replyVerifyChannel: vi
        .fn()
        .mockResolvedValue({ ok: false, errorKind: "apiError", errorDetail: "invalid_auth" }),
    });
    renderUI(<ReplySettingsSection />, bridge);
    const tokenInputs = screen.getAllByPlaceholderText("粘贴 token…");
    fireEvent.change(tokenInputs[0]!, { target: { value: "bad" } }); // lark
    fireEvent.click(screen.getAllByText("连接")[0]!);
    await waitFor(() => expect(screen.getByText(/invalid_auth/)).toBeInTheDocument());
    expect(useReplyStore.getState().channels.connections.lark).toBeUndefined();
  });

  it("断开 → 调用 bridge 且清连接态", async () => {
    useReplyStore.setState((s) => ({
      channels: {
        ...s.channels,
        connections: { slack: { id: "slack", isConnected: true, accountName: "bob" } },
      },
    }));
    const bridge = makeBridge();
    renderUI(<ReplySettingsSection />, bridge);
    fireEvent.click(screen.getByText("断开"));
    await waitFor(() => expect(bridge.replyDisconnectChannel).toHaveBeenCalledWith("slack"));
    expect(useReplyStore.getState().channels.connections.slack).toBeUndefined();
  });
});

describe("ReplySettingsSection 调试记录", () => {
  it("正式包（非 devMode）不渲染调试分区", () => {
    renderUI(<ReplySettingsSection />, makeBridge());
    expect(screen.queryByText("暂无调用记录。")).not.toBeInTheDocument();
  });

  it("空态渲染提示", async () => {
    renderUI(<ReplySettingsSection />, makeDevBridge());
    await waitFor(() => expect(screen.getByText("暂无调用记录。")).toBeInTheDocument());
  });

  it("有记录时渲染列表并可展开看 prompt/输出", async () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      ts: 1_700_000_000_000 + i,
      source: i % 2 === 0 ? ("ax" as const) : ("ocr" as const),
      systemPrompt: `sys-${i}`,
      userPrompt: `usr-${i}`,
      output: `out-${i}`,
    }));
    const bridge = makeDevBridge({ replyGetDebugLog: vi.fn().mockResolvedValue(entries) });
    renderUI(<ReplySettingsSection />, bridge);
    // 20 条各一个「详情」展开按钮
    await waitFor(() => expect(screen.getAllByText("详情")).toHaveLength(20));
    // 展开第一条 → 看到 prompt 与 output
    fireEvent.click(screen.getAllByText("详情")[0]!);
    expect(screen.getByText(/sys-0/)).toBeInTheDocument();
    expect(screen.getByText("out-0")).toBeInTheDocument();
  });
});
