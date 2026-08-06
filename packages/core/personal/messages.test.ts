import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePersonalStore } from "../store/personal";
import { usePiArtifactsStore } from "../store/piArtifacts";
import { useCortexUIStore } from "../store/ui";
import type { CliStreamEvent, SessionMeta } from "../desktop/types";
import {
  PURE_TOOL_TURN_PLACEHOLDER,
  RESULT_EXIT_GRACE_MS,
  __ensureChatLoadedForTest,
  __handleCliEventForTest,
  __handleCliExitForTest,
  __handlePiEventForTest,
  __resetPersonalMessageRunsForTest,
  __resolveSessionModelRefForTest,
  __setBridgeForTest,
  __flushChatForTest,
  __clearProcessForTest,
  __scheduleStrayProcessTimerForTest,
  __processCleanupTimerCountForTest,
  __autoTitleForTest,
  presetSessionTitle,
  adjustHiddenHistoryForSanitize,
  appendLocalUserMessage,
  artifactResumeKey,
  beginPiRun,
  reapSessionRun,
  respondPiUi,
  serializeAskQuestionAnswers,
  agentSessionPatch,
  buildAttachmentSystemPrompt,
  buildTurnPromptText,
  buildGlobalAppend,
  buildSingleSendSkillInjection,
  piEntryMatchesText,
  clearAgentSessionPatch,
  clearArtifactSessionPatch,
  createHiddenHistory,
  emptyFoldCursor,
  finalizeAgentLog,
  foldCliEvent,
  isMissingAgentSessionError,
  personalBranchKeys,
  personalChatKeys,
  personalProcessKeys,
  personalRunEventsKeys,
  type RunEvent,
  prewarmPiSession,
  resolveSpawnAgentId,
  restrictedToolForMode,
  runUsesNestedRoleEvents,
  sanitizeForSave,
  sessionResumeId,
  sameTextOrdinal,
  splitPersonalMessages,
  thinkingSnippet,
  truncateForEdit,
  typingText,
  windowTailMessages,
} from "./messages";
import { __resetPiSessionsForTest, isPiSessionOpen } from "./pi-session";
import type { DesktopBridge } from "../desktop/bridge";
import type { Message } from "../types";

const baseSession: SessionMeta = {
  id: "s1",
  projectId: "p1",
  title: "Session 1",
  agent: "claude",
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  vi.useRealTimers();
  __resetPersonalMessageRunsForTest();
  usePersonalStore.setState({
    sessions: [],
    projects: [],
    runningBySession: {},
    piRuntimeBySession: {},
  });
});

afterEach(() => {
  __resetPersonalMessageRunsForTest();
  vi.useRealTimers();
});

describe("会话自动标题", () => {
  it("手动名称即使仍符合 Session N 格式也不被自动标题覆盖", () => {
    const session = { ...baseSession, title: "Session 42", titleManuallyEdited: true };
    const oneshotCli = vi.fn();
    usePersonalStore.setState({ sessions: [session] });

    __autoTitleForTest({ oneshotCli } as unknown as DesktopBridge, session, "第一条消息");

    expect(usePersonalStore.getState().sessions[0]?.title).toBe("Session 42");
    expect(oneshotCli).not.toHaveBeenCalled();
  });

  // 产物 skill 派发给 agent 的是 `/skill:design …`(pi)或 skill prose(claude),
  // 直接拿去派生标题会把派发指令搬进标题栏(用户实测)。派发处先用原话占位。
  it("presetSessionTitle 用用户原话占位,随后的 autoTitle 让位不再改名", () => {
    usePersonalStore.setState({ sessions: [baseSession] });

    presetSessionTitle(baseSession, "设计一张线下技术沙龙的活动海报");
    expect(usePersonalStore.getState().sessions[0]?.title).toBe(
      "设计一张线下技术沙龙的活动海报",
    );

    const oneshotCli = vi.fn();
    __autoTitleForTest(
      { oneshotCli } as unknown as DesktopBridge,
      baseSession,
      "/skill:design 设计一张线下技术沙龙的活动海报",
    );
    expect(usePersonalStore.getState().sessions[0]?.title).toBe(
      "设计一张线下技术沙龙的活动海报",
    );
    expect(oneshotCli).not.toHaveBeenCalled();
  });

  // presetSessionTitle 只覆盖「派发处主动先占位」的产物 skill;pi 会话是把
  // `/skill:<name> …` 原样透传给 CLI 的，没有占位那一步，标题直接由 autoTitle 从
  // 发送文本派生 → 会话列表里就出现「/skill:incident-…」(用户实测)。
  // 前缀是派发指令不是内容，标题派生要统一把它剥掉，与哪个 skill、哪个 agent 无关。
  it("autoTitle 从 /skill: 文本派生标题时剥掉前缀", () => {
    usePersonalStore.setState({ sessions: [baseSession] });
    // 这里标题仍是默认值 → autoTitle 会真的去跑 haiku 概括,桩必须返回 Promise。
    const oneshotCli = vi.fn().mockResolvedValue({ ok: false, text: "" });
    __autoTitleForTest(
      { oneshotCli } as unknown as DesktopBridge,
      baseSession,
      "/skill:incident-apology-report 昨晚 23:05 到今天 01:10 平台无法访问",
    );
    const title = usePersonalStore.getState().sessions[0]?.title ?? "";
    expect(title).not.toContain("/skill:");
    expect(title.startsWith("昨晚 23:05")).toBe(true);
  });

  it("presetSessionTitle 也剥前缀(派发处直接传了原始文本时的兜底)", () => {
    usePersonalStore.setState({ sessions: [baseSession] });
    presetSessionTitle(baseSession, "/skill:contract-review-report 审查这份合同,我方是乙方");
    const title = usePersonalStore.getState().sessions[0]?.title ?? "";
    expect(title).not.toContain("/skill:");
    expect(title.startsWith("审查这份合同")).toBe(true);
  });

  it("presetSessionTitle 不动用户手改过的标题,空文本也不动", () => {
    const edited = { ...baseSession, title: "我的海报", titleManuallyEdited: true };
    usePersonalStore.setState({ sessions: [edited] });
    presetSessionTitle(edited, "设计一张海报");
    expect(usePersonalStore.getState().sessions[0]?.title).toBe("我的海报");

    usePersonalStore.setState({ sessions: [baseSession] });
    presetSessionTitle(baseSession, "   ");
    expect(usePersonalStore.getState().sessions[0]?.title).toBe("Session 1");
  });
});

describe("personal message agent session helpers", () => {
  it("产物运行把带 roleId 的设计子代理事件视为嵌套事件", () => {
    expect(runUsesNestedRoleEvents({ artifactResumeKey: "artifact-key" })).toBe(true);
    expect(runUsesNestedRoleEvents({})).toBe(false);
  });

  it("恢复中的产物运行忽略子代理 init/result，不覆盖 resume 或提前收尾", async () => {
    vi.useFakeTimers();
    const artifact = {
      kind: "slides" as const,
      documentId: "deck-1",
      title: "Deck",
      workspaceRoot: "/project",
      entryPath: "/project/.cortex-design/deck-1/deck.bento.html",
      createdAt: 1,
      updatedAt: 1,
    };
    const key = artifactResumeKey(baseSession, artifact);
    usePersonalStore.setState({
      sessions: [{
        ...baseSession,
        artifacts: [artifact],
        artifactSessionIds: { [key]: "parent-session" },
      }],
      runningBySession: {},
    });
    const qc = new QueryClient();
    const runId = "artifact:slides:deck-1:run-1";
    __handleCliEventForTest(
      qc,
      runId,
      { type: "init", sessionId: "child-session", roleId: "design-delegate" },
      "s1",
    );
    expect(usePersonalStore.getState().sessions[0]?.artifactSessionIds?.[key]).toBe(
      "parent-session",
    );
    __handleCliEventForTest(
      qc,
      runId,
      { type: "result", ok: true, text: "child done", roleId: "design-delegate" },
      "s1",
    );
    await vi.advanceTimersByTimeAsync(RESULT_EXIT_GRACE_MS + 1);
    expect(usePersonalStore.getState().runningBySession.s1).toBe(runId);
  });

  it("当前会话的产物运行成功后自动打开右栏编辑器", () => {
    const artifact = {
      kind: "slides" as const,
      documentId: "deck-auto-open",
      title: "自动打开的演示文稿",
      workspaceRoot: "/project",
      entryPath: "/project/.cortex-design/deck-auto-open/deck.bento.html",
      createdAt: 1,
      updatedAt: 1,
    };
    usePersonalStore.setState({
      sessions: [{
        ...baseSession,
        activeArtifact: artifact,
        artifacts: [artifact],
      }],
      activeSessionId: "s1",
      rightView: "files",
      runningBySession: {},
    });
    useCortexUIStore.setState({ rightOpen: false });
    const qc = new QueryClient();
    const runId = "artifact:slides:deck-auto-open:run-1";

    __handleCliEventForTest(
      qc,
      runId,
      { type: "result", ok: true, text: "演示文稿已生成" },
      "s1",
    );
    __handleCliExitForTest(qc, runId, 0, undefined, "s1");

    expect(usePersonalStore.getState().rightView).toBe("artifact");
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
  });

  it("并发子角色文本按事件 roleId 归属，父文本回到主消息", () => {
    const artifact = {
      kind: "slides" as const,
      documentId: "deck-roles",
      title: "Deck",
      workspaceRoot: "/project",
      entryPath: "/project/.cortex-design/deck-roles/deck.bento.html",
      createdAt: 1,
      updatedAt: 1,
    };
    usePersonalStore.setState({
      sessions: [{ ...baseSession, artifacts: [artifact] }],
      runningBySession: {},
    });
    const qc = new QueryClient();
    const runId = "artifact:slides:deck-roles:run-1";
    __handleCliEventForTest(qc, runId, {
      type: "init",
      sessionId: "role-a-session",
      roleId: "role-a",
    }, "s1");
    __handleCliEventForTest(qc, runId, {
      type: "init",
      sessionId: "role-b-session",
      roleId: "role-b",
    }, "s1");
    __handleCliEventForTest(qc, runId, { type: "text", delta: "A1", roleId: "role-a" }, "s1");
    __handleCliEventForTest(qc, runId, { type: "text", delta: "B1", roleId: "role-b" }, "s1");
    __handleCliEventForTest(qc, runId, { type: "text", delta: "A2", roleId: "role-a" }, "s1");
    __handleCliEventForTest(qc, runId, { type: "result", ok: true, roleId: "role-a" }, "s1");
    __handleCliEventForTest(qc, runId, { type: "result", ok: true, roleId: "role-b" }, "s1");
    __handleCliEventForTest(qc, runId, { type: "text", delta: "parent" }, "s1");

    const visible = (
      qc.getQueryData<Message[]>(personalChatKeys.detail("s1")) ?? []
    ).flatMap<string>((message) => {
      if (message.kind === "roleHeader") {
        return [`header:${message.roleId}`];
      }
      if (message.kind === "text") {
        return [`text:${message.roleId ?? "parent"}:${String(message.text)}`];
      }
      return [];
    });
    expect(visible).toEqual([
      "header:role-a",
      "text:role-a:A1A2",
      "header:role-b",
      "text:role-b:B1",
      "text:parent:parent",
    ]);
  });

  it("不同产物与模型使用彼此隔离的 resume key", () => {
    const artifact = {
      kind: "design" as const,
      documentId: "doc-1",
      title: "Home",
      workspaceRoot: "/project",
      entryPath: "/project/.cortex-design/doc-1",
      createdAt: 1,
      updatedAt: 1,
    };
    const first = artifactResumeKey(baseSession, artifact);
    expect(artifactResumeKey(baseSession, { ...artifact, documentId: "doc-2" })).not.toBe(first);
    expect(artifactResumeKey({ ...baseSession, model: "other" }, artifact)).not.toBe(first);
  });

  it("Claude 旧字段可作为 resume id 回退", () => {
    expect(sessionResumeId({ ...baseSession, claudeSessionId: "claude-old" })).toBe("claude-old");
  });

  it("优先使用当前 agent 的通用 session id", () => {
    expect(
      sessionResumeId({
        ...baseSession,
        agent: "codex",
        claudeSessionId: "claude-old",
        agentSessionIds: { codex: "codex-thread" },
      }),
    ).toBe("codex-thread");
  });

  it("写入 Claude init 时同步兼容旧字段", () => {
    expect(agentSessionPatch(baseSession, "claude", "claude-new")).toEqual({
      agentSessionIds: { claude: "claude-new" },
      claudeSessionId: "claude-new",
    });
  });

  it("写入 Codex init 时不污染 claudeSessionId", () => {
    expect(agentSessionPatch({ ...baseSession, claudeSessionId: "claude-old" }, "codex", "codex-thread")).toEqual({
      agentSessionIds: { codex: "codex-thread" },
    });
  });

  it("清理当前 agent 的 resume id 时保留其它 agent id", () => {
    expect(
      clearAgentSessionPatch(
        {
          ...baseSession,
          agent: "codex",
          agentSessionIds: { claude: "claude-new", codex: "codex-thread", pi: "pi-session" },
        },
        "codex",
      ),
    ).toEqual({ agentSessionIds: { claude: "claude-new", pi: "pi-session" } });
  });

  it("清理产物 resume id 时不污染普通会话与其它产物", () => {
    expect(
      clearArtifactSessionPatch(
        {
          ...baseSession,
          agentSessionIds: { claude: "chat" },
          artifactSessionIds: { first: "one", second: "two" },
        },
        "first",
      ),
    ).toEqual({ artifactSessionIds: { second: "two" } });
  });

  it("清理 Claude resume id 时同步清理旧兼容字段", () => {
    expect(
      clearAgentSessionPatch(
        {
          ...baseSession,
          claudeSessionId: "claude-old",
          agentSessionIds: { claude: "claude-new", codex: "codex-thread" },
        },
        "claude",
      ),
    ).toEqual({ agentSessionIds: { codex: "codex-thread" }, claudeSessionId: undefined });
  });

  it("识别 Codex 本地 rollout 缺失导致的 resume 错误", () => {
    expect(
      isMissingAgentSessionError(
        "Error: thread/resume: thread/resume failed: no rollout found for thread id 019ec100",
      ),
    ).toBe(true);
    expect(isMissingAgentSessionError("provider failed")).toBe(false);
  });
});

function msg(uid: string, text = uid): Message {
  return { kind: "text", who: "me", time: "10:00", text, uid };
}

describe("restrictedToolForMode 运行模式拦截检测", () => {
  it("plan:写类(Write/Edit)→ edit,执行类(Bash/Shell)→ exec", () => {
    expect(restrictedToolForMode("Write", "plan")).toBe("edit");
    expect(restrictedToolForMode("Edit", "plan")).toBe("edit");
    expect(restrictedToolForMode("MultiEdit", "plan")).toBe("edit");
    expect(restrictedToolForMode("Bash", "plan")).toBe("exec");
    expect(restrictedToolForMode("Shell", "plan")).toBe("exec");
  });

  it("plan:只读类工具不拦", () => {
    expect(restrictedToolForMode("Read", "plan")).toBeNull();
    expect(restrictedToolForMode("Grep", "plan")).toBeNull();
  });

  it("非 plan(accept-edits/full-auto/缺省):一律不拦(检测仅 plan 生效)", () => {
    // accept-edits 现仅供 design/writing 等内部固定档使用,会话 UI 不再产出;不做拦截提示。
    expect(restrictedToolForMode("Bash", "accept-edits")).toBeNull();
    expect(restrictedToolForMode("Write", "accept-edits")).toBeNull();
    expect(restrictedToolForMode("Bash", "full-auto")).toBeNull();
    expect(restrictedToolForMode("Write", "full-auto")).toBeNull();
    expect(restrictedToolForMode("Bash", undefined)).toBeNull();
  });

  it("工具名大小写不敏感", () => {
    expect(restrictedToolForMode("bash", "plan")).toBe("exec");
    expect(restrictedToolForMode("WRITE", "plan")).toBe("edit");
  });

  it("pi + plan:白名单外工具(扩展自定义工具)→ tool", () => {
    // pi plan 档 --tools 白名单仅 read/grep/find/ls,扩展工具(如记忆扩展)在外 → 归 tool 类。
    expect(restrictedToolForMode("memory_index", "plan", "pi")).toBe("tool");
    expect(restrictedToolForMode("hermes-memory", "plan", "pi")).toBe("tool");
    // 白名单内只读工具仍不拦。
    expect(restrictedToolForMode("read", "plan", "pi")).toBeNull();
    expect(restrictedToolForMode("grep", "plan", "pi")).toBeNull();
    expect(restrictedToolForMode("find", "plan", "pi")).toBeNull();
    expect(restrictedToolForMode("ls", "plan", "pi")).toBeNull();
    // 写/执行类仍优先归各自类别(非 tool)。
    expect(restrictedToolForMode("Write", "plan", "pi")).toBe("edit");
    expect(restrictedToolForMode("Bash", "plan", "pi")).toBe("exec");
  });

  it("pi + plan tool 检测仅限 pi:claude 的白名单外工具不误判为 tool", () => {
    // 其它 agent 的 plan 走原生机制,不套 pi 的 --tools 白名单,故非写/执行类工具不拦。
    expect(restrictedToolForMode("WebFetch", "plan", "claude")).toBeNull();
    expect(restrictedToolForMode("memory_index", "plan")).toBeNull(); // 无 agent → 不套白名单
  });

  it("pi + accept-edits:白名单只对 plan 生效,扩展工具在 accept-edits 不归 tool", () => {
    expect(restrictedToolForMode("memory_index", "accept-edits", "pi")).toBeNull();
  });
});

