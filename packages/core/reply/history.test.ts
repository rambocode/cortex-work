// 回复历史纯逻辑的行为契约测试（数据模型与追加/截断规则见 history.ts 文件头）。

import { describe, expect, it } from "vitest";
import {
  HISTORY_KEEP,
  appendHistoryEntry,
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
    expect(list[0].ts).toBe(3);
  });

  it("超过保留上限时截断最旧的", () => {
    const many = Array.from({ length: HISTORY_KEEP }, (_, i) => entry(`e${i}`, i));
    const list = appendHistoryEntry(many, entry("newest", 9999));
    expect(list).toHaveLength(HISTORY_KEEP);
    expect(list[0].id).toBe("newest");
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
