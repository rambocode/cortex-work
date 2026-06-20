// schedule-cron 纯函数单测：ScheduleSpec↔cron 映射、数值域校验、cron 校验、
// nextRun 计算（固定 UTC 锚点确保确定性,不依赖运行时时区/当前时间）。

import { describe, expect, it } from "vitest";
import {
  computeNextRun,
  scheduleToCron,
  validateCron,
  validateScheduleSpec,
} from "./schedule-cron";

const TZ = "UTC";
const AFTER = new Date("2026-01-05T00:00:00Z"); // 2026-01-05 是周一 00:00 UTC

describe("scheduleToCron", () => {
  it("hourly → 指定分钟,每小时", () => {
    expect(scheduleToCron({ kind: "hourly", minute: 15 })).toBe("15 * * * *");
  });
  it("daily → 每天 hh:mm", () => {
    expect(scheduleToCron({ kind: "daily", hour: 9, minute: 30 })).toBe("30 9 * * *");
  });
  it("weekdays → 周一至周五 1-5", () => {
    expect(scheduleToCron({ kind: "weekdays", hour: 7, minute: 0 })).toBe("0 7 * * 1-5");
  });
  it("weekly → 指定周几（0=周日）", () => {
    expect(scheduleToCron({ kind: "weekly", weekday: 3, hour: 8, minute: 0 })).toBe("0 8 * * 3");
    expect(scheduleToCron({ kind: "weekly", weekday: 0, hour: 8, minute: 0 })).toBe("0 8 * * 0");
  });
  it("cron → 原样（去首尾空白）", () => {
    expect(scheduleToCron({ kind: "cron", expression: "  */5 * * * *  " })).toBe("*/5 * * * *");
  });
  it("once → 无 cron 表示,抛错（调用方须单独分支）", () => {
    expect(() => scheduleToCron({ kind: "once", at: AFTER.getTime() })).toThrow();
  });
});

describe("validateScheduleSpec", () => {
  it("合法值通过", () => {
    expect(validateScheduleSpec({ kind: "hourly", minute: 0 }).ok).toBe(true);
    expect(validateScheduleSpec({ kind: "daily", hour: 23, minute: 59 }).ok).toBe(true);
    expect(validateScheduleSpec({ kind: "weekly", weekday: 6, hour: 0, minute: 0 }).ok).toBe(true);
  });
  it("分钟越界被拒", () => {
    expect(validateScheduleSpec({ kind: "hourly", minute: 60 }).ok).toBe(false);
    expect(validateScheduleSpec({ kind: "hourly", minute: -1 }).ok).toBe(false);
  });
  it("小时越界被拒", () => {
    expect(validateScheduleSpec({ kind: "daily", hour: 24, minute: 0 }).ok).toBe(false);
  });
  it("星期越界被拒", () => {
    expect(validateScheduleSpec({ kind: "weekly", weekday: 7, hour: 0, minute: 0 }).ok).toBe(false);
  });
  it("非整数被拒", () => {
    expect(validateScheduleSpec({ kind: "daily", hour: 9.5, minute: 0 }).ok).toBe(false);
  });
  it("空 cron 被拒,非法 cron 被拒,合法 cron 通过", () => {
    expect(validateScheduleSpec({ kind: "cron", expression: "" }).ok).toBe(false);
    expect(validateScheduleSpec({ kind: "cron", expression: "99 99 99 99 99" }).ok).toBe(false);
    expect(validateScheduleSpec({ kind: "cron", expression: "*/5 * * * *" }).ok).toBe(true);
  });
  it("once: 有限 at 通过,NaN/Infinity 被拒（不强制 future）", () => {
    expect(validateScheduleSpec({ kind: "once", at: AFTER.getTime() }).ok).toBe(true);
    expect(validateScheduleSpec({ kind: "once", at: 0 }).ok).toBe(true); // 过去也算合法,future 交给 UI
    expect(validateScheduleSpec({ kind: "once", at: NaN }).ok).toBe(false);
    expect(validateScheduleSpec({ kind: "once", at: Infinity }).ok).toBe(false);
  });
});

describe("validateCron", () => {
  it("合法表达式返回 ok + nextRun", () => {
    const v = validateCron("*/5 * * * *", TZ);
    expect(v.ok).toBe(true);
    expect(typeof v.nextRun).toBe("number");
  });
  it("非法表达式返回 ok:false + error", () => {
    const v = validateCron("99 99 99 99 99");
    expect(v.ok).toBe(false);
    expect(v.error).toBeTruthy();
  });
  it("空表达式被拒", () => {
    expect(validateCron("   ").ok).toBe(false);
  });
});

describe("computeNextRun（UTC 锚点 2026-01-05 周一 00:00）", () => {
  it("hourly 命中指定分钟且晚于锚点", () => {
    const ts = computeNextRun({ kind: "hourly", minute: 15 }, TZ, AFTER)!;
    expect(ts).toBeGreaterThan(AFTER.getTime());
    expect(new Date(ts).getUTCMinutes()).toBe(15);
  });
  it("daily 命中 hh:mm", () => {
    const ts = computeNextRun({ kind: "daily", hour: 9, minute: 30 }, TZ, AFTER)!;
    const d = new Date(ts);
    expect(d.getUTCHours()).toBe(9);
    expect(d.getUTCMinutes()).toBe(30);
    expect(ts).toBeGreaterThan(AFTER.getTime());
  });
  it("weekly 命中指定周几与时刻", () => {
    const ts = computeNextRun({ kind: "weekly", weekday: 3, hour: 8, minute: 0 }, TZ, AFTER)!;
    const d = new Date(ts);
    expect(d.getUTCDay()).toBe(3); // 周三
    expect(d.getUTCHours()).toBe(8);
    expect(d.getUTCMinutes()).toBe(0);
  });
  it("weekdays 落在周一至周五", () => {
    const ts = computeNextRun({ kind: "weekdays", hour: 7, minute: 0 }, TZ, AFTER)!;
    const day = new Date(ts).getUTCDay();
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(5);
    expect(new Date(ts).getUTCHours()).toBe(7);
  });
  it("非法 cron 返回 null", () => {
    expect(computeNextRun({ kind: "cron", expression: "99 99 99 99 99" }, TZ, AFTER)).toBeNull();
  });
  it("once: at 晚于参考点返回 at,已过/相等返回 null", () => {
    const future = AFTER.getTime() + 60_000;
    expect(computeNextRun({ kind: "once", at: future }, TZ, AFTER)).toBe(future);
    expect(computeNextRun({ kind: "once", at: AFTER.getTime() - 60_000 }, TZ, AFTER)).toBeNull();
    expect(computeNextRun({ kind: "once", at: AFTER.getTime() }, TZ, AFTER)).toBeNull(); // 相等不再触发
  });
});
