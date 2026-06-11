import { describe, expect, it } from "vitest";
import type { SessionMeta } from "../desktop/types";
import { agentSessionPatch, buildAttachmentSystemPrompt, createHiddenHistory, sessionResumeId, splitPersonalMessages } from "./messages";
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