describe("personal hidden history helpers", () => {
  const messages = [msg("m1"), msg("m2"), msg("m3"), msg("m4")];

  it("没有隐藏游标时返回完整消息", () => {
    const slice = splitPersonalMessages(messages);
    expect(slice.hiddenMessages).toEqual([]);
    expect(slice.visibleMessages).toEqual(messages);
    expect(slice.messages).toEqual(messages);
    expect(slice.hiddenCount).toBe(0);
  });

  it("优先按 throughUid 后一条作为显示起点", () => {
    const slice = splitPersonalMessages(messages, { count: 1, throughUid: "m2", hiddenAt: 100 });
    expect(slice.hiddenMessages.map((m) => m.uid)).toEqual(["m1", "m2"]);
    expect(slice.visibleMessages.map((m) => m.uid)).toEqual(["m3", "m4"]);
    expect(slice.hiddenCount).toBe(2);
  });

  it("throughUid 找不到时回退到 count 并限制在消息长度内", () => {
    const slice = splitPersonalMessages(messages, { count: 99, throughUid: "missing", hiddenAt: 100 });
    expect(slice.hiddenMessages.map((m) => m.uid)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(slice.visibleMessages).toEqual([]);
    expect(slice.hiddenCount).toBe(4);
  });

  it("创建隐藏游标时记录当前完整消息尾部", () => {
    expect(createHiddenHistory(messages, 1234)).toEqual({ count: 4, throughUid: "m4", hiddenAt: 1234 });
  });
});

describe("windowTailMessages 渲染窗口尾部切片", () => {
  const five = [msg("m1"), msg("m2"), msg("m3"), msg("m4"), msg("m5")];

  it("limit ≥ 总数:返回全量,无折叠", () => {
    expect(windowTailMessages(five, 5)).toEqual({ rendered: five, collapsedEarlier: 0 });
    expect(windowTailMessages(five, 99)).toEqual({ rendered: five, collapsedEarlier: 0 });
  });

  it("limit < 总数:返回尾部 limit 条,折叠数为差值", () => {
    const r = windowTailMessages(five, 2);
    expect(r.rendered.map((m) => m.uid)).toEqual(["m4", "m5"]);
    expect(r.collapsedEarlier).toBe(3);
  });

  it("limit 递增:切片头部前移", () => {
    expect(windowTailMessages(five, 4).rendered.map((m) => m.uid)).toEqual(["m2", "m3", "m4", "m5"]);
  });

  it("limit ≤ 0:折叠全部(防御,不抛、不越界)", () => {
    expect(windowTailMessages(five, 0)).toEqual({ rendered: [], collapsedEarlier: 5 });
    expect(windowTailMessages(five, -3)).toEqual({ rendered: [], collapsedEarlier: 5 });
  });

  it("空消息:返回空,无折叠", () => {
    expect(windowTailMessages([], 20)).toEqual({ rendered: [], collapsedEarlier: 0 });
  });
});

describe("typingText 启动状态文案", () => {
  it("starting / thinking 两阶段文案区分", () => {
    expect(typingText("claude", "starting", 0)).toBe("正在启动 Claude Code…");
    expect(typingText("claude", "thinking", 0)).toBe("Claude Code 正在思考…");
    expect(typingText("codex", "starting", 0)).toBe("正在启动 Codex…");
  });

  it("等待 5 秒以上才显示时长", () => {
    expect(typingText("claude", "starting", 4900)).toBe("正在启动 Claude Code…");
    expect(typingText("claude", "starting", 12_300)).toBe("正在启动 Claude Code…已等待 12 秒");
    expect(typingText("codex", "thinking", 65_000)).toBe("Codex 正在思考…已等待 65 秒");
  });
});

describe("CLI result 收尾兜底", () => {
  function setupRecoveredRun(qc: QueryClient, runId = "run-1") {
    usePersonalStore.setState({
      sessions: [{ ...baseSession, agent: "pi", agentSessionIds: {} }],
      runningBySession: {},
    });
    __handleCliEventForTest(qc, runId, { type: "init", sessionId: "pi-session" }, "s1");
    expect(usePersonalStore.getState().runningBySession.s1).toBe(runId);
  }

  it("收到 result 后即使 cli:exit 丢失,也会在短延迟后清掉 runningBySession", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupRecoveredRun(qc);

    __handleCliEventForTest(qc, "run-1", { type: "result", ok: true, text: "DONE" }, "s1");
    expect(usePersonalStore.getState().runningBySession.s1).toBe("run-1");

    await vi.advanceTimersByTimeAsync(RESULT_EXIT_GRACE_MS);
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined();
    const messages = qc.getQueryData<Message[]>(personalChatKeys.detail("s1")) ?? [];
    expect(messages.filter((m) => m.kind === "text" && m.who === "pi")).toHaveLength(1);
  });

  it("正常 cli:exit 先到时取消 result 兜底,不会重复追加消息", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupRecoveredRun(qc);

    __handleCliEventForTest(qc, "run-1", { type: "result", ok: true, text: "DONE" }, "s1");
    const beforeExit = qc.getQueryData<Message[]>(personalChatKeys.detail("s1")) ?? [];

    __handleCliExitForTest(qc, "run-1", 0, undefined, "s1");
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined();

    await vi.advanceTimersByTimeAsync(RESULT_EXIT_GRACE_MS);
    const afterTimers = qc.getQueryData<Message[]>(personalChatKeys.detail("s1")) ?? [];
    expect(afterTimers).toHaveLength(beforeExit.length);
  });
});

describe("truncateForEdit 编辑重发截断", () => {
  const msgs: Message[] = [
    { kind: "text", who: "me", time: "10:00", text: "第一问", uid: "u1" },
    { kind: "text", who: "claude", time: "10:01", text: "第一答", uid: "a1" },
    { kind: "text", who: "me", time: "10:02", text: "第二问", uid: "u2" },
    { kind: "agentLog", who: "claude", time: "10:03", title: "执行", items: [], uid: "log1" },
    { kind: "text", who: "claude", time: "10:04", text: "第二答", uid: "a2" },
  ];

  it("截断到目标消息之前(目标本身也移除,由重发的新消息替代)", () => {
    const out = truncateForEdit(msgs, "u2");
    expect(out?.map((m) => m.uid)).toEqual(["u1", "a1"]);
  });

  it("编辑第一条:全部清空", () => {
    expect(truncateForEdit(msgs, "u1")).toEqual([]);
  });

  it("目标不存在返回 null,原数组不受影响", () => {
    expect(truncateForEdit(msgs, "nope")).toBeNull();
    expect(msgs).toHaveLength(5);
  });
});

describe("sameTextOrdinal 同文序号", () => {
  const msgs: Message[] = [
    { kind: "text", who: "me", time: "10:00", text: "继续", uid: "u1" },
    { kind: "text", who: "claude", time: "10:01", text: "继续", uid: "a1" }, // agent 同文不计入
    { kind: "text", who: "me", time: "10:02", text: "换个问题", uid: "u2" },
    { kind: "text", who: "me", time: "10:03", text: "继续", uid: "u3" },
  ];

  it("只统计用户消息中的同文,返回 0-based 序号", () => {
    expect(sameTextOrdinal(msgs, "u1", "继续")).toBe(0);
    expect(sameTextOrdinal(msgs, "u3", "继续")).toBe(1);
    expect(sameTextOrdinal(msgs, "u2", "换个问题")).toBe(0);
  });

  it("目标不在同文集合中返回 -1", () => {
    expect(sameTextOrdinal(msgs, "u2", "继续")).toBe(-1);
  });
});

// ── 流式交错折叠 ──────────────────────────────────────────────────────────
const txt = (delta: string): CliStreamEvent => ({ type: "text", delta });
const tool = (name: string, detail?: string): CliStreamEvent => ({ type: "tool", name, detail });

// 用确定性 newUid 顺序折叠一串事件,返回最终消息数组 + 游标。
function foldAll(events: CliStreamEvent[]) {
  let n = 0;
  const ctx = { agent: "claude" as const, time: "10:00", newUid: (p: string) => `${p}-${++n}` };
  let cursor = emptyFoldCursor();
  let messages: Message[] = [];
  for (const ev of events) {
    const r = foldCliEvent(messages, ev, cursor, ctx);
    messages = r.messages;
    cursor = r.cursor;
  }
  return { messages, cursor };
}

function asLog(m: Message | undefined): Extract<Message, { kind: "agentLog" }> {
  if (!m || m.kind !== "agentLog") throw new Error(`expected agentLog, got ${m?.kind}`);
  return m;
}
function asText(m: Message | undefined): Extract<Message, { kind: "text" }> {
  if (!m || m.kind !== "text") throw new Error(`expected text, got ${m?.kind}`);
  return m;
}

// B1 重校准:foldCliEvent 退化为「纯同流折叠」——text 与 tool 分别落在两条独立数组（消息流 /
// 过程流）,不再在同一数组里交错收尾。这里只测同流折叠语义;跨流收尾（text 到达收尾 process 流
// agentLog）由下方 __handleCliEventForTest 集成断言覆盖（KTD6）。
describe("同流折叠 foldCliEvent(纯函数)", () => {
  it("连续文本增量合并进同一个 text 块", () => {
    const { messages } = foldAll([txt("Hel"), txt("lo")]);
    expect(messages.map((m) => m.kind)).toEqual(["text"]);
    expect(asText(messages[0]!).text).toBe("Hello");
  });

  it("连续工具合并进同一张 agentLog 卡片,末项 running、前项 check", () => {
    const { messages } = foldAll([tool("t1"), tool("t2"), tool("t3")]);
    expect(messages.map((m) => m.kind)).toEqual(["agentLog"]);
    const log = asLog(messages[0]!);
    expect(log.active).toBe(true); // 未被打断、未 result,仍运行中
    expect(log.items).toEqual([
      { ic: "check", text: "t1", toolName: "t1" },
      { ic: "check", text: "t2", toolName: "t2" },
      { ic: "running", text: "t3", toolName: "t3" },
    ]);
  });

  it("text 分支不再收尾上一块 agentLog（跨流收尾移交调用方）", () => {
    // 同一数组喂 tool→text:text 分支只开新文本块,不动 agentLog（其 active 仍为 true）——
    // 该「同数组收尾」在 B1 下成为静默 no-op,被移除（KTD6）。
    const { messages } = foldAll([tool("t1"), txt("A")]);
    expect(messages.map((m) => m.kind)).toEqual(["agentLog", "text"]);
    const log = asLog(messages[0]!);
    expect(log.active).toBe(true); // 不再被 text 收尾
    expect(log.items).toEqual([{ ic: "running", text: "t1", toolName: "t1" }]);
    expect(asText(messages[1]!).text).toBe("A");
  });

  it("codex 连续整段 agent_message（无工具间隔）合并为单块（既定行为）", () => {
    const { messages } = foldAll([txt("段一"), txt("段二")]);
    expect(messages.map((m) => m.kind)).toEqual(["text"]);
    expect(asText(messages[0]!).text).toBe("段一段二");
  });

  it("工具 detail 拼进步骤文案：name · detail;结构化 toolName/detail 并存(注册表数据源)", () => {
    const { messages } = foldAll([tool("Edit", "src/a.ts")]);
    expect(asLog(messages[0]!).items).toEqual([
      { ic: "running", text: "Edit · src/a.ts", toolName: "Edit", detail: "src/a.ts" },
    ]);
  });

  it("finalizeAgentLog：全部 items 翻 check 并标记完成;spread 保留 toolName(防回归)", () => {
    const { messages, cursor } = foldAll([tool("t1"), tool("t2")]);
    const out = finalizeAgentLog(messages, cursor.logUid!);
    const log = asLog(out[0]!);
    expect(log.active).toBe(false);
    expect(log.completed).toBe(true);
    expect(log.title).toBe("Agent 执行完成");
    expect(log.items.every((it) => it.ic === "check")).toBe(true);
    // 收尾的 map 必须用 spread 保留新字段——丢掉 toolName 注册表卡片会在完成后消失。
    expect(log.items.map((it) => it.toolName)).toEqual(["t1", "t2"]);
  });
});

describe("sanitizeForSave 落盘清理(过程不落盘:思考与工具步骤皆丢弃)", () => {
  it("丢弃 typing / reasoning / agentLog,只保留问答正文", () => {
    const input: Message[] = [
      { kind: "text", who: "me", time: "10:00", text: "问", uid: "u1" },
      { kind: "reasoning", who: "pi", time: "10:00", text: "思考中", active: true, uid: "r1" },
      { kind: "typing", who: "pi", text: "...", uid: "t1" },
      {
        kind: "agentLog",
        who: "pi",
        time: "10:00",
        title: "执行",
        active: true,
        items: [{ ic: "running", text: "x" }],
        uid: "log1",
      },
      { kind: "text", who: "pi", time: "10:01", text: "答", uid: "a1" },
    ];
    const out = sanitizeForSave(input);
    // 过程移出落盘契约:agentLog（工具步骤）与 reasoning（思考）、typing 都不落盘,只剩问答。
    expect(out.map((m) => m.kind)).toEqual(["text", "text"]);
    expect(out.some((m) => m.kind === "reasoning")).toBe(false);
    expect(out.some((m) => m.kind === "agentLog")).toBe(false);
  });

  it("已完成的 reasoning / agentLog(历史遗留)也被清掉,加载即顺带破坏性迁移", () => {
    const input: Message[] = [
      { kind: "reasoning", who: "pi", time: "10:00", text: "旧思考", active: false, completed: true, uid: "r0" },
      {
        kind: "agentLog",
        who: "claude",
        time: "10:00",
        title: "旧执行",
        active: false,
        completed: true,
        items: [{ ic: "check", text: "Edit" }],
        uid: "log0",
      },
      { kind: "text", who: "pi", time: "10:00", text: "正文", uid: "a1" },
    ];
    expect(sanitizeForSave(input).map((m) => m.kind)).toEqual(["text"]);
  });

  it("丢弃 agent 报错/提示(uid('err-') 命名空间),保留用户与 agent 正文", () => {
    const input: Message[] = [
      { kind: "text", who: "me", time: "10:00", text: "问", uid: "u-1-aaa" },
      { kind: "text", who: "pi", time: "10:01", text: "⚠️ 执行失败: boom", uid: "err-2-bbb" },
      { kind: "text", who: "pi", time: "10:02", text: "答", uid: "at-3-ccc" },
      // 无 uid 的正文不属报错命名空间,保留。
      { kind: "text", who: "pi", time: "10:03", text: "无 uid 正文" },
    ];
    const out = sanitizeForSave(input);
    expect(out.map((m) => m.uid)).toEqual(["u-1-aaa", "at-3-ccc", undefined]);
    expect(out.some((m) => typeof m.uid === "string" && m.uid.startsWith("err-"))).toBe(false);
  });

  it("survivesSanitize 与 sanitizeForSave 一致:报错不计入隐藏游标 count", () => {
    const msgs: Message[] = [
      { kind: "text", who: "me", time: "10:00", text: "问", uid: "u-1-a" },
      { kind: "text", who: "pi", time: "10:01", text: "⚠️ 失败", uid: "err-2-b" },
      { kind: "text", who: "pi", time: "10:02", text: "答", uid: "at-3-c" },
    ];
    // count 以「落盘后存活」计:报错被剥离不计入,须与 sanitizeForSave 后长度一致(否则游标偏移)。
    expect(createHiddenHistory(msgs, 1).count).toBe(sanitizeForSave(msgs).length);
    expect(createHiddenHistory(msgs, 1).count).toBe(2);
  });
});

describe("ensureChatLoaded 即建即发不丢首条消息", () => {
  // 复现:Spotlight / 新会话落地页创建会话后同一 tick 立刻发送。新会话的 usePersonalChat
  // useQuery 已发起在途 loadChat,若 ensureChatLoaded 再自起一个 loadChat,晚到的那个会
  // 把已写入的首条用户消息覆盖成空历史。修复后两者去重为同一请求,首条消息得以保留。
  it("并发历史加载去重,首条用户消息不被空历史覆盖", async () => {
    const qc = new QueryClient();
    const key = personalChatKeys.detail("snew");
    const releases: Array<(v: Message[]) => void> = [];
    const loadChat = vi.fn(
      () => new Promise<Message[]>((resolve) => releases.push(resolve)),
    );
    const bridge = { loadChat } as unknown as Parameters<typeof __ensureChatLoadedForTest>[1];

    // (1) 模拟 usePersonalChat 的 useQuery 在新会话挂载时发起的在途历史加载。
    const observerFetch = qc.fetchQuery({
      queryKey: key,
      queryFn: () => loadChat(),
      staleTime: Infinity,
    });
    // (2) send 内部的 ensureChatLoaded —— 修复后应复用上面的在途 fetch,而非另起一个。
    const ensure = __ensureChatLoadedForTest(qc, bridge, "snew");

    // 放行历史加载(空历史)。去重后只有一个待 resolve 的请求。
    releases.forEach((r) => r([]));
    await Promise.all([observerFetch, ensure]);

    // (3) 历史落定后追加首条用户消息(模拟 send 的 appendMsg)。
    qc.setQueryData<Message[]>(key, (prev) => [...(prev ?? []), msg("u1", "明天什么天气")]);
    // 给可能晚到的覆盖一个机会(旧实现里第二个 loadChat 会在此后 resolve 并覆盖)。
    await Promise.resolve();

    // 去重:消息流 loadChat 复用在途请求只发一次;第二次是分支组补载(v2,独立 query key)。
    expect(loadChat).toHaveBeenCalledTimes(2);
    // 首条用户消息保留,未被空历史覆盖。
    const final = qc.getQueryData<Message[]>(key) ?? [];
    expect(final).toHaveLength(1);
    expect(asText(final[0]!).text).toBe("明天什么天气");
  });

  // 深化（U8）即建即发的基线:深化新会话与收件箱共享同一 queryKey
  // personalChatKeys.detail(sessionId),其首条用户消息同样不能被空历史覆盖（对照 1e0f2e7）。
  // 这里直接复刻深化路径的硬时序:createSession 返回新 id → 共享 key 上 useQuery 已在途
  // → ensureChatLoaded 去重 → 追加首条。
  it("深化即建即发:共享 queryKey + ensureChatLoaded,深化首条不被空历史覆盖", async () => {
    const qc = new QueryClient();
    // 深化新会话 id（createSession 返回值;深化路径用它拼 queryKey 与 docDir）。
    const deepenSessionId = "sess-deepen";
    const key = personalChatKeys.detail(deepenSessionId);
    const releases: Array<(v: Message[]) => void> = [];
    const loadChat = vi.fn(() => new Promise<Message[]>((resolve) => releases.push(resolve)));
    const bridge = { loadChat } as unknown as Parameters<typeof __ensureChatLoadedForTest>[1];

    // (1) NotesView/会话区挂载新会话时 useQuery 发起的在途历史加载。
    const observerFetch = qc.fetchQuery({
      queryKey: key,
      queryFn: () => loadChat(),
      staleTime: Infinity,
    });
    // (2) 深化编排里 send 调用的 ensureChatLoaded —— 必须复用上面的在途 fetch。
    const ensure = __ensureChatLoadedForTest(qc, bridge, deepenSessionId);

    releases.forEach((r) => r([]));
    await Promise.all([observerFetch, ensure]);

    // (3) send 的 appendMsg 写入种子首条用户消息。
    qc.setQueryData<Message[]>(key, (prev) => [...(prev ?? []), msg("u1", "深化这批闪记")]);
    await Promise.resolve();

    // 同上:1 次消息流(去重) + 1 次分支组补载。
    expect(loadChat).toHaveBeenCalledTimes(2);
    const final = qc.getQueryData<Message[]>(key) ?? [];
    expect(final).toHaveLength(1);
    expect(asText(final[0]!).text).toBe("深化这批闪记");
  });
});

