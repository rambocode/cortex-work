import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CoreProvider,
  personalChatKeys,
  personalProcessKeys,
  usePersonalActions,
  usePersonalStore,
  useCortexUIStore,
} from "@cortex-work/core";
import type { DesktopBridge, SessionMeta } from "@cortex-work/core";
import type { Message } from "@cortex-work/core/types";
import { MessageStream } from "../ChatArea";
import { PersonalChatArea } from "./PersonalChatArea";

const NOW = Date.now();

const bridge = {
  loadChat: async () => [],
  saveChat: async () => {},
} as unknown as DesktopBridge;

function renderArea(onToast: (text: string) => void = () => {}) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <PersonalChatArea onToast={onToast} />
    </CoreProvider>,
  );
}

// 注入指定聊天消息(usePersonalChat 走 bridge.loadChat)的渲染助手。
function renderAreaWithChat(messages: Message[]) {
  const b = { loadChat: async () => messages, saveChat: async () => {} } as unknown as DesktopBridge;
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
      <PersonalChatArea onToast={() => {}} />
    </CoreProvider>,
  );
}

function renderMessageStream(messages: Message[]) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <MessageStream
        contact={{
          id: "pi",
          name: "Pi",
          group: "shared",
          avatar: { initials: "PI", bg: "#4338ca" },
          agentStatus: "online",
          statusText: "",
          last: "",
          time: "",
          unread: 0,
        }}
        convo={{ headerStatus: { dot: "online", text: "" }, metaRow: [], messages }}
        onSelectFile={() => {}}
        activeFile=""
        onApprove={() => {}}
        collapsibleReasoning
      />
    </CoreProvider>,
  );
}

describe("PersonalChatArea 项目引导态（无 session）", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [],
      activeProjectId: "p1",
      activeSessionId: undefined,
      timelineProjectId: undefined,
    });
  });

  it("激活项目但无 session:显示项目名与「新建聊天」引导", () => {
    renderArea();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText(/还没有聊天/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建聊天/ })).toBeInTheDocument();
  });

  it("点击「新建聊天」创建 session 并激活", () => {
    const toast = vi.fn();
    renderArea(toast);
    fireEvent.click(screen.getByRole("button", { name: /新建聊天/ }));
    const s = usePersonalStore.getState();
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0]?.projectId).toBe("p1");
    expect(s.activeSessionId).toBe(s.sessions[0]?.id);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("alpha"));
  });

  it("项目有 session 但未选中:提示选择或新建", () => {
    usePersonalStore.setState({
      sessions: [
        {
          id: "s1",
          projectId: "p1",
          title: "Session 1",
          agent: "claude",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      activeSessionId: undefined,
    });
    renderArea();
    expect(screen.getByText(/在左侧选择一个 Session/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建聊天/ })).toBeInTheDocument();
  });

  it("未激活任何项目:保持原有通用空状态", () => {
    usePersonalStore.setState({ activeProjectId: undefined });
    renderArea();
    expect(screen.getByText("选择或新建一个 Session")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /新建聊天/ })).toBeNull();
  });
});

