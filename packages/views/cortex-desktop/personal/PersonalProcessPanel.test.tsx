// 右侧执行过程区（U4）测试：渲染/空集 null、流式更新、会话隔离、不改 PersonalRightPanel 宽度、
// 门控、默认收起为圆形 icon、点击向下展开、跨轮恢复默认收起、键盘可达。

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

// 默认收起为圆形 icon（is-collapsed 按钮），body 不渲染：点击 icon 把过程区向下展开，露出步骤/回复状态。
function expandPanel(container: HTMLElement) {
  fireEvent.click(container.querySelector(".pw-process.is-collapsed") as HTMLElement);
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

  it("当前会话有过程流时渲染过程区（默认收起为圆形 icon），展开后展示步骤", async () => {
    const process = [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })];
    const { view } = renderPanel({ process });
    // 默认收起：圆形 icon 按钮（含 fab-ic），body 未渲染、步骤不可见。
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
    expect(view.container.querySelector(".pw-process-fab-ic")).toBeInTheDocument();
    expect(view.container.querySelector(".pw-process-body")).toBeNull();
    expect(view.container.textContent).not.toContain("Bash · ls");
    // 点击 icon 向下展开 → 步骤可见。
    expandPanel(view.container);
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument();
      expect(view.container.textContent).toContain("Bash · ls");
    });
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

  it("挂载时无过程但当前会话运行中,立即显示收起态 icon(运行中),展开后见回复状态", async () => {
    const { view } = renderPanel({ running: true });
    // 默认收起：圆形 icon（data-active=true 即运行中转圈），body 未渲染。
    await waitFor(() => expect(view.container.querySelector('.pw-process.is-collapsed[data-active="true"]')).toBeInTheDocument());
    expect(view.container.querySelector(".pw-process-body")).toBeNull();
    // 展开后才见右侧回复状态文本。
    expandPanel(view.container);
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument();
      expect(view.container.textContent).toContain("Claude Code 正在响应");
    });
  });

  it("无过程但 typing 状态变化时,展开态下回复状态同步更新", async () => {
    const { view, qc, sessionId } = renderPanel({
      running: true,
      messages: [{ kind: "typing", who: "claude", uid: "typing-1", text: "Claude Code 正在启动..." }],
    });
    // 无过程步骤、runId 稳定 → processResetKey 稳定，展开后保持展开。
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
    expandPanel(view.container);
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

describe("PersonalProcessPanel 流式更新 / 默认收起 / 用户展开", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  it("展开后流式追加 tool 步骤时过程区增量更新(同一轮保持展开)", async () => {
    const { view, qc, sessionId } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })],
    });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
    expandPanel(view.container);
    await waitFor(() => expect(view.container.textContent).toContain("Bash · ls"));
    // 同一 uid 追加 items：processResetKey 不变，保持展开。
    act(() => {
      qc.setQueryData(personalProcessKeys.detail(sessionId), [
        logMsg({ uid: "l1", active: true, items: [{ ic: "check", text: "Bash · ls" }, { ic: "running", text: "Edit · b.ts" }] }),
      ]);
    });
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument();
      expect(view.container.textContent).toContain("Edit · b.ts");
    });
  });

  it("finalizeRun 后（active 全 false）保持默认收起为圆形 icon", async () => {
    const { view, qc, sessionId } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })],
    });
    // 默认收起：圆形 icon（运行中）。
    await waitFor(() => expect(view.container.querySelector('.pw-process.is-collapsed[data-active="true"]')).toBeInTheDocument());
    // 模拟收尾：active 翻 false（步骤打勾）。
    act(() => {
      qc.setQueryData(personalProcessKeys.detail(sessionId), [
        logMsg({ uid: "l1", active: false, items: [{ ic: "check", text: "Bash · ls" }] }),
      ]);
    });
    await waitFor(() => {
      // 仍收起：圆形 icon（fab-ic 在），body 不渲染，data-active 翻 false（完成绿勾）。
      expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument();
      expect(view.container.querySelector(".pw-process-fab-ic")).toBeInTheDocument();
      expect(view.container.querySelector(".pw-process-body")).toBeNull();
      expect(view.container.querySelector('.pw-process.is-collapsed[data-active="false"]')).toBeInTheDocument();
      expect(view.container.querySelector('.pw-process.is-collapsed[aria-label="展开执行过程"]')).toBeInTheDocument();
    });
  });

  it("用户展开后,同一轮新增步骤不强制重新收起", async () => {
    const { view, qc, sessionId } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })],
    });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
    // 点击 icon 展开。
    expandPanel(view.container);
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument());
    act(() => {
      qc.setQueryData(personalProcessKeys.detail(sessionId), [
        logMsg({ uid: "l1", active: true, items: [{ ic: "check", text: "Bash · ls" }, { ic: "running", text: "Edit · b.ts" }] }),
      ]);
    });
    // 同一轮（uid 不变）新增步骤：保持展开。
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument();
      expect(view.container.textContent).toContain("Edit · b.ts");
    });
  });

  it("下一轮过程流替换后恢复默认收起", async () => {
    const { view, qc, sessionId } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })],
    });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
    expandPanel(view.container);
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument());
    // 下一轮：首步 uid 变（processResetKey 变）→ 恢复默认收起。
    act(() => {
      qc.setQueryData(personalProcessKeys.detail(sessionId), [
        logMsg({ uid: "l2", active: true, items: [{ ic: "running", text: "Bash · pwd" }] }),
      ]);
    });
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument();
      expect(view.container.querySelector(".pw-process-body")).toBeNull();
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
    // 切回 A → A 过程重现（默认收起，展开后见 A 的步骤）。
    act(() => usePersonalStore.setState({ activeSessionId: "A" }));
    await waitFor(() => expect(view.container.querySelector(".pw-process")).toBeInTheDocument());
    expandPanel(view.container);
    await waitFor(() => expect(view.container.textContent).toContain("Bash · A"));
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
    // 当前会话 A：默认收起，展开后只见 A 的步骤,不见 B 的（互不串台）。
    await waitFor(() => expect(view.container.querySelector(".pw-process")).toBeInTheDocument());
    expandPanel(view.container);
    await waitFor(() => expect(view.container.textContent).toContain("Bash · A 步骤"));
    expect(view.container.textContent).not.toContain("Edit · B 步骤");
    // 切到 B：activeSessionId 变 → 恢复默认收起，展开后只见 B 的步骤,不见 A 的。
    act(() => usePersonalStore.setState({ activeSessionId: "B" }));
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
    expandPanel(view.container);
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

  it("timelineProjectId 残留但项目不存在时仍按会话区渲染过程（展开后见步骤）", async () => {
    const r = renderPanel({ process, view: { timelineProjectId: "missing-project" } });
    await waitFor(() => expect(r.view.container.querySelector(".pw-process")).toBeInTheDocument());
    expandPanel(r.view.container);
    await waitFor(() => expect(r.view.container.textContent).toContain("Bash · ls"));
  });
});