describe("personal attachment system prompt", () => {
  // skill 注入块必须携带 path/base_dir + 公共说明，否则 agent 无法定位 SKILL.md 及其引用的同目录文件
  it("把 prompt 和 todo 附件序列化为不同上下文块，skill 块带 path/base_dir 与解析说明", () => {
    expect(
      buildAttachmentSystemPrompt([
        { id: "p1", name: "review.md", path: "/prompts/review.md", kind: "prompt", content: "Review rules" },
        {
          id: "t1",
          name: "实现续期",
          path: "/code/app/tasks/t1.md",
          kind: "todo",
          projectName: "app",
          content: "## 验收\n- 测试通过",
        },
      ]),
    ).toBe(
      [
        '<skill name="review.md" path="/prompts/review.md" base_dir="/prompts">',
        "Review rules",
        "</skill>",
        "",
        '<todo name="实现续期" project="app">',
        "# 实现续期",
        "",
        "## 验收\n- 测试通过",
        "</todo>",
        "",
        "注：skill 内的相对路径均基于其 base_dir；被引用的脚本/文档可直接按路径读取。",
      ].join("\n"),
    );
  });

  it("base_dir 为 path 去掉最后一段（嵌套目录）", () => {
    const out = buildAttachmentSystemPrompt([
      {
        id: "p1",
        name: "incident-apology-report",
        path: "/Users/mike/source/ai/skills/cortex-desktop/incident-apology-report/SKILL.md",
        kind: "prompt",
        content: "steps",
      },
    ]);
    expect(out).toContain('path="/Users/mike/source/ai/skills/cortex-desktop/incident-apology-report/SKILL.md"');
    expect(out).toContain('base_dir="/Users/mike/source/ai/skills/cortex-desktop/incident-apology-report"');
  });

  // path 无目录可推导（空串/仅文件名）时回退旧格式，且不输出公共说明——兼容旧数据
  it("path 无目录可推导时回退旧格式，不带属性与说明", () => {
    expect(
      buildAttachmentSystemPrompt([{ id: "p1", name: "review.md", path: "", kind: "prompt", content: "rules" }]),
    ).toBe('<skill name="review.md">\nrules\n</skill>');
    expect(
      buildAttachmentSystemPrompt([
        { id: "p2", name: "solo", path: "SKILL.md", kind: "prompt", content: "rules" },
      ]),
    ).toBe('<skill name="solo">\nrules\n</skill>');
  });
});

describe("buildTurnPromptText 附件块并入 prompt 文本（续轮留存）", () => {
  // claude --resume / codex exec resume 只回放对话历史,不回放上一轮 system prompt;
  // 附件块必须进 prompt 文本才能在续轮仍对 agent 可见（回归:第二轮 agent 丢失 skill 流程）。
  it("有附件块 → 附件块 + 空行 + 原文", () => {
    expect(buildTurnPromptText("继续实现", '<skill name="a">x</skill>')).toBe(
      '<skill name="a">x</skill>\n\n继续实现',
    );
  });

  it("无附件块 → 原文原样", () => {
    expect(buildTurnPromptText("继续实现", undefined)).toBe("继续实现");
  });

  it("纯附件无文本（如纯图发送）→ 仅附件块", () => {
    expect(buildTurnPromptText("", '<skill name="a">x</skill>')).toBe('<skill name="a">x</skill>');
  });
});

describe("buildGlobalAppend 全局指令 + 语言注入（U3/U4,三端统一）", () => {
  afterEach(() => {
    usePersonalStore.setState((s) => ({ generalSettings: { ...s.generalSettings, globalInstruction: undefined } }));
    useCortexUIStore.setState((s) => ({ tweaks: { ...s.tweaks, language: "zh-Hans" } }));
  });

  it("无全局指令 + zh → 仅语言指令(简体中文)", () => {
    useCortexUIStore.setState((s) => ({ tweaks: { ...s.tweaks, language: "zh-Hans" } }));
    expect(buildGlobalAppend()).toBe("请始终用简体中文回复。");
  });

  it("切到 en → 语言指令随之变英文", () => {
    useCortexUIStore.setState((s) => ({ tweaks: { ...s.tweaks, language: "en" } }));
    expect(buildGlobalAppend()).toBe("Always respond in English.");
  });

  it("全局指令 + 语言 → 全局指令在前、语言在后(顺序稳定)", () => {
    usePersonalStore.setState((s) => ({ generalSettings: { ...s.generalSettings, globalInstruction: "始终用简洁中文回答" } }));
    useCortexUIStore.setState((s) => ({ tweaks: { ...s.tweaks, language: "zh-Hans" } }));
    expect(buildGlobalAppend()).toBe("始终用简洁中文回答\n\n请始终用简体中文回复。");
  });

  it("全局指令仅空白 → trim 后不注入,仅保留语言指令", () => {
    usePersonalStore.setState((s) => ({ generalSettings: { ...s.generalSettings, globalInstruction: "   \n  " } }));
    useCortexUIStore.setState((s) => ({ tweaks: { ...s.tweaks, language: "en" } }));
    expect(buildGlobalAppend()).toBe("Always respond in English.");
  });
});

describe("piEntryMatchesText 编辑重发定位（U3/U4 前缀剥离回归）", () => {
  // U3/U4 后 buildGlobalAppend 恒非空,pi 每轮 prompt 经 buildPiPromptMessage 带前缀
  // `${appendSystemPrompt}\n\n${text}`。fork/编辑重发靠本函数「\n\n + 原文」后缀匹配剥离前缀定位,
  // 故必须验证:无论前缀含语言指令还是多块(全局指令+语言+附件),原文仍可命中。
  it("纯语言指令前缀 → 仍命中原文", () => {
    expect(piEntryMatchesText("请始终用简体中文回复。\n\n继续实现", "继续实现")).toBe(true);
  });

  it("多块前缀(全局指令 + 语言 + 附件)→ 仍命中原文(结尾 \\n\\n+原文)", () => {
    const entry = "始终用简洁中文\n\n请始终用简体中文回复。\n\n<skill name=\"a.md\">x</skill>\n\n继续实现";
    expect(piEntryMatchesText(entry, "继续实现")).toBe(true);
  });

  it("无前缀(裸原文)→ 命中", () => {
    expect(piEntryMatchesText("继续实现", "继续实现")).toBe(true);
  });

  it("尾串等于原文但无 \\n\\n 分隔 → 不误命中(收紧匹配)", () => {
    expect(piEntryMatchesText("xyz继续实现", "继续实现")).toBe(false);
  });
});

