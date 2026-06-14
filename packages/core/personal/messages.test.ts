import { describe, expect, it } from "vitest";
import type { CliStreamEvent, SessionMeta } from "../desktop/types";
import {
  agentSessionPatch,
  buildAttachmentSystemPrompt,
  clearAgentSessionPatch,
  createHiddenHistory,
  emptyFoldCursor,
  finalizeAgentLog,
  foldCliEvent,
  isMissingAgentSessionError,
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
