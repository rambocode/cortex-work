// 右侧执行过程区（U4）测试：渲染/空集 null、流式更新、会话隔离、不改 PersonalRightPanel 宽度、
// reduced-motion、门控、窄窗退化、键盘可达。

import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CoreProvider, personalProcessKeys, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type { Message } from "@cortex-work/core/types";
import { PersonalProcessPanel } from "./PersonalProcessPanel";

const bridge = { loadChat: async () => [], saveChat: async () => {} } as unknown as DesktopBridge;

// agentLog 过程步骤工厂。active=true 表示运行中（默认展开、不可收起）。
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

// 把过程浮层挂进一个可控宽度的容器（模拟 .pw-center-col 实际可用宽度）。
// jsdom clientWidth 恒为 0,会被当成窄窗 → 这里给容器实例定义 clientWidth getter。
function renderPanel(opts: {
  process?: Message[];
  sessionId?: string;
  activeSessionId?: string;
  // 中栏可用宽度;默认宽窗（>阈值 480）。设 < 480 触发窄窗退化。
  colWidth?: number;
  view?: Partial<{ homeOpen: boolean; automationOpen: boolean; settingsOpen: boolean; noteEditorId: string; timelineProjectId: string }>;
}) {
  const sessionId = opts.sessionId ?? "s1";
  const activeSessionId = opts.activeSessionId ?? sessionId;
  const qc = new QueryClient();
  if (opts.process) qc.setQueryData(personalProcessKeys.detail(sessionId), opts.process);
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
    ...opts.view,
  });
  // 模拟 .pw-center-col：浮层的直接父元素，clientWidth 决定窄窗退化。
  const col = document.createElement("div");
  Object.defineProperty(col, "clientWidth", { configurable: true, value: opts.colWidth ?? 900 });
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

  it("过程流为空时 return null（不渲染浮层）", async () => {
    const { view } = renderPanel({ process: [] });
    await waitFor(() => expect(view.container.querySelector(".chat")).toBeNull());
    expect(view.container.querySelector(".pw-process")).toBeNull();
  });

  it("无过程 query（undefined）时也 return null", async () => {
    const { view } = renderPanel({});
    await new Promise((r) => setTimeout(r, 0));
    expect(view.container.querySelector(".pw-process")).toBeNull();
  });
});

describe("PersonalProcessPanel 流式更新 / 结束收起可重开", () => {
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

  it("finalizeRun 后（active 全 false）收起为可重开入口，再点开仍显示该轮过程", async () => {
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
    // 收起为可重开入口（role=button），不再展开 body。
    const entry = await waitFor(() => {
      const el = view.container.querySelector('.pw-process .pw-process-entry[role="button"]');
      if (!el) throw new Error("collapsed entry 未出现");
      return el as HTMLElement;
    });
    expect(entry.getAttribute("aria-expanded")).toBe("false");
    // 点开 → 重新展开，仍显示该轮过程（数据保留）。
    fireEvent.click(entry);
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument();
      expect(view.container.textContent).toContain("Bash · ls");
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
    Object.defineProperty(col, "clientWidth", { configurable: true, value: 900 });
    document.body.appendChild(col);
    const view = render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
        <PersonalProcessPanel />
      </CoreProvider>,
      { container: col },
    );
    // B 无过程 → 浮层不渲染（A 的过程不冒到 B）。
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
    Object.defineProperty(col, "clientWidth", { configurable: true, value: 900 });
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

  it("浮层不渲染进 PersonalRightPanel（无 .pw-rp-* 结构）、不改 rightView", async () => {
    const { view } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })],
    });
    await waitFor(() => expect(view.container.querySelector(".pw-process")).toBeInTheDocument());
    // 过程区是独立浮层，不含右栏视图链的任何节点。
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
});

describe("PersonalProcessPanel 窄窗退化", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  it("中栏宽度 < 阈值时退化为底部贴附/单行摘要（is-narrow + is-collapsed），不展开 body", async () => {
    const process = [logMsg({ uid: "l1", active: true, items: [{ ic: "check", text: "Bash · ls" }, { ic: "running", text: "Edit · b.ts" }] })];
    // colWidth=400 < 480 → 窄窗。
    const { view } = renderPanel({ process, colWidth: 400 });
    const panel = await waitFor(() => {
      const el = view.container.querySelector(".pw-process");
      if (!el) throw new Error("panel 未出现");
      return el;
    });
    expect(panel.classList.contains("is-narrow")).toBe(true);
    expect(panel.classList.contains("is-collapsed")).toBe(true);
    // 退化为单行摘要：不展开步骤 body，仅入口标签（含步数）。
    expect(view.container.querySelector(".pw-process-body")).toBeNull();
    expect(view.container.textContent).toContain("2 步");
  });

  it("宽窗（>阈值）运行中时正常展开 body", async () => {
    const process = [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })];
    const { view } = renderPanel({ process, colWidth: 900 });
    await waitFor(() => {
      expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument();
      expect(view.container.querySelector(".pw-process-body")).toBeInTheDocument();
    });
  });
});

describe("PersonalProcessPanel 键盘可达 / 不抢焦点", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  it("收起入口键盘可聚焦并可激活（role=button + tabindex），Enter/Space 展开", async () => {
    // 完成态 → 默认收起为入口。
    const process = [logMsg({ uid: "l1", active: false, items: [{ ic: "check", text: "Bash · ls" }] })];
    const { view } = renderPanel({ process });
    const entry = await waitFor(() => {
      const el = view.container.querySelector('.pw-process-entry[role="button"]') as HTMLElement | null;
      if (!el) throw new Error("entry 未出现");
      return el;
    });
    expect(entry.getAttribute("tabindex")).toBe("0");
    entry.focus();
    expect(document.activeElement).toBe(entry);
    fireEvent.keyDown(entry, { key: "Enter" });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-expanded")).toBeInTheDocument());
  });

  it("浮层出现不抢当前焦点（无 autoFocus）", async () => {
    // 预先聚焦一个外部输入,浮层挂载后焦点不应被夺走。
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