describe("PersonalChatArea 文件链接点击 → 右栏预览", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [{ id: "s1", projectId: "p1", title: "Session 1", agent: "claude", createdAt: NOW, updatedAt: NOW }],
      activeProjectId: "p1",
      activeSessionId: "s1",
      timelineProjectId: undefined,
      filePreviewRequest: undefined,
    });
    useCortexUIStore.setState({ rightOpen: false });
  });

  it("点 Agent 文本里的项目内路径 → requestFilePreview(绝对路径/basename)+ 展开右栏", async () => {
    renderAreaWithChat([
      { kind: "text", who: "claude", time: "12:00", uid: "m1", text: "见 `packages/core/x.ts` 文件" },
    ]);
    const link = await screen.findByText("packages/core/x.ts");
    expect(link).toHaveClass("file-link");
    fireEvent.click(link);
    const s = usePersonalStore.getState();
    expect(s.filePreviewRequest).toEqual({
      projectId: "p1",
      path: "/code/alpha/packages/core/x.ts",
      name: "x.ts",
    });
    expect(s.rightView).toBe("files");
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
  });

  it("diff 卡片文件行点击 → 同样触发 requestFilePreview;项目外路径短路不派发", async () => {
    renderAreaWithChat([
      {
        kind: "diff",
        who: "claude",
        time: "12:01",
        uid: "d1",
        title: "变更",
        sub: "2 个文件",
        status: "pending",
        files: [
          { path: "src/a.ts", add: 1, del: 0 },
          { path: "/etc/passwd", add: 1, del: 0 },
        ],
      } as Message,
    ]);
    const rowInternal = await screen.findByText("src/a.ts");
    fireEvent.click(rowInternal);
    expect(usePersonalStore.getState().filePreviewRequest).toEqual({
      projectId: "p1",
      path: "/code/alpha/src/a.ts",
      name: "a.ts",
    });

    // 项目外路径:短路,不覆盖上一次请求(handleOpenFile within=false 直接返回)。
    usePersonalStore.setState({ filePreviewRequest: undefined });
    fireEvent.click(screen.getByText("/etc/passwd"));
    expect(usePersonalStore.getState().filePreviewRequest).toBeUndefined();
  });

  it("ref 缺目录但项目内能定位 → 用真实绝对路径派发(本次反馈核心 bug)", async () => {
    // yuque 表格只列裸文件名,真实文件在子目录;resolveProjectFile 命中子目录路径。
    const b = {
      loadChat: async () => [
        { kind: "text", who: "claude", time: "12:00", uid: "m9", text: "见 `002.md` 文件" },
      ],
      saveChat: async () => {},
      resolveProjectFile: async (_root: string, _ref: string) => "/code/alpha/outputs/yuque-kb/docs/002.md",
    } as unknown as DesktopBridge;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
    fireEvent.click(await screen.findByText("002.md"));
    await waitFor(() =>
      expect(usePersonalStore.getState().filePreviewRequest).toEqual({
        projectId: "p1",
        path: "/code/alpha/outputs/yuque-kb/docs/002.md",
        name: "002.md",
      }),
    );
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
  });

  it("无项目会话:projectPath 缺失,文本路径不可点(无 .file-link)", async () => {
    usePersonalStore.setState({
      sessions: [
        { id: "s2", title: "Session 2", agent: "claude", createdAt: NOW, updatedAt: NOW, noProjectDir: "/tmp/x" },
      ],
      activeProjectId: undefined,
      activeSessionId: "s2",
    });
    renderAreaWithChat([
      { kind: "text", who: "claude", time: "12:02", uid: "m2", text: "见 `packages/core/x.ts` 文件" },
    ]);
    const code = await screen.findByText("packages/core/x.ts");
    expect(code).not.toHaveClass("file-link");
    fireEvent.click(code);
    expect(usePersonalStore.getState().filePreviewRequest).toBeUndefined();
  });
});

describe("PersonalChatArea pi 渲染：reasoning 块 + 运行时状态（U5）", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [{ id: "s1", projectId: "p1", title: "Session 1", agent: "pi", createdAt: NOW, updatedAt: NOW }],
      activeProjectId: "p1",
      activeSessionId: "s1",
      timelineProjectId: undefined,
      runningBySession: {},
      piRuntimeBySession: {},
    });
  });

  it("运行中的 reasoning 消息默认展开,展示思考文本", () => {
    renderMessageStream([{ kind: "reasoning", who: "pi", time: "12:00", uid: "r1", text: "让我想想这个问题", active: true }]);
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("让我想想这个问题")).toBeInTheDocument();
  });

  it("历史 reasoning 经加载被 sanitize 清理,不再渲染思考块", async () => {
    renderAreaWithChat([
      { kind: "reasoning", who: "pi", time: "12:00", uid: "r1", text: "让我想想这个问题" },
      { kind: "text", who: "pi", time: "12:01", uid: "a1", text: "这是答案" },
    ]);
    // 历史思考(reasoning)不作为长期记录,加载时已被剔除;正文照常渲染。
    expect(await screen.findByText("这是答案")).toBeInTheDocument();
    expect(screen.queryByText("思考过程")).toBeNull();
    expect(screen.queryByText("让我想想这个问题")).toBeNull();
  });

  it("点「思考过程」头部可折叠隐藏思考正文", async () => {
    renderMessageStream([{ kind: "reasoning", who: "pi", time: "12:00", uid: "r1", text: "思考内容X", active: true }]);
    const head = screen.getByText("思考过程");
    expect(screen.getByText("思考内容X")).toBeInTheDocument();
    fireEvent.click(head);
    expect(screen.queryByText("思考内容X")).toBeNull();
  });

  it("pi 运行时状态徽标:压缩 / 重试 / 待注入 / 思考强度", async () => {
    usePersonalStore.getState().setPiRuntime("s1", {
      compacting: true,
      retry: { attempt: 2, max: 3 },
      steering: 1,
      thinkingLevel: "high",
    });
    renderAreaWithChat([]);
    expect(await screen.findByText("压缩上下文…")).toBeInTheDocument();
    expect(screen.getByText(/重试中 2\/3/)).toBeInTheDocument();
    expect(screen.getByText(/1 条待注入/)).toBeInTheDocument();
    expect(screen.getByText(/思考 high/)).toBeInTheDocument();
  });

  it("claude 会话不显示 pi 运行时徽标（即便误置 runtime）", async () => {
    usePersonalStore.setState({
      sessions: [{ id: "s1", projectId: "p1", title: "S", agent: "claude", createdAt: NOW, updatedAt: NOW }],
    });
    usePersonalStore.getState().setPiRuntime("s1", { compacting: true });
    renderAreaWithChat([]);
    await screen.findAllByText(/alpha/);
    expect(screen.queryByText("压缩上下文…")).toBeNull();
  });
});

