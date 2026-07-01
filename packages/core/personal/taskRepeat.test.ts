import { describe, it, expect } from "vitest";
import { computeNextOccurrence, rollRepeat, canRoll } from "./taskRepeat";

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
