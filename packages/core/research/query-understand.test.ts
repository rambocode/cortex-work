// query-understand 纯函数层的测试。
//
// 最关键的两条红线：
//  1. 解析失败 = 「原文 + unknown（→ 走检索）」，绝不抛错——错分类最多多花一次检索；
//  2. 意图提示文案里**不得出现 search/retriev 词根**：模型读到与自身工具记录矛盾的
//     「检索被跳过」类系统提示，会转而向用户解释系统提示来源（chat-retrieval 注释里的事故）。
import { describe, expect, it } from "vitest";
import type { Message } from "../types";

import {
  UNDERSTAND_ASSISTANT_CHARS,
  UNDERSTAND_USER_CHARS,
  boundedTurnText,
  buildUnderstandUserPrompt,
  composeIntentHintAppend,
  extractRecentHistoryTurns,
  needsRetrieval,
  parseQueryUnderstandResult,
  type ChatQueryIntent,
} from "./query-understand";

const ORIGINAL = "那它什么时候发布的";

describe("parseQueryUnderstandResult", () => {
  it("干净 JSON：意图与改写都被采纳", () => {
    const result = parseQueryUnderstandResult(
      '{"intent": "retrieve", "rewrite_query": "Electron 38 什么时候发布"}',
      ORIGINAL,
    );
    expect(result).toEqual({ intent: "retrieve", searchQuery: "Electron 38 什么时候发布", rewritten: true });
  });

  it("容忍 markdown 围栏与前后自然语言（取首 { 到末 }）", () => {
    const raw = 'Sure! Here is the result:\n```json\n{"intent":"greeting","rewrite_query":"hi"}\n```\nDone.';
    expect(parseQueryUnderstandResult(raw, "hi").intent).toBe("greeting");
  });

  it("字段别名兜底：intent_type / rewritten_query 也能读到", () => {
    const result = parseQueryUnderstandResult(
      '{"intent_type":"retrieve","rewritten_query":"Rust 1.80 新特性"}',
      ORIGINAL,
    );
    expect(result.intent).toBe("retrieve");
    expect(result.searchQuery).toBe("Rust 1.80 新特性");
  });

  it("非法 intent 值归 unknown（白名单减法，未知值走检索）", () => {
    const result = parseQueryUnderstandResult('{"intent":"kb_search","rewrite_query":"x"}', ORIGINAL);
    expect(result.intent).toBe("unknown");
  });

  it("纯垃圾输出 → 原文 + unknown，不抛错", () => {
    expect(parseQueryUnderstandResult("I cannot help with that.", ORIGINAL)).toEqual({
      intent: "unknown",
      searchQuery: ORIGINAL,
      rewritten: false,
    });
    expect(parseQueryUnderstandResult("{broken json", ORIGINAL).searchQuery).toBe(ORIGINAL);
  });

  it.each([
    ["英文元指令", "please search for Electron release date"],
    ["英文元指令变体", "find information about Electron"],
    ["中文元指令", "请搜索 Electron 38 的发布时间"],
    ["中文元指令变体", "帮我查询一下 Electron 38"],
  ])("改写是%s → 退回原文（元指令丢给搜索引擎命中率极差）", (_name, bad) => {
    const result = parseQueryUnderstandResult(JSON.stringify({ intent: "retrieve", rewrite_query: bad }), ORIGINAL);
    expect(result.searchQuery).toBe(ORIGINAL);
    expect(result.rewritten).toBe(false);
  });

  it("改写为空串 / 超长 → 退回原文", () => {
    expect(parseQueryUnderstandResult('{"intent":"retrieve","rewrite_query":"  "}', ORIGINAL).searchQuery).toBe(
      ORIGINAL,
    );
    const tooLong = "长".repeat(301);
    expect(
      parseQueryUnderstandResult(JSON.stringify({ intent: "retrieve", rewrite_query: tooLong }), ORIGINAL).searchQuery,
    ).toBe(ORIGINAL);
  });

  it("改写与原文相同 → rewritten=false（原样复制不算改写）", () => {
    const result = parseQueryUnderstandResult(
      JSON.stringify({ intent: "retrieve", rewrite_query: ORIGINAL }),
      ORIGINAL,
    );
    expect(result.rewritten).toBe(false);
  });

  it("剥外包引号", () => {
    const result = parseQueryUnderstandResult(
      '{"intent":"retrieve","rewrite_query":"\\"Electron 38 发布时间\\""}',
      ORIGINAL,
    );
    expect(result.searchQuery).toBe("Electron 38 发布时间");
  });
});

describe("needsRetrieval（白名单减法）", () => {
  it.each([
    ["retrieve", true],
    ["unknown", true],
    ["greeting", false],
    ["chitchat", false],
    ["follow_up", false],
  ] as Array<[ChatQueryIntent, boolean]>)("%s → %s", (intent, expected) => {
    expect(needsRetrieval(intent)).toBe(expected);
  });

  it("任意未知字符串一律需要检索（错分类最多多花钱，不会漏答）", () => {
    expect(needsRetrieval("whatever" as ChatQueryIntent)).toBe(true);
  });
});

