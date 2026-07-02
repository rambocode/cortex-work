import { describe, it, expect } from "vitest";
import { computeNextOccurrence, rollRepeat, canRoll } from "./taskRepeat";
import type { TaskRepeat } from "../desktop/tasks-types";

describe("computeNextOccurrence", () => {
  it("daily +1 天", () => {
    expect(computeNextOccurrence("2026-07-01", { kind: "daily" })).toBe("2026-07-02");
  });
  it("daily interval=3", () => {
    expect(computeNextOccurrence("2026-07-01", { kind: "daily", interval: 3 })).toBe("2026-07-04");
  });
  it("weekly +7 天", () => {
    expect(computeNextOccurrence("2026-07-01", { kind: "weekly" })).toBe("2026-07-08");
  });
  it("monthly 同日", () => {
    expect(computeNextOccurrence("2026-07-15", { kind: "monthly" })).toBe("2026-08-15");
  });
  it("monthly 月末夹取 1/31→2/28", () => {
    expect(computeNextOccurrence("2026-01-31", { kind: "monthly" })).toBe("2026-02-28");
  });
  it("跨年 12→次年 1 月", () => {
    expect(computeNextOccurrence("2026-12-10", { kind: "monthly" })).toBe("2027-01-10");
  });
  it("daily 跨月末 6/30→7/1", () => {
    expect(computeNextOccurrence("2026-06-30", { kind: "daily" })).toBe("2026-07-01");
  });
});

describe("rollRepeat / canRoll", () => {
  it("同时推进 due 与 defer", () => {
    expect(
      rollRepeat({ dueDate: "2026-07-01", deferDate: "2026-06-30", repeat: { kind: "daily" } }),
    ).toEqual({ dueDate: "2026-07-02", deferDate: "2026-07-01" });
  });
  it("无 repeat → 原样返回", () => {
    expect(rollRepeat({ dueDate: "2026-07-01" })).toEqual({ dueDate: "2026-07-01", deferDate: undefined });
  });
  it("canRoll 需 repeat + 至少一个日期锚点", () => {
    expect(canRoll({ repeat: { kind: "daily" }, dueDate: "2026-07-01" })).toBe(true);
    expect(canRoll({ repeat: { kind: "weekly" }, deferDate: "2026-07-01" })).toBe(true);
    expect(canRoll({ repeat: { kind: "daily" } })).toBe(false); // 无日期
    expect(canRoll({ dueDate: "2026-07-01" })).toBe(false); // 无 repeat
  });
});

// ── U14 自定义重复：周几集合 / 月中的一天 / 第 N 个星期几（真值经独立计算核对）──
describe("computeNextOccurrence · 自定周几（weekly custom）", () => {
  // 2026-07-01=周三；[1,3,5]=周一/三/五。
  const wk = (weekdays: number[], interval = 1): TaskRepeat => ({ kind: "weekly", custom: true, weekdays, interval });
  it("[一三五] 周三(07-01) → 最近周五 07-03", () => {
    expect(computeNextOccurrence("2026-07-01", wk([1, 3, 5]))).toBe("2026-07-03");
  });
  it("[一三五] 周五(07-03) → 下周一 07-06", () => {
    expect(computeNextOccurrence("2026-07-03", wk([1, 3, 5]))).toBe("2026-07-06");
  });
  it("[一] 每 2 周：从周一 07-06 跳过一周 → 07-20", () => {
    expect(computeNextOccurrence("2026-07-06", wk([1], 2))).toBe("2026-07-20");
  });
  it("weekdays 空 → 防呆回退简单每 N 周(+7)", () => {
    expect(computeNextOccurrence("2026-07-01", wk([]))).toBe("2026-07-08");
  });
  it("custom=false 忽略 weekdays，走简单周", () => {
    expect(computeNextOccurrence("2026-07-01", { kind: "weekly", custom: false, weekdays: [1, 3, 5] })).toBe("2026-07-08");
  });
});

describe("computeNextOccurrence · 月中的一天（monthly day）", () => {
  const md = (monthDays: Array<number | "last">, interval = 1): TaskRepeat => ({
    kind: "monthly",
    custom: true,
    monthMode: "day",
    monthDays,
    interval,
  });
  it("[1,15] 从 1 日 → 同月 15 日", () => {
    expect(computeNextOccurrence("2026-07-01", md([1, 15]))).toBe("2026-07-15");
  });
  it("[1,15] 从 15 日 → 下月 1 日", () => {
    expect(computeNextOccurrence("2026-07-15", md([1, 15]))).toBe("2026-08-01");
  });
  it("[last] 从 07-20 → 07-31", () => {
    expect(computeNextOccurrence("2026-07-20", md(["last"]))).toBe("2026-07-31");
  });
  it("[last] 从 01-31 → 02-28（月末夹取）", () => {
    expect(computeNextOccurrence("2026-01-31", md(["last"]))).toBe("2026-02-28");
  });
  it("[31] 在无 31 日的月被丢弃 → 跳到有 31 日的月（04-15 → 05-31）", () => {
    expect(computeNextOccurrence("2026-04-15", md([31]))).toBe("2026-05-31");
  });
  it("[15] 每 2 月：07-15 → 09-15", () => {
    expect(computeNextOccurrence("2026-07-15", md([15], 2))).toBe("2026-09-15");
  });
  it("缺 monthMode 默认按 day 消费 monthDays（覆盖切单位遗留/agent 直发路径）", () => {
    expect(computeNextOccurrence("2026-07-01", { kind: "monthly", custom: true, monthDays: [15] })).toBe("2026-07-15");
  });
});