describe("PersonalChatArea 历史会话分页渲染窗口", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [{ id: "s1", projectId: "p1", title: "S1", agent: "claude", createdAt: NOW, updatedAt: NOW }],
      activeProjectId: "p1",
      activeSessionId: "s1",
      timelineProjectId: undefined,
      runningBySession: {},
    });
  });

  // n 条用户文本消息(走 renderRich 纯文本,findByText 稳定)。
  const many = (n: number, prefix = "消息"): Message[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: "text" as const,
      who: "me",
      time: "10:00",
      text: `${prefix}${i + 1}`,
      uid: `m${i + 1}`,
    }));

  it("默认只渲染尾部 20 条,更早的折叠", async () => {
    renderAreaWithChat(many(30));
    expect(await screen.findByText("消息30")).toBeInTheDocument();
    expect(screen.getByText("消息11")).toBeInTheDocument(); // 尾部第 20 条
    expect(screen.queryByText("消息10")).toBeNull(); // 第 21 条往前折叠
    expect(screen.queryByText("消息1")).toBeNull();
  });

  it("折叠时显示「展开更多」入口并标注剩余条数", async () => {
    renderAreaWithChat(many(30));
    await screen.findByText("消息30");
    expect(screen.getByText(/还有 10 条更早消息/)).toBeInTheDocument();
    expect(screen.getByText("展开更多")).toBeInTheDocument();
  });

  it("点「展开更多」多渲染一页,覆盖全部后入口消失", async () => {
    renderAreaWithChat(many(30));
    await screen.findByText("消息30");
    fireEvent.click(screen.getByText("展开更多"));
    expect(await screen.findByText("消息1")).toBeInTheDocument(); // 20→40 覆盖 30 条
    expect(screen.getByText("消息10")).toBeInTheDocument();
    expect(screen.queryByText("展开更多")).toBeNull();
  });

  it("消息不足 20 条:不显示入口,全部渲染", async () => {
    renderAreaWithChat(many(12));
    expect(await screen.findByText("消息12")).toBeInTheDocument();
    expect(screen.getByText("消息1")).toBeInTheDocument();
    expect(screen.queryByText("展开更多")).toBeNull();
  });

  it("切换会话后窗口重置为尾部 20 条", async () => {
    const b = {
      loadChat: async (sid: string) => (sid === "s1" ? many(30) : many(25, "B")),
      saveChat: async () => {},
    } as unknown as DesktopBridge;
    usePersonalStore.setState({
      sessions: [
        { id: "s1", projectId: "p1", title: "S1", agent: "claude", createdAt: NOW, updatedAt: NOW },
        { id: "s2", projectId: "p1", title: "S2", agent: "claude", createdAt: NOW, updatedAt: NOW },
      ],
    });
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
    await screen.findByText("消息30");
    fireEvent.click(screen.getByText("展开更多"));
    await screen.findByText("消息1"); // s1 全展开

    usePersonalStore.getState().setActiveSession("s2");
    expect(await screen.findByText("B25")).toBeInTheDocument();
    expect(screen.getByText("B6")).toBeInTheDocument(); // 尾部 20(25-20+1=6)
    expect(screen.queryByText("B5")).toBeNull(); // 窗口已重置,更早折叠
  });

  it("/clear 后:窗口优先,展完可见集才出现「显示隐藏」入口", async () => {
    usePersonalStore.setState({
      sessions: [
        {
          id: "s1",
          projectId: "p1",
          title: "S1",
          agent: "claude",
          createdAt: NOW,
          updatedAt: NOW,
          hiddenHistory: { count: 5, throughUid: "m5", hiddenAt: NOW },
        },
      ],
    });
    renderAreaWithChat(many(30)); // 隐藏 m1..m5 → 可见 m6..m30(25 条)
    await screen.findByText("消息30");
    expect(screen.getByText(/还有 5 条更早消息/)).toBeInTheDocument(); // 25-20=5
    expect(screen.queryByText(/已隐藏/)).toBeNull(); // 窗口未展完,不显示隐藏 gate
    fireEvent.click(screen.getByText("展开更多")); // +20 → 覆盖可见 25 条
    expect(await screen.findByText("消息6")).toBeInTheDocument(); // 可见集顶部
    expect(screen.queryByText("消息5")).toBeNull(); // 仍属 /clear 隐藏区
    expect(screen.getByText(/已隐藏 5 条历史记录/)).toBeInTheDocument(); // 现在出现隐藏 gate
  });
});