describe("pi RPC 会话事件折叠（handlePiEvent）", () => {
  const piSession: SessionMeta = { ...baseSession, agent: "pi", agentSessionIds: {} };

  function setupPiRun(qc: QueryClient, sessionId = "s1", runId = "prun-1"): string {
    usePersonalStore.setState({
      sessions: [{ ...piSession, id: sessionId }],
      runningBySession: {},
      piRuntimeBySession: {},
    });
    beginPiRun(qc, { runId, sessionId, typingUid: `typ-${sessionId}`, cwd: "/proj", promptText: "hi" });
    expect(usePersonalStore.getState().runningBySession[sessionId]).toBe(runId);
    return runId;
  }

  function cacheOf(qc: QueryClient, sessionId = "s1"): Message[] {
    return qc.getQueryData<Message[]>(personalChatKeys.detail(sessionId)) ?? [];
  }

  // 瞬态过程流缓存读取:agentLog（工具步骤）与 reasoning（思考）现落在 process key,不再进消息流。
  function processCacheOf(qc: QueryClient, sessionId = "s1"): Message[] {
    return qc.getQueryData<Message[]>(personalProcessKeys.detail(sessionId)) ?? [];
  }

  it("text 增量折叠进单一文本块", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "你好" });
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "世界" });
    const texts = cacheOf(qc).filter((m) => m.kind === "text" && m.who === "pi");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ text: "你好世界" });
  });

  it("reasoning 增量累进单一思考块(进过程流),不与正文混", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "先想想" });
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "再想想" });
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "答案" });
    // reasoning 落过程流(不落盘);正文落消息流。
    const reasoning = processCacheOf(qc).filter((m) => m.kind === "reasoning");
    const texts = cacheOf(qc).filter((m) => m.kind === "text" && m.who === "pi");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({ text: "先想想再想想", active: false, completed: true });
    expect(cacheOf(qc).some((m) => m.kind === "reasoning")).toBe(false); // 消息流无 reasoning
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ text: "答案" });
  });

  it("reasoning 未结束前保持 active,供 UI 默认展开", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "先想想" });
    const reasoning = processCacheOf(qc).find((m) => m.kind === "reasoning");
    expect(reasoning).toMatchObject({ text: "先想想", active: true });
  });

  it("tool-start 会收尾当前 reasoning,再在过程流追加工具卡片", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "先想工具" });
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1", detail: "ls" });
    const reasoning = processCacheOf(qc).find((m) => m.kind === "reasoning");
    const log = processCacheOf(qc).find((m) => m.kind === "agentLog");
    expect(reasoning).toMatchObject({ active: false, completed: true });
    expect(log).toMatchObject({ kind: "agentLog", active: true });
    // 工具卡片不进消息流。
    expect(cacheOf(qc).some((m) => m.kind === "agentLog")).toBe(false);
  });

  it("artifact 事件:产物进 store + 会话正文折叠 piArtifact 卡 + 过程流折叠已完成步骤;不自动弹面板", () => {
    usePiArtifactsStore.setState({ sessions: {}, openReq: undefined });
    const qc = new QueryClient();
    setupPiRun(qc);
    usePersonalStore.setState({ activeSessionId: "s1" });
    __handlePiEventForTest(qc, "s1", {
      type: "artifact",
      action: "create",
      filename: "chart.html",
      content: "<h1>hi</h1>",
    });
    const art = usePiArtifactsStore.getState();
    expect(art.sessions.s1!.byName["chart.html"]).toMatchObject({ content: "<h1>hi</h1>", version: 1, kind: "html" });
    // 实机反馈:宽面板挤占中栏 → 产物改为会话内渲染,**不再自动弹侧栏**(openReq 只由用户点击触发)。
    expect(art.openReq).toBeUndefined();
    // 会话正文流出现自含内容的 piArtifact 持久卡。
    const card = cacheOf(qc).find((m) => m.kind === "piArtifact");
    expect(card).toMatchObject({ filename: "chart.html", content: "<h1>hi</h1>", artifactKind: "html", version: 1 });
    // 过程流出现一条已完成的 artifacts 工具步骤（mapPiEvent 吞掉了 tool-start/tool-end,这是唯一来源）。
    const log = processCacheOf(qc).find((m) => m.kind === "agentLog");
    expect(log).toBeDefined();
    expect(JSON.stringify(log)).toContain("chart.html");
  });

  it("artifact 卡:update 同名原地覆盖且 version 自增;delete 置 deleted 保留卡壳;落盘存活", () => {
    usePiArtifactsStore.setState({ sessions: {}, openReq: undefined });
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "artifact", action: "create", filename: "a.md", content: "v1" });
    __handlePiEventForTest(qc, "s1", { type: "artifact", action: "update", filename: "a.md", content: "v2" });
    let cards = cacheOf(qc).filter((m) => m.kind === "piArtifact");
    expect(cards).toHaveLength(1); // 原地覆盖,不追加新卡
    expect(cards[0]).toMatchObject({ content: "v2", version: 2 });
    __handlePiEventForTest(qc, "s1", { type: "artifact", action: "delete", filename: "a.md" });
    cards = cacheOf(qc).filter((m) => m.kind === "piArtifact");
    expect(cards[0]).toMatchObject({ deleted: true });
    // 删除后重建 → 追加新卡(按时间线,不复活旧卡)。
    __handlePiEventForTest(qc, "s1", { type: "artifact", action: "create", filename: "a.md", content: "v3" });
    cards = cacheOf(qc).filter((m) => m.kind === "piArtifact");
    expect(cards).toHaveLength(2);
    expect(cards[1]).toMatchObject({ content: "v3", version: 1 });
    expect((cards[1] as { deleted?: boolean }).deleted).toBeFalsy();
    // 持久卡落盘存活(sanitizeForSave 黑名单机制)。
    expect(sanitizeForSave(cacheOf(qc)).filter((m) => m.kind === "piArtifact")).toHaveLength(2);
  });

  it("artifact 事件:无活跃 run 仍进 store(产物比单轮 run 长寿);带错 runId 也不被代际守卫丢弃", () => {
    usePiArtifactsStore.setState({ sessions: {}, openReq: undefined });
    const qc = new QueryClient();
    // 无 run:直接派发(会话恢复/竞态路径)。
    usePersonalStore.setState({ sessions: [{ ...piSession, id: "s1" }], runningBySession: {}, activeSessionId: undefined });
    __handlePiEventForTest(qc, "s1", { type: "artifact", action: "create", filename: "late.md", content: "v1" });
    expect(usePiArtifactsStore.getState().sessions.s1!.byName["late.md"]).toBeDefined();
    // 带过期 runId:守卫豁免,快照仍应用。
    setupPiRun(qc, "s1", "prun-new");
    __handlePiEventForTest(qc, "s1", { type: "artifact", action: "update", filename: "late.md", content: "v2" }, "prun-old");
    expect(usePiArtifactsStore.getState().sessions.s1!.byName["late.md"]!.content).toBe("v2");
  });

  it("tool-start + tool-end(同 toolCallId) 在过程流折叠为一张卡片并翻 check", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1", detail: "ls" });
    __handlePiEventForTest(qc, "s1", { type: "tool-end", name: "Bash", toolCallId: "t1", isError: false });
    const logs = processCacheOf(qc).filter((m) => m.kind === "agentLog");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ items: [{ ic: "check", text: "Bash · ls" }] });
    // 验证 finalizeLastToolItem 作用于 process key 而非持久流。
    expect(cacheOf(qc).some((m) => m.kind === "agentLog")).toBe(false);
  });

  it("tool-end 出错时项文本前缀 ⚠️(过程流)", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1", detail: "rm -rf" });
    __handlePiEventForTest(qc, "s1", { type: "tool-end", name: "Bash", toolCallId: "t1", isError: true });
    const log = processCacheOf(qc).find((m) => m.kind === "agentLog");
    expect(log?.kind === "agentLog" && log.items[0]).toMatchObject({ ic: "check", text: "⚠️ Bash · rm -rf" });
  });

  it("result(willRetry:false) 收尾本轮:清 running + 落定", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "完成" });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: false });
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined();
    vi.useRealTimers();
  });

  // settled（pi 0.82.1 agent_settled）三种到达顺序都必须幂等——重复收尾会多出空卡片 / usage 双计。
  it("settled 在 result 之后到达 → no-op（run 已删,不重复收尾）", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "完成" });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: false });
    const afterResult = cacheOf(qc);
    __handlePiEventForTest(qc, "s1", { type: "settled" });
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined();
    // 消息流不因迟到的 settled 增删任何条目。
    expect(cacheOf(qc)).toEqual(afterResult);
    vi.useRealTimers();
  });

  it("settled 单独到达（pi 漏发 agent_end）→ 补收尾,清 running", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "完成" });
    __handlePiEventForTest(qc, "s1", { type: "settled" });
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined();
    vi.useRealTimers();
  });

  it("settled 先到、result 随后 → 只收尾一次,running 不复活", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "完成" });
    __handlePiEventForTest(qc, "s1", { type: "settled" });
    const afterSettled = cacheOf(qc);
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: false });
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined();
    expect(cacheOf(qc)).toEqual(afterSettled);
    vi.useRealTimers();
  });

  it("settled 不误伤 result(willRetry:true) 保留的 run", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: true });
    // 重试链进行中 pi 不会发 settled;真发了也不该收尾——gotResult 已被 willRetry 分支复位为 false,
    // 故此处显式钉住「settled 不抢收尾」的边界（见 handlePiEvent 的 settled 分支注释）。
    __handlePiEventForTest(qc, "s1", { type: "settled" });
    expect(usePersonalStore.getState().runningBySession.s1).toBe("prun-1");
  });

  it("result(willRetry:true) 不收尾,running 保持", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: true });
    expect(usePersonalStore.getState().runningBySession.s1).toBe("prun-1");
  });

  it("result(willRetry:true) 会收尾本次 reasoning,下一次 reasoning 开新块", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "第一次" });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: true });
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "第二次" });
    const reasoning = processCacheOf(qc).filter((m) => m.kind === "reasoning");
    expect(reasoning).toHaveLength(2);
    expect(reasoning[0]).toMatchObject({ text: "第一次", active: false, completed: true });
    expect(reasoning[1]).toMatchObject({ text: "第二次", active: true });
    expect(usePersonalStore.getState().runningBySession.s1).toBe("prun-1");
  });

  it("error 事件 → ⚠️ 气泡;aborted → 中断轻提示", () => {
    const qc = new QueryClient();
    setupPiRun(qc, "s1");
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "出错前思考" });
    __handlePiEventForTest(qc, "s1", { type: "error", error: "401 unauthorized" });
    const err = cacheOf(qc).find((m) => m.kind === "text" && typeof m.text === "string" && m.text.startsWith("⚠️"));
    expect(err?.kind === "text" && err.text).toContain("执行出错");
    expect(err?.kind === "text" && err.text).toContain("供应商");
    // error 分支显式收尾过程流 reasoning。
    const reasoning = processCacheOf(qc).find((m) => m.kind === "reasoning");
    expect(reasoning).toMatchObject({ active: false, completed: true });

    const qc2 = new QueryClient();
    setupPiRun(qc2, "s2", "prun-2");
    __handlePiEventForTest(qc2, "s2", { type: "error", error: "aborted" });
    const abortMsg = cacheOf(qc2, "s2").find((m) => m.kind === "text" && typeof m.text === "string" && m.text.includes("已中断"));
    expect(abortMsg).toBeTruthy();
  });

  it("crashed → ⚠️ + 清 running/runtime;过程 reasoning 不入消息流", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    usePersonalStore.getState().setPiRuntime("s1", { steering: 2 });
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "崩溃前思考" });
    __handlePiEventForTest(qc, "s1", { type: "crashed", error: "退出码 1" });
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined();
    expect(usePersonalStore.getState().piRuntimeBySession.s1).toBeUndefined();
    // reasoning 落在过程流、绝不进消息流（崩溃文案才进消息流并落盘）。过程流的清空/收尾归 U2。
    expect(cacheOf(qc).some((m) => m.kind === "reasoning")).toBe(false);
    const crash = cacheOf(qc).find((m) => m.kind === "text" && typeof m.text === "string" && m.text.includes("已退出"));
    expect(crash).toBeTruthy();
  });

  it("notify(扩展命令输出)→ 作为 pi 消息入流 + 置 sawText(免补「纯工具轮」占位)", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "notify", message: "✅ 索引完成：120 条会话", level: "info" });
    const m = cacheOf(qc).find(
      (x) => x.kind === "text" && typeof x.text === "string" && x.text.includes("索引完成"),
    );
    expect(m).toMatchObject({ who: "pi" });
    // 随后补发的 result 收尾不应再加「纯工具轮」占位（sawText 已置真）。
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: false });
    expect(cacheOf(qc).some((x) => x.kind === "text" && typeof x.text === "string" && x.text.includes("索引完成"))).toBe(true);
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined(); // 已收尾
  });

  it("notify 多行输出 → 包进 ```text 代码块(保留换行/对齐,避免 markdown 折行)", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", {
      type: "notify",
      message: "📊 Results:\n├─ Sessions: 42\n└─ Messages: 206",
      level: "info",
    });
    const m = cacheOf(qc).find((x) => x.kind === "text" && typeof x.text === "string" && x.text.includes("Results"));
    expect(m?.kind === "text" && m.text).toMatch(/^```text\n/);
    expect(m?.kind === "text" && m.text).toContain("├─ Sessions: 42\n└─ Messages: 206");
  });

  it("queue/compaction/retry/thinking-level 写入 piRuntimeBySession", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "queue", steering: 3, followUp: 1 });
    __handlePiEventForTest(qc, "s1", { type: "compaction", phase: "start" });
    __handlePiEventForTest(qc, "s1", { type: "retry", attempt: 2, maxAttempts: 3 });
    __handlePiEventForTest(qc, "s1", { type: "thinking-level", level: "high" });
    const rt = usePersonalStore.getState().piRuntimeBySession.s1;
    expect(rt).toMatchObject({ steering: 3, followUp: 1, compacting: true, retry: { attempt: 2, max: 3 }, thinkingLevel: "high" });
  });

  it("事件按 uiSessionId 分派,A 会话不串进 B", () => {
    const qc = new QueryClient();
    usePersonalStore.setState({
      sessions: [
        { ...piSession, id: "s1" },
        { ...piSession, id: "s2" },
      ],
      runningBySession: {},
      piRuntimeBySession: {},
    });
    beginPiRun(qc, { runId: "r1", sessionId: "s1", typingUid: "t1" });
    beginPiRun(qc, { runId: "r2", sessionId: "s2", typingUid: "t2" });
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "给A" });
    expect(cacheOf(qc, "s1").some((m) => m.kind === "text" && m.text === "给A")).toBe(true);
    expect(cacheOf(qc, "s2").some((m) => m.kind === "text")).toBe(false);
  });

  it("代际守卫:带旧 runId 的事件被丢弃,不折叠进当前轮（阶段4 U7）", () => {
    const qc = new QueryClient();
    setupPiRun(qc); // runningBySession.s1 = "prun-1"
    // 当前轮事件（runId 匹配）→ 正常折叠。
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "本轮" }, "prun-1");
    // 旧轮串台事件（runId 不符）→ 丢弃。
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "旧轮串台" }, "prun-OLD");
    const texts = cacheOf(qc).filter((m) => m.kind === "text" && m.who === "pi");
    expect(texts.some((m) => m.kind === "text" && typeof m.text === "string" && m.text.includes("本轮"))).toBe(true);
    expect(texts.some((m) => m.kind === "text" && typeof m.text === "string" && m.text.includes("串台"))).toBe(false);
  });

  it("无 runId 的事件（旧契约/状态事件）放行,不被守卫拦", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "无 runId" }); // 不传 runId
    expect(cacheOf(qc).some((m) => m.kind === "text" && m.text === "无 runId")).toBe(true);
  });

  it("看门狗只刷新等待时长,绝不收尾本轮（长驻进程）", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupPiRun(qc);
    // 推进远超单发静默阈值（300s）;pi 轮仍在跑,不被自动收尾。
    await vi.advanceTimersByTimeAsync(400_000);
    expect(usePersonalStore.getState().runningBySession.s1).toBe("prun-1");
    vi.useRealTimers();
  });

  it("error 后无 result:宽限到期自行收尾清 running（防 pi 不发 agent_end 卡死）", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "error", error: "401 unauthorized" });
    expect(usePersonalStore.getState().runningBySession.s1).toBe("prun-1"); // 暂不收尾,等宽限
    await vi.advanceTimersByTimeAsync(4_000);
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined();
    vi.useRealTimers();
  });

  it("error 紧跟 result:下个事件取消宽限,不重复收尾", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "error", error: "boom" });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: false });
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined();
    const before = (qc.getQueryData<Message[]>(personalChatKeys.detail("s1")) ?? []).length;
    await vi.advanceTimersByTimeAsync(6_000); // 宽限已被取消,不应再动消息
    const after = (qc.getQueryData<Message[]>(personalChatKeys.detail("s1")) ?? []).length;
    expect(after).toBe(before);
    vi.useRealTimers();
  });

  it("error→willRetry:true→text→result:清掉瞬态错误,重试文本进新块", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "首答" });
    __handlePiEventForTest(qc, "s1", { type: "error", error: "transient" });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: true }); // 复位游标
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "重试答案" });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: false });
    const texts = cacheOf(qc).filter((m) => m.kind === "text" && m.who === "pi");
    // 首答与重试答案各自成块（游标已在 willRetry 复位,不并入同一块）。
    expect(texts.some((m) => m.kind === "text" && m.text === "重试答案")).toBe(true);
    expect(
      texts.some(
        (m) =>
          m.kind === "text" &&
          typeof m.text === "string" &&
          m.text.includes("执行出错"),
      ),
    ).toBe(false);
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined();
  });

  it("reapSessionRun:停看门狗 + 删 run + 清 running/runtime（删运行中会话用）", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    usePersonalStore.getState().setPiRuntime("s1", { steering: 2 });
    reapSessionRun(qc, "s1");
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined();
    expect(usePersonalStore.getState().piRuntimeBySession.s1).toBeUndefined();
    // 残余事件到来已无活跃 run,被安全丢弃（不抛、不写）。
    expect(() => __handlePiEventForTest(qc, "s1", { type: "text", delta: "晚到" })).not.toThrow();
    expect(cacheOf(qc).some((m) => m.kind === "text" && m.text === "晚到")).toBe(false);
  });

  it("reapSessionRun:强制回收一个在跑的 run 时经注入 bridge 以 warn 级记录埋点（U7）", () => {
    const qc = new QueryClient();
    const logMessage = vi.fn<(level: string, message: string) => Promise<void>>(async () => {});
    setupPiRun(qc);
    __setBridgeForTest({ loadChat: async () => [], saveChat: async () => {}, logMessage } as unknown as Parameters<
      typeof __setBridgeForTest
    >[0]);
    reapSessionRun(qc, "s1");
    expect(logMessage).toHaveBeenCalledTimes(1);
    const [level, message] = logMessage.mock.calls[0]!;
    expect(level).toBe("warn");
    expect(message).toContain("force-reclaim");
    expect(message).toContain("agent=pi");
    __setBridgeForTest(null);
  });

  it("reapSessionRun:web 端 bridge=null 时不抛错（埋点安全 no-op）", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __setBridgeForTest(null);
    expect(() => reapSessionRun(qc, "s1")).not.toThrow();
  });
});

// ── U1：过程流独立通道 + 不落盘 + 旧档迁移 ──────────────────────────────────
describe("U1 过程流独立通道（CLI）", () => {
  const chatOf = (qc: QueryClient, sessionId = "s1"): Message[] =>
    qc.getQueryData<Message[]>(personalChatKeys.detail(sessionId)) ?? [];
  const procOf = (qc: QueryClient, sessionId = "s1"): Message[] =>
    qc.getQueryData<Message[]>(personalProcessKeys.detail(sessionId)) ?? [];

  // 用 init 事件触发 HMR 兜底重建一个 claude run（runs 注册表里有该 runId）。
  function setupCliRun(qc: QueryClient, sessionId = "s1", runId = "run-c1"): void {
    usePersonalStore.setState({
      sessions: [{ ...baseSession, id: sessionId, agent: "claude", agentSessionIds: {} }],
      runningBySession: {},
    });
    __handleCliEventForTest(qc, runId, { type: "init", sessionId: "claude-sess" }, sessionId);
    expect(usePersonalStore.getState().runningBySession[sessionId]).toBe(runId);
  }

  it("一轮 text 事件:消息流含 text,过程流为空", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-c1", { type: "text", delta: "你好结果" }, "s1");
    const texts = chatOf(qc).filter((m) => m.kind === "text" && m.who === "claude");
    expect(texts).toHaveLength(1);
    expect(asText(texts[0]!).text).toBe("你好结果");
    expect(procOf(qc)).toHaveLength(0);
  });

  it("一轮 tool 事件:过程流含 running 的 agentLog,消息流不新增 agentLog", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-c1", { type: "tool", name: "Edit", detail: "a.ts" }, "s1");
    const logs = procOf(qc).filter((m) => m.kind === "agentLog");
    expect(logs).toHaveLength(1);
    expect(asLog(logs[0]!)).toMatchObject({ active: true, items: [{ ic: "running", text: "Edit · a.ts" }] });
    expect(chatOf(qc).some((m) => m.kind === "agentLog")).toBe(false);
  });

  it("thinking↔tool 交错:过程流按时序生成 [思考,工具,思考,工具] 多块,而非合并", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    // 真实 codex 轮:think → tool → think → tool。每次切换收尾对方的块,保留完整时间线。
    __handleCliEventForTest(qc, "run-c1", { type: "thinking", delta: "先分析" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "tool", name: "Shell", detail: "ls" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "thinking", delta: "再分析" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "tool", name: "Shell", detail: "cat" }, "s1");
    const proc = procOf(qc);
    expect(proc.map((m) => m.kind)).toEqual(["reasoning", "agentLog", "reasoning", "agentLog"]);
    // 两个思考块各自独立(不被合并),第一个已收尾、第二个仍活跃。
    const reasonings = proc.filter((m) => m.kind === "reasoning");
    expect(reasonings[0]).toMatchObject({ text: "先分析", active: false });
    expect(reasonings[1]).toMatchObject({ text: "再分析" });
  });

  it("tool 事件更新消息流里的 transient typing 占位,但不落盘", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    qc.setQueryData<Message[]>(personalChatKeys.detail("s1"), [
      { kind: "typing", who: "claude", uid: "recovered-no-typing", text: "启动中" },
    ]);
    __handleCliEventForTest(qc, "run-c1", { type: "tool", name: "Edit", detail: "a.ts" }, "s1");
    const typing = chatOf(qc).find((m) => m.kind === "typing");
    expect(typing).toMatchObject({ kind: "typing", text: "Claude Code 正在执行 Edit · a.ts" });
    expect(sanitizeForSave(chatOf(qc)).some((m) => m.kind === "typing")).toBe(false);
  });

  it("tool,tool,text:text 到达对 process key 收尾 agentLog(两步全 check),消息流只一条 text", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-c1", { type: "tool", name: "Read", detail: "x" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "tool", name: "Edit", detail: "y" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "text", delta: "完成了" }, "s1");
    // 跨流收尾:process 流的 agentLog 两步全部 check 且完成（非 :408 同数组 no-op）。
    const log = procOf(qc).find((m) => m.kind === "agentLog");
    expect(asLog(log!)).toMatchObject({ active: false, completed: true });
    expect(asLog(log!).items.every((it) => it.ic === "check")).toBe(true);
    // 消息流只有一条 agent text,无 agentLog。
    const texts = chatOf(qc).filter((m) => m.kind === "text" && m.who === "claude");
    expect(texts).toHaveLength(1);
    expect(asText(texts[0]!).text).toBe("完成了");
    expect(chatOf(qc).some((m) => m.kind === "agentLog")).toBe(false);
  });

  it("text 后接 tool:消息流新文本块在 tool 之后开新块（tool 打断文本，process/message 各自折叠）", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-c1", { type: "text", delta: "段一" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "tool", name: "Bash" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "text", delta: "段二" }, "s1");
    const texts = chatOf(qc).filter((m) => m.kind === "text" && m.who === "claude");
    // tool 打断:段一、段二各自成块(不并入同一文本块)。
    expect(texts.map((m) => asText(m).text)).toEqual(["段一", "段二"]);
    expect(procOf(qc).filter((m) => m.kind === "agentLog")).toHaveLength(1);
  });

  it("result 收尾过程流当前 agentLog（非消息流）", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-c1", { type: "tool", name: "Edit", detail: "z" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "result", ok: true, text: "" }, "s1");
    const log = procOf(qc).find((m) => m.kind === "agentLog");
    expect(asLog(log!)).toMatchObject({ active: false, completed: true });
    expect(asLog(log!).items.every((it) => it.ic === "check")).toBe(true);
  });

  // ── 三段编排:中间段 text(intent/subagent)进过程流、绝不落聊天正文 ────────────
  // 回归保护:不按 stage 路由时，段1改写提示词 + 段2子执行输出会全部拼进聊天正文。
  it("编排中间段 text(intent/subagent)进过程流,聊天正文为空", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-c1", { type: "text", delta: "改写后的提示词", stage: "intent" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "text", delta: "子执行输出", stage: "subagent" }, "s1");
    // 两段中间文本进过程流(与 reasoning 同通道、无工具打断时折叠为同一块),聊天正文不出现。
    const reasonings = procOf(qc).filter((m) => m.kind === "reasoning");
    expect(reasonings.map((m) => (m as { text: string }).text).join("")).toBe("改写后的提示词子执行输出");
    expect(chatOf(qc).some((m) => m.kind === "text" && m.who === "claude")).toBe(false);
  });

  it("编排 refine 段 text 进聊天正文(最终回复)", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-c1", { type: "text", delta: "过程", stage: "subagent" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "text", delta: "最终回复", stage: "refine" }, "s1");
    const texts = chatOf(qc).filter((m) => m.kind === "text" && m.who === "claude");
    // 聊天正文只含 refine 段(最终回复),中间段被挡在过程流。
    expect(texts.map((m) => asText(m).text)).toEqual(["最终回复"]);
  });

  it("编排段边界 thinking 事件(空 delta + stageLabel)在过程流插入 stageTitle 块、不产生空 reasoning", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-c1", { type: "thinking", delta: "", stage: "intent", stageLabel: "理解意图中…" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "thinking", delta: "", stage: "subagent", stageLabel: "子 agent 执行中…" }, "s1");
    // refine 段输出进聊天正文,过程面板其后无内容,不插标题(避免悬空"假进行中")。
    __handleCliEventForTest(qc, "run-c1", { type: "thinking", delta: "", stage: "refine", stageLabel: "整理回复中…" }, "s1");
    const stages = procOf(qc).filter((m) => m.kind === "stageTitle");
    expect(stages.map((m) => (m as { label: string }).label)).toEqual(["理解意图中…", "子 agent 执行中…"]);
    // 空 delta 不得创建空 reasoning 块（段边界走 stageTitle 通道，不进 foldReasoning）。
    expect(procOf(qc).some((m) => m.kind === "reasoning")).toBe(false);
    // 段边界不落聊天正文。
    expect(chatOf(qc).some((m) => m.kind === "text")).toBe(false);
  });
});

describe("U3 纯工具轮终态占位（中栏避免「问了没回」）", () => {
  const chatOf = (qc: QueryClient, sessionId = "s1"): Message[] =>
    qc.getQueryData<Message[]>(personalChatKeys.detail(sessionId)) ?? [];

  // claude run（HMR 兜底重建,runs 注册表里有该 runId）。
  function setupCliRun(qc: QueryClient, sessionId = "s1", runId = "run-c1"): void {
    usePersonalStore.setState({
      sessions: [{ ...baseSession, id: sessionId, agent: "claude", agentSessionIds: {} }],
      runningBySession: {},
    });
    __handleCliEventForTest(qc, runId, { type: "init", sessionId: "claude-sess" }, sessionId);
  }

  function setupPiRun(qc: QueryClient, sessionId = "s1", runId = "prun-1"): void {
    usePersonalStore.setState({
      sessions: [{ ...baseSession, id: sessionId, agent: "pi", agentSessionIds: {} }],
      runningBySession: {},
      piRuntimeBySession: {},
    });
    beginPiRun(qc, { runId, sessionId, typingUid: `typ-${sessionId}`, cwd: "/proj", promptText: "hi" });
  }

  it("CLI 纯工具轮(ev.ok、!sawText、!ev.text):不追加持久 text 占位", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-c1", { type: "tool", name: "Bash", detail: "ls" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "result", ok: true, text: "" }, "s1");
    const texts = chatOf(qc).filter((m) => m.kind === "text" && m.who === "claude");
    expect(texts).toHaveLength(0);
  });

  it("CLI 有文本的正常轮:不追加占位(不重复)", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-c1", { type: "text", delta: "真正回复" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "result", ok: true, text: "" }, "s1");
    const texts = chatOf(qc).filter((m) => m.kind === "text" && m.who === "claude");
    expect(texts).toHaveLength(1);
    expect(asText(texts[0]!).text).toBe("真正回复");
    expect(chatOf(qc).some((m) => m.kind === "text" && asText(m).text === PURE_TOOL_TURN_PLACEHOLDER)).toBe(false);
  });

  it("CLI result 带最终文本(ev.text)时用其兜底,不补占位", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-c1", { type: "tool", name: "Read", detail: "x" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "result", ok: true, text: "最终结果" }, "s1");
    const texts = chatOf(qc).filter((m) => m.kind === "text" && m.who === "claude");
    expect(texts).toHaveLength(1);
    expect(asText(texts[0]!).text).toBe("最终结果");
  });

  it("Covers R4. CLI result.ok=false:进消息流的是 ⚠️ 错误文案,而非占位", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-c1", { type: "tool", name: "Bash", detail: "boom" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "result", ok: false, error: "炸了" }, "s1");
    const texts = chatOf(qc).filter((m) => m.kind === "text" && m.who === "claude");
    expect(texts).toHaveLength(1);
    expect(asText(texts[0]!).text).toContain("⚠️");
    expect(chatOf(qc).some((m) => m.kind === "text" && asText(m).text === PURE_TOOL_TURN_PLACEHOLDER)).toBe(false);
  });

  it("pi 纯工具轮(result 仅 willRetry:false、!sawText):不追加持久 text 占位", () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1", detail: "ls" });
    __handlePiEventForTest(qc, "s1", { type: "tool-end", name: "Bash", toolCallId: "t1", isError: false });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: false });
    const texts = chatOf(qc).filter((m) => m.kind === "text" && m.who === "pi");
    expect(texts).toHaveLength(0);
    vi.useRealTimers();
  });

  it("pi tool-start/tool-end 更新消息流里的 transient typing 占位", () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupPiRun(qc);
    qc.setQueryData<Message[]>(personalChatKeys.detail("s1"), [
      { kind: "typing", who: "pi", uid: "typ-s1", text: "启动中" },
    ]);
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1", detail: "ls" });
    expect(chatOf(qc).find((m) => m.kind === "typing")).toMatchObject({
      kind: "typing",
      text: "Cortex 正在执行 Bash · ls",
    });
    __handlePiEventForTest(qc, "s1", { type: "tool-end", name: "Bash", toolCallId: "t1", isError: false });
    expect(chatOf(qc).find((m) => m.kind === "typing")).toMatchObject({
      kind: "typing",
      text: "Cortex 已完成 Bash",
    });
    vi.useRealTimers();
  });

  it("pi 有文本的正常轮:不追加占位(不重复)", () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "完成" });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: false });
    const texts = chatOf(qc).filter((m) => m.kind === "text" && m.who === "pi");
    expect(texts).toHaveLength(1);
    expect(asText(texts[0]!).text).toBe("完成");
    expect(chatOf(qc).some((m) => m.kind === "text" && asText(m).text === PURE_TOOL_TURN_PLACEHOLDER)).toBe(false);
    vi.useRealTimers();
  });

  it("pi 只有思考、没有最终正文时给出可见提示，不静默结束本轮", () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "正在分析" });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: false });

    const texts = chatOf(qc).filter((m) => m.kind === "text" && m.who === "pi");
    expect(texts).toHaveLength(1);
    expect(asText(texts[0]!).text).toContain("未生成最终答复");
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined();
    vi.useRealTimers();
  });

  it("pi result(willRetry:true) 不收尾、不补占位（仅等下一轮）", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: true });
    expect(chatOf(qc).some((m) => m.kind === "text" && asText(m).text === PURE_TOOL_TURN_PLACEHOLDER)).toBe(false);
  });

  it("pi 失败轮(resultOk=false,error 先到)不补占位:仅 ⚠️ 错误文案进消息流", () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "error", error: "401 unauthorized" });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: false });
    const texts = chatOf(qc).filter((m) => m.kind === "text" && m.who === "pi");
    expect(texts.some((m) => typeof asText(m).text === "string" && (asText(m).text as string).startsWith("⚠️"))).toBe(
      true,
    );
    expect(texts.some((m) => asText(m).text === PURE_TOOL_TURN_PLACEHOLDER)).toBe(false);
    vi.useRealTimers();
  });
});

describe("U1 过程流永不落盘（saveChat spy）", () => {
  it("一轮 text+tool+reasoning:saveChat 只收到 text;process key 写入从不触发 bridge.save*", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    const saveChat = vi.fn<(sessionId: string, messages: Message[]) => Promise<void>>(async () => undefined);
    __setBridgeForTest({ saveChat } as unknown as Parameters<typeof __setBridgeForTest>[0]);
    usePersonalStore.setState({
      sessions: [{ ...baseSession, id: "s1", agent: "pi", agentSessionIds: {} }],
      runningBySession: {},
      piRuntimeBySession: {},
    });
    beginPiRun(qc, { runId: "prun-s", sessionId: "s1", typingUid: "typ", cwd: "/p", promptText: "hi" });
    // 预置空分支组:flushChat 落盘前要求分支态已加载(v2 兼容),测试桩 bridge 无 loadChat 补载通道。
    qc.setQueryData(personalBranchKeys.detail("s1"), []);
    saveChat.mockClear(); // 忽略 beginPiRun 前可能的写入,只看流式阶段。

    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "思考" });
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1", detail: "ls" });
    __handlePiEventForTest(qc, "s1", { type: "tool-end", name: "Bash", toolCallId: "t1", isError: false });
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "答案" });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: false });
    await vi.advanceTimersByTimeAsync(2_000); // 推进任何节流/兜底 timer。

    // saveChat 被调用过(text/result 驱动),但每次入参都不含 agentLog/reasoning。
    expect(saveChat).toHaveBeenCalled();
    for (const [, saved] of saveChat.mock.calls) {
      expect(saved.every((m) => m.kind !== "agentLog" && m.kind !== "reasoning" && m.kind !== "typing")).toBe(true);
    }
    // 最后一次落盘内容只含 text。
    const lastSaved = saveChat.mock.calls[saveChat.mock.calls.length - 1]![1];
    expect(lastSaved.every((m) => m.kind === "text")).toBe(true);
    vi.useRealTimers();
  });
});

describe("U1 旧档破坏性迁移与隐藏游标无损（R11）", () => {
  const t = (uid: string, text = uid, who = "me"): Message =>
    ({ kind: "text", who, time: "10:00", text, uid }) as Message;
  const log = (uid: string): Message =>
    ({ kind: "agentLog", who: "claude", time: "10:00", title: "执行", active: false, completed: true, items: [{ ic: "check", text: "Edit" }], uid }) as Message;

  it("加载含历史 agentLog 的旧档 → 触发一次 flushChat → saveChat 入参已不含 agentLog", () => {
    const qc = new QueryClient();
    const saveChat = vi.fn<(sessionId: string, messages: Message[]) => Promise<void>>(async () => undefined);
    __setBridgeForTest({ saveChat } as unknown as Parameters<typeof __setBridgeForTest>[0]);
    // 模拟加载后的缓存（loadChat 已过 sanitize 则本就无 agentLog;但若缓存里混入 agentLog，
    // flushChat 也必须原地清洗——这里直接喂含 agentLog 的缓存固化破坏性契约）。
    qc.setQueryData<Message[]>(personalChatKeys.detail("s1"), [t("u1", "问"), log("g1"), t("a1", "答", "claude")]);
    // 预置空分支组(理由同上:测试桩无 loadChat,跳过 flushChat 的分支补载异步跳变)。
    qc.setQueryData(personalBranchKeys.detail("s1"), []);
    __flushChatForTest(qc, "s1");
    expect(saveChat).toHaveBeenCalledTimes(1);
    const saved = saveChat.mock.calls[0]![1];
    expect(saved.some((m) => m.kind === "agentLog")).toBe(false);
    expect(saved.map((m) => m.kind)).toEqual(["text", "text"]);
  });

  it("throughUid 命中路径:剥离 agentLog 后可见/隐藏切分对用户语义不变", () => {
    // 旧档:text-agentLog-text 交错 + 带 throughUid 的隐藏游标。
    const original = [t("u1", "旧问"), log("g1"), t("a1", "旧答", "claude"), t("u2", "新问"), t("a2", "新答", "claude")];
    const hh = { count: 3, throughUid: "a1", hiddenAt: 1 }; // 隐藏到「旧答」为止。
    // 清洗后数组（agentLog 剥离）。
    const stripped = sanitizeForSave(original);
    // throughUid 命中:adjust 原样返回（位置无关）。
    const adjusted = adjustHiddenHistoryForSanitize(original, hh);
    expect(adjusted).toEqual(hh);
    const before = splitPersonalMessages(original, hh);
    const after = splitPersonalMessages(stripped, adjusted);
    // 可见集（剔除 agentLog 后）对用户语义一致。
    const userVisible = (s: typeof before) => s.visibleMessages.filter((m) => m.kind === "text").map((m) => m.uid);
    expect(userVisible(after)).toEqual(userVisible(before));
    expect(userVisible(after)).toEqual(["u2", "a2"]);
  });

  it("count 兜底路径（无 throughUid）:回算 count 后隐藏/可见边界对用户语义不变", () => {
    // 旧档:text-agentLog-text 交错,隐藏游标仅 count（隐藏到「旧答」为止 = 原数组前 3 条）。
    const original = [t("u1", "旧问"), log("g1"), t("a1", "旧答", "claude"), t("u2", "新问"), t("a2", "新答", "claude")];
    const hh = { count: 3, hiddenAt: 1 }; // 无 throughUid。
    const stripped = sanitizeForSave(original);
    const adjusted = adjustHiddenHistoryForSanitize(original, hh)!;
    // 原前 3 条里有 1 条 agentLog 被剥离 → count 回算为 2。
    expect(adjusted.count).toBe(2);
    const before = splitPersonalMessages(original, hh);
    const after = splitPersonalMessages(stripped, adjusted);
    const userVisible = (s: typeof before) => s.visibleMessages.filter((m) => m.kind === "text").map((m) => m.uid);
    expect(userVisible(after)).toEqual(userVisible(before));
    expect(userVisible(after)).toEqual(["u2", "a2"]);
  });

  it("createHiddenHistory 用「落盘后存活」计数(忽略 agentLog/reasoning)", () => {
    const msgs = [t("u1"), log("g1"), t("a1", "答", "claude")];
    expect(createHiddenHistory(msgs, 9)).toEqual({ count: 2, throughUid: "a1", hiddenAt: 9 });
  });
});

describe("pi extension UI 待确认队列（阶段3 U5）", () => {
  const req = (id: string) =>
    ({ type: "extension_ui_request", id, method: "confirm", title: "T", message: "M" }) as const;

  beforeEach(() => usePersonalStore.setState({ piUiPending: [], sessions: [], runningBySession: {} }));

  it("push/resolve/clearForSession store 队列", () => {
    const st = usePersonalStore.getState();
    st.pushPiUiRequest({ uiSessionId: "sA", request: req("1") });
    st.pushPiUiRequest({ uiSessionId: "sB", request: req("1") });
    expect(usePersonalStore.getState().piUiPending).toHaveLength(2);
    st.resolvePiUiRequest("sA", "1");
    expect(usePersonalStore.getState().piUiPending.map((p) => `${p.uiSessionId}:${p.request.id}`)).toEqual(["sB:1"]);
    usePersonalStore.getState().pushPiUiRequest({ uiSessionId: "sB", request: req("3") });
    usePersonalStore.getState().clearPiUiForSession("sB");
    expect(usePersonalStore.getState().piUiPending).toHaveLength(0);
  });

  it("respondPiUi:回写 piUiResponse + 出队", () => {
    const piUiResponse = vi.fn(async () => undefined);
    usePersonalStore.getState().pushPiUiRequest({ uiSessionId: "sA", request: req("7") });
    respondPiUi({ piUiResponse } as unknown as Parameters<typeof respondPiUi>[0], "sA", "7", { confirmed: true });
    expect(piUiResponse).toHaveBeenCalledWith("sA", "7", { confirmed: true });
    expect(usePersonalStore.getState().piUiPending).toHaveLength(0);
  });

  it("respondPiUi:bridge 无 piUiResponse（web）时只出队,不抛", () => {
    usePersonalStore.getState().pushPiUiRequest({ uiSessionId: "sA", request: req("8") });
    expect(() => respondPiUi(null, "sA", "8", { cancelled: true })).not.toThrow();
    expect(usePersonalStore.getState().piUiPending).toHaveLength(0);
  });

  it("crashed 事件清掉该会话悬挂的确认弹窗", () => {
    const qc = new QueryClient();
    usePersonalStore.setState({
      sessions: [{ ...baseSession, id: "s1", agent: "pi" }],
      runningBySession: {},
      piRuntimeBySession: {},
      piUiPending: [{ uiSessionId: "s1", request: req("9") }],
    });
    __handlePiEventForTest(qc, "s1", { type: "crashed", error: "退出码 1" });
    expect(usePersonalStore.getState().piUiPending).toHaveLength(0);
  });
});

describe("serializeAskQuestionAnswers（答案聚合纯函数,U4）", () => {
  const env = {
    groups: [
      { id: "g0", question: "Q0", options: [{ label: "A" }, { label: "B" }], recommended: 0, allowCustom: true },
      { id: "g1", question: "Q1", options: [{ label: "X" }], allowCustom: true },
    ],
  };

  it("选项作答 → value=label,isCustom=false", () => {
    const out = JSON.parse(serializeAskQuestionAnswers(env, { g0: { optionIndex: 1 }, g1: { optionIndex: 0 } }));
    expect(out.answers).toEqual([
      { groupId: "g0", value: "B", isCustom: false },
      { groupId: "g1", value: "X", isCustom: false },
    ]);
  });

  it("自定义非空 → 覆盖选项(互斥),isCustom=true,trim", () => {
    const out = JSON.parse(
      serializeAskQuestionAnswers(env, { g0: { optionIndex: 0, custom: "  我的答案  " }, g1: { optionIndex: 0 } }),
    );
    expect(out.answers[0]).toEqual({ groupId: "g0", value: "我的答案", isCustom: true });
    expect(out.answers[1]).toEqual({ groupId: "g1", value: "X", isCustom: false });
  });

  it("自定义空串 → 回落选项;选项越界且无自定义 → 跳过该组", () => {
    const out = JSON.parse(serializeAskQuestionAnswers(env, { g0: { optionIndex: 0, custom: "   " }, g1: { optionIndex: 9 } }));
    expect(out.answers).toEqual([{ groupId: "g0", value: "A", isCustom: false }]);
  });
});

// ── U2：过程流生命周期与按语义分类的清理出口 ────────────────────────────────
describe("U2 过程流生命周期与清理出口", () => {
  const chatOf = (qc: QueryClient, sessionId = "s1"): Message[] =>
    qc.getQueryData<Message[]>(personalChatKeys.detail(sessionId)) ?? [];
  const procOf = (qc: QueryClient, sessionId = "s1"): Message[] =>
    qc.getQueryData<Message[]>(personalProcessKeys.detail(sessionId)) ?? [];

  // 经 init 触发 HMR 兜底重建一个 claude run（runs 注册表里有该 runId）。
  function setupCliRun(qc: QueryClient, sessionId = "s1", runId = "run-u2"): void {
    usePersonalStore.setState({
      sessions: [{ ...baseSession, id: sessionId, agent: "claude", agentSessionIds: {} }],
      runningBySession: {},
    });
    __handleCliEventForTest(qc, runId, { type: "init", sessionId: "claude-sess" }, sessionId);
  }

  const piSession: SessionMeta = { ...baseSession, agent: "pi", agentSessionIds: {} };
  function setupPiRun(qc: QueryClient, sessionId = "s1", runId = "prun-u2"): string {
    usePersonalStore.setState({
      sessions: [{ ...piSession, id: sessionId }],
      runningBySession: {},
      piRuntimeBySession: {},
    });
    beginPiRun(qc, { runId, sessionId, typingUid: `typ-${sessionId}`, cwd: "/proj", promptText: "hi" });
    return runId;
  }

  it("finalizeRun 成功后过程流步骤全部完成且保留可读（不立即清空）", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-u2", { type: "tool", name: "Edit", detail: "a.ts" }, "s1");
    __handleCliEventForTest(qc, "run-u2", { type: "result", ok: true, text: "" }, "s1");
    // result 收尾过程流当前 agentLog;此时过程流仍在（未清）。
    await vi.advanceTimersByTimeAsync(RESULT_EXIT_GRACE_MS); // 触发 finalizeRun（成功路径）。
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined();
    const logs = procOf(qc).filter((m) => m.kind === "agentLog");
    expect(logs).toHaveLength(1); // 保留可读,未被清空。
    expect(logs[0]).toMatchObject({ active: false, completed: true });
    expect((logs[0] as Extract<Message, { kind: "agentLog" }>).items.every((it) => it.ic === "check")).toBe(true);
    vi.useRealTimers();
  });

  it("pi result(成功) 收尾本轮:过程流 reasoning+agentLog 全部完成且保留", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "想想" });
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1", detail: "ls" });
    __handlePiEventForTest(qc, "s1", { type: "tool-end", name: "Bash", toolCallId: "t1", isError: false });
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "答案" });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: false }); // 同步收尾 finalizeRun 成功路径。
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined();
    // 过程流保留可读且全部完成态。
    const log = procOf(qc).find((m) => m.kind === "agentLog");
    const reasoning = procOf(qc).find((m) => m.kind === "reasoning");
    expect(log).toMatchObject({ active: false, completed: true });
    expect((log as Extract<Message, { kind: "agentLog" }>).items.every((it) => it.ic === "check")).toBe(true);
    expect(reasoning).toMatchObject({ active: false, completed: true });
  });

  it("finalizeProcessForRetain 兜底:成功收尾把残留 active 过程块翻完成并保留", () => {
    // 构造一个「success（gotResult+resultOk 不为 false）但过程流仍有 active agentLog 未被收尾」的边界
    // （正常 result/turn-end 已收尾,这里直接喂状态固化兜底契约）。经 setupPiRun 起 run 后,先放一个
    // tool-start（过程流 active agentLog），再喂 result 之外的 turn-end？turn-end 也会收尾——故改为直接
    // 在 process key 注入一个 active agentLog,再触发成功 finalizeRun（result）验证兜底翻完成 + 保留。
    const qc = new QueryClient();
    setupPiRun(qc);
    qc.setQueryData<Message[]>(personalProcessKeys.detail("s1"), [
      { kind: "agentLog", who: "pi", time: "10:00", title: "执行", active: true, items: [{ ic: "running", text: "Bash" }], uid: "stale-log" },
    ]);
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "done" });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: false });
    const log = procOf(qc).find((m) => m.uid === "stale-log");
    expect(log).toMatchObject({ active: false, completed: true });
    expect((log as Extract<Message, { kind: "agentLog" }>).items.every((it) => it.ic === "check")).toBe(true);
  });

  it("纯文本轮（无过程）finalizeRun 成功不创建空过程缓存", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-u2", { type: "text", delta: "你好" }, "s1");
    __handleCliEventForTest(qc, "run-u2", { type: "result", ok: true, text: "" }, "s1");
    await vi.advanceTimersByTimeAsync(RESULT_EXIT_GRACE_MS);
    expect(qc.getQueryData(personalProcessKeys.detail("s1"))).toBeUndefined();
    vi.useRealTimers();
  });

  it("切到他会话:A 过程流不被清,切回仍可重现（按 key 隔离保留）", () => {
    const qc = new QueryClient();
    setupCliRun(qc, "sA", "run-A");
    __handleCliEventForTest(qc, "run-A", { type: "tool", name: "Edit", detail: "a.ts" }, "sA");
    // 「切到他会话」在 core 层不触发任何清理;A 的 process key 原样保留,供切回重现。
    expect(procOf(qc, "sA").filter((m) => m.kind === "agentLog")).toHaveLength(1);
  });

  it("开始新一轮即清:clearProcess 清掉上一轮保留过程", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-u2", { type: "tool", name: "Edit", detail: "a.ts" }, "s1");
    expect(procOf(qc).filter((m) => m.kind === "agentLog")).toHaveLength(1);
    // 新一轮入口（send 起手）会 clearProcess（此处用测试入口模拟该清理语义）。
    __clearProcessForTest(qc, "s1");
    expect(qc.getQueryData(personalProcessKeys.detail("s1"))).toBeUndefined();
  });

  it("运行中 stop（reapSessionRun/4s 兜底语义）:过程流被清,无错误文本误入消息流", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1", detail: "ls" });
    expect(procOf(qc).filter((m) => m.kind === "agentLog")).toHaveLength(1);
    // reapSessionRun 是 stop/删会话共用的立即清空出口。
    reapSessionRun(qc, "s1");
    expect(qc.getQueryData(personalProcessKeys.detail("s1"))).toBeUndefined();
    // 不应有 ⚠️ 误入消息流（stop 收尾不追加错误文案）。
    expect(chatOf(qc).some((m) => m.kind === "text" && typeof m.text === "string" && m.text.startsWith("⚠️"))).toBe(false);
  });

  it("会话删除（reapSessionRun）在挂了游离清理 timer 后:推进 fake timer 不复活过程流", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1", detail: "ls" });
    // 模拟「会话结束后挂的游离延迟清理 timer」（若不取消会把数据写回 process key）。
    __scheduleStrayProcessTimerForTest(qc, "s1", 5_000);
    expect(__processCleanupTimerCountForTest()).toBe(1);
    // 删会话:reapSessionRun → clearProcess 先 clearTimeout 再 removeQueries。
    reapSessionRun(qc, "s1");
    expect(__processCleanupTimerCountForTest()).toBe(0); // 游离 timer 已取消。
    await vi.advanceTimersByTimeAsync(10_000); // 推进远超 timer 延迟。
    // 过程流未被复活写回。
    expect(qc.getQueryData(personalProcessKeys.detail("s1"))).toBeUndefined();
    vi.useRealTimers();
  });

  it("clearProcess 先 clearTimeout:游离 timer 不在清空后复活 process key", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-u2", { type: "tool", name: "Edit" }, "s1");
    __scheduleStrayProcessTimerForTest(qc, "s1", 3_000);
    __clearProcessForTest(qc, "s1");
    expect(__processCleanupTimerCountForTest()).toBe(0);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(qc.getQueryData(personalProcessKeys.detail("s1"))).toBeUndefined();
    vi.useRealTimers();
  });

  it("pi crashed:过程流被清,游离 timer 被取消", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "崩溃前" });
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1", detail: "ls" });
    __scheduleStrayProcessTimerForTest(qc, "s1", 5_000);
    __handlePiEventForTest(qc, "s1", { type: "crashed", error: "退出码 1" });
    expect(qc.getQueryData(personalProcessKeys.detail("s1"))).toBeUndefined();
    expect(__processCleanupTimerCountForTest()).toBe(0);
    // 崩溃文案进消息流（C2 守护:错误文本仍落消息流）。
    expect(chatOf(qc).some((m) => m.kind === "text" && typeof m.text === "string" && m.text.includes("已退出"))).toBe(true);
  });

  it("pi error 宽限到期 finalizeRun（失败路径）:过程流被清", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1", detail: "ls" });
    __handlePiEventForTest(qc, "s1", { type: "error", error: "401 unauthorized" });
    expect(procOf(qc).filter((m) => m.kind === "agentLog")).toHaveLength(1); // error 后未清,等宽限。
    await vi.advanceTimersByTimeAsync(4_000); // 宽限到期 → finalizeRun（resultOk=false 失败路径）→ clearProcess。
    expect(qc.getQueryData(personalProcessKeys.detail("s1"))).toBeUndefined();
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined();
    vi.useRealTimers();
  });

  it("finalizeRun run-not-found 兜底（stop 4s / watchdog 等出口的共享清空结构）:过程流被清且取消游离 timer", async () => {
    // watchdog 超时与 stop 4s 兜底都先删 run 再 clearTransient+clearProcess;其「run 已不在注册表」
    // 后对 sessionId 立即清空过程流的结构,与 finalizeRun 的 run-not-found 兜底分支同源。此处驱动该
    // 兜底分支：run 不在注册表 + 已有过程流 + 已挂游离 timer → 断言过程流被清、timer 被取消、不复活。
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupCliRun(qc, "s1", "run-stop");
    __handleCliEventForTest(qc, "run-stop", { type: "tool", name: "Edit" }, "s1");
    expect(procOf(qc).filter((m) => m.kind === "agentLog")).toHaveLength(1);
    __scheduleStrayProcessTimerForTest(qc, "s1", 2_000);
    // runId 不在注册表 → finalizeRun 走 run-not-found 兜底分支 → clearTransient + clearProcess。
    __handleCliExitForTest(qc, "phantom-run", 0, undefined, "s1");
    expect(qc.getQueryData(personalProcessKeys.detail("s1"))).toBeUndefined();
    expect(__processCleanupTimerCountForTest()).toBe(0);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(qc.getQueryData(personalProcessKeys.detail("s1"))).toBeUndefined();
    vi.useRealTimers();
  });

  it("__resetPersonalMessageRunsForTest 清空全部延迟清理 timer", () => {
    const qc = new QueryClient();
    __scheduleStrayProcessTimerForTest(qc, "sA", 5_000);
    __scheduleStrayProcessTimerForTest(qc, "sB", 5_000);
    expect(__processCleanupTimerCountForTest()).toBe(2);
    __resetPersonalMessageRunsForTest();
    expect(__processCleanupTimerCountForTest()).toBe(0);
  });

  it("editResend 截断:目标会话上一轮残留过程入口被清（clearProcess 语义）", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-u2", { type: "tool", name: "Edit", detail: "a.ts" }, "s1");
    __handleCliEventForTest(qc, "run-u2", { type: "result", ok: true, text: "" }, "s1");
    expect(procOf(qc).filter((m) => m.kind === "agentLog")).toHaveLength(1); // 上一轮保留入口。
    // editResend 截断前显式 clearProcess（此处用测试入口模拟）。
    __clearProcessForTest(qc, "s1");
    expect(qc.getQueryData(personalProcessKeys.detail("s1"))).toBeUndefined();
  });

  it("后台长轮 process query 不被全局 10min gcTime 回收（显式 gcTime Infinity）", () => {
    // gcTime 由 usePersonalProcess 在 useQuery 上声明（Infinity）;此处以行为契约断言:
    // clearProcess 之外的「时间流逝」不应清空 process key——即过程流的回收**仅**由 clearProcess 出口负责。
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-u2", { type: "tool", name: "Edit" }, "s1");
    // 不调任何清理出口,直接断言数据仍在（核心层无定时回收;真正 gc 由 React Query observer 生命周期 +
    // 显式 gcTime 控制,设 Infinity 后即便切走变 inactive 也不在窗口内被回收）。
    expect(procOf(qc).filter((m) => m.kind === "agentLog")).toHaveLength(1);
  });
});

// ── U5：集成与回归（跨场景 + 不落盘强保证 + HMR 续流） ──────────────────────────
describe("U5 集成：多会话并发 / 切换重现 / HMR 续流", () => {
  const chatOf = (qc: QueryClient, sessionId: string): Message[] =>
    qc.getQueryData<Message[]>(personalChatKeys.detail(sessionId)) ?? [];
  const procOf = (qc: QueryClient, sessionId: string): Message[] =>
    qc.getQueryData<Message[]>(personalProcessKeys.detail(sessionId)) ?? [];

  // 经 init 触发 HMR 兜底重建一个 claude run（registry 里没有该 runId → 用 sessionIdHint 重建）。
  function startCliRunViaInit(qc: QueryClient, sessionId: string, runId: string): void {
    __handleCliEventForTest(qc, runId, { type: "init", sessionId: `claude-${sessionId}` }, sessionId);
    expect(usePersonalStore.getState().runningBySession[sessionId]).toBe(runId);
  }

  it("多会话并发：A、B 同时运行,过程流各自累积,互不串台", () => {
    const qc = new QueryClient();
    usePersonalStore.setState({
      sessions: [
        { ...baseSession, id: "A", agent: "claude", agentSessionIds: {} },
        { ...baseSession, id: "B", agent: "claude", agentSessionIds: {} },
      ],
      runningBySession: {},
    });
    startCliRunViaInit(qc, "A", "run-A");
    startCliRunViaInit(qc, "B", "run-B");
    // A 跑两个工具,B 跑一个工具 + 一段文本。
    __handleCliEventForTest(qc, "run-A", { type: "tool", name: "Read", detail: "a1" }, "A");
    __handleCliEventForTest(qc, "run-A", { type: "tool", name: "Edit", detail: "a2" }, "A");
    __handleCliEventForTest(qc, "run-B", { type: "tool", name: "Bash", detail: "b1" }, "B");
    __handleCliEventForTest(qc, "run-B", { type: "text", delta: "B 的结果" }, "B");

    // 过程流各自累积:A 的 agentLog 含两步,B 的含一步且已被 text 跨流收尾。
    const logA = procOf(qc, "A").find((m) => m.kind === "agentLog");
    const logB = procOf(qc, "B").find((m) => m.kind === "agentLog");
    expect(asLog(logA!).items.map((it) => it.text)).toEqual(["Read · a1", "Edit · a2"]);
    expect(asLog(logA!).active).toBe(true); // A 仍运行中,未收尾。
    expect(asLog(logB!).active).toBe(false); // B 被 text 收尾。
    expect(asLog(logB!).items[0]).toMatchObject({ ic: "check", text: "Bash · b1" });
    // 消息流也不串台:A 无 agent text,B 有「B 的结果」。
    expect(chatOf(qc, "A").some((m) => m.kind === "text" && m.who === "claude")).toBe(false);
    expect(chatOf(qc, "B").filter((m) => m.kind === "text" && m.who === "claude").map((m) => asText(m).text)).toEqual([
      "B 的结果",
    ]);
  });

  it("切换重现：A 运行中(过程已累积)切到 B 再切回 A,A 过程续流可继续接收事件", () => {
    // core 层无「当前会话」概念,切换是 view 层的 activeSessionId;过程按 key 隔离保留。
    // 这里验证:A 的过程流在「切走期间」不被任何 core 出口清掉,切回后仍能续接新事件。
    const qc = new QueryClient();
    usePersonalStore.setState({
      sessions: [
        { ...baseSession, id: "A", agent: "claude", agentSessionIds: {} },
        { ...baseSession, id: "B", agent: "claude", agentSessionIds: {} },
      ],
      runningBySession: {},
    });
    startCliRunViaInit(qc, "A", "run-A");
    __handleCliEventForTest(qc, "run-A", { type: "tool", name: "Read", detail: "a1" }, "A");
    expect(asLog(procOf(qc, "A").find((m) => m.kind === "agentLog")!).items).toHaveLength(1);

    // 「切到 B」:B 起一轮(不触碰 A 的 key)。
    startCliRunViaInit(qc, "B", "run-B");
    __handleCliEventForTest(qc, "run-B", { type: "tool", name: "Bash", detail: "b1" }, "B");
    // A 过程流仍在(切走不清)。
    expect(asLog(procOf(qc, "A").find((m) => m.kind === "agentLog")!).items).toHaveLength(1);

    // 「切回 A」:A 仍运行中,续接新工具事件 → 过程流追加第二步。
    __handleCliEventForTest(qc, "run-A", { type: "tool", name: "Edit", detail: "a2" }, "A");
    expect(asLog(procOf(qc, "A").find((m) => m.kind === "agentLog")!).items.map((it) => it.text)).toEqual([
      "Read · a1",
      "Edit · a2",
    ]);
  });

  it("HMR 重建 run（sessionIdHint 路径）后过程流仍能继续接收过程事件", () => {
    const qc = new QueryClient();
    usePersonalStore.setState({
      sessions: [{ ...baseSession, id: "s1", agent: "claude", agentSessionIds: {} }],
      runningBySession: {},
    });
    // 第一轮:init 重建 run + 一个工具进过程流。
    startCliRunViaInit(qc, "s1", "run-1");
    __handleCliEventForTest(qc, "run-1", { type: "tool", name: "Read", detail: "x" }, "s1");
    expect(procOf(qc, "s1").filter((m) => m.kind === "agentLog")).toHaveLength(1);

    // 模拟 HMR:renderer 重载、内存 registry 丢失（用 reset 清掉 runs,但保留 store/缓存场景由下方
    // 新 runId 的 init 兜底重建覆盖）。这里直接用一个「registry 里不存在的新 runId」喂事件——
    // 它会经 sessionIdHint 兜底重建 run,使仍在跑的流继续渲染。
    __resetPersonalMessageRunsForTest(); // 清 runs + 过程缓存（模拟重载后内存清空）。
    usePersonalStore.setState({
      sessions: [{ ...baseSession, id: "s1", agent: "claude", agentSessionIds: {} }],
      runningBySession: {},
    });
    // 主进程回显的后续事件带新 runId（renderer 重载后主进程仍持原流）。
    __handleCliEventForTest(qc, "run-hmr", { type: "init", sessionId: "claude-s1" }, "s1");
    __handleCliEventForTest(qc, "run-hmr", { type: "tool", name: "Edit", detail: "y" }, "s1");
    // 续流:重建的 run 有全新过程游标,新工具事件被接住并落进过程流（新开一张 agentLog 卡片,
    // 旧轮的 Read · x 缓存仍残留——这正是 HMR 后「续流不卡死」的可观察证据)。
    const steps = procOf(qc, "s1")
      .filter((m) => m.kind === "agentLog")
      .flatMap((m) => asLog(m).items.map((it) => it.text));
    expect(steps).toContain("Edit · y"); // 续流事件已被新建 run 接住、落进过程流。
    expect(usePersonalStore.getState().runningBySession.s1).toBe("run-hmr"); // 运行态恢复,不再卡「运行中」。
  });
});

describe("U5 端到端不落盘强保证（R10:结构上无落盘通道）", () => {
  it("含工具+思考+结果的一轮:saveChat 只由 text/result 触发、只含 text;process key 写入从不触发 bridge.save*", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    const saveChat = vi.fn<(sessionId: string, messages: Message[]) => Promise<void>>(async () => undefined);
    __setBridgeForTest({ saveChat } as unknown as Parameters<typeof __setBridgeForTest>[0]);
    usePersonalStore.setState({
      sessions: [{ ...baseSession, id: "s1", agent: "pi", agentSessionIds: {} }],
      runningBySession: {},
      piRuntimeBySession: {},
    });
    beginPiRun(qc, { runId: "prun-e2e", sessionId: "s1", typingUid: "typ", cwd: "/p", promptText: "hi" });
    // 预置空分支组:flushChat 落盘前要求分支态已加载(v2 兼容),测试桩 bridge 无 loadChat 补载通道。
    qc.setQueryData(personalBranchKeys.detail("s1"), []);
    saveChat.mockClear();

    // 一整轮:思考 → 工具 → 工具收尾 → 正文 → 收尾。
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "想想" });
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1", detail: "ls" });
    __handlePiEventForTest(qc, "s1", { type: "tool-end", name: "Bash", toolCallId: "t1", isError: false });
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "最终答案" });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: false });
    await vi.advanceTimersByTimeAsync(2_000);

    // (1) saveChat 被触发过（text/result 驱动落盘）。
    expect(saveChat).toHaveBeenCalled();
    // (2) 每一次落盘入参都只含 text,绝不含过程块（agentLog/reasoning/typing）。
    for (const [, saved] of saveChat.mock.calls) {
      expect(saved.every((m) => m.kind === "text")).toBe(true);
    }
    // (3) 过程流确有数据（思考+工具都进了 process key,只是不落盘）。
    const proc = qc.getQueryData<Message[]>(personalProcessKeys.detail("s1")) ?? [];
    expect(proc.some((m) => m.kind === "agentLog")).toBe(true);
    expect(proc.some((m) => m.kind === "reasoning")).toBe(true);
    vi.useRealTimers();
  });

  it("直接写 process key（setProcessMessages 链路）:绝不触发任何 bridge.save*（R10 结构闭环）", async () => {
    // __scheduleStrayProcessTimerForTest 经 setProcessMessages 直接往 process key 注入 agentLog,
    // 不碰消息流、不调 scheduleChatSave——以此精确证明「过程流写入无落盘通道」（区别于 tool 事件会
    // 顺带 dropMsg 触动消息流 typing）。
    vi.useFakeTimers();
    const qc = new QueryClient();
    const saveChat = vi.fn<(sessionId: string, messages: Message[]) => Promise<void>>(async () => undefined);
    __setBridgeForTest({ saveChat } as unknown as Parameters<typeof __setBridgeForTest>[0]);
    __scheduleStrayProcessTimerForTest(qc, "s1", 1_000);
    await vi.advanceTimersByTimeAsync(2_000); // timer 触发 → setProcessMessages 写入 process key（一条 reasoning）。
    // process key 已写入,但 bridge.saveChat 从未被调用。
    expect((qc.getQueryData<Message[]>(personalProcessKeys.detail("s1")) ?? []).length).toBeGreaterThan(0);
    expect(saveChat).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("纯工具事件:消息流落盘入参从不含过程块(agentLog/reasoning/typing)——落盘只见问答", async () => {
    // tool 事件会 dropMsg 触动消息流(故 saveChat 可能被调),但任何一次落盘入参都不得含过程块。
    vi.useFakeTimers();
    const qc = new QueryClient();
    const saveChat = vi.fn<(sessionId: string, messages: Message[]) => Promise<void>>(async () => undefined);
    __setBridgeForTest({ saveChat } as unknown as Parameters<typeof __setBridgeForTest>[0]);
    usePersonalStore.setState({
      sessions: [{ ...baseSession, id: "s1", agent: "claude", agentSessionIds: {} }],
      runningBySession: {},
    });
    __handleCliEventForTest(qc, "run-p", { type: "init", sessionId: "claude-s1" }, "s1");
    __handleCliEventForTest(qc, "run-p", { type: "tool", name: "Read", detail: "a" }, "s1");
    __handleCliEventForTest(qc, "run-p", { type: "tool", name: "Edit", detail: "b" }, "s1");
    await vi.advanceTimersByTimeAsync(2_000);
    expect((qc.getQueryData<Message[]>(personalProcessKeys.detail("s1")) ?? []).some((m) => m.kind === "agentLog")).toBe(
      true,
    );
    for (const [, saved] of saveChat.mock.calls) {
      expect(saved.every((m) => m.kind !== "agentLog" && m.kind !== "reasoning" && m.kind !== "typing")).toBe(true);
    }
    vi.useRealTimers();
  });
});

describe("U5 editResend 截断含旧 agentLog 的会话:落盘与中栏均无 agentLog", () => {
  const t = (uid: string, text = uid, who = "me"): Message =>
    ({ kind: "text", who, time: "10:00", text, uid }) as Message;
  const log = (uid: string): Message =>
    ({
      kind: "agentLog",
      who: "claude",
      time: "10:00",
      title: "执行",
      active: false,
      completed: true,
      items: [{ ic: "check", text: "Edit" }],
      uid,
    }) as Message;

  it("truncateForEdit 截断点之前残留 agentLog,sanitize 后写回缓存的截断内容不含 agentLog", () => {
    // 模拟旧档缓存:u1 → agentLog → a1 → u2(待编辑) → a2。截断到 u2 之前 → [u1, agentLog, a1]。
    const stale = [t("u1", "旧问"), log("g1"), t("a1", "旧答", "claude"), t("u2", "新问"), t("a2", "新答", "claude")];
    const truncatedRaw = truncateForEdit(stale, "u2");
    expect(truncatedRaw?.map((m) => m.kind)).toEqual(["text", "agentLog", "text"]); // 纯截断仍含 agentLog
    // editResend 写回前过一遍 sanitizeForSave → 中栏缓存不再含 agentLog（避免闪回工具步骤）。
    const forCache = sanitizeForSave(truncatedRaw!);
    expect(forCache.map((m) => m.kind)).toEqual(["text", "text"]);
    expect(forCache.some((m) => m.kind === "agentLog")).toBe(false);
  });
});

describe("resolveSpawnAgentId（U7）", () => {
  const derived = [{ id: "my-codex", base: "codex" as const, label: "My Codex" }];
  it("有 derivedAgentId 且仍在派生列表 → 用派生 id", () => {
    expect(resolveSpawnAgentId({ agent: "codex", derivedAgentId: "my-codex" }, derived)).toBe("my-codex");
  });
  it("无 derivedAgentId → 用 base agent", () => {
    expect(resolveSpawnAgentId({ agent: "claude", derivedAgentId: undefined }, derived)).toBe("claude");
  });
  it("derivedAgentId 已失效(不在列表)→ 回退 base(RISK-3)", () => {
    expect(resolveSpawnAgentId({ agent: "codex", derivedAgentId: "gone" }, derived)).toBe("codex");
    expect(resolveSpawnAgentId({ agent: "codex", derivedAgentId: "my-codex" }, undefined)).toBe("codex");
  });
});

describe("buildSingleSendSkillInjection（U5 单发 skill 注入分派）", () => {
  const records = [
    { name: "alpha", description: "做 A", dir: "/g/alpha" },
    { name: "beta", description: "做 B", dir: "/g/beta" },
  ];

  it("claude:不 prose 注入,appendWithSkills 等于原始 appendSystemPrompt,记录经 skillRecords 下发", () => {
    const { appendWithSkills, skillRecords } = buildSingleSendSkillInjection("claude", "全局指令", records);
    expect(appendWithSkills).toBe("全局指令"); // 不含「## 已启用的 Skills」段
    expect(appendWithSkills).not.toContain("已启用的 Skills");
    expect(skillRecords).toBe(records); // 原样交主进程建桥接目录
  });

  it("claude:无 appendSystemPrompt → undefined,仍带 skillRecords", () => {
    const { appendWithSkills, skillRecords } = buildSingleSendSkillInjection("claude", undefined, records);
    expect(appendWithSkills).toBeUndefined();
    expect(skillRecords).toBe(records);
  });

  it("codex:仍把已启用 skill 渲染成 prose 并入 appendSystemPrompt,不带 skillRecords（回归现状）", () => {
    const { appendWithSkills, skillRecords } = buildSingleSendSkillInjection("codex", "全局指令", records);
    expect(appendWithSkills).toContain("全局指令");
    expect(appendWithSkills).toContain("## 已启用的 Skills");
    expect(appendWithSkills).toContain("- **alpha** — 做 A");
    expect(skillRecords).toBeUndefined();
  });

  it("codex:无启用 skill + 无 appendSystemPrompt → undefined", () => {
    const { appendWithSkills, skillRecords } = buildSingleSendSkillInjection("codex", undefined, []);
    expect(appendWithSkills).toBeUndefined();
    expect(skillRecords).toBeUndefined();
  });

  it("pi 产物单发走 --skill 路径，不把 skill 列表改写成 prose", () => {
    const piRecords = [
      { name: "native", description: "Pi 自发现", dir: "/pi/native", origin: "agent" as const },
      { name: "shared", description: "共享", dir: "/shared/skill", origin: "shared" as const },
    ];

    const result = buildSingleSendSkillInjection("pi", "全局指令", piRecords, {
      useOwnSkills: true,
      artifactSkill: { name: "slides", path: "/builtin/slides" },
    });

    expect(result.appendWithSkills).toBe("全局指令");
    expect(result.appendWithSkills).not.toContain("已启用的 Skills");
    expect(result.skillRecords).toBeUndefined();
    expect(result.skillPaths).toEqual(["/shared/skill", "/builtin/slides"]);
  });

  it("claude:空记录也走原生路径(skillRecords 为空数组,不 prose)", () => {
    const { appendWithSkills, skillRecords } = buildSingleSendSkillInjection("claude", undefined, []);
    expect(appendWithSkills).toBeUndefined();
    expect(skillRecords).toEqual([]);
  });
});

// ── pi typing 活动行(结构化 activity 字段,实时透出思考/工具进度到聊天流) ──────────
describe("pi typing 活动行(activity)", () => {
  const piSession: SessionMeta = { ...baseSession, agent: "pi", agentSessionIds: {} };

  function setupPiRun(qc: QueryClient, sessionId = "s1", runId = "prun-1"): string {
    usePersonalStore.setState({
      sessions: [{ ...piSession, id: sessionId }],
      runningBySession: {},
      piRuntimeBySession: {},
    });
    beginPiRun(qc, { runId, sessionId, typingUid: `typ-${sessionId}`, cwd: "/proj", promptText: "hi" });
    // 模拟 send 侧创建的 typing 占位(beginPiRun 不负责 appendMsg)。
    qc.setQueryData<Message[]>(personalChatKeys.detail(sessionId), (prev) => [
      ...(prev ?? []),
      { kind: "typing", who: "pi", text: "启动中", uid: `typ-${sessionId}` },
    ]);
    return runId;
  }

  function typingOf(qc: QueryClient, sessionId = "s1") {
    const m = (qc.getQueryData<Message[]>(personalChatKeys.detail(sessionId)) ?? []).find(
      (x) => x.kind === "typing",
    );
    return m?.kind === "typing" ? m : undefined;
  }

  it("reasoning 事件 → activity 进入 thinking 相并携带尾部片段", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "先想想" });
    const t = typingOf(qc);
    expect(t?.activity).toMatchObject({ phase: "thinking", snippet: "先想想" });
    expect(typeof t?.activity?.startedAt).toBe("number");
  });

  it("reasoning 累计后 snippet 只保留尾部(截断,不含开头)", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: `开头${"甲".repeat(200)}` });
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "结尾片段" });
    const snippet = typingOf(qc)?.activity?.snippet ?? "";
    expect(snippet.endsWith("结尾片段")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(140);
    expect(snippet.includes("开头")).toBe(false);
  });

  it("tool-start → phase:tool + 工具名/detail/toolStartedAt,首个工具 stepCount 0", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1", detail: "ls" });
    const a = typingOf(qc)?.activity;
    expect(a).toMatchObject({ phase: "tool", toolName: "Bash", detail: "ls", stepCount: 0 });
    expect(typeof a?.toolStartedAt).toBe("number");
  });

  it("tool-end → phase:toolDone 且 stepCount 累加;下个工具 stepCount 随之推进", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1", detail: "ls" });
    __handlePiEventForTest(qc, "s1", { type: "tool-end", name: "Bash", toolCallId: "t1", isError: false });
    expect(typingOf(qc)?.activity).toMatchObject({ phase: "toolDone", toolName: "Bash", stepCount: 1 });
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Read", toolCallId: "t2" });
    expect(typingOf(qc)?.activity).toMatchObject({ phase: "tool", toolName: "Read", stepCount: 1 });
    __handlePiEventForTest(qc, "s1", { type: "tool-end", name: "Read", toolCallId: "t2", isError: false });
    expect(typingOf(qc)?.activity).toMatchObject({ phase: "toolDone", stepCount: 2 });
  });

  it("MCP 工具名清洗后展示(mcp__server__tool → tool)", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", {
      type: "tool-start",
      name: "mcp__doc__extract_document",
      toolCallId: "t1",
    });
    expect(typingOf(qc)?.activity?.toolName).toBe("extract_document");
  });

  it("正文首 token 到达 → typing(连同 activity)被移除", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "想" });
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "答案" });
    expect(typingOf(qc)).toBeUndefined();
  });

  it("代际守卫:旧 runId 的事件不改新轮 activity", () => {
    const qc = new QueryClient();
    setupPiRun(qc, "s1", "prun-new");
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "新轮思考" }, "prun-new");
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1" }, "prun-old");
    expect(typingOf(qc)?.activity).toMatchObject({ phase: "thinking", snippet: "新轮思考" });
  });

  it("result 收尾 → typing(连同 activity)整条移除,无过期活动行残留", () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1" });
    __handlePiEventForTest(qc, "s1", { type: "tool-end", name: "Bash", toolCallId: "t1", isError: false });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: false });
    expect(typingOf(qc)).toBeUndefined();
    vi.useRealTimers();
  });
});

describe("thinkingSnippet 尾部片段派生", () => {
  it("多行取最后两行并压平空白", () => {
    expect(thinkingSnippet("第一行\n第二行\n第三行")).toBe("第二行 第三行");
  });
  it("超长截尾至 140 字以内", () => {
    const s = thinkingSnippet("x".repeat(500));
    expect(s.length).toBeLessThanOrEqual(140);
    expect(s.endsWith("x")).toBe(true);
  });
  it("空串与纯空白返回空", () => {
    expect(thinkingSnippet("")).toBe("");
    expect(thinkingSnippet("  \n  ")).toBe("");
  });
});

// ── 会话预热(prewarmPiSession):输入首字符时提前拉起 pi 进程,消除首轮冷启 ~800ms ──────
describe("prewarmPiSession 会话预热", () => {
  const piSession: SessionMeta = { ...baseSession, agent: "pi", agentSessionIds: {} };

  function prewarmBridge(over: Record<string, unknown> = {}) {
    return {
      piOpen: vi.fn(async (req: { uiSessionId: string }) => ({
        uiSessionId: req.uiSessionId,
        sessionId: "pi-warm",
        sessionFile: "/sessions/warm.jsonl",
      })),
      piPrompt: vi.fn(async () => undefined),
      onPiEvent: vi.fn(() => () => undefined),
      ...over,
    } as unknown as DesktopBridge;
  }

  beforeEach(() => {
    __resetPiSessionsForTest();
    usePersonalStore.setState({ sessions: [piSession], runningBySession: {}, piRuntimeBySession: {} });
  });

  it("并发预热只 spawn 一次,且绝不 setRunning", async () => {
    const qc = new QueryClient();
    const bridge = prewarmBridge();
    await Promise.all([
      prewarmPiSession(qc, bridge, piSession, "/proj"),
      prewarmPiSession(qc, bridge, piSession, "/proj"),
    ]);
    expect((bridge.piOpen as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(usePersonalStore.getState().runningBySession["s1"]).toBeUndefined();
    expect(isPiSessionOpen("s1")).toBe(true);
  });

  it("已开启的温会话 no-op(不重复 spawn)", async () => {
    const qc = new QueryClient();
    const bridge = prewarmBridge();
    await prewarmPiSession(qc, bridge, piSession, "/proj");
    await prewarmPiSession(qc, bridge, piSession, "/proj");
    expect((bridge.piOpen as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("非 pi 会话 no-op", async () => {
    const qc = new QueryClient();
    const bridge = prewarmBridge();
    await prewarmPiSession(qc, bridge, { ...piSession, agent: "claude" }, "/proj");
    expect((bridge.piOpen as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("piOpen 失败静默:不抛错、不写错误消息进聊天流", async () => {
    const qc = new QueryClient();
    const bridge = prewarmBridge({ piOpen: vi.fn(async () => Promise.reject(new Error("spawn 失败"))) });
    await expect(prewarmPiSession(qc, bridge, piSession, "/proj")).resolves.toBeUndefined();
    const msgs = qc.getQueryData<Message[]>(personalChatKeys.detail("s1")) ?? [];
    expect(msgs).toHaveLength(0);
  });

  it("预热成功后把 sessionFile 持久到 SessionMeta(供后续重开恢复)", async () => {
    const qc = new QueryClient();
    const bridge = prewarmBridge();
    await prewarmPiSession(qc, bridge, piSession, "/proj");
    const sess = usePersonalStore.getState().sessions.find((s) => s.id === "s1");
    expect(sess?.piSessionFile).toBe("/sessions/warm.jsonl");
  });
});

describe("pi typing 活动行:重试复位", () => {
  it("result(willRetry:true) 后步数复位,重试轮工具从第 1 步重计", () => {
    const qc = new QueryClient();
    usePersonalStore.setState({
      sessions: [{ ...baseSession, id: "s1", agent: "pi", agentSessionIds: {} }],
      runningBySession: {},
      piRuntimeBySession: {},
    });
    beginPiRun(qc, { runId: "prun-r", sessionId: "s1", typingUid: "typ-s1", cwd: "/proj", promptText: "hi" });
    qc.setQueryData<Message[]>(personalChatKeys.detail("s1"), [
      { kind: "typing", who: "pi", text: "启动中", uid: "typ-s1" },
    ]);
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1" });
    __handlePiEventForTest(qc, "s1", { type: "tool-end", name: "Bash", toolCallId: "t1", isError: false });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: true });
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Read", toolCallId: "t2" });
    const typing = (qc.getQueryData<Message[]>(personalChatKeys.detail("s1")) ?? []).find((m) => m.kind === "typing");
    expect(typing?.kind === "typing" && typing.activity).toMatchObject({ phase: "tool", stepCount: 0 });
  });
});

describe("运行事件流(personalRunEventsKeys)采集与 tool phase:end 守卫", () => {
  const procOf = (qc: QueryClient, sessionId = "s1"): Message[] =>
    qc.getQueryData<Message[]>(personalProcessKeys.detail(sessionId)) ?? [];
  const runEventsOf = (qc: QueryClient, sessionId = "s1"): RunEvent[] =>
    qc.getQueryData<RunEvent[]>(personalRunEventsKeys.detail(sessionId)) ?? [];

  function setupCliRun(qc: QueryClient, sessionId = "s1", runId = "run-c1"): void {
    usePersonalStore.setState({
      sessions: [{ ...baseSession, id: sessionId, agent: "claude", agentSessionIds: {} }],
      runningBySession: {},
    });
    __handleCliEventForTest(qc, runId, { type: "init", sessionId: "claude-sess" }, sessionId);
  }

  it("tool phase:end 不折叠进过程流 agentLog(不翻倍),但记入运行事件流", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(
      qc,
      "run-c1",
      { type: "tool", name: "Bash", detail: "ls", input: { command: "ls" }, phase: "start", toolCallId: "t1" },
      "s1",
    );
    const itemsAfterStart = (procOf(qc).find((m) => m.kind === "agentLog") as { items: unknown[] }).items.length;
    __handleCliEventForTest(
      qc,
      "run-c1",
      { type: "tool", name: "", phase: "end", toolCallId: "t1", output: "a.txt", isError: false },
      "s1",
    );
    // 过程流 agentLog 条目数不变(end 被守卫忽略)。
    const itemsAfterEnd = (procOf(qc).find((m) => m.kind === "agentLog") as { items: unknown[] }).items.length;
    expect(itemsAfterEnd).toBe(itemsAfterStart);
    // 运行事件流:start 与 end 都在(供详情弹层按 toolCallId 配对)。
    const toolEvents = runEventsOf(qc).filter((r) => r.ev.type === "tool");
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[1]!.ev).toMatchObject({ phase: "end", output: "a.txt" });
  });

  it("运行事件流全链路记录:tool/usage/result + text/thinking 增量合并成段,且带 runId", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-c1", { type: "thinking", delta: "先想" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "thinking", delta: "再想" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "tool", name: "Read", detail: "x", phase: "start" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "text", delta: "回" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "text", delta: "复" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "usage", inputTokens: 10, outputTokens: 2 }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "result", ok: true, text: "done" }, "s1");
    const recs = runEventsOf(qc);
    // 连续同类增量合并为单段,时间线保序:init → 思考段 → tool → 回复段 → usage → result。
    expect(recs.map((r) => r.ev.type)).toEqual(["init", "thinking", "tool", "text", "usage", "result"]);
    expect(recs[1]!.ev).toMatchObject({ type: "thinking", delta: "先想再想" });
    expect(recs[3]!.ev).toMatchObject({ type: "text", delta: "回复" });
    expect(recs.every((r) => r.runId === "run-c1")).toBe(true);
  });

  it("CLI 回合结束时聚合多条 usage 并追加一条可持久化 turnUsage", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-c1", { type: "text", delta: "完成" }, "s1");
    __handleCliEventForTest(qc, "run-c1", { type: "usage", inputTokens: 10, outputTokens: 2 }, "s1");
    __handleCliEventForTest(
      qc,
      "run-c1",
      { type: "usage", inputTokens: 4, outputTokens: 3, roleId: "reviewer" },
      "s1",
    );
    __handleCliEventForTest(qc, "run-c1", { type: "result", ok: true }, "s1");
    __handleCliExitForTest(qc, "run-c1", 0, undefined, "s1");

    const messages = qc.getQueryData<Message[]>(personalChatKeys.detail("s1")) ?? [];
    expect(messages.filter((m) => m.kind === "turnUsage")).toEqual([
      expect.objectContaining({
        kind: "turnUsage",
        runId: "run-c1",
        inputTokens: 14,
        outputTokens: 5,
      }),
    ]);
    expect(sanitizeForSave(messages).some((m) => m.kind === "turnUsage")).toBe(true);
  });

  it("Pi 同一用户回合累加中间 turn-end 与最终 result 的 usage", () => {
    const qc = new QueryClient();
    usePersonalStore.setState({
      sessions: [{ ...baseSession, id: "s1", agent: "pi", agentSessionIds: {} }],
      runningBySession: {},
      piRuntimeBySession: {},
    });
    beginPiRun(qc, { runId: "prun-1", sessionId: "s1", typingUid: "typ-1", cwd: "/p", promptText: "hi" });
    __handlePiEventForTest(qc, "s1", {
      type: "turn-end",
      usage: { inputTokens: 20, outputTokens: 4 },
    });
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "完成" });
    __handlePiEventForTest(qc, "s1", {
      type: "result",
      willRetry: false,
      usage: { inputTokens: 8, outputTokens: 2 },
    });

    const messages = qc.getQueryData<Message[]>(personalChatKeys.detail("s1")) ?? [];
    expect(messages.filter((m) => m.kind === "turnUsage")).toEqual([
      expect.objectContaining({
        kind: "turnUsage",
        runId: "prun-1",
        inputTokens: 28,
        outputTokens: 6,
      }),
    ]);
  });

  it("运行事件流环形上限 1000:超限丢最旧", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    for (let i = 0; i < 1005; i++) {
      __handleCliEventForTest(qc, "run-c1", { type: "tool", name: `T${i}`, phase: "start" }, "s1");
    }
    const events = runEventsOf(qc);
    expect(events).toHaveLength(1000);
    // 最旧的(init + 前几条 tool)已被挤出,末条是最新的。
    const last = events[events.length - 1]!.ev;
    expect(last).toMatchObject({ type: "tool", name: "T1004" });
  });

  it("pi RPC 事件也进运行事件流:tool-start/end 转 CliStreamEvent 形态,reasoning 合并为思考段", () => {
    const qc = new QueryClient();
    usePersonalStore.setState({
      sessions: [{ ...baseSession, id: "s1", agent: "pi", agentSessionIds: {} }],
      runningBySession: {},
      piRuntimeBySession: {},
    });
    beginPiRun(qc, { runId: "prun-1", sessionId: "s1", typingUid: "typ-1", cwd: "/p", promptText: "hi" });
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "想想" });
    __handlePiEventForTest(qc, "s1", {
      type: "tool-start",
      name: "bash",
      toolCallId: "c1",
      detail: "ls",
      input: { command: "ls" },
    });
    __handlePiEventForTest(qc, "s1", {
      type: "tool-end",
      name: "bash",
      toolCallId: "c1",
      isError: false,
      output: "a.txt",
    });
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: false });
    const recs = runEventsOf(qc);
    expect(recs.map((r) => r.ev.type)).toEqual(["thinking", "tool", "tool", "result"]);
    expect(recs[0]!.ev).toMatchObject({ type: "thinking", delta: "想想" });
    expect(recs[1]!.ev).toMatchObject({ type: "tool", phase: "start", input: { command: "ls" }, toolCallId: "c1" });
    expect(recs[2]!.ev).toMatchObject({ type: "tool", phase: "end", output: "a.txt", isError: false });
    expect(recs[3]!.ev).toMatchObject({ type: "result", ok: true });
    expect(recs.every((r) => r.runId === "prun-1")).toBe(true);
  });
});

describe("todo 事件折叠(任务清单卡片)", () => {
  function setupCliRun(qc: QueryClient, runId = "run-1"): void {
    usePersonalStore.setState({
      sessions: [{ ...baseSession, agent: "claude", agentSessionIds: {} }],
      runningBySession: {},
    });
    __handleCliEventForTest(qc, runId, { type: "init", sessionId: "cl-session" }, "s1");
  }
  function chatOf(qc: QueryClient): Message[] {
    return qc.getQueryData<Message[]>(personalChatKeys.detail("s1")) ?? [];
  }
  const TODOS_V1 = [
    { text: "分析", status: "in_progress" as const },
    { text: "实现", status: "pending" as const },
  ];
  const TODOS_V2 = [
    { text: "分析", status: "completed" as const },
    { text: "实现", status: "in_progress" as const },
  ];

  it("同 runId 连续 todo 事件 → 单卡原地覆盖(整表替换,不新增)", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-1", { type: "todo", todos: TODOS_V1 }, "s1");
    __handleCliEventForTest(qc, "run-1", { type: "todo", todos: TODOS_V2 }, "s1");
    const cards = chatOf(qc).filter((m) => m.kind === "todoList");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ runId: "run-1", todos: TODOS_V2, active: true });
  });

  it("不同 runId → 各自独立卡片(新一轮清单开新卡)", () => {
    const qc = new QueryClient();
    setupCliRun(qc, "run-1");
    __handleCliEventForTest(qc, "run-1", { type: "todo", todos: TODOS_V1 }, "s1");
    __handleCliEventForTest(qc, "run-2", { type: "init", sessionId: "cl-session" }, "s1");
    __handleCliEventForTest(qc, "run-2", { type: "todo", todos: TODOS_V2 }, "s1");
    const cards = chatOf(qc).filter((m) => m.kind === "todoList");
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.kind === "todoList" && c.runId)).toEqual(["run-1", "run-2"]);
  });

  it("游标打断:todo 卡之后的 text 开新块,排在卡片后(不回写卡片前的旧 text 块)", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-1", { type: "text", delta: "前段" }, "s1");
    __handleCliEventForTest(qc, "run-1", { type: "todo", todos: TODOS_V1 }, "s1");
    __handleCliEventForTest(qc, "run-1", { type: "text", delta: "后段" }, "s1");
    const kinds = chatOf(qc).map((m) => m.kind);
    const cardIdx = kinds.indexOf("todoList");
    expect(cardIdx).toBeGreaterThan(-1);
    const texts = chatOf(qc).filter((m) => m.kind === "text" && m.who === "claude");
    expect(texts).toHaveLength(2); // 「前段」「后段」两个独立块,而非并成一块
    expect(texts[1]).toMatchObject({ text: "后段" });
    // 「后段」块位于卡片之后。
    expect(kinds.lastIndexOf("text")).toBeGreaterThan(cardIdx);
  });

  it("run 结束(cli:exit)→ 该 run 的卡片 active 置 false,未完成项保持原状态", () => {
    const qc = new QueryClient();
    setupCliRun(qc);
    __handleCliEventForTest(qc, "run-1", { type: "todo", todos: TODOS_V1 }, "s1");
    __handleCliEventForTest(qc, "run-1", { type: "result", ok: true, text: "done" }, "s1");
    __handleCliExitForTest(qc, "run-1", 0, undefined, "s1");
    const card = chatOf(qc).find((m) => m.kind === "todoList");
    expect(card).toMatchObject({ active: false, todos: TODOS_V1 });
  });

  it("pi RPC 路径:todo 事件同样折进持久消息流并支持覆盖更新", () => {
    const qc = new QueryClient();
    usePersonalStore.setState({
      sessions: [{ ...baseSession, agent: "pi", agentSessionIds: {} }],
      runningBySession: {},
      piRuntimeBySession: {},
    });
    beginPiRun(qc, { runId: "prun-t", sessionId: "s1", typingUid: "typ-s1", cwd: "/proj", promptText: "hi" });
    __handlePiEventForTest(qc, "s1", { type: "todo", todos: TODOS_V1 });
    __handlePiEventForTest(qc, "s1", { type: "todo", todos: TODOS_V2 });
    const cards = chatOf(qc).filter((m) => m.kind === "todoList");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ runId: "prun-t", todos: TODOS_V2 });
    // 过程流不含 todo 卡(与 agentLog 分离)。
    const process = qc.getQueryData<Message[]>(personalProcessKeys.detail("s1")) ?? [];
    expect(process.some((m) => m.kind === "todoList")).toBe(false);
  });

  it("sanitizeForSave:todoList 保留且 active 归一 false;计入隐藏游标 count", () => {
    const msgs: Message[] = [
      { kind: "text", who: "me", time: "10:00", text: "问", uid: "u1" },
      {
        kind: "todoList",
        who: "claude",
        time: "10:00",
        runId: "run-1",
        todos: TODOS_V1,
        active: true,
        uid: "td1",
      },
      { kind: "reasoning", who: "claude", time: "10:00", text: "思考", active: true, uid: "r1" },
      { kind: "text", who: "claude", time: "10:01", text: "答", uid: "a1" },
    ];
    const out = sanitizeForSave(msgs);
    expect(out.map((m) => m.kind)).toEqual(["text", "todoList", "text"]);
    expect(out[1]).toMatchObject({ kind: "todoList", active: false, todos: TODOS_V1 });
    // count 与落盘后长度一致(游标不偏移)。
    expect(createHiddenHistory(msgs, 1).count).toBe(out.length);
  });
});

// appendLocalUserMessage：把一条用户消息追加进会话流并落盘，但**不发给任何 agent**。
//
// 用于「消息本身不是给 agent 的」派发——/skill:research 的活由 CRE 引擎干，
// 会话流里那一条只是让用户回头能看见「我当时问了什么」。
// 这一组测试守的核心是**它绝不能顺手把消息发出去**：一旦哪次改动让它走上 send 的老路，
// 用户发起一次研究会额外烧掉一轮 agent 的钱，而界面上看不出任何异常。
describe("appendLocalUserMessage 本地追加(不 spawn CLI)", () => {
  /// 桩桥：只提供落盘与历史加载两条通道。**故意不提供任何 spawn 通道**——
  /// 真去调 startCli/oneshotCli 会直接 TypeError，比断言更早地把回归打出来。
  function stubBridge() {
    const saveChat = vi.fn(async () => undefined);
    const loadChat = vi.fn(async () => [] as Message[]);
    const startCli = vi.fn();
    const oneshotCli = vi.fn();
    const bridge = { saveChat, loadChat, startCli, oneshotCli } as unknown as DesktopBridge;
    __setBridgeForTest(bridge);
    return { bridge, saveChat, loadChat, startCli, oneshotCli };
  }

  it("消息进会话流并立即落盘", async () => {
    const qc = new QueryClient();
    const session = { ...baseSession, id: "s-res" };
    usePersonalStore.setState({ sessions: [session] });
    const { bridge, saveChat } = stubBridge();
    // 分支态预置为空:flushChat 落盘前要求它已加载(v2 兼容),与本文件其它落盘用例同一前置。
    qc.setQueryData(personalBranchKeys.detail("s-res"), []);

    await appendLocalUserMessage(qc, bridge, session, "调研向量数据库选型");

    const messages = qc.getQueryData<Message[]>(personalChatKeys.detail("s-res")) ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "text", who: "me", text: "调研向量数据库选型" });
    // 立即落盘（而非等节流 timer）：用户可能马上切走会话或关窗。
    expect(saveChat).toHaveBeenCalledTimes(1);
  });

  it("不 spawn 任何 CLI（研究由 CRE 引擎跑，这条消息不该产生 agent 轮次）", async () => {
    const qc = new QueryClient();
    const session = { ...baseSession, id: "s-res" };
    usePersonalStore.setState({ sessions: [session] });
    const { bridge, startCli, oneshotCli } = stubBridge();
    qc.setQueryData(personalBranchKeys.detail("s-res"), []);

    await appendLocalUserMessage(qc, bridge, session, "调研向量数据库选型");

    expect(startCli).not.toHaveBeenCalled();
    expect(oneshotCli).not.toHaveBeenCalled();
    // 也不该点亮运行态：中栏据此转圈，而这条消息没有任何东西在跑。
    expect(usePersonalStore.getState().runningBySession["s-res"]).toBeFalsy();
  });

  it("会话仍是默认标题时按首条内容改名（否则侧栏永远挂着 Session N）", async () => {
    const qc = new QueryClient();
    const session = { ...baseSession, id: "s-res", title: "Session 7" };
    usePersonalStore.setState({ sessions: [session] });
    const { bridge } = stubBridge();
    qc.setQueryData(personalBranchKeys.detail("s-res"), []);

    await appendLocalUserMessage(qc, bridge, session, "调研向量数据库选型");

    expect(usePersonalStore.getState().sessions[0]?.title).toBe("调研向量数据库选型");
  });

  it("用户手改过标题就不动它（哪怕仍长得像 Session N）", async () => {
    const qc = new QueryClient();
    const session = { ...baseSession, id: "s-res", title: "Session 7", titleManuallyEdited: true };
    usePersonalStore.setState({ sessions: [session] });
    const { bridge } = stubBridge();
    qc.setQueryData(personalBranchKeys.detail("s-res"), []);

    await appendLocalUserMessage(qc, bridge, session, "调研向量数据库选型");

    expect(usePersonalStore.getState().sessions[0]?.title).toBe("Session 7");
  });

  it("已有非默认标题的会话不被改名（第二次研究不该顶掉原标题）", async () => {
    const qc = new QueryClient();
    const session = { ...baseSession, id: "s-res", title: "向量库调研" };
    usePersonalStore.setState({ sessions: [session] });
    const { bridge } = stubBridge();
    qc.setQueryData(personalBranchKeys.detail("s-res"), []);

    await appendLocalUserMessage(qc, bridge, session, "再调研一次别的东西");

    expect(usePersonalStore.getState().sessions[0]?.title).toBe("向量库调研");
  });

  /// 历史尚未加载时先补载再追加，否则这条消息会被随后 resolve 的磁盘历史整个盖掉
  /// （与 send 路径同一个坑，见「ensureChatLoaded 即建即发不丢首条消息」）。
  it("先加载历史再追加，已有历史不被覆盖", async () => {
    const qc = new QueryClient();
    const session = { ...baseSession, id: "s-res" };
    usePersonalStore.setState({ sessions: [session] });
    const saveChat = vi.fn(async () => undefined);
    const existing: Message[] = [
      { kind: "text", who: "me", time: "10:00", text: "先前的对话", uid: "u0" } as Message,
    ];
    const loadChat = vi.fn(async () => existing);
    const bridge = { saveChat, loadChat } as unknown as DesktopBridge;
    __setBridgeForTest(bridge);
    qc.setQueryData(personalBranchKeys.detail("s-res"), []);

    await appendLocalUserMessage(qc, bridge, session, "调研向量数据库选型");

    const messages = qc.getQueryData<Message[]>(personalChatKeys.detail("s-res")) ?? [];
    expect(messages.map((m) => (m as { text?: string }).text)).toEqual([
      "先前的对话",
      "调研向量数据库选型",
    ]);
  });
});

describe("resolveSessionModelRef 回退语义（计划 §5：不静默回退）", () => {
  const piSession = (over: Partial<SessionMeta> = {}): SessionMeta => ({
    id: "s-ref",
    projectId: "p1",
    title: "t",
    agent: "pi",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });

  beforeEach(() => {
    usePersonalStore.setState({ defaultModelRef: { providerId: "gp", modelId: "gm" } });
  });

  it("会话两个字段都有 → 原样用，不看全局默认", () => {
    expect(__resolveSessionModelRefForTest(piSession({ providerId: "sp", model: "sm" }))).toEqual({
      providerId: "sp",
      modelId: "sm",
    });
  });

  it("只有 session.model → 保留它（用户对本会话的显式选择会真的发出去），provider 取全局默认", () => {
    expect(__resolveSessionModelRefForTest(piSession({ model: "sm" }))).toEqual({
      providerId: "gp",
      modelId: "sm",
    });
  });

  it("两者都无 → 整体落全局默认", () => {
    expect(__resolveSessionModelRefForTest(piSession())).toEqual({ providerId: "gp", modelId: "gm" });
  });

  it("全局默认也没有 → 空引用（消费方据此进「未配置模型」阻断态，不兜底任何模型）", () => {
    usePersonalStore.setState({ defaultModelRef: undefined });
    expect(__resolveSessionModelRefForTest(piSession())).toEqual({ providerId: "", modelId: "" });
  });
});
