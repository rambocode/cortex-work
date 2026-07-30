import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { relTime } from "./PersonalSidebar";

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const ago = (ms: number) => NOW - ms;

  it("周粒度:8 天→1 周、14 天→2 周 (R11)", () => {
    expect(relTime(ago(8 * DAY))).toBe("1 周");
    expect(relTime(ago(14 * DAY))).toBe("2 周");
  });

  it("6 天仍显示天,不进周粒度", () => {
    expect(relTime(ago(6 * DAY))).toBe("6 天");
  });

  it("月粒度:35 天→1 个月、70 天→2 个月", () => {
    expect(relTime(ago(35 * DAY))).toBe("1 个月");
    expect(relTime(ago(70 * DAY))).toBe("2 个月");
  });

  it("既有粒度回归:刚刚/分钟/小时/天", () => {
    expect(relTime(ago(30_000))).toBe("刚刚");
    expect(relTime(ago(5 * MIN))).toBe("5 分钟");
    expect(relTime(ago(3 * HOUR))).toBe("3 小时");
    expect(relTime(ago(2 * DAY))).toBe("2 天");
  });
});
