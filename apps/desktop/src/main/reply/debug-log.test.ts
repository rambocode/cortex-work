import { describe, it, expect } from "vitest";
import { ReplyDebugLog, REPLY_DEBUG_LIMIT } from "./debug-log";
import type { ReplyDebugEntry } from "../ipc/reply-types";

function entry(id: string, over: Partial<ReplyDebugEntry> = {}): ReplyDebugEntry {
  return { id, ts: Number(id), kind: "first", source: "ax", ...over };
}

describe("ReplyDebugLog 环形缓冲", () => {
  it("最新记录在前", () => {
    const log = new ReplyDebugLog();
    log.add(entry("1"));
    log.add(entry("2"));
    expect(log.list().map((e) => e.id)).toEqual(["2", "1"]);
  });

  it("第 21 条写入淘汰最旧的一条", () => {
    const log = new ReplyDebugLog();
    for (let i = 1; i <= REPLY_DEBUG_LIMIT + 1; i += 1) {
      log.add(entry(String(i)));
    }
    const ids = log.list().map((e) => e.id);
    expect(ids).toHaveLength(REPLY_DEBUG_LIMIT);
    expect(ids[0]).toBe(String(REPLY_DEBUG_LIMIT + 1)); // 最新在前
    expect(ids).not.toContain("1"); // 最旧被淘汰
    expect(ids[ids.length - 1]).toBe("2");
  });

  it("记录错误分支（output 缺失、error 存在）", () => {
    const log = new ReplyDebugLog();
    log.add(entry("1", { source: "ocr", ocrText: "对方：在吗", error: "生成失败" }));
    const [rec] = log.list();
    expect(rec.error).toBe("生成失败");
    expect(rec.output).toBeUndefined();
    expect(rec.source).toBe("ocr");
  });

  it("list 返回副本，外部修改不影响内部", () => {
    const log = new ReplyDebugLog();
    log.add(entry("1"));
    const snapshot = log.list();
    snapshot.push(entry("999"));
    expect(log.list()).toHaveLength(1);
  });

  it("clear 清空", () => {
    const log = new ReplyDebugLog();
    log.add(entry("1"));
    log.clear();
    expect(log.list()).toEqual([]);
  });

  it("自定义上限", () => {
    const log = new ReplyDebugLog(2);
    log.add(entry("1"));
    log.add(entry("2"));
    log.add(entry("3"));
    expect(log.list().map((e) => e.id)).toEqual(["3", "2"]);
  });
});
