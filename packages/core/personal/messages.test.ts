import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePersonalStore } from "../store/personal";
import type { CliStreamEvent, SessionMeta } from "../desktop/types";
import {
  RESULT_EXIT_GRACE_MS,
  __ensureChatLoadedForTest,
  __handleCliEventForTest,
  __handleCliExitForTest,
  __handlePiEventForTest,
  __resetPersonalMessageRunsForTest,
  beginPiRun,
  reapSessionRun,
  respondPiUi,
  serializeAskQuestionAnswers,
  agentSessionPatch,
  buildAttachmentSystemPrompt,
  clearAgentSessionPatch,
  createHiddenHistory,
  emptyFoldCursor,
  finalizeAgentLog,
  foldCliEvent,
  isMissingAgentSessionError,
  personalChatKeys,
  sessionResumeId,
  sameTextOrdinal,
  splitPersonalMessages,
  truncateForEdit,
  typingText,
} from "./messages";
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

describe("personal message agent session helpers", () => {
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

describe("流式交错折叠 foldCliEvent", () => {
  it("文本→工具→文本：按到达顺序交替成三块", () => {
    const { messages } = foldAll([txt("A"), tool("t1"), txt("B")]);
    expect(messages.map((m) => m.kind)).toEqual(["text", "agentLog", "text"]);
    expect(asText(messages[0]!).text).toBe("A");
    expect(asText(messages[2]!).text).toBe("B");
    // 被文本打断的 agentLog 已收尾,不遗留 running。
    const log = asLog(messages[1]!);
    expect(log.active).toBe(false);
    expect(log.completed).toBe(true);
    expect(log.items).toEqual([{ ic: "check", text: "t1" }]);
  });

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
      { ic: "check", text: "t1" },
      { ic: "check", text: "t2" },
      { ic: "running", text: "t3" },
    ]);
  });

  it("工具组被文本打断：开新文本块,旧卡片收尾", () => {
    const { messages } = foldAll([txt("A"), tool("t1"), tool("t2"), txt("B")]);
    expect(messages.map((m) => m.kind)).toEqual(["text", "agentLog", "text"]);
    const log = asLog(messages[1]!);
    expect(log.active).toBe(false);
    expect(log.completed).toBe(true);
    expect(log.title).toBe("Agent 执行完成");
    expect(log.items).toEqual([
      { ic: "check", text: "t1" },
      { ic: "check", text: "t2" },
    ]);
    expect(asText(messages[2]!).text).toBe("B");
  });

  it("多轮交错 text/tool/tool/text/tool → 四块", () => {
    const { messages } = foldAll([txt("A"), tool("t1"), tool("t2"), txt("B"), tool("t3")]);
    expect(messages.map((m) => m.kind)).toEqual(["text", "agentLog", "text", "agentLog"]);
    expect(asLog(messages[1]!).active).toBe(false); // 第一组被打断收尾
    const last = asLog(messages[3]!);
    expect(last.active).toBe(true); // 末组仍运行中
    expect(last.items).toEqual([{ ic: "running", text: "t3" }]);
  });

  it("以工具起手：首块为 agentLog,无前置空 text 块", () => {
    const { messages } = foldAll([tool("t1"), txt("A")]);
    expect(messages.map((m) => m.kind)).toEqual(["agentLog", "text"]);
    expect(asLog(messages[0]!).items).toEqual([{ ic: "check", text: "t1" }]);
    expect(asText(messages[1]!).text).toBe("A");
  });

  it("codex 连续整段 agent_message（无工具间隔）合并为单块（既定行为）", () => {
    const { messages } = foldAll([txt("段一"), txt("段二")]);
    expect(messages.map((m) => m.kind)).toEqual(["text"]);
    expect(asText(messages[0]!).text).toBe("段一段二");
  });

  it("工具 detail 拼进步骤文案：name · detail", () => {
    const { messages } = foldAll([tool("Edit", "src/a.ts")]);
    expect(asLog(messages[0]!).items).toEqual([{ ic: "running", text: "Edit · src/a.ts" }]);
  });

  it("finalizeAgentLog：全部 items 翻 check 并标记完成", () => {
    const { messages, cursor } = foldAll([tool("t1"), tool("t2")]);
    const out = finalizeAgentLog(messages, cursor.logUid!);
    const log = asLog(out[0]!);
    expect(log.active).toBe(false);
    expect(log.completed).toBe(true);
    expect(log.title).toBe("Agent 执行完成");
    expect(log.items.every((it) => it.ic === "check")).toBe(true);
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

    // 去重:整个过程 loadChat 只被调用一次。
    expect(loadChat).toHaveBeenCalledTimes(1);
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

    expect(loadChat).toHaveBeenCalledTimes(1);
    const final = qc.getQueryData<Message[]>(key) ?? [];
    expect(final).toHaveLength(1);
    expect(asText(final[0]!).text).toBe("深化这批闪记");
  });
});

