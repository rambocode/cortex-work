// 对话级记忆纯逻辑的行为契约测试（key 归一 / 最近回复上限 / LRU 裁剪 / 注入组装 / 蒸馏 prompt）。

import { describe, expect, it } from "vitest";
import {
  MAX_CONVERSATIONS,
  RECENT_REPLIES_LIMIT,
  appendRecentReply,
  buildConversationDistillPrompt,
  capConversations,
  composeConversationMemory,
  conversationKey,
  type ConversationMemory,
} from "./conversation-memory";

/// 最小对话记忆工厂。
function memory(patch: Partial<ConversationMemory> = {}): ConversationMemory {
  return {
    appName: "WeChat",
    counterpart: "张玲玲",
    summary: "",
    recentReplies: [],
    updatedAt: 0,
    ...patch,
  };
}

describe("conversationKey", () => {
  it("bundleId + counterpart 归一化（去空白、小写）后拼 key", () => {
    expect(conversationKey("com.tencent.xinWeChat", " 张玲玲-财务 ")).toBe(
      "com.tencent.xinwechat|张玲玲-财务",
    );
  });

  it("counterpart 为空/空白 → null（不分桶：宁可不记，不把整个 app 混一桶）", () => {
    expect(conversationKey("com.tencent.xinWeChat", "")).toBeNull();
    expect(conversationKey("com.tencent.xinWeChat", "   ")).toBeNull();
  });

  it("bundleId 为空 → null（无稳定 app 标识时放弃分桶）", () => {
    expect(conversationKey("", "张玲玲")).toBeNull();
  });
});

describe("appendRecentReply", () => {
  it("newest-first 追加，超上限截断", () => {
    let replies: string[] = [];
    for (let i = 1; i <= RECENT_REPLIES_LIMIT + 2; i++) {
      replies = appendRecentReply(replies, `回复${i}`);
    }
    expect(replies).toHaveLength(RECENT_REPLIES_LIMIT);
    expect(replies[0]).toBe(`回复${RECENT_REPLIES_LIMIT + 2}`);
  });

  it("空白回复忽略；重复正文去重（提升到最新位）", () => {
    expect(appendRecentReply(["a"], "  ")).toEqual(["a"]);
    expect(appendRecentReply(["a", "b"], "b")).toEqual(["b", "a"]);
  });

  it("纯函数：不改入参", () => {
    const input = ["a"];
    appendRecentReply(input, "b");
    expect(input).toEqual(["a"]);
  });
});

describe("capConversations", () => {
  it("未超上限原样返回（引用不变，省一次落盘 diff）", () => {
    const map = { k1: memory({ updatedAt: 1 }) };
    expect(capConversations(map)).toBe(map);
  });

  it("超上限按 updatedAt 保留最近的（LRU 淘汰最旧）", () => {
    const map: Record<string, ConversationMemory> = {};
    for (let i = 0; i < MAX_CONVERSATIONS + 3; i++) {
      map[`k${i}`] = memory({ updatedAt: i });
    }
    const capped = capConversations(map);
    expect(Object.keys(capped)).toHaveLength(MAX_CONVERSATIONS);
    expect(capped["k0"]).toBeUndefined();
    expect(capped["k2"]).toBeUndefined();
    expect(capped[`k${MAX_CONVERSATIONS + 2}`]).toBeDefined();
  });
});

describe("composeConversationMemory", () => {
  it("有 summary → 用 summary（含对方名标注）", () => {
    const text = composeConversationMemory(
      memory({ summary: "- 偏好简短回复\n- 项目代号 X", recentReplies: ["好的"] }),
    );
    expect(text).toContain("张玲玲");
    expect(text).toContain("偏好简短回复");
    // summary 优先时不再罗列最近回复（避免 prompt 冗长）
    expect(text).not.toContain("好的");
  });

  it("无 summary 有最近回复 → few-shot 列最近回复", () => {
    const text = composeConversationMemory(memory({ recentReplies: ["收到，我看下", "明天说"] }));
    expect(text).toContain("收到，我看下");
    expect(text).toContain("明天说");
  });

  it("两者皆空 → 空串（调用方据此不注入该段）", () => {
    expect(composeConversationMemory(memory())).toBe("");
  });
});

describe("buildConversationDistillPrompt", () => {
  it("system 约束要点输出；user 含对话原文、已采纳回复与既有要点", () => {
    const prompt = buildConversationDistillPrompt({
      appName: "WeChat",
      counterpart: "张玲玲",
      conversation: "对方：报销单交了吗？",
      acceptedDraft: "刚交了，你查收下",
      existingSummary: "- 财务同事",
    });
    expect(prompt.system).toContain("- ");
    expect(prompt.user).toContain("报销单交了吗");
    expect(prompt.user).toContain("刚交了，你查收下");
    expect(prompt.user).toContain("财务同事");
    expect(prompt.user).toContain("张玲玲");
  });

  it("无既有要点时 user 不含「已记住的要点」段", () => {
    const prompt = buildConversationDistillPrompt({
      appName: "WeChat",
      counterpart: "张玲玲",
      conversation: "对方：在吗",
      acceptedDraft: "在的",
      existingSummary: "",
    });
    expect(prompt.user).not.toContain("已记住的要点");
  });
});