describe("computeNextOccurrence · 第 N 个星期几（monthly weekday）", () => {
  const mw = (ordinal: TaskRepeat["ordinal"], weekday: number, interval = 1): TaskRepeat => ({
    kind: "monthly",
    custom: true,
    monthMode: "weekday",
    ordinal,
    weekday,
    interval,
  });
  it("第 3 个周一：从 07-01 → 07-20", () => {
    expect(computeNextOccurrence("2026-07-01", mw("3", 1))).toBe("2026-07-20");
  });
  it("第 3 个周一：从自身 07-20 → 下月 08-17", () => {
    expect(computeNextOccurrence("2026-07-20", mw("3", 1))).toBe("2026-08-17");
  });
  it("最后一个周五：从 07-01 → 07-31", () => {
    expect(computeNextOccurrence("2026-07-01", mw("last", 5))).toBe("2026-07-31");
  });
  it("第 5 个周日：02 月无 → 跳到 03-29", () => {
    expect(computeNextOccurrence("2026-02-01", mw("5", 0))).toBe("2026-03-29");
  });
});

describe("rollRepeat · 子日单位（分/时，锚提醒时刻）", () => {
  it("每 30 分钟：提醒时刻 +30 分、清 firedAt；日期原样不动", () => {
    const at = new Date(2026, 7, 14, 9, 0, 0, 0).getTime();
    const r = rollRepeat({ dueDate: "2026-08-14", reminder: { at, firedAt: 111 }, repeat: { kind: "minutely", interval: 30 } });
    expect(r.reminder).toEqual({ at: at + 30 * 60_000, firedAt: undefined });
    expect(r.dueDate).toBe("2026-08-14");
  });
  it("每 2 小时：提醒时刻 +2 小时", () => {
    const at = new Date(2026, 7, 14, 9, 0, 0, 0).getTime();
    const r = rollRepeat({ reminder: { at }, repeat: { kind: "hourly", interval: 2 } });
    expect(r.reminder?.at).toBe(at + 2 * 3_600_000);
  });
  it("分/时但无提醒 → 不产出 reminder，且 canRoll 为假（有提醒才可滚）", () => {
    const r = rollRepeat({ dueDate: "2026-08-14", repeat: { kind: "hourly" } });
    expect(r.reminder).toBeUndefined();
    expect(canRoll({ dueDate: "2026-08-14", repeat: { kind: "hourly" } })).toBe(false);
    expect(canRoll({ reminder: { at: 1 }, repeat: { kind: "hourly" } })).toBe(true);
  });
});

describe("rollRepeat · 日期类重复的提醒顺延与 defer/due 提前量", () => {
  it("每天 + 提醒：提醒随日期平移一天、清 firedAt（否则重复任务只响一次）", () => {
    const at = new Date(2026, 6, 1, 9, 0, 0, 0).getTime(); // 2026-07-01 09:00 本地
    const r = rollRepeat({ dueDate: "2026-07-01", reminder: { at, firedAt: 5 }, repeat: { kind: "daily" } });
    expect(r.dueDate).toBe("2026-07-02");
    expect(r.reminder).toEqual({ at: new Date(2026, 6, 2, 9, 0, 0, 0).getTime(), firedAt: undefined });
  });
  it("每天无提醒 → 不产出 reminder（不凭空造提醒）", () => {
    expect(rollRepeat({ dueDate: "2026-07-01", repeat: { kind: "daily" } }).reminder).toBeUndefined();
  });
  it("自定每周一 + defer/due：以 due 位移平移 defer，保持 2 天提前量不塌缩", () => {
    // defer 周日 07-05、due 周二 07-07；自定每周一：due→07-13(下周一,+6)，defer 同平移 +6 → 07-11。
    const r = rollRepeat({
      deferDate: "2026-07-05",
      dueDate: "2026-07-07",
      repeat: { kind: "weekly", custom: true, weekdays: [1] },
    });
    expect(r.dueDate).toBe("2026-07-13");
    expect(r.deferDate).toBe("2026-07-11");
  });
});
