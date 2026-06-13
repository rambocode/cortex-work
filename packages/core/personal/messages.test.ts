import { describe, expect, it } from "vitest";
import type { SessionMeta } from "../desktop/types";
import {
  agentSessionPatch,
  buildAttachmentSystemPrompt,
  createHiddenHistory,
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
