// 右侧执行过程区（U4）测试：渲染/空集 null、流式更新、会话隔离、不改 PersonalRightPanel 宽度、
// 门控、默认展开、用户折叠、键盘可达。

import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CoreProvider, personalChatKeys, personalProcessKeys, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type { Message } from "@cortex-work/core/types";
import { PersonalProcessPanel } from "./PersonalProcessPanel";

const bridge = { loadChat: async () => [], saveChat: async () => {} } as unknown as DesktopBridge;

// agentLog 过程步骤工厂。active=true 表示运行中。
function logMsg(opts: { uid: string; active?: boolean; items: { ic: "check" | "running" | "pending" | "dot"; text: string }[]; title?: string }): Message {
  return {
    kind: "agentLog",
    who: "claude",
    time: "12:00",
    title: opts.title ?? "执行",
    active: opts.active,
    items: opts.items,
    uid: opts.uid,
  };
}

// 把过程区挂进一个可控容器（模拟 .pw-center-col）。
function renderPanel(opts: {
  process?: Message[];
  messages?: Message[];
  sessionId?: string;
  activeSessionId?: string;
  running?: boolean;
  extensionCommand?: boolean;
  view?: Partial<{ homeOpen: boolean; automationOpen: boolean; settingsOpen: boolean; noteEditorId: string; timelineProjectId: string }>;
}) {
  const sessionId = opts.sessionId ?? "s1";
  const activeSessionId = opts.activeSessionId ?? sessionId;
  const qc = new QueryClient();
  if (opts.process) qc.setQueryData(personalProcessKeys.detail(sessionId), opts.process);
  if (opts.messages) qc.setQueryData(personalChatKeys.detail(sessionId), opts.messages);
  usePersonalStore.setState({
    homeOpen: false,
    automationOpen: false,
    settingsOpen: false,
    noteEditorId: undefined,
    timelineProjectId: undefined,
    projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: 0 }],
    sessions: [{ id: sessionId, projectId: "p1", title: "S1", agent: "claude", createdAt: 0, updatedAt: 0 }],
    activeProjectId: "p1",
    activeSessionId,
    runningBySession: opts.running ? { [activeSessionId]: "run-1" } : {},
    piRuntimeBySession: opts.extensionCommand ? { [activeSessionId]: { extensionCommand: true } } : {},
    ...opts.view,
  });
  // 模拟 .pw-center-col：过程区的直接父元素。
  const col = document.createElement("div");
  document.body.appendChild(col);
  const view = render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
      <PersonalProcessPanel />
    </CoreProvider>,
    { container: col },
  );
  return { qc, view, sessionId, col };
}

describe("PersonalProcessPanel 渲染 / 空集", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  it("当前会话有过程流时渲染过程区并展示步骤", async () => {
    const process = [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })];
    const { view } = renderPanel({ process });
    await waitFor(() => expect(view.container.querySelector(".pw-process")).toBeInTheDocument());
    expect(view.container.textContent).toContain("Bash · ls");
  });

  it("过程流为空时 return null（不渲染过程区）", async () => {
    const { view } = renderPanel({ process: [] });
    await waitFor(() => expect(view.container.querySelector(".chat")).toBeNull());
    expect(view.container.querySelector(".pw-process")).toBeNull();
  });

  it("无过程 query（undefined）时也 return null", async () => {
    const { view } = renderPanel({});
    await new Promise((r) => setTimeout(r, 0));
    expect(view.container.querySelector(".pw-process")).toBeNull();
  });

  it("扩展命令轮(运行中但无过程步骤)→ 不渲染过程区(避免空态闪现)", async () => {
    const { view } = renderPanel({ running: true, extensionCommand: true });
    // 即便 running,扩展命令无过程步骤时也不渲染（命令输出在消息流）。
    expect(view.container.querySelector(".pw-process")).toBeNull();
  });

  it("扩展命令轮但有过程步骤 → 仍渲染(不误伤真有步骤的轮)", async () => {
    const { view } = renderPanel({
      running: true,
      extensionCommand: true,
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "step" }] })],
    });
    await waitFor(() => expect(view.container.querySelector(".pw-process")).toBeInTheDocument());
  });

  it("挂载时无过程但当前会话运行中,立即显示右侧回复状态", async () => {
    const { view, qc, sessionId } = renderPanel({ running: true });
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument();
      expect(view.container.textContent).toContain("Claude Code 正在响应");
    });
    act(() => {
      qc.setQueryData(personalProcessKeys.detail(sessionId), [
        logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · first" }] }),
      ]);
    });
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument();
      expect(view.container.textContent).toContain("Bash · first");
    });
  });

  it("无过程但 typing 状态变化时,右侧回复状态同步更新", async () => {
    const { view, qc, sessionId } = renderPanel({
      running: true,
      messages: [{ kind: "typing", who: "claude", uid: "typing-1", text: "Claude Code 正在启动..." }],
    });
    await waitFor(() => expect(view.container.textContent).toContain("Claude Code 正在启动"));
    act(() => {
      qc.setQueryData<Message[]>(personalChatKeys.detail(sessionId), [
        { kind: "typing", who: "claude", uid: "typing-1", text: "Claude Code 正在执行工具 Bash · git status" },
      ]);
    });
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument();
      expect(view.container.textContent).toContain("Claude Code 正在执行工具 Bash · git status");
    });
  });
});