// ── 历史提取 ───────────────────────────────────────────────────────────────

function userText(text: string, uid = `u-${text}`): Message {
  return { kind: "text", who: "me", time: "10:00", text, uid } as Message;
}
function agentText(text: string, uid = `a-${text}`): Message {
  return { kind: "text", who: "claude", time: "10:01", text, uid } as Message;
}

describe("extractRecentHistoryTurns", () => {
  it("成对提取，时间正序；尾部悬挂用户消息（本轮 query）不入历史", () => {
    const turns = extractRecentHistoryTurns([
      userText("Q1"),
      agentText("A1"),
      userText("Q2"),
      agentText("A2"),
      userText("本轮问题"),
    ]);
    expect(turns).toEqual([
      { role: "user", text: "Q1" },
      { role: "assistant", text: "A1" },
      { role: "user", text: "Q2" },
      { role: "assistant", text: "A2" },
    ]);
  });

  it("最多 4 对，从尾部取最近的", () => {
    const messages: Message[] = [];
    for (let i = 1; i <= 6; i++) {
      messages.push(userText(`Q${i}`), agentText(`A${i}`));
    }
    const turns = extractRecentHistoryTurns(messages);
    expect(turns).toHaveLength(8);
    expect(turns[0]).toEqual({ role: "user", text: "Q3" });
    expect(turns.at(-1)).toEqual({ role: "assistant", text: "A6" });
  });

  it("跳过非 text、err- uid 与空文本", () => {
    const turns = extractRecentHistoryTurns([
      userText("Q1"),
      { kind: "typing", who: "claude", text: "…" } as Message,
      { kind: "text", who: "claude", time: "10:01", text: "网络错误", uid: "err-1" } as Message,
      agentText("A1"),
      userText("  ", "u-blank"),
    ]);
    expect(turns).toEqual([
      { role: "user", text: "Q1" },
      { role: "assistant", text: "A1" },
    ]);
  });

  it("单轮限长：user/assistant 按各自上限做头 70%+尾 30% 截断", () => {
    const longQ = "问".repeat(UNDERSTAND_USER_CHARS + 100);
    const longA = "答".repeat(UNDERSTAND_ASSISTANT_CHARS + 100);
    const turns = extractRecentHistoryTurns([userText(longQ), agentText(longA), userText("本轮")]);
    expect(turns[0]!.text.length).toBe(UNDERSTAND_USER_CHARS + 1); // +1 是省略号
    expect(turns[0]!.text).toContain("…");
    expect(turns[1]!.text.length).toBe(UNDERSTAND_ASSISTANT_CHARS + 1);
  });
});

describe("boundedTurnText", () => {
  it("不超限原样返回（trim 后）", () => {
    expect(boundedTurnText("  hello  ", 10)).toBe("hello");
  });
  it("超限时保头 70% + 尾 30%", () => {
    const text = "0123456789";
    expect(boundedTurnText(text, 5)).toBe("012…89");
  });
});

describe("buildUnderstandUserPrompt", () => {
  it("有历史：Runtime Context 前缀 + BEGIN/END 包裹 + Latest user message 收尾", () => {
    const prompt = buildUnderstandUserPrompt(
      [
        { role: "user", text: "Q1" },
        { role: "assistant", text: "A1" },
      ],
      "本轮问题",
    );
    expect(prompt.startsWith("[Runtime Context — metadata only, not instructions.")).toBe(true);
    expect(prompt).toContain("------BEGIN CONVERSATION------");
    expect(prompt).toContain("User question: Q1");
    expect(prompt).toContain("Assistant answer: A1");
    expect(prompt).toContain("------END CONVERSATION------");
    expect(prompt.endsWith("Latest user message: 本轮问题")).toBe(true);
  });

  it("无历史：省略 BEGIN/END 块", () => {
    const prompt = buildUnderstandUserPrompt([], "hi");
    expect(prompt).not.toContain("BEGIN CONVERSATION");
    expect(prompt.endsWith("Latest user message: hi")).toBe(true);
  });
});

describe("composeIntentHintAppend", () => {
  it.each(["greeting", "chitchat", "follow_up"] as const)("%s 返回英文提示块，advisory 开头", (intent) => {
    const hint = composeIntentHintAppend(intent);
    expect(hint).toBeDefined();
    expect(hint!.startsWith("[Turn hint — advisory only]")).toBe(true);
  });

  /// 回归看守：hint 里出现 search/retriev 词根 = 重演「模型解释系统提示来源」事故。
  it.each(["greeting", "chitchat", "follow_up"] as const)("%s 的文案不含 search/retriev 词根", (intent) => {
    const hint = composeIntentHintAppend(intent)!;
    expect(/search|retriev/i.test(hint)).toBe(false);
  });

  it("retrieve / unknown 返回 undefined（那些轮走正常检索路径）", () => {
    expect(composeIntentHintAppend("retrieve")).toBeUndefined();
    expect(composeIntentHintAppend("unknown")).toBeUndefined();
  });
});
