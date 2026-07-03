// 日历空闲段行为契约测试。核心断言移植自 ReplyClone ReplyCoreTests.swift，
// 时区固定 UTC 保证确定性；另补 8 段截断与空摘要用例（对应 U1 计划场景）。

import { describe, expect, it } from "vitest";
import {
  availabilityContext,
  freeSlots,
  slotDurationMinutes,
  summarizeSlots,
  type BusyEvent,
} from "./calendar-slots";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// 2026-07-02 09:00 UTC 作为窗口起点
const DAY9 = Date.UTC(2026, 6, 2, 9, 0, 0);

describe("freeSlots / summarizeSlots", () => {
  it("扣除忙碌区间后切出 [30,60,90] 分钟空闲段，摘要含 09:00-09:30", () => {
    const events: BusyEvent[] = [
      { start: DAY9 + 30 * MIN, end: DAY9 + 60 * MIN, title: "Standup" },
      { start: DAY9 + 120 * MIN, end: DAY9 + 150 * MIN, title: "Review" },
    ];
    const slots = freeSlots({ start: DAY9, end: DAY9 + 4 * HOUR }, events, 30 * MIN);
    expect(slots.map(slotDurationMinutes)).toEqual([30, 60, 90]);
    expect(summarizeSlots(slots, "UTC")).toContain("09:00-09:30");
  });

  it("无空闲段 → 空摘要", () => {
    const events: BusyEvent[] = [{ start: DAY9, end: DAY9 + 4 * HOUR, title: "Blocked" }];
    const slots = freeSlots({ start: DAY9, end: DAY9 + 4 * HOUR }, events, 30 * MIN);
    expect(slots).toEqual([]);
    expect(summarizeSlots(slots, "UTC")).toBe("");
  });

  it("重叠忙碌区间合并后再算空闲", () => {
    const events: BusyEvent[] = [
      { start: DAY9 + 30 * MIN, end: DAY9 + 90 * MIN, title: "A" },
      { start: DAY9 + 60 * MIN, end: DAY9 + 120 * MIN, title: "B" },
    ];
    const slots = freeSlots({ start: DAY9, end: DAY9 + 4 * HOUR }, events, 30 * MIN);
    // 合并 09:30-11:00 → 空闲 09:00-09:30、11:00-13:00
    expect(slots.map(slotDurationMinutes)).toEqual([30, 120]);
  });
});

describe("availabilityContext", () => {
  it("加「可用时间：」前缀", () => {
    const events: BusyEvent[] = [{ start: DAY9 + 30 * MIN, end: DAY9 + 60 * MIN, title: "S" }];
    const context = availabilityContext({ start: DAY9, end: DAY9 + 2 * HOUR }, events, {
      timeZone: "UTC",
    });
    expect(context.startsWith("可用时间：")).toBe(true);
    expect(context).toContain("09:00-09:30");
  });

  it("空闲段 >8 时截断为 8", () => {
    // 09:00-18:00 窗口内，每小时插一段 30 分钟忙碌 → 产生 9 段空闲，应截断到 8
    const events: BusyEvent[] = [];
    for (let h = 10; h <= 17; h += 1) {
      events.push({ start: DAY9 + (h - 9) * HOUR, end: DAY9 + (h - 9) * HOUR + 30 * MIN, title: `E${h}` });
    }
    const window = { start: DAY9, end: DAY9 + 9 * HOUR };
    expect(freeSlots(window, events, 30 * MIN)).toHaveLength(9);
    const context = availabilityContext(window, events, { timeZone: "UTC" });
    const segments = context.slice("可用时间：".length).split(", ");
    expect(segments).toHaveLength(8);
  });

  it("无空闲段 → 空串（prompt 侧静默跳段）", () => {
    const events: BusyEvent[] = [{ start: DAY9, end: DAY9 + 2 * HOUR, title: "Blocked" }];
    expect(availabilityContext({ start: DAY9, end: DAY9 + 2 * HOUR }, events, { timeZone: "UTC" })).toBe("");
  });
});