describe("PersonalProcessPanel 流式更新 / 默认展开 / 用户折叠", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  it("流式追加 tool 步骤时过程区增量更新", async () => {
    const { view, qc, sessionId } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })],
    });
    await waitFor(() => expect(view.container.textContent).toContain("Bash · ls"));
    act(() => {
      qc.setQueryData(personalProcessKeys.detail(sessionId), [
        logMsg({ uid: "l1", active: true, items: [{ ic: "check", text: "Bash · ls" }, { ic: "running", text: "Edit · b.ts" }] }),
      ]);
    });
    await waitFor(() => expect(view.container.textContent).toContain("Edit · b.ts"));
  });

  it("finalizeRun 后（active 全 false）仍保持展开,保留最近一次过程", async () => {
    const { view, qc, sessionId } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })],
    });
    // 运行中默认展开：有 head（含「执行过程」标题），body 内可见步骤。
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument());
    // 模拟收尾：active 翻 false（步骤打勾）。
    act(() => {
      qc.setQueryData(personalProcessKeys.detail(sessionId), [
        logMsg({ uid: "l1", active: false, items: [{ ic: "check", text: "Bash · ls" }] }),
      ]);
    });
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument();
      expect(view.container.querySelector(".pw-process-body")).toBeInTheDocument();
      expect(view.container.textContent).toContain("Bash · ls");
    });
    expect(view.container.querySelector(".pw-process-entry")).toBeNull();
  });

  it("运行中也允许用户折叠;同一轮新增步骤不强制重新展开", async () => {
    const { view, qc, sessionId } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })],
    });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument());
    // 点击头部即折叠：body 收起,只剩头部一行。
    fireEvent.click(view.container.querySelector(".pw-process-head") as HTMLElement);
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument();
      expect(view.container.querySelector(".pw-process-body")).toBeNull();
    });
    act(() => {
      qc.setQueryData(personalProcessKeys.detail(sessionId), [
        logMsg({ uid: "l1", active: true, items: [{ ic: "check", text: "Bash · ls" }, { ic: "running", text: "Edit · b.ts" }] }),
      ]);
    });
    // 同一轮新增步骤不强制重新展开：仍折叠（body 不渲染,故不显示步骤文本）。
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument();
      expect(view.container.querySelector(".pw-process-body")).toBeNull();
    });
  });

  it("下一轮过程流替换后恢复默认展开", async () => {
    const { view, qc, sessionId } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })],
    });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument());
    fireEvent.click(view.container.querySelector(".pw-process-head") as HTMLElement);
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
    act(() => {
      qc.setQueryData(personalProcessKeys.detail(sessionId), [
        logMsg({ uid: "l2", active: true, items: [{ ic: "running", text: "Bash · pwd" }] }),
      ]);
    });
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument();
      expect(view.container.textContent).toContain("Bash · pwd");
    });
  });
});

describe("PersonalProcessPanel 会话隔离（R7）", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  it("过程挂在会话 A，activeSessionId 为 B 时不显示 A 的过程；切回 A 重现", async () => {
    const qc = new QueryClient();
    qc.setQueryData(personalProcessKeys.detail("A"), [logMsg({ uid: "la", active: true, items: [{ ic: "running", text: "Bash · A" }] })]);
    usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined });
    usePersonalStore.setState({
      homeOpen: false,
      automationOpen: false,
      settingsOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: 0 }],
      sessions: [
        { id: "A", projectId: "p1", title: "A", agent: "claude", createdAt: 0, updatedAt: 0 },
        { id: "B", projectId: "p1", title: "B", agent: "claude", createdAt: 0, updatedAt: 0 },
      ],
      activeProjectId: "p1",
      activeSessionId: "B",
    });
    const col = document.createElement("div");
    document.body.appendChild(col);
    const view = render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
        <PersonalProcessPanel />
      </CoreProvider>,
      { container: col },
    );
    // B 无过程 → 过程区不渲染（A 的过程不冒到 B）。
    await new Promise((r) => setTimeout(r, 0));
    expect(view.container.querySelector(".pw-process")).toBeNull();
    // 切回 A → A 过程重现。
    act(() => usePersonalStore.setState({ activeSessionId: "A" }));
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process")).toBeInTheDocument();
      expect(view.container.textContent).toContain("Bash · A");
    });
  });
});

