// 回复历史纯逻辑的行为契约测试（数据模型与追加/截断规则见 history.ts 文件头）。

import { describe, expect, it } from "vitest";
import {
  HISTORY_KEEP,
  appendHistoryEntry,
  normalizeHistoryEvent,
  type ReplyHistoryEntry,
} from "./history";

/// 构造一条最小历史条目（测试便捷工厂，字段可覆写）。
function entry(id: string, ts: number, patch: Partial<ReplyHistoryEntry> = {}): ReplyHistoryEntry {
  return {
    id,
    ts,
    appName: "WeChat",
    appBundleId: "com.tencent.xinWeChat",
    counterpart: "张玲玲",
    conversation: "对方：明天方便对一下吗？",
    candidates: [
      { text: "好，明天上午可以。", stance: "agree" },
      { text: "明天恐怕不行。", stance: "reject" },
    ],
    acceptedIndex: 0,
    acceptedText: "好，明天上午可以。",
    ...patch,
  };
}

describe("appendHistoryEntry", () => {
  it("newest-first：新条目插在数组头部", () => {
    const list = appendHistoryEntry([entry("a", 1)], entry("b", 2));
    expect(list.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("按 id 去重：重复追加同 id 只保留最新一条", () => {
    const list = appendHistoryEntry([entry("a", 1), entry("b", 2)], entry("a", 3));
    expect(list.map((e) => e.id)).toEqual(["a", "b"]);
    expect(list[0]!.ts).toBe(3);
  });

  it("超过保留上限时截断最旧的", () => {
    const many = Array.from({ length: HISTORY_KEEP }, (_, i) => entry(`e${i}`, i));
    const list = appendHistoryEntry(many, entry("newest", 9999));
    expect(list).toHaveLength(HISTORY_KEEP);
    expect(list[0]!.id).toBe("newest");
    // 尾部（最旧）被挤出
    expect(list.some((e) => e.id === `e${HISTORY_KEEP - 1}`)).toBe(false);
  });

  it("keep 参数可自定义上限（入参 newest-first，挤出尾部最旧的）", () => {
    const list = appendHistoryEntry([entry("b", 2), entry("a", 1)], entry("c", 3), 2);
    expect(list.map((e) => e.id)).toEqual(["c", "b"]);
  });

  it("纯函数：不改入参数组", () => {
    const input = [entry("a", 1)];
    appendHistoryEntry(input, entry("b", 2));
    expect(input).toHaveLength(1);
  });
});

describe("normalizeHistoryEvent", () => {
  it("本项目 schema：字段直通，缺省字段兜底", () => {
    const normalized = normalizeHistoryEvent({ id: "a", ts: 5, candidates: [{ text: "好", stance: "agree" }] });
    expect(normalized).toMatchObject({ id: "a", ts: 5, acceptedIndex: 0, counterpart: "" });
    expect(normalized!.candidates).toEqual([{ text: "好", stance: "agree" }]);
  });

  it("Reply.app 源 schema：appBundleID/at/insertedText/pickedIndex/contextPreview 映射", () => {
    // 取自源项目真实事件文件的字段形态
    const normalized = normalizeHistoryEvent({
      appBundleID: "com.tencent.xinWeChat",
      appName: "微信",
      at: "2026-07-02T14:09:30Z",
      candidates: ["好的，代码发你参考一下，你看看能不能直接用"],
      channel: "im",
      contextPreview: "我: 实现你想要的查询分析等 对方: 的加载，跟你这个似的",
      id: "E3D11331-3B1A-4786-967B-3F8643BD3053",
      insertedText: "好的，代码发你参考一下，你看看能不能直接用",
      outcome: "inserted",
      pickedIndex: 0,
      schemaVersion: 1,
    });
    expect(normalized).toMatchObject({
      id: "E3D11331-3B1A-4786-967B-3F8643BD3053",
      ts: Date.parse("2026-07-02T14:09:30Z"),
      appBundleId: "com.tencent.xinWeChat",
      appName: "微信",
      counterpart: "",
      conversation: "我: 实现你想要的查询分析等 对方: 的加载，跟你这个似的",
      acceptedIndex: 0,
      acceptedText: "好的，代码发你参考一下，你看看能不能直接用",
    });
    // 字符串候选归一为 {text, stance: null}
    expect(normalized!.candidates).toEqual([
      { text: "好的，代码发你参考一下，你看看能不能直接用", stance: null },
    ]);
  });

  it("源 schema 缺 insertedText 时回落 pickedIndex 指向的候选", () => {
    const normalized = normalizeHistoryEvent({
      id: "x",
      at: "2026-07-02T00:00:00Z",
      appBundleID: "b",
      appName: "a",
      candidates: ["一", "二"],
      pickedIndex: 1,
    });
    expect(normalized!.acceptedText).toBe("二");
  });

  it("无法识别（缺 id / 缺时间 / 非法时间）→ null", () => {
    expect(normalizeHistoryEvent(null)).toBeNull();
    expect(normalizeHistoryEvent({ ts: 1 })).toBeNull();
    expect(normalizeHistoryEvent({ id: "a" })).toBeNull();
    expect(normalizeHistoryEvent({ id: "a", at: "不是时间" })).toBeNull();
  });

  it("非法 stance 归一为 null", () => {
    const normalized = normalizeHistoryEvent({
      id: "a",
      ts: 1,
      candidates: [{ text: "好", stance: "question" }],
    });
    expect(normalized!.candidates[0]!.stance).toBeNull();
  });
});