describe("personal attachment system prompt", () => {
  it("把 prompt 和 todo 附件序列化为不同上下文块", () => {
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
        '<skill name="review.md">',
        "Review rules",
        "</skill>",
        "",
        '<todo name="实现续期" project="app">',
        "# 实现续期",
        "",
        "## 验收\n- 测试通过",
        "</todo>",
      ].join("\n"),
    );
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

  it("text 增量折叠进单一文本块", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "你好" });
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "世界" });
    const texts = cacheOf(qc).filter((m) => m.kind === "text" && m.who === "pi");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ text: "你好世界" });
  });

  it("reasoning 增量累进单一思考块,不与正文混", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "先想想" });
    __handlePiEventForTest(qc, "s1", { type: "reasoning", delta: "再想想" });
    __handlePiEventForTest(qc, "s1", { type: "text", delta: "答案" });
    const msgs = cacheOf(qc);
    const reasoning = msgs.filter((m) => m.kind === "reasoning");
    const texts = msgs.filter((m) => m.kind === "text" && m.who === "pi");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({ text: "先想想再想想" });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ text: "答案" });
  });

  it("tool-start + tool-end(同 toolCallId) 折叠为一张卡片并翻 check", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1", detail: "ls" });
    __handlePiEventForTest(qc, "s1", { type: "tool-end", name: "Bash", toolCallId: "t1", isError: false });
    const logs = cacheOf(qc).filter((m) => m.kind === "agentLog");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ items: [{ ic: "check", text: "Bash · ls" }] });
  });

  it("tool-end 出错时项文本前缀 ⚠️", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "tool-start", name: "Bash", toolCallId: "t1", detail: "rm -rf" });
    __handlePiEventForTest(qc, "s1", { type: "tool-end", name: "Bash", toolCallId: "t1", isError: true });
    const log = cacheOf(qc).find((m) => m.kind === "agentLog");
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

  it("result(willRetry:true) 不收尾,running 保持", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    __handlePiEventForTest(qc, "s1", { type: "result", willRetry: true });
    expect(usePersonalStore.getState().runningBySession.s1).toBe("prun-1");
  });

  it("error 事件 → ⚠️ 气泡;aborted → 中断轻提示", () => {
    const qc = new QueryClient();
    setupPiRun(qc, "s1");
    __handlePiEventForTest(qc, "s1", { type: "error", error: "401 unauthorized" });
    const err = cacheOf(qc).find((m) => m.kind === "text" && typeof m.text === "string" && m.text.startsWith("⚠️"));
    expect(err?.kind === "text" && err.text).toContain("执行出错");
    expect(err?.kind === "text" && err.text).toContain("供应商");

    const qc2 = new QueryClient();
    setupPiRun(qc2, "s2", "prun-2");
    __handlePiEventForTest(qc2, "s2", { type: "error", error: "aborted" });
    const abortMsg = cacheOf(qc2, "s2").find((m) => m.kind === "text" && typeof m.text === "string" && m.text.includes("已中断"));
    expect(abortMsg).toBeTruthy();
  });

  it("crashed → ⚠️ + 清 running/runtime", () => {
    const qc = new QueryClient();
    setupPiRun(qc);
    usePersonalStore.getState().setPiRuntime("s1", { steering: 2 });
    __handlePiEventForTest(qc, "s1", { type: "crashed", error: "退出码 1" });
    expect(usePersonalStore.getState().runningBySession.s1).toBeUndefined();
    expect(usePersonalStore.getState().piRuntimeBySession.s1).toBeUndefined();
    const crash = cacheOf(qc).find((m) => m.kind === "text" && typeof m.text === "string" && m.text.includes("已退出"));
    expect(crash).toBeTruthy();
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

  it("error→willRetry:true→text→result:重试文本进新块,不续在错误后", () => {
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
});

describe("pi extension UI 待确认队列（阶段3 U5）", () => {
  const req = (id: string) =>
    ({ type: "extension_ui_request", id, method: "confirm", title: "T", message: "M" }) as const;

  beforeEach(() => usePersonalStore.setState({ piUiPending: [], sessions: [], runningBySession: {} }));

  it("push/resolve/clearForSession store 队列", () => {
    const st = usePersonalStore.getState();
    st.pushPiUiRequest({ uiSessionId: "sA", request: req("1") });
    st.pushPiUiRequest({ uiSessionId: "sB", request: req("2") });
    expect(usePersonalStore.getState().piUiPending).toHaveLength(2);
    st.resolvePiUiRequest("1");
    expect(usePersonalStore.getState().piUiPending.map((p) => p.request.id)).toEqual(["2"]);
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
