// 定时参数解析纯函数单测。这层的错误全都会变成「任务在错误的时刻触发」，
// 且要等用户发现某天没收到才暴露，故对缺字段/越界/歧义格式各留一条断言。

import { describe, expect, it } from "vitest";
import { buildScheduleSpec, describeSchedule, touchesSchedule } from "./schedule-input";

describe("buildScheduleSpec — 六种 kind 的正常路径", () => {
  it("hourly", () => {
    expect(buildScheduleSpec({ schedule_kind: "hourly", minute: 30 })).toEqual({
      ok: true,
      spec: { kind: "hourly", minute: 30 },
    });
  });

  it("daily", () => {
    expect(buildScheduleSpec({ schedule_kind: "daily", hour: 9, minute: 0 })).toEqual({
      ok: true,
      spec: { kind: "daily", hour: 9, minute: 0 },
    });
  });

  it("weekdays", () => {
    expect(buildScheduleSpec({ schedule_kind: "weekdays", hour: 18, minute: 30 })).toEqual({
      ok: true,
      spec: { kind: "weekdays", hour: 18, minute: 30 },
    });
  });

  it("weekly（weekday 0=周日）", () => {
    expect(buildScheduleSpec({ schedule_kind: "weekly", weekday: 0, hour: 10, minute: 0 })).toEqual({
      ok: true,
      spec: { kind: "weekly", weekday: 0, hour: 10, minute: 0 },
    });
  });

  it("cron（前后空白被裁掉）", () => {
    expect(buildScheduleSpec({ schedule_kind: "cron", cron_expression: "  0 9-19/2 * * 1-5 " })).toEqual({
      ok: true,
      spec: { kind: "cron", expression: "0 9-19/2 * * 1-5" },
    });
  });

  it("once（不带时区 → 按本机时区解释）", () => {
    const r = buildScheduleSpec({ schedule_kind: "once", at: "2026-08-05T09:00" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.spec).toEqual({ kind: "once", at: new Date(2026, 7, 5, 9, 0, 0, 0).getTime() });
  });

  it("once（带时区偏移 → 按给定偏移，与本机无关）", () => {
    const r = buildScheduleSpec({ schedule_kind: "once", at: "2026-08-05T09:00:00+08:00" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.spec).toEqual({ kind: "once", at: Date.UTC(2026, 7, 5, 1, 0, 0) });
  });
});

describe("buildScheduleSpec — 缺字段", () => {
  it.each([
    ["hourly 缺 minute", { schedule_kind: "hourly" }, /minute/],
    ["daily 缺 hour", { schedule_kind: "daily", minute: 0 }, /hour/],
    ["weekdays 缺 minute", { schedule_kind: "weekdays", hour: 9 }, /minute/],
    ["weekly 缺 weekday", { schedule_kind: "weekly", hour: 9, minute: 0 }, /weekday/],
    ["cron 缺表达式", { schedule_kind: "cron" }, /cron_expression/],
    ["once 缺 at", { schedule_kind: "once" }, /at/],
  ])("%s → 明确报出缺哪个字段", (_name, args, pattern) => {
    const r = buildScheduleSpec(args);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(pattern);
  });

  it("schedule_kind 缺失或非法 → 列出全部合法取值", () => {
    const r = buildScheduleSpec({});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("hourly");
    expect(!r.ok && r.error).toContain("once");
    expect(buildScheduleSpec({ schedule_kind: "每天" }).ok).toBe(false);
  });
});

describe("buildScheduleSpec — 越界（复用 IPC 路径同一个把关函数）", () => {
  it.each([
    ["minute=60", { schedule_kind: "hourly", minute: 60 }, /分钟/],
    ["hour=24", { schedule_kind: "daily", hour: 24, minute: 0 }, /小时/],
    ["weekday=7", { schedule_kind: "weekly", weekday: 7, hour: 9, minute: 0 }, /星期/],
  ])("%s → 中文越界文案", (_name, args, pattern) => {
    const r = buildScheduleSpec(args);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(pattern);
  });

  it("非法 cron 表达式被 croner 拒掉", () => {
    expect(buildScheduleSpec({ schedule_kind: "cron", cron_expression: "不是 cron" }).ok).toBe(false);
  });
});

describe("buildScheduleSpec — at 的格式护栏", () => {
  it("自然语言时间被明确拒绝（而非静默解析成 NaN 或 1970）", () => {
    const r = buildScheduleSpec({ schedule_kind: "once", at: "明天早上九点" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("2026-08-05T09:00");
  });

  it("纯日期被拒：ES 规范里纯日期按 UTC、带时刻按本地，同一函数两种基准", () => {
    const r = buildScheduleSpec({ schedule_kind: "once", at: "2026-08-05" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/必须含时分/);
  });

  it("epoch 毫秒数字串被拒（模型算时间戳错误率高，错了就是 1970 年触发）", () => {
    expect(buildScheduleSpec({ schedule_kind: "once", at: "1786000000000" }).ok).toBe(false);
  });

  it("空格分隔符被归一成 T", () => {
    const r = buildScheduleSpec({ schedule_kind: "once", at: "2026-08-05 09:00" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.spec).toEqual({ kind: "once", at: new Date(2026, 7, 5, 9, 0, 0, 0).getTime() });
  });
});

describe("describeSchedule", () => {
  it.each([
    [{ kind: "hourly", minute: 5 } as const, "每小时第 5 分"],
    [{ kind: "daily", hour: 9, minute: 0 } as const, "每天 09:00"],
    [{ kind: "weekdays", hour: 18, minute: 30 } as const, "工作日 18:30"],
    [{ kind: "weekly", weekday: 5, hour: 18, minute: 0 } as const, "每周五 18:00"],
    [{ kind: "weekly", weekday: 0, hour: 10, minute: 0 } as const, "每周日 10:00"],
    [{ kind: "cron", expression: "0 9 * * 1" } as const, "自定义 cron：0 9 * * 1"],
  ])("%o → %s", (spec, expected) => {
    expect(describeSchedule(spec)).toBe(expected);
  });

  it("once 输出本地可读时刻", () => {
    expect(describeSchedule({ kind: "once", at: new Date(2026, 7, 5, 9, 0).getTime() })).toContain("一次性");
  });
});

describe("touchesSchedule（决定 update 时是否强制要求给全定时字段）", () => {
  it("只改名字 → false", () => {
    expect(touchesSchedule({})).toBe(false);
  });

  it.each([
    ["schedule_kind", { schedule_kind: "daily" }],
    ["只给 hour", { hour: 8 }],
    ["只给 at", { at: "2026-08-05T09:00" }],
  ])("碰了 %s → true（半套字段合出来的时刻多半不是用户想要的）", (_n, args) => {
    expect(touchesSchedule(args)).toBe(true);
  });
});
