// ReplySettingsSection（U9）单测：平台守卫、权限中心、触发键、记忆、渠道校验、调试记录。
// 断言优先落在 locale 无关的插值值（账号名/错误 detail）与结构角色上，静态文案按默认 locale（zh-Hans）。

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreProvider, usePersonalStore, useReplyStore } from "@cortex-work/core";
import type { DesktopBridge, ProviderProfile } from "@cortex-work/core";
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
});

// 生成一个 chat_completions 供应商（模型选择器测试用）。
function chatProvider(over: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: "p1",
    name: "ChatOne",
    baseUrl: "https://api.example.com",
    apiKey: "sk",
    endpointFormat: "chat_completions",
    models: [{ id: "m1", label: "Model One" }],
    enabled: true,
    ...over,
  };
}

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
    expect(screen.getByText("未设置")).toBeInTheDocument();
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
  it("修改起草触发键写入 store", async () => {
    renderUI(<ReplySettingsSection />, makeBridge());
    // combobox[0] = 生成模型供应商下拉（无 provider 时仅「跟随默认」），故起草触发键为 combobox[1]。
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[1]!, { target: { value: "option" } });
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

describe("ReplySettingsSection 生成模型选择器", () => {
  it("供应商下拉仅列 enabled 且 chat_completions 的供应商", () => {
    usePersonalStore.setState({
      providerSettings: {
        providers: [
          chatProvider({ id: "p1", name: "ChatOne" }),
          chatProvider({ id: "p2", name: "DisabledOne", enabled: false }),
          chatProvider({ id: "p3", name: "RespOne", endpointFormat: "responses" }),
          chatProvider({ id: "p4", name: "EmptyModels", models: [] }),
        ],
      },
    });
    renderUI(<ReplySettingsSection />, makeBridge());
    // combobox[0] = 供应商下拉。
    const providerSelect = screen.getAllByRole("combobox")[0]!;
    const optionTexts = within(providerSelect)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(optionTexts).toContain("跟随供应商默认");
    expect(optionTexts).toContain("ChatOne");
    // 禁用 / 非 chat_completions / 空模型列表 的供应商不出现(空模型选中后 UI 与 main 解析会静默分歧)。
    expect(optionTexts).not.toContain("DisabledOne");
    expect(optionTexts).not.toContain("RespOne");
    expect(optionTexts).not.toContain("EmptyModels");
  });

  it("选择供应商写入 reply store 并默认取首个模型；再改模型下拉写入所选", () => {
    usePersonalStore.setState({
      providerSettings: {
        providers: [
          chatProvider({
            id: "p1",
            name: "ChatOne",
            models: [
              { id: "m1", label: "Model One" },
              { id: "m2", label: "Model Two" },
            ],
          }),
        ],
      },
    });
    renderUI(<ReplySettingsSection />, makeBridge());
    // 选供应商 → providerId + 首个模型 id 一并写入。
    fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: "p1" } });
    expect(useReplyStore.getState().settings.providerId).toBe("p1");
    expect(useReplyStore.getState().settings.model).toBe("m1");
    // 选具体供应商后出现模型下拉（combobox[1]），改为第二个模型。
    fireEvent.change(screen.getAllByRole("combobox")[1]!, { target: { value: "m2" } });
    expect(useReplyStore.getState().settings.model).toBe("m2");
  });

  it("「跟随默认」态展示实际回退目标（供应商 + 模型）", () => {
    usePersonalStore.setState({
      providerSettings: {
        providers: [chatProvider({ id: "p1", name: "ChatOne", models: [{ id: "m1" }] })],
        defaultProviderId: "p1",
        defaultModel: "m1",
      },
    });
    // reply 未选专属供应商（默认 providerId undefined）→ 展示回退目标。
    renderUI(<ReplySettingsSection />, makeBridge());
    expect(screen.getByText(/将使用「ChatOne」的 m1/)).toBeInTheDocument();
  });

  it("无可用供应商/无默认 → 渲染警示与「去配置供应商」按钮，点击跳转 providers 分区", () => {
    // providerSettings 为空（beforeEach 已复位）。
    renderUI(<ReplySettingsSection />, makeBridge());
    expect(screen.getByText("未配置可用模型")).toBeInTheDocument();
    fireEvent.click(screen.getByText("去配置供应商"));
    expect(usePersonalStore.getState().settingsTab).toBe("providers");
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
