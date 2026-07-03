// ReplySettingsSection（U9）单测：平台守卫、权限中心、触发键、记忆、渠道校验、调试记录。
// 断言优先落在 locale 无关的插值值（账号名/错误 detail）与结构角色上，静态文案按默认 locale（zh-Hans）。

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreProvider, useReplyStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { DEFAULT_REPLY_SETTINGS } from "@cortex-work/core/desktop/types";
import { emptyMemoryState } from "@cortex-work/core/reply/memory";

import { ReplySettingsSection } from "./ReplySettingsSection";

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

beforeEach(() => {
  // 每例重置 store，避免用例间串态。
  useReplyStore.setState({
    hydrated: true,
    settings: { ...DEFAULT_REPLY_SETTINGS },
    memory: emptyMemoryState(),
    channels: { connections: {}, credentials: {}, notes: {} },
  });
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

describe("ReplySettingsSection 权限中心", () => {
  it("渲染五项状态；非 granted 项出现「去授权」按钮", async () => {
    renderUI(<ReplySettingsSection />, makeBridge());
    // granted / denied / notDetermined / unknown 各态文案
    await waitFor(() => expect(screen.getAllByText("已授权").length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText("已拒绝")).toBeInTheDocument();
    expect(screen.getByText("未设置")).toBeInTheDocument();
    expect(screen.getByText("未知")).toBeInTheDocument();
    // 三个非 granted 项（screen/calendar/mic）各一个去授权按钮
    expect(screen.getAllByText("去授权")).toHaveLength(3);
  });

  it("点击「去授权」调用 replyOpenPermissionSettings", async () => {
    const bridge = makeBridge();
    renderUI(<ReplySettingsSection />, bridge);
    // 先等权限异步加载完成（denied 徽标出现），再取稳定的按钮节点点击，避免命中加载前会被替换的节点。
    await screen.findByText("已拒绝");
    fireEvent.click(screen.getAllByText("去授权")[0]!);
    expect(bridge.replyOpenPermissionSettings).toHaveBeenCalledTimes(1);
  });
});

describe("ReplySettingsSection 触发键与学习开关", () => {
  it("修改起草触发键写入 store", async () => {
    renderUI(<ReplySettingsSection />, makeBridge());
    // 第一个下拉 = 起草触发键
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

describe("ReplySettingsSection 记忆管理", () => {
  it("编辑手写笔记写入当前分区 manual", async () => {
    renderUI(<ReplySettingsSection />, makeBridge());
    const memo = screen.getByPlaceholderText(/我是 X 项目的产品经理/);
    fireEvent.change(memo, { target: { value: "简短、无寒暄" } });
    // 默认分区 profile
    expect(useReplyStore.getState().memory.profile.manual).toBe("简短、无寒暄");
  });

  it("展示分区 auto 学习要点（U10 蒸馏产出）", async () => {
    useReplyStore.setState((s) => ({
      memory: { ...s.memory, profile: { manual: "", auto: "- 语气随意" } },
    }));
    renderUI(<ReplySettingsSection />, makeBridge());
    expect(screen.getByText("- 语气随意")).toBeInTheDocument();
  });
});

describe("ReplySettingsSection 渠道连接", () => {
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
  it("空态渲染提示", async () => {
    renderUI(<ReplySettingsSection />, makeBridge());
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
    const bridge = makeBridge({ replyGetDebugLog: vi.fn().mockResolvedValue(entries) });
    renderUI(<ReplySettingsSection />, bridge);
    // 20 条各一个「详情」展开按钮
    await waitFor(() => expect(screen.getAllByText("详情")).toHaveLength(20));
    // 展开第一条 → 看到 prompt 与 output
    fireEvent.click(screen.getAllByText("详情")[0]!);
    expect(screen.getByText(/sys-0/)).toBeInTheDocument();
    expect(screen.getByText("out-0")).toBeInTheDocument();
  });
});
