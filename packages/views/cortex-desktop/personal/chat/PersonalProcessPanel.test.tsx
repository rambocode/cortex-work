// 右侧执行过程入口（U4）测试：圆形状态 icon 的渲染/门控/会话隔离/键盘可达,
// 以及点击 icon 直接打开运行过程详情弹层(AgentTranscriptDialog)。
// 旧「向下展开步骤卡片」形态已移除,相关展开/收起用例一并删除。

import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CoreProvider,
  personalProcessKeys,
  personalRunEventsKeys,
  usePersonalStore,
  type RunEvent,
} from "@cortex-work/core";
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

// 运行事件工厂:tool start 事件(详情弹层数据源)。
function toolRunEvent(runId: string, name: string, detail: string): RunEvent {
  return { runId, ts: Date.now(), ev: { type: "tool", name, detail, phase: "start", toolCallId: `${name}-1` } };
}

// 点击圆形 icon → 打开详情弹层。
function openDialog(container: HTMLElement) {
  fireEvent.click(container.querySelector(".pw-process.is-collapsed") as HTMLElement);
}

// 把入口挂进一个可控容器（模拟 .pw-center-col）。
function renderPanel(opts: {
  process?: Message[];
  runEvents?: RunEvent[];
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
  if (opts.runEvents) qc.setQueryData(personalRunEventsKeys.detail(sessionId), opts.runEvents);
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
  // 模拟 .pw-center-col：入口的直接父元素。
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

  it("当前会话有过程流时渲染圆形 icon(单一形态,无展开卡片)", async () => {
    const process = [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })];
    const { view } = renderPanel({ process });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
    expect(view.container.querySelector(".pw-process-fab-ic")).toBeInTheDocument();
    // 旧展开卡片形态不复存在。
    expect(view.container.querySelector(".pw-process-body")).toBeNull();
    expect(view.container.querySelector(".pw-process.is-expanded")).toBeNull();
  });

  it("过程流为空且未运行时 return null（不渲染入口）", async () => {
    const { view } = renderPanel({ process: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(view.container.querySelector(".pw-process")).toBeNull();
  });

  it("无过程 query（undefined）时也 return null", async () => {
    const { view } = renderPanel({});
    await new Promise((r) => setTimeout(r, 0));
    expect(view.container.querySelector(".pw-process")).toBeNull();
  });

  it("扩展命令轮(运行中但无过程步骤)→ 不渲染入口(避免空态闪现)", async () => {
    const { view } = renderPanel({ running: true, extensionCommand: true });
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

  it("挂载时无过程但当前会话运行中,立即显示 icon(data-active=true 运行中转圈)", async () => {
    const { view } = renderPanel({ running: true });
    await waitFor(() =>
      expect(view.container.querySelector('.pw-process.is-collapsed[data-active="true"]')).toBeInTheDocument(),
    );
  });

  it("finalizeRun 后（active 全 false 且 runId 清空）icon 翻完成态(绿勾)", async () => {
    const { view, qc, sessionId } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })],
    });
    await waitFor(() =>
      expect(view.container.querySelector('.pw-process.is-collapsed[data-active="true"]')).toBeInTheDocument(),
    );
    act(() => {
      qc.setQueryData(personalProcessKeys.detail(sessionId), [
        logMsg({ uid: "l1", active: false, items: [{ ic: "check", text: "Bash · ls" }] }),
      ]);
    });
    await waitFor(() =>
      expect(view.container.querySelector('.pw-process.is-collapsed[data-active="false"]')).toBeInTheDocument(),
    );
  });
});