describe("PersonalProcessPanel 默认收起", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  it("运行中默认收起为圆形 icon、body 收起,不使用窄窗底部贴附形态", async () => {
    const process = [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })];
    const { view } = renderPanel({ process });
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument();
      expect(view.container.querySelector(".pw-process-fab-ic")).toBeInTheDocument();
      expect(view.container.querySelector(".pw-process-body")).toBeNull();
    });
    expect(view.container.querySelector(".pw-process.is-narrow")).toBeNull();
  });
});

describe("PersonalProcessPanel 键盘可达 / 不抢焦点", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  it("默认收起为原生 <button> icon，点击展开；展开后头部键盘可激活收起", async () => {
    // 运行中（active=true）默认收起为圆形 icon。
    const process = [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })];
    const { view } = renderPanel({ process });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
    // 收起态是原生 <button>，键盘/读屏可达。
    const fab = view.container.querySelector(".pw-process.is-collapsed") as HTMLElement;
    expect(fab.tagName).toBe("BUTTON");
    fireEvent.click(fab);
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument());
    // 展开态头部即收起开关，键盘可聚焦并可激活。
    const head = view.container.querySelector('.pw-process-head[role="button"]') as HTMLElement;
    expect(head.getAttribute("tabindex")).toBe("0");
    head.focus();
    expect(document.activeElement).toBe(head);
    fireEvent.keyDown(head, { key: "Enter" });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
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
