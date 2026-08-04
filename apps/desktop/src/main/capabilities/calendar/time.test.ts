// 时间解析纯函数单测。这层的错误全是「差几小时 / 差一天」的静默偏移 —— 不报错，
// 只让模型自信地报出错误答案，所以三类边界（纯日期、DST、时区偏移）各留回归锁。

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  formatLocal,
  localTimeZone,
  parseTimeInput,
  resolveWindow,
  validateWindow,
} from "./time";

afterEach(() => {
  vi.useRealTimers();
});

describe("parseTimeInput — 三种形态的语义契约", () => {
  it("带 Z 偏移：按 UTC，与本机时区无关", () => {
    const r = parseTimeInput("2026-08-04T06:00:00Z");
    expect(r.ok && r.ms).toBe(Date.UTC(2026, 7, 4, 6, 0, 0));
  });

  it("带 +08:00 偏移：按给定偏移", () => {
    const r = parseTimeInput("2026-08-04T14:00:00+08:00");
    expect(r.ok && r.ms).toBe(Date.UTC(2026, 7, 4, 6, 0, 0));
  });

  it("紧凑偏移 +0800 同样接受", () => {
    expect(parseTimeInput("2026-08-04T14:00+0800")).toEqual(parseTimeInput("2026-08-04T14:00+08:00"));
  });

  it("无偏移的日期时间：按本机本地时区", () => {
    const r = parseTimeInput("2026-08-04T14:00");
    expect(r.ok && r.ms).toBe(new Date(2026, 7, 4, 14, 0, 0, 0).getTime());
  });

  it("空格分隔符等价于 T", () => {
    expect(parseTimeInput("2026-08-04 14:00")).toEqual(parseTimeInput("2026-08-04T14:00"));
  });

  it("秒与小数秒可选", () => {
    const a = parseTimeInput("2026-08-04T14:00:30");
    expect(a.ok && a.ms).toBe(new Date(2026, 7, 4, 14, 0, 30, 0).getTime());
    expect(parseTimeInput("2026-08-04T14:00:30.500")).toEqual(a);
  });
});

// ⚠️ 本组是「不许改回 Date.parse」的回归锁。
// ES 规范里 Date.parse("2026-08-04") 按 UTC、Date.parse("2026-08-04T00:00") 按本地时区，
// 在 UTC+8 下两者差 8 小时；用 Date.parse 实现会让「查 8 月 4 日的日程」实际查到 8 月 3 日。
describe("parseTimeInput — 纯日期按本地时区的当日边界（回归锁）", () => {
  it("start 边界 = 本地当日 00:00:00.000，与显式写 T00:00 完全一致", () => {
    const dateOnly = parseTimeInput("2026-08-04", "start");
    const explicit = parseTimeInput("2026-08-04T00:00");
    expect(dateOnly).toEqual(explicit);
    expect(dateOnly.ok && dateOnly.ms).toBe(new Date(2026, 7, 4, 0, 0, 0, 0).getTime());
  });

  it("start 边界与 Date.parse 的 UTC 解释不同（除非本机就是 UTC）", () => {
    const ours = parseTimeInput("2026-08-04", "start");
    const naive = Date.parse("2026-08-04");
    const offsetMin = new Date(2026, 7, 4).getTimezoneOffset();
    if (offsetMin !== 0) {
      expect(ours.ok && ours.ms).not.toBe(naive);
    }
    // 差值恰好是本机偏移 —— 钉住「我们按本地、Date.parse 按 UTC」这个事实。
    expect(ours.ok && ours.ms).toBe(naive + offsetMin * 60_000);
  });

  it("end 边界 = 本地当日 23:59:59.999（「查 8 月 4 日」应覆盖一整天而非零长度窗口）", () => {
    const r = parseTimeInput("2026-08-04", "end");
    expect(r.ok && r.ms).toBe(new Date(2026, 7, 4, 23, 59, 59, 999).getTime());
  });
});

describe("parseTimeInput — DST 边界不抛异常", () => {
  it("春季空洞时刻（本地不存在）被规范化而非报错", () => {
    const r = parseTimeInput("2026-03-08T02:30");
    expect(r.ok).toBe(true);
    expect(r.ok && Number.isFinite(r.ms)).toBe(true);
  });

  it("秋季重复时刻给出确定结果", () => {
    const r = parseTimeInput("2026-11-01T01:30");
    expect(r.ok).toBe(true);
    expect(r.ok && Number.isFinite(r.ms)).toBe(true);
  });
});