describe("PersonalProcessPanel 点击 icon 打开详情弹层", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  it("点击 icon → 打开 AgentTranscriptDialog;调用/结果分行,输出可见;关闭按钮可关", async () => {
    const now = Date.now();
    const { view } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })],
      runEvents: [
        toolRunEvent("run-1", "Bash", "ls -la"),
        // 结果帧:与上面 start 同 toolCallId(Bash-1),独立成结果行,输出灰色展示。
        {
          runId: "run-1",
          ts: now,
          ev: { type: "tool", name: "", phase: "end", toolCallId: "Bash-1", output: "a.txt\nb.txt", isError: false },
        },
        // 模型输出段(全链路):思考与回复各一段。
        { runId: "run-1", ts: now, ev: { type: "thinking", delta: "先想想" } },
        { runId: "run-1", ts: now, ev: { type: "text", delta: "最终回复正文" } },
      ],
    });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
    // 弹层默认不挂载。
    expect(view.container.querySelector(".pw-transcript-dlg")).toBeNull();
    openDialog(view.container);
    await waitFor(() => expect(view.container.querySelector(".pw-transcript-dlg")).toBeInTheDocument());
    // 调用行与结果行各自独立(multica 风格);结果行摘要展示输出首行。
    await waitFor(() => {
      expect(view.container.querySelector(".pw-transcript-row.is-tool-call")).toBeInTheDocument();
      expect(view.container.querySelector(".pw-transcript-row.is-tool-result")).toBeInTheDocument();
      expect(view.container.textContent).toContain("a.txt");
    });
    // 全链路:思考段与回复段也在时间线上。
    expect(view.container.textContent).toContain("先想想");
    expect(view.container.textContent).toContain("最终回复正文");
    // 点关闭按钮 → 弹层卸载。
    fireEvent.click(view.container.querySelector('.pw-transcript-head .pw-icon-btn[title="关闭"]') as HTMLElement);
    await waitFor(() => expect(view.container.querySelector(".pw-transcript-dlg")).toBeNull());
  });

  it("usage 带 cachedInputTokens → 统计栏显示缓存 token 数(真实成本口径)", async () => {
    const now = Date.now();
    const { view } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "step" }] })],
      runEvents: [
        {
          runId: "run-1",
          ts: now,
          ev: { type: "usage", inputTokens: 162491, outputTokens: 2696, cachedInputTokens: 152832 },
        },
      ],
    });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
    openDialog(view.container);
    await waitFor(() => expect(view.container.querySelector(".pw-transcript-dlg")).toBeInTheDocument());
    // 运行事件经 query 异步到达,统计栏断言需等待。
    await waitFor(() => expect(view.container.textContent).toContain("162,491"));
    expect(view.container.textContent).toContain("2,696");
    // codex ws 的 cachedInputTokens 需展示,否则累计 input 数字会让用户误判成本。
    expect(view.container.textContent).toContain("缓存 152,832");
  });

  it("工具 end 帧无输出但带 detail(webSearch 查询词)→ 结果行显示查询词,并回填空 detail 的调用行", async () => {
    const now = Date.now();
    const { view } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "step" }] })],
      runEvents: [
        // 模拟 codex webSearch:started 时查询词为空(input 快照 query:""),completed 才带查询词、无输出正文。
        {
          runId: "run-1",
          ts: now,
          ev: { type: "tool", name: "WebSearch", phase: "start", toolCallId: "ws-1", input: { type: "webSearch", query: "", action: { type: "other" } } },
        },
        {
          runId: "run-1",
          ts: now,
          ev: { type: "tool", name: "WebSearch", phase: "end", toolCallId: "ws-1", detail: "AI 资讯 本周", input: { type: "webSearch", query: "AI 资讯 本周", action: { type: "search" } } },
        },
      ],
    });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
    openDialog(view.container);
    await waitFor(() => expect(view.container.querySelector(".pw-transcript-dlg")).toBeInTheDocument());
    // 运行事件经 query 异步到达,先等结果行渲染出来再断言内容。
    await waitFor(() => expect(view.container.querySelector(".pw-transcript-row.is-tool-result")).toBeInTheDocument());
    const resultRow = view.container.querySelector(".pw-transcript-row.is-tool-result");
    expect(resultRow?.textContent).toContain("AI 资讯 本周");
    expect(resultRow?.textContent).not.toContain("(无输出内容)");
    // 调用行的空 detail 被 end 帧回填,不再是空摘要。
    const callRow = view.container.querySelector(".pw-transcript-row.is-tool-call");
    expect(callRow?.textContent).toContain("AI 资讯 本周");
    // 展开调用行 → 输入参数 JSON 也被完成帧覆盖(不再是 started 时 query:"" 的快照)。
    fireEvent.click(callRow!.querySelector(".pw-transcript-row-main") as HTMLElement);
    await waitFor(() => expect(callRow?.textContent).toContain('"query": "AI 资讯 本周"'));
    expect(callRow?.textContent).not.toContain('"query": ""');
  });

  it("processPanelOpenReq(点聊天流 typing 行)→ 直接打开弹层", async () => {
    const { view, sessionId } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })],
    });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
    act(() => {
      usePersonalStore.setState({ processPanelOpenReq: { sessionId, nonce: 1 } });
    });
    await waitFor(() => expect(view.container.querySelector(".pw-transcript-dlg")).toBeInTheDocument());
  });

  it("子代理卡请求只展示该 callId 的过程，且无会话级过程 FAB 时仍能打开", async () => {
    const { view, sessionId } = renderPanel({
      runEvents: [
        { ...toolRunEvent("run-1", "Read", "src/target.ts"), ev: { ...toolRunEvent("run-1", "Read", "src/target.ts").ev, subagentCallId: "call-target" } },
        { ...toolRunEvent("run-1", "Bash", "echo unrelated"), ev: { ...toolRunEvent("run-1", "Bash", "echo unrelated").ev, subagentCallId: "call-other" } },
      ],
    });
    expect(view.container.querySelector(".pw-process.is-collapsed")).not.toBeInTheDocument();
    act(() => {
      usePersonalStore.getState().requestOpenProcessPanel(sessionId, {
        callId: "call-target",
        label: "Repository Explorer",
      });
    });
    await waitFor(() => expect(view.getByRole("dialog", { name: "子代理过程：Repository Explorer" })).toBeInTheDocument());
    expect(view.getByText("src/target.ts")).toBeInTheDocument();
    expect(view.queryByText("echo unrelated")).not.toBeInTheDocument();
  });

  it("切会话 → 已打开的弹层自动关闭(不残留上一会话内容)", async () => {
    const { view } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })],
      running: true,
    });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
    openDialog(view.container);
    await waitFor(() => expect(view.container.querySelector(".pw-transcript-dlg")).toBeInTheDocument());
    act(() => {
      usePersonalStore.setState({
        sessions: [
          { id: "s1", projectId: "p1", title: "S1", agent: "claude", createdAt: 0, updatedAt: 0 },
          { id: "s2", projectId: "p1", title: "S2", agent: "claude", createdAt: 0, updatedAt: 0 },
        ],
        activeSessionId: "s2",
        runningBySession: { s2: "run-2" },
      });
    });
    await waitFor(() => expect(view.container.querySelector(".pw-transcript-dlg")).toBeNull());
  });
});