describe("PersonalProcessPanel 多会话并发（U5）：只渲染 activeSessionId 那份", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  it("A、B 同时有过程流时,过程区只显示当前会话(A)的过程,切到 B 显示 B 的", async () => {
    const qc = new QueryClient();
    // 两会话各自累积过程流（并发运行）。
    qc.setQueryData(personalProcessKeys.detail("A"), [
      logMsg({ uid: "la", active: true, items: [{ ic: "running", text: "Bash · A 步骤" }] }),
    ]);
    qc.setQueryData(personalProcessKeys.detail("B"), [
      logMsg({ uid: "lb", active: true, items: [{ ic: "running", text: "Edit · B 步骤" }] }),
    ]);
    usePersonalStore.setState({
      homeOpen: false,
      automationOpen: false,
      settingsOpen: false,
      noteEditorId: undefined,
      timelineProjectId: undefined,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: 0 }],
      sessions: [
        { id: "A", projectId: "p1", title: "A", agent: "claude", createdAt: 0, updatedAt: 0 },
        { id: "B", projectId: "p1", title: "B", agent: "claude", createdAt: 0, updatedAt: 0 },
      ],
      activeProjectId: "p1",
      activeSessionId: "A",
    });
    const col = document.createElement("div");
    document.body.appendChild(col);
    const view = render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
        <PersonalProcessPanel />
      </CoreProvider>,
      { container: col },
    );
    // 当前会话 A:只见 A 的步骤,不见 B 的（互不串台）。
    await waitFor(() => expect(view.container.textContent).toContain("Bash · A 步骤"));
    expect(view.container.textContent).not.toContain("Edit · B 步骤");
    // 切到 B:只见 B 的步骤,不见 A 的。
    act(() => usePersonalStore.setState({ activeSessionId: "B" }));
    await waitFor(() => {
      expect(view.container.textContent).toContain("Edit · B 步骤");
      expect(view.container.textContent).not.toContain("Bash · A 步骤");
    });
  });
});

describe("PersonalProcessPanel 不改右栏（R6）", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  it("过程区不渲染进 PersonalRightPanel（无 .pw-rp-* 结构）、不改 rightView", async () => {
    const { view } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })],
    });
    await waitFor(() => expect(view.container.querySelector(".pw-process")).toBeInTheDocument());
    // 过程区独立于右栏视图链。
    expect(view.container.querySelector(".pw-rp-view")).toBeNull();
    expect(view.container.querySelector(".right")).toBeNull();
  });
});

describe("PersonalProcessPanel 门控（中栏非会话区不渲染）", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  const process = [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })];

  it.each([
    ["automationOpen", { automationOpen: true }],
    ["homeOpen", { homeOpen: true }],
    ["settingsOpen", { settingsOpen: true }],
    ["noteEditorId", { noteEditorId: "n1" }],
    ["timelineProjectId", { timelineProjectId: "p1" }],
  ])("%s 打开（中栏非会话区）时过程区不渲染", async (_name, view) => {
    const r = renderPanel({ process, view });
    await new Promise((res) => setTimeout(res, 0));
    expect(r.view.container.querySelector(".pw-process")).toBeNull();
  });

  it("timelineProjectId 残留但项目不存在时仍按会话区渲染过程", async () => {
    const r = renderPanel({ process, view: { timelineProjectId: "missing-project" } });
    await waitFor(() => {
      expect(r.view.container.querySelector(".pw-process")).toBeInTheDocument();
      expect(r.view.container.textContent).toContain("Bash · ls");
    });
  });
});

describe("PersonalProcessPanel 默认展开", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  it("运行中正常展开 body,不使用窄窗底部贴附形态", async () => {
    const process = [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })];
    const { view } = renderPanel({ process });
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument();
      expect(view.container.querySelector(".pw-process-body")).toBeInTheDocument();
    });
    expect(view.container.querySelector(".pw-process.is-narrow")).toBeNull();
  });
});

describe("PersonalProcessPanel 键盘可达 / 不抢焦点", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  it("头部即折叠开关，键盘可聚焦并可激活（role=button + tabindex），Enter 切换展开/收起", async () => {
    const process = [logMsg({ uid: "l1", active: false, items: [{ ic: "check", text: "Bash · ls" }] })];
    const { view } = renderPanel({ process });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument());
    const head = view.container.querySelector('.pw-process-head[role="button"]') as HTMLElement;
    expect(head).not.toBeNull();
    expect(head.getAttribute("tabindex")).toBe("0");
    head.focus();
    expect(document.activeElement).toBe(head);
    // Enter 收起。
    fireEvent.keyDown(head, { key: "Enter" });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
    // Enter 再次展开。
    fireEvent.keyDown(head, { key: "Enter" });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument());
  });

  it("过程区出现不抢当前焦点（无 autoFocus）", async () => {
    // 预先聚焦一个外部输入,过程区挂载后焦点不应被夺走。
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    const process = [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })];
    renderPanel({ process });
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(input);
    input.remove();
  });
});