describe("parseTimeInput — 拒绝无法可靠解析的输入", () => {
  it.each([
    ["空串", ""],
    ["自然语言", "明天下午三点"],
    ["epoch 毫秒", "1786000000000"],
    ["美式日期", "08/04/2026"],
    ["只有时间", "14:00"],
    ["月份越界", "2026-13-04T10:00"],
    ["小时越界", "2026-08-04T25:00"],
  ])("%s → 明确报错并给出正确写法", (_n, input) => {
    const r = parseTimeInput(input);
    expect(r.ok).toBe(false);
  });

  // Date 构造函数对越界分量是**静默滚动**而非报错：new Date(2026,12,4) → 2027 年 1 月、
  // new Date(2026,1,31) → 3 月。模型偶尔会给出这类日期，滚过去之后查到的是完全不同的时段，
  // 而它会照常把结果汇报给用户。故必须显式判域。
  it.each([
    ["2026-13-04", "月份 13 不能滚到次年 1 月"],
    ["2026-02-30", "2 月 30 日不能滚到 3 月"],
    ["2026-04-31", "4 月 31 日不能滚到 5 月"],
    ["2026-00-10", "月份 0 非法"],
  ])("%s 被拒（%s）", (input) => {
    expect(parseTimeInput(input).ok).toBe(false);
    expect(parseTimeInput(`${input}T10:00`).ok).toBe(false);
  });

  it("闰年 2 月 29 日正常接受", () => {
    expect(parseTimeInput("2028-02-29").ok).toBe(true);
    expect(parseTimeInput("2026-02-29").ok).toBe(false); // 2026 非闰年
  });

  it("错误文案里给出三种可用写法，供模型自我纠正", () => {
    const r = parseTimeInput("明天下午三点");
    expect(!r.ok && r.reason).toContain("2026-08-04T14:00");
    expect(!r.ok && r.reason).toContain("+08:00");
  });
});

describe("validateWindow", () => {
  it("end 必须晚于 start", () => {
    const t = Date.now();
    expect(validateWindow(t, t).ok).toBe(false);
    expect(validateWindow(t, t - 1).ok).toBe(false);
    expect(validateWindow(t, t + 1).ok).toBe(true);
  });

  it(`跨度超过 ${MAX_WINDOW_DAYS} 天被拒（EventKit 对超长窗口会静默返回空）`, () => {
    const t = Date.now();
    expect(validateWindow(t, t + MAX_WINDOW_DAYS * 86_400_000).ok).toBe(true);
    const tooLong = validateWindow(t, t + (MAX_WINDOW_DAYS + 2) * 86_400_000);
    expect(tooLong.ok).toBe(false);
    expect(!tooLong.ok && tooLong.reason).toContain(String(MAX_WINDOW_DAYS));
  });
});

describe("resolveWindow — 默认窗口", () => {
  it("两个参数都省略 → 现在起 7 天", () => {
    const now = new Date(2026, 7, 4, 10, 0, 0).getTime();
    const r = resolveWindow(undefined, undefined, now);
    expect(r.ok && r.startMs).toBe(now);
    expect(r.ok && r.endMs).toBe(now + DEFAULT_WINDOW_DAYS * 86_400_000);
  });

  it("只给 start → 自该时刻起 7 天", () => {
    const now = Date.now();
    const r = resolveWindow("2026-08-04T09:00", undefined, now);
    const start = new Date(2026, 7, 4, 9, 0, 0, 0).getTime();
    expect(r.ok && r.startMs).toBe(start);
    expect(r.ok && r.endMs).toBe(start + DEFAULT_WINDOW_DAYS * 86_400_000);
  });

  it("只给纯日期的 start 与 end → 覆盖整段日期区间", () => {
    const r = resolveWindow("2026-08-04", "2026-08-05", Date.now());
    expect(r.ok && r.startMs).toBe(new Date(2026, 7, 4, 0, 0, 0, 0).getTime());
    expect(r.ok && r.endMs).toBe(new Date(2026, 7, 5, 23, 59, 59, 999).getTime());
  });

  it("参数有误时指明是 start 还是 end 出的问题", () => {
    const r1 = resolveWindow("明天", undefined, Date.now());
    expect(!r1.ok && r1.reason).toContain("start");
    const r2 = resolveWindow("2026-08-04", "下周", Date.now());
    expect(!r2.ok && r2.reason).toContain("end");
  });
});

describe("formatLocal", () => {
  it("输出带本机偏移的 ISO，而非 UTC 的 Z 结尾", () => {
    const ms = new Date(2026, 7, 4, 14, 30, 5).getTime();
    const s = formatLocal(ms);
    expect(s).toMatch(/^2026-08-04T14:30:05(Z|[+-]\d{2}:\d{2})$/);
  });

  it("与 parseTimeInput 往返一致", () => {
    const ms = new Date(2026, 7, 4, 14, 30, 5).getTime();
    const back = parseTimeInput(formatLocal(ms));
    expect(back.ok && back.ms).toBe(ms);
  });
});

describe("localTimeZone", () => {
  it("返回非空 IANA 标识", () => {
    expect(localTimeZone().length).toBeGreaterThan(0);
  });
});