describe("PersonalChatArea 中栏运行中提示（U3·R2）", () => {
  afterEach(() => cleanup());

  // 用受控 QueryClient 注入,以便在渲染前写入过程流 query 并断言中栏提示回填进度。
  function renderRunning(opts: {
    messages?: Message[];
    process?: Message[];
    running?: boolean;
    sessionId?: string;
  }) {
    const sessionId = opts.sessionId ?? "s1";
    const qc = new QueryClient();
    if (opts.process) qc.setQueryData(personalProcessKeys.detail(sessionId), opts.process);
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [{ id: sessionId, projectId: "p1", title: "S1", agent: "claude", createdAt: NOW, updatedAt: NOW }],
      activeProjectId: "p1",
      activeSessionId: sessionId,
      timelineProjectId: undefined,
      runningBySession: opts.running ? { [sessionId]: "run-1" } : {},
      piRuntimeBySession: {},
    });
    const b = { loadChat: async () => opts.messages ?? [], saveChat: async () => {} } as unknown as DesktopBridge;
    const view = render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b} queryClient={qc}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
    return { qc, view, sessionId };
  }

  it("Covers R2. 消息流为空但 running=true（convo===null）时中栏存在 .pw-running-hint", async () => {
    const { view } = renderRunning({ messages: [], running: true });
    // 首轮纯工具:消息流为空（convo===null,MessageStream 不渲染内容）,提示仍独立可见。
    const hint = await waitFor(() => {
      const el = view.container.querySelector(".pw-running-hint");
      if (!el) throw new Error("running hint 未出现");
      return el;
    });
    expect(hint).toBeInTheDocument();
  });

  it("Covers R2. 非运行态:不渲染 .pw-running-hint", async () => {
    const { view } = renderRunning({ messages: [], running: false });
    await waitFor(() => expect(view.container.querySelector(".chat")).toBeInTheDocument());
    expect(view.container.querySelector(".pw-running-hint")).toBeNull();
  });

  it("Covers R2. finalizeRun 后（running 翻 false）提示消失", async () => {
    const { view, sessionId } = renderRunning({ messages: [], running: true });
    await waitFor(() => expect(view.container.querySelector(".pw-running-hint")).toBeInTheDocument());
    // 模拟一轮结束:store 运行态清空（finalizeRun 的对外可观察效果）。
    act(() => {
      usePersonalStore.getState().setRunning(sessionId, undefined);
    });
    await waitFor(() => expect(view.container.querySelector(".pw-running-hint")).toBeNull());
  });

  it("Covers R2. 浮层不可见且运行中:提示回填步数/最近一步（取自 process 流派生计数）", async () => {
    // 过程流挂两个工具步骤,最近一步文本为「Edit · b.ts」。中栏提示须回填该进度。
    const process: Message[] = [
      {
        kind: "agentLog",
        who: "claude",
        time: "12:00",
        title: "执行",
        active: true,
        items: [
          { ic: "check", text: "Bash · ls" },
          { ic: "running", text: "Edit · b.ts" },
        ],
        uid: "log1",
      },
    ];
    const { view } = renderRunning({ messages: [], process, running: true });
    await waitFor(() => {
      const el = view.container.querySelector(".pw-running-hint-text");
      if (!el) throw new Error("hint text 未出现");
      expect(el.textContent).toContain("已执行 2 步");
      expect(el.textContent).toContain("Edit · b.ts");
    });
  });

  it("过程流为空但运行中:提示回退为「思考中…」,不报错", async () => {
    const { view } = renderRunning({ messages: [], process: [], running: true });
    await waitFor(() => {
      const el = view.container.querySelector(".pw-running-hint-text");
      if (!el) throw new Error("hint text 未出现");
      expect(el.textContent).toContain("思考中");
    });
  });
});

