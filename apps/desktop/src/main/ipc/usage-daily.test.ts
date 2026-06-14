import { describe, expect, it } from "vitest";
import { bucketEventsByDay } from "./usage-daily";

// 本地零点日键，与 usage.ts 内部 dayKey 等价（用于构造期望值，避免依赖时区）。
function dk(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 以本地时间构造某天某时刻的时间戳（避开 UTC 偏移导致的跨天漂移）。
function at(y: number, mo: number, d: number, h = 12, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

const ev = (t: number, tokens: number, parts?: Partial<{ in: number; out: number; cc: number; cr: number }>) => ({
  t,
  in: parts?.in ?? tokens,
  out: parts?.out ?? 0,
  cc: parts?.cc ?? 0,
  cr: parts?.cr ?? 0,
});

describe("bucketEventsByDay", () => {
  const now = at(2026, 6, 14, 18, 0); // 2026-06-14 本地 18:00

  it("跨 3 天的事件分别累加到对应日（tokens = in+out+cc+cr）", () => {
    const events = [
      ev(at(2026, 6, 12), 0, { in: 100, out: 50, cc: 10, cr: 5 }), // 165
      ev(at(2026, 6, 13), 0, { in: 200, out: 0, cc: 0, cr: 0 }), // 200
      ev(at(2026, 6, 14), 0, { in: 1, out: 2, cc: 3, cr: 4 }), // 10
    ];
    const out = bucketEventsByDay(events, 26, now);
    expect(out).toEqual([
      { day: "2026-06-12", tokens: 165, msgs: 1 },
      { day: "2026-06-13", tokens: 200, msgs: 1 },
      { day: "2026-06-14", tokens: 10, msgs: 1 },
    ]);
  });

  it("同一天多条事件合并到同一个日桶", () => {
    const events = [ev(at(2026, 6, 14, 9), 100), ev(at(2026, 6, 14, 15), 200), ev(at(2026, 6, 14, 23), 300)];
    const out = bucketEventsByDay(events, 26, now);
    expect(out).toEqual([{ day: "2026-06-14", tokens: 600, msgs: 3 }]);
  });

  it("本地零点前后的两条事件落入相邻两天，不串桶", () => {
    const before = at(2026, 6, 13, 23, 59); // 13 日 23:59
    const after = at(2026, 6, 14, 0, 1); // 14 日 00:01
    const out = bucketEventsByDay([ev(before, 10), ev(after, 20)], 26, now);
    expect(out).toEqual([
      { day: "2026-06-13", tokens: 10, msgs: 1 },
      { day: "2026-06-14", tokens: 20, msgs: 1 },
    ]);
  });

  it("超出 weeks*7 天窗口的旧事件被丢弃", () => {
    // weeks=2 → 窗口含今天往前 14 天（2026-06-01 ~ 06-14）。
    const old = at(2026, 5, 30); // 15 天前，应丢弃
    const edge = at(2026, 6, 1); // 第 14 天，应保留
    const out = bucketEventsByDay([ev(old, 999), ev(edge, 7)], 2, now);
    expect(out).toEqual([{ day: "2026-06-01", tokens: 7, msgs: 1 }]);
  });

  it("空事件数组返回空", () => {
    expect(bucketEventsByDay([], 26, now)).toEqual([]);
  });

  it("结果按 day 升序", () => {
    const events = [ev(at(2026, 6, 14), 1), ev(at(2026, 6, 10), 1), ev(at(2026, 6, 12), 1)];
    const days = bucketEventsByDay(events, 26, now).map((p) => p.day);
    expect(days).toEqual([...days].sort());
    expect(dk(now)).toBe("2026-06-14"); // sanity: now 的日键
  });
});
