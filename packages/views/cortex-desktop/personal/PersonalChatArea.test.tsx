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
    // 探测命中后才点亮为可点 file-link(checking 期是普通 code、无 onClick);先等点亮再点击。
    await waitFor(() => expect(screen.getByText("002.md")).toHaveClass("file-link"));
    fireEvent.click(screen.getByText("002.md"));
    await waitFor(() =>
      expect(usePersonalStore.getState().filePreviewRequest).toEqual({
        projectId: "p1",
        path: "/code/alpha/outputs/yuque-kb/docs/002.md",
        name: "002.md",
      }),
    );
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
  });

  it("项目外的非文本产物(如 outputs 里的 xlsx)→ 系统默认应用打开,不进右栏预览", async () => {
    const openPath = vi.fn(async () => "");
    const b = {
      loadChat: async () => [
        { kind: "text", who: "claude", time: "12:00", uid: "mx", text: "见 `/data/outputs/x/monthly.xlsx`" },
      ],
      saveChat: async () => {},
      // 项目根为 /code/alpha,文件在项目外;主进程按真实存在性解析回绝对路径。
      resolveProjectFile: async (_root: string, _ref: string) => "/data/outputs/x/monthly.xlsx",
      openPath,
    } as unknown as DesktopBridge;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
    // 项目外绝对路径也点亮为可点 file-link(渲染层放行 + 主进程解析命中)。
    await waitFor(() => expect(screen.getByText("/data/outputs/x/monthly.xlsx")).toHaveClass("file-link"));
    fireEvent.click(screen.getByText("/data/outputs/x/monthly.xlsx"));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith("/data/outputs/x/monthly.xlsx"));
    // 非文本不走右栏内置预览。
    expect(usePersonalStore.getState().filePreviewRequest).toBeUndefined();
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

  it("无项目会话:codex 绝对路径产物(.docx)经 fileExists 命中 → 可点 + 系统打开(截图回归)", async () => {
    // 复现用户截图:无项目会话里 codex 输出指向项目外绝对路径的文件,旧逻辑(!projectPath 短路)→
    // 死链接点击无反应。现按 fileExists 存在性放行,点击经 openPath 系统打开。
    usePersonalStore.setState({
      sessions: [{ id: "s3", title: "总结", agent: "codex", createdAt: NOW, updatedAt: NOW, noProjectDir: "/tmp/x" }],
      activeProjectId: undefined,
      activeSessionId: "s3",
    });
    const openPath = vi.fn(async () => "");
    const fileExists = vi.fn(async () => true);
    const abs = "/Users/mike/.codex/outputs/report.docx";
    const b = {
      loadChat: async () => [{ kind: "text", who: "codex", time: "06:03", uid: "m3", text: `产物在 [报告](${abs})` }],
      saveChat: async () => {},
      fileExists,
      openPath,
    } as unknown as DesktopBridge;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
    await waitFor(() => expect(screen.getByText("报告")).toHaveClass("file-link"));
    fireEvent.click(screen.getByText("报告"));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith(abs));
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

  // pi 运行时徽标（压缩/重试/待注入/思考强度）已随会话标题上移到中栏顶栏,
  // 相关断言移至 PersonalTopBar.test.tsx（PersonalSessionHeader）。
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

describe("PersonalChatArea 运行态占位位置", () => {
  afterEach(() => cleanup());

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

  it("running=true 时不在消息流外渲染 .pw-running-hint", async () => {
    const { view } = renderRunning({ messages: [], running: true });
    await waitFor(() => expect(view.container.querySelector(".chat")).toBeInTheDocument());
    expect(view.container.querySelector(".pw-running-hint")).toBeNull();
  });

  it("即便有过程流,也不在输入框上方渲染外部运行提示", async () => {
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
    await waitFor(() => expect(view.container.querySelector(".chat")).toBeInTheDocument());
    expect(view.container.querySelector(".pw-running-hint")).toBeNull();
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

  it("Pi 编辑重发 fork 失败时不再显示定位告警,并清理旧告警", async () => {
    const qc = new QueryClient();
    const piSession: SessionMeta = {
      id: "s1",
      projectId: "p1",
      title: "S1",
      agent: "pi",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const warning = "⚠️ 未能在 pi 侧定位编辑点,已带原有上下文重发（pi 仍记得被编辑前的内容）。";
    // 报错提示在生产中恒由 uid("err") 创建（→ "err-…"）；sanitizeForSave 按该命名空间剥离。
    const stale: Message[] = [
      { kind: "text", who: "pi", time: "09:18", uid: "err-1-w1", text: warning },
      { kind: "text", who: "pi", time: "09:36", uid: "err-2-w2", text: warning },
      { kind: "text", who: "me", time: "09:49", uid: "u2", text: "总结提交" },
      { kind: "text", who: "pi", time: "09:50", uid: "a2", text: "旧回答" },
    ];
    qc.setQueryData(personalChatKeys.detail("s1"), stale);
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [piSession],
      activeProjectId: "p1",
      activeSessionId: "s1",
      agentsAvailable: { claude: true, codex: true, pi: true },
      runningBySession: {},
      timelineProjectId: undefined,
    });
    const b = {
      loadChat: async () => stale,
      saveChat: vi.fn(async () => undefined),
      piOpen: vi.fn(async () => ({ uiSessionId: "s1", sessionId: "pi-live", sessionFile: "/tmp/pi.jsonl" })),
      piPrompt: vi.fn(async () => undefined),
    } as unknown as DesktopBridge;

    let editResendFn: ReturnType<typeof usePersonalActions>["editResend"] | undefined;
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b} queryClient={qc}>
        <PersonalChatArea onToast={() => {}} />
        <EditResendProbe onReady={(fn) => (editResendFn = fn)} />
      </CoreProvider>,
    );
    await screen.findByText("旧回答");

    await act(async () => {
      await editResendFn!(piSession, "/code/alpha", "u2", "重新总结", []);
    });

    const cached = qc.getQueryData<Message[]>(personalChatKeys.detail("s1")) ?? [];
    expect(cached.filter((m) => m.kind === "text" && m.who === "pi" && m.text === warning)).toHaveLength(0);
    expect(cached.some((m) => m.kind === "text" && m.who === "pi" && m.uid === "err-1-w1")).toBe(false);
    usePersonalStore.getState().setRunning("s1", undefined);
  });
});

// U5:assistant 消息「追问」按钮 + 浮层挂载 + Web/能力门控。
describe("PersonalChatArea 追问入口（U5）", () => {
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
      providerSettings: { providers: [] },
    });
  });

  // 带 askFollowupStream 能力的桥（桌面端）。
  function bridgeWithAsk(messages: Message[]): DesktopBridge {
    return {
      loadChat: async () => messages,
      saveChat: async () => {},
      askFollowupStream: async () => {},
      onAskFollowupEvent: () => () => {},
      cancelFollowup: async () => {},
    } as unknown as DesktopBridge;
  }

  function renderWith(b: DesktopBridge) {
    return render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
  }

  it("assistant 文本消息出现「追问」按钮,排在复制/朗读之后", async () => {
    renderWith(bridgeWithAsk([{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "答案正文" }]));
    await screen.findByText("答案正文");
    const followBtn = screen.getByRole("button", { name: "追问" });
    expect(followBtn).toBeInTheDocument();
    // 同一操作行内:复制在追问之前(顺序固定)。
    const row = followBtn.closest(".m-act-row");
    const btns = row ? Array.from(row.querySelectorAll<HTMLButtonElement>("button")) : [];
    const copyIdx = btns.findIndex((b) => b.getAttribute("title") === "复制回复内容");
    const followIdx = btns.findIndex((b) => b === followBtn);
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    expect(followIdx).toBeGreaterThan(copyIdx);
  });

  it("me（用户）消息不出现「追问」按钮", async () => {
    renderWith(bridgeWithAsk([{ kind: "text", who: "me", time: "12:00", uid: "m1", text: "我的问题" }]));
    await screen.findByText("我的问题");
    expect(screen.queryByRole("button", { name: "追问" })).toBeNull();
  });

  it("无 askFollowupStream 能力（Web/旧壳）→ 不渲染「追问」按钮", async () => {
    const webBridge = { loadChat: async () => [{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "答案正文" }], saveChat: async () => {} } as unknown as DesktopBridge;
    renderWith(webBridge);
    await screen.findByText("答案正文");
    expect(screen.queryByRole("button", { name: "追问" })).toBeNull();
  });

  it("点击「追问」→ 打开浮层,种子为该条正文(R2)", async () => {
    renderWith(bridgeWithAsk([{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "可被追问的回复" }]));
    await screen.findByText("可被追问的回复");
    fireEvent.click(screen.getByRole("button", { name: "追问" }));
    // 浮层就绪:dialog + 种子正文(浮层内再次出现该文本)。
    const dialog = await screen.findByRole("dialog", { name: "追问" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("就这条回复追问")).toBeInTheDocument();
    // 浮层内出现种子正文(顶部种子区)。
    expect(screen.getAllByText("可被追问的回复").length).toBeGreaterThanOrEqual(1);
  });

  it("关闭浮层 → 焦点归还触发按钮", async () => {
    renderWith(bridgeWithAsk([{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "回复正文Z" }]));
    await screen.findByText("回复正文Z");
    const trigger = screen.getByRole("button", { name: "追问" });
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "追问" });
    // 点关闭(浮层右上角 X)。
    fireEvent.click(screen.getByTitle("关闭"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "追问" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("pi 自定义供应商:sessionCtx.provider 经 askFollowupStream 解析传入", async () => {
    usePersonalStore.setState({
      sessions: [
        { id: "s1", projectId: "p1", title: "S1", agent: "pi", createdAt: NOW, updatedAt: NOW, providerId: "deepseek", model: "ds-chat" },
      ],
      providerSettings: {
        providers: [
          {
            id: "deepseek",
            name: "DeepSeek",
            baseUrl: "https://api.deepseek.com",
            apiKey: "sk-x",
            endpointFormat: "chat_completions",
            enabled: true,
            models: [{ id: "ds-chat", label: "DeepSeek Chat" }],
          },
        ],
        defaultProviderId: "deepseek",
      },
    });
    const askSpy = vi.fn(async (_req: { agent: string; model?: string; cwd: string; provider?: { id: string; baseUrl: string; apiKey?: string } }) => {});
    const b = {
      loadChat: async () => [{ kind: "text", who: "pi", time: "12:00", uid: "a1", text: "pi 的回复" }],
      saveChat: async () => {},
      askFollowupStream: askSpy,
      onAskFollowupEvent: () => () => {},
      cancelFollowup: async () => {},
    } as unknown as DesktopBridge;
    renderWith(b);
    await screen.findByText("pi 的回复");
    fireEvent.click(screen.getByRole("button", { name: "追问" }));
    await screen.findByRole("dialog", { name: "追问" });
    // 在浮层里发一问,验证传入的 sessionCtx(agent/model/cwd/provider)。
    const ta = screen.getByPlaceholderText(/继续追问/);
    fireEvent.change(ta, { target: { value: "为什么?" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => expect(askSpy).toHaveBeenCalled());
    const req = askSpy.mock.calls[0]![0];
    expect(req.agent).toBe("pi");
    expect(req.model).toBe("ds-chat");
    expect(req.cwd).toBe("/code/alpha");
    expect(req.provider).toMatchObject({ id: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-x" });
  });

  it("无项目会话:cwd 取 noProjectDir,仍可发起追问(R9 由主进程兜底)", async () => {
    usePersonalStore.setState({
      sessions: [
        { id: "s2", title: "S2", agent: "claude", createdAt: NOW, updatedAt: NOW, noProjectDir: "/tmp/noproj" },
      ],
      activeProjectId: undefined,
      activeSessionId: "s2",
    });
    const askSpy = vi.fn(async (_req: { agent: string; model?: string; cwd: string; provider?: { id: string; baseUrl: string; apiKey?: string } }) => {});
    const b = {
      loadChat: async () => [{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "无项目回复" }],
      saveChat: async () => {},
      askFollowupStream: askSpy,
      onAskFollowupEvent: () => () => {},
      cancelFollowup: async () => {},
    } as unknown as DesktopBridge;
    renderWith(b);
    await screen.findByText("无项目回复");
    fireEvent.click(screen.getByRole("button", { name: "追问" }));
    await screen.findByRole("dialog", { name: "追问" });
    const ta = screen.getByPlaceholderText(/继续追问/);
    fireEvent.change(ta, { target: { value: "追问内容" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => expect(askSpy).toHaveBeenCalled());
    expect(askSpy.mock.calls[0]![0].cwd).toBe("/tmp/noproj");
    // 无真实项目 → tightenTools=true(FIX-3,主进程据此剥离跳审批标志)。
    expect((askSpy.mock.calls[0]![0] as { tightenTools?: boolean }).tightenTools).toBe(true);
  });

  it("真实项目会话:tightenTools=false(FIX-3)", async () => {
    const askSpy = vi.fn(async (_req: { tightenTools?: boolean }) => {});
    const b = {
      loadChat: async () => [{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "有项目回复" }],
      saveChat: async () => {},
      askFollowupStream: askSpy,
      onAskFollowupEvent: () => () => {},
      cancelFollowup: async () => {},
    } as unknown as DesktopBridge;
    renderWith(b);
    await screen.findByText("有项目回复");
    fireEvent.click(screen.getByRole("button", { name: "追问" }));
    await screen.findByRole("dialog", { name: "追问" });
    const ta = screen.getByPlaceholderText(/继续追问/);
    fireEvent.change(ta, { target: { value: "问" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => expect(askSpy).toHaveBeenCalled());
    expect((askSpy.mock.calls[0]![0] as { tightenTools?: boolean }).tightenTools).toBe(false);
  });

  it("追问继承当前会话 effort", async () => {
    usePersonalStore.setState({
      sessions: [
        { id: "s1", projectId: "p1", title: "S1", agent: "claude", effort: "high", createdAt: NOW, updatedAt: NOW },
      ],
    });
    const askSpy = vi.fn(async (_req: { effort?: string }) => {});
    const b = {
      loadChat: async () => [{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "可追问回复" }],
      saveChat: async () => {},
      askFollowupStream: askSpy,
      onAskFollowupEvent: () => () => {},
      cancelFollowup: async () => {},
    } as unknown as DesktopBridge;
    renderWith(b);
    await screen.findByText("可追问回复");
    fireEvent.click(screen.getByRole("button", { name: "追问" }));
    await screen.findByRole("dialog", { name: "追问" });
    const ta = screen.getByPlaceholderText(/继续追问/);
    fireEvent.change(ta, { target: { value: "继续?" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => expect(askSpy).toHaveBeenCalled());
    expect((askSpy.mock.calls[0]![0] as { effort?: string }).effort).toBe("high");
  });

  it("仅 askFollowupStream、缺 onAskFollowupEvent/cancelFollowup → 不渲染「追问」按钮(FIX-2)", async () => {
    const partial = {
      loadChat: async () => [{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "部分桥回复" }],
      saveChat: async () => {},
      askFollowupStream: async () => {},
      // onAskFollowupEvent / cancelFollowup 缺失(旧壳)。
    } as unknown as DesktopBridge;
    renderWith(partial);
    await screen.findByText("部分桥回复");
    expect(screen.queryByRole("button", { name: "追问" })).toBeNull();
  });
});

// FIX-1 / FIX-6:经真实 useFollowupAsk(浮层挂载)验证收尾语义与重试替换。
describe("PersonalChatArea 追问收尾语义(FIX-1 / FIX-6)", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [{ id: "s1", projectId: "p1", title: "S1", agent: "claude", createdAt: NOW, updatedAt: NOW }],
      activeProjectId: "p1",
      activeSessionId: "s1",
      timelineProjectId: undefined,
      runningBySession: {},
      providerSettings: { providers: [] },
    });
  });

  // 捕获事件回调的桥:emit(askId, event) 可主动注入 ask:event。
  function makeEventBridge() {
    let cb: ((askId: string, ev: unknown) => void) | null = null;
    const askSpy = vi.fn(async (_req: { askId: string }) => {});
    const cancelSpy = vi.fn(async (_askId: string) => {});
    const bridge = {
      loadChat: async () => [{ kind: "text", who: "claude", time: "12:00", uid: "a1", text: "种子回复" }],
      saveChat: async () => {},
      askFollowupStream: askSpy,
      onAskFollowupEvent: (fn: (askId: string, ev: unknown) => void) => {
        cb = fn;
        return () => {
          cb = null;
        };
      },
      cancelFollowup: cancelSpy,
    } as unknown as DesktopBridge;
    return {
      bridge,
      askSpy,
      cancelSpy,
      emit: (ev: unknown) => {
        const askId = askSpy.mock.calls[askSpy.mock.calls.length - 1]![0].askId;
        act(() => {
          cb?.(askId, ev);
        });
      },
    };
  }

  function renderWith(b: DesktopBridge) {
    return render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={b}>
        <PersonalChatArea onToast={() => {}} />
      </CoreProvider>,
    );
  }

  async function openOverlayAndAsk(h: ReturnType<typeof makeEventBridge>, question: string) {
    renderWith(h.bridge);
    await screen.findByText("种子回复");
    fireEvent.click(screen.getByRole("button", { name: "追问" }));
    await screen.findByRole("dialog", { name: "追问" });
    const ta = screen.getByPlaceholderText(/继续追问/);
    fireEvent.change(ta, { target: { value: question } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => expect(h.askSpy).toHaveBeenCalled());
  }

  it("init→(长间隔静默)→text→result:不被提前收尾,answer 正常渲染(FIX-1)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = makeEventBridge();
    await openOverlayAndAsk(h, "为什么?");

    // init 后推进 30s(远超旧的 1.5s grace),期间无新事件。
    h.emit({ type: "init", sessionId: "x" });
    vi.advanceTimersByTime(30_000);
    // 此时仍应在 running(未被提前判 done):停止按钮在,输入禁用。
    expect(screen.getByRole("button", { name: /停止/ })).toBeInTheDocument();

    // 真实 text 到达 → 必须被渲染(activeRef 仍在,未被代际守卫丢弃)。
    h.emit({ type: "text", delta: "因为如此" });
    expect(await screen.findByText("因为如此")).toBeInTheDocument();

    // result 才正常收尾 → running 关闭,回到「发送」按钮。
    h.emit({ type: "result", ok: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: /停止/ })).toBeNull());
  });

  it("仅 text 无 result:不再因 1.5s 不活动提前收尾(FIX-1,删除旧 grace 语义)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = makeEventBridge();
    await openOverlayAndAsk(h, "问");
    h.emit({ type: "text", delta: "片段" });
    vi.advanceTimersByTime(10_000); // 远超旧 1.5s
    // 没有 result → 仍在 running(旧实现此刻已误关)。
    expect(screen.getByRole("button", { name: /停止/ })).toBeInTheDocument();
  });

  it("error 轮重试:原位替换该轮而非并存(FIX-6)", async () => {
    const h = makeEventBridge();
    await openOverlayAndAsk(h, "会失败的问");
    // 失败收尾。
    h.emit({ type: "result", ok: false, error: "炸了" });
    expect(await screen.findByText("炸了")).toBeInTheDocument();

    // 点重试 → 应调 ask(question, retryOf);新轮替换旧 error 轮(turns 仍只 1 轮)。
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    await waitFor(() => expect(h.askSpy).toHaveBeenCalledTimes(2));
    // 旧 error 文案消失(被替换),问题文本仍只出现一次。
    await waitFor(() => expect(screen.queryByText("炸了")).toBeNull());
    expect(screen.getAllByText("会失败的问")).toHaveLength(1);
  });
});