describe("PersonalChatArea editResend 截断后中栏不闪回旧 agentLog（U5·R12）", () => {
  afterEach(() => cleanup());

  const claudeSession: SessionMeta = {
    id: "s1",
    projectId: "p1",
    title: "S1",
    agent: "claude",
    agentSessionIds: { claude: "c1" },
    createdAt: NOW,
    updatedAt: NOW,
  };

  // 探针组件:把 editResend 暴露到外部引用,便于在 act 里驱动真实编辑重发链路。
  function EditResendProbe({ onReady }: { onReady: (fn: ReturnType<typeof usePersonalActions>["editResend"]) => void }) {
    const { editResend } = usePersonalActions();
    onReady(editResend);
    return null;
  }

  it("旧档缓存含 agentLog,editResend 截断后写回缓存被 sanitize → 中栏不渲染 .agent-log", async () => {
    const qc = new QueryClient();
    // 旧档残留:u1(问) → agentLog(旧工具步骤) → a1(答) → u2(待编辑问) → a2(答)。
    const stale: Message[] = [
      { kind: "text", who: "me", time: "10:00", uid: "u1", text: "第一问" },
      {
        kind: "agentLog",
        who: "claude",
        time: "10:01",
        uid: "g1",
        title: "旧执行",
        active: false,
        completed: true,
        items: [{ ic: "check", text: "Edit · old.ts" }],
      },
      { kind: "text", who: "claude", time: "10:02", uid: "a1", text: "第一答" },
      { kind: "text", who: "me", time: "10:03", uid: "u2", text: "第二问" },
      { kind: "text", who: "claude", time: "10:04", uid: "a2", text: "第二答" },
    ];
    qc.setQueryData(personalChatKeys.detail("s1"), stale);
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [claudeSession],
      activeProjectId: "p1",
      activeSessionId: "s1",
      agentsAvailable: { claude: true, codex: true, pi: true },
      runningBySession: {},
      timelineProjectId: undefined,
    });
    // loadChat 返回同一份旧档（ensureChatLoaded 内部已过 sanitize,但缓存里已是含 agentLog 的脏态:
    // 模拟「加载后流式期写入又未及重载」的边界,固化 editResend 写回前 sanitize 的护栏）。
    const b = {
      loadChat: async () => stale,
      saveChat: vi.fn(async () => undefined),
      startCli: vi.fn(async () => undefined),
      killCli: vi.fn(async () => undefined),
      trimAgentSession: vi.fn(async () => true),
    } as unknown as DesktopBridge;

    let editResendFn: ReturnType<typeof usePersonalActions>["editResend"] | undefined;
    const view = render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b} queryClient={qc}>
        <PersonalChatArea onToast={() => {}} />
        <EditResendProbe onReady={(fn) => (editResendFn = fn)} />
      </CoreProvider>,
    );
    // 初始:旧档含 agentLog → 中栏内联渲染 .agent-log（编辑前的现状）。
    await screen.findByText("第二答");
    expect(view.container.querySelector(".agent-log")).toBeInTheDocument();

    // 编辑重发「第二问」(u2):截断到 u2 之前 → [u1, agentLog, a1],写回前 sanitize → agentLog 被剥离。
    await act(async () => {
      await editResendFn!(claudeSession, "/code/alpha", "u2", "改后的第二问", []);
    });

    // 落盘内容不含 agentLog（saveChat 经 sanitizeForSave）。
    for (const call of (b.saveChat as ReturnType<typeof vi.fn>).mock.calls) {
      const saved = call[1] as Message[];
      expect(saved.some((m) => m.kind === "agentLog")).toBe(false);
    }
    // 缓存（中栏数据源）也不再含 agentLog → 中栏不再渲染 .agent-log（不闪回旧工具步骤）。
    const cached = qc.getQueryData<Message[]>(personalChatKeys.detail("s1")) ?? [];
    expect(cached.some((m) => m.kind === "agentLog")).toBe(false);
    await waitFor(() => expect(view.container.querySelector(".agent-log")).toBeNull());
    // 重发经 startCli（claude 链路,R10 零回归）。
    expect((b.startCli as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});