describe("PersonalProcessPanel 会话隔离（R7）", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  it("过程挂在会话 A，activeSessionId 为 B 时不显示 A 的入口；切回 A 弹层只见 A 的事件", async () => {
    const qc = new QueryClient();
    qc.setQueryData(personalProcessKeys.detail("A"), [
      logMsg({ uid: "la", active: true, items: [{ ic: "running", text: "Bash · A" }] }),
    ]);
    qc.setQueryData(personalRunEventsKeys.detail("A"), [toolRunEvent("run-a", "Bash", "echo A-cmd")]);
    qc.setQueryData(personalRunEventsKeys.detail("B"), [toolRunEvent("run-b", "Edit", "B-file.ts")]);
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
      activeSessionId: "B",
      runningBySession: {},
    });
    const col = document.createElement("div");
    document.body.appendChild(col);
    const view = render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
        <PersonalProcessPanel />
      </CoreProvider>,
      { container: col },
    );
    // B 无过程且未运行 → 入口不渲染（A 的过程不冒到 B）。
    await new Promise((r) => setTimeout(r, 0));
    expect(view.container.querySelector(".pw-process")).toBeNull();
    // 切回 A → 入口重现,弹层只见 A 的运行事件。
    act(() => usePersonalStore.setState({ activeSessionId: "A" }));
    await waitFor(() => expect(view.container.querySelector(".pw-process")).toBeInTheDocument());
    openDialog(view.container as HTMLElement);
    await waitFor(() => expect(view.container.textContent).toContain("echo A-cmd"));
    expect(view.container.textContent).not.toContain("B-file.ts");
  });
});

describe("PersonalProcessPanel 不改右栏（R6）", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  it("入口不渲染进 PersonalRightPanel（无 .pw-rp-* 结构）、不改 rightView", async () => {
    const { view } = renderPanel({
      process: [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })],
    });
    await waitFor(() => expect(view.container.querySelector(".pw-process")).toBeInTheDocument());
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
  ])("%s 打开（中栏非会话区）时入口不渲染", async (_name, view) => {
    const r = renderPanel({ process, view });
    await new Promise((res) => setTimeout(res, 0));
    expect(r.view.container.querySelector(".pw-process")).toBeNull();
  });

  it("timelineProjectId 残留但项目不存在时仍按会话区渲染入口", async () => {
    const r = renderPanel({ process, view: { timelineProjectId: "missing-project" } });
    await waitFor(() => expect(r.view.container.querySelector(".pw-process")).toBeInTheDocument());
  });
});

describe("PersonalProcessPanel 键盘可达 / 不抢焦点", () => {
  afterEach(() => cleanup());
  beforeEach(() => usePersonalStore.setState({ homeOpen: false, automationOpen: false, settingsOpen: false, noteEditorId: undefined, timelineProjectId: undefined }));

  it("入口是原生 <button>,点击打开弹层;弹层内 Esc 关闭", async () => {
    const process = [logMsg({ uid: "l1", active: true, items: [{ ic: "running", text: "Bash · ls" }] })];
    const { view } = renderPanel({ process });
    await waitFor(() => expect(view.container.querySelector(".pw-process.is-collapsed")).toBeInTheDocument());
    const fab = view.container.querySelector(".pw-process.is-collapsed") as HTMLElement;
    expect(fab.tagName).toBe("BUTTON");
    fireEvent.click(fab);
    await waitFor(() => expect(view.container.querySelector(".pw-transcript-dlg")).toBeInTheDocument());
    fireEvent.keyDown(view.container.querySelector(".pw-transcript-dlg") as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(view.container.querySelector(".pw-transcript-dlg")).toBeNull());
  });

  it("入口出现不抢当前焦点（无 autoFocus）", async () => {
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
