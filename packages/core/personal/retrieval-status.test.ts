// retrieval-status 状态机的测试：条目「首个事件才创建、同 uid 原位替换、必须收敛终态」
// 三条生产方义务逐一看守（渲染侧契约见 types/index.ts 的 retrieval 变体）。
import { describe, expect, it } from "vitest";
import type { Message } from "../types";

import { beginRetrievalTimeline } from "./retrieval-status";

type RetrievalMessage = Extract<Message, { kind: "retrieval" }>;

/// 用一个可变数组 fake 过程流；write 语义与 setProcessMessages 一致（updater(prev) → next）。
function fakeStream() {
  const box = { messages: [] as Message[] };
  return {
    box,
    write: (updater: (prev: Message[]) => Message[]) => {
      box.messages = updater(box.messages);
    },
    only(): RetrievalMessage {
      expect(box.messages).toHaveLength(1);
      return box.messages[0] as RetrievalMessage;
    },
  };
}

describe("beginRetrievalTimeline", () => {
  it("write 缺失 → no-op 句柄，不抛错", () => {
    const handle = beginRetrievalTimeline(undefined, "claude");
    expect(() => {
      handle.update({ phase: "understanding" });
      handle.finalize();
    }).not.toThrow();
  });

  it("不发状态 → 不留条目；finalize 对未创建的条目 no-op", () => {
    const stream = fakeStream();
    const handle = beginRetrievalTimeline(stream.write, "claude");
    handle.finalize();
    expect(stream.box.messages).toEqual([]);
  });

  it("首个事件创建条目（understanding，active=true），后续同 uid 原位替换", () => {
    const stream = fakeStream();
    const handle = beginRetrievalTimeline(stream.write, "claude");
    handle.update({ phase: "understanding" });
    const first = stream.only();
    expect(first.kind).toBe("retrieval");
    expect(first.phase).toBe("understanding");
    expect(first.active).toBe(true);
    expect(first.uid).toBeDefined();

    handle.update({ phase: "searching", query: "改写后的查询", rewritten: true });
    const second = stream.only(); // 仍只有一条 = 原位替换
    expect(second.uid).toBe(first.uid);
    expect(second.phase).toBe("searching");
    expect(second.query).toBe("改写后的查询");
  });

  it("done 带 resultCount 且收敛（active=false + endedAt）；searching 的 query 保留到终态", () => {
    const stream = fakeStream();
    const handle = beginRetrievalTimeline(stream.write, "claude");
    handle.update({ phase: "searching", query: "改写查询", rewritten: true });
    handle.update({ phase: "done", documentCount: 3 });
    const entry = stream.only();
    expect(entry.phase).toBe("done");
    expect(entry.resultCount).toBe(3);
    expect(entry.active).toBe(false);
    expect(entry.endedAt).toBeDefined();
    // query 是过程面板回看的线索，终态不该丢。
    expect(entry.query).toBe("改写查询");
  });

  it("done 不带 documentCount（仅意图理解、无检索链路）→ 条目无 resultCount 键", () => {
    const stream = fakeStream();
    const handle = beginRetrievalTimeline(stream.write, "claude");
    handle.update({ phase: "understanding" });
    handle.update({ phase: "done" });
    const entry = stream.only();
    expect(entry.phase).toBe("done");
    // 「已理解问题」与「检索到 0 条」是两种终态，靠 resultCount 是否存在区分，不能混。
    expect("resultCount" in entry).toBe(false);
    expect(entry.active).toBe(false);
  });

  it("原文照发（rewritten=false）时不存 query（不重复存一份用户消息）", () => {
    const stream = fakeStream();
    const handle = beginRetrievalTimeline(stream.write, "claude");
    handle.update({ phase: "searching", query: "用户原文", rewritten: false });
    expect(stream.only().query).toBeUndefined();
  });

  it("skipped 带 skipReason", () => {
    const stream = fakeStream();
    const handle = beginRetrievalTimeline(stream.write, "claude");
    handle.update({ phase: "understanding" });
    handle.update({ phase: "skipped", intent: "chitchat" });
    const entry = stream.only();
    expect(entry.phase).toBe("skipped");
    expect(entry.skipReason).toBe("chitchat");
    expect(entry.active).toBe(false);
  });

  it("终态后再 update 被忽略（保留已收敛的结论）", () => {
    const stream = fakeStream();
    const handle = beginRetrievalTimeline(stream.write, "claude");
    handle.update({ phase: "done", documentCount: 1 });
    handle.update({ phase: "failed", reason: "late" });
    expect(stream.only().phase).toBe("done");
  });

  it("finalize 把非终态收敛为 failed/interrupted；已终态则不动", () => {
    const stream = fakeStream();
    const handle = beginRetrievalTimeline(stream.write, "claude");
    handle.update({ phase: "understanding" });
    handle.finalize();
    const entry = stream.only();
    expect(entry.phase).toBe("failed");
    expect(entry.error).toBe("interrupted");
    expect(entry.active).toBe(false);

    const stream2 = fakeStream();
    const handle2 = beginRetrievalTimeline(stream2.write, "claude");
    handle2.update({ phase: "done", documentCount: 0 });
    handle2.finalize();
    expect(stream2.only().phase).toBe("done");
  });

  it("条目追加在既有过程流之后，不动其它消息", () => {
    const stream = fakeStream();
    stream.box.messages = [{ kind: "typing", who: "claude", text: "…" } as Message];
    const handle = beginRetrievalTimeline(stream.write, "claude");
    handle.update({ phase: "understanding" });
    expect(stream.box.messages).toHaveLength(2);
    expect(stream.box.messages[0]!.kind).toBe("typing");
  });
});
