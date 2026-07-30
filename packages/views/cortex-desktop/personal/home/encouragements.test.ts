import { describe, it, expect } from "vitest";
import { pickEncouragement, slotOf } from "./encouragements";

describe("encouragements", () => {
  it("slotOf 按小时分档", () => {
    expect(slotOf(2)).toBe("lateNight");
    expect(slotOf(7)).toBe("earlyMorning");
    expect(slotOf(10)).toBe("morning");
    expect(slotOf(13)).toBe("noon");
    expect(slotOf(16)).toBe("afternoon");
    expect(slotOf(21)).toBe("evening");
  });

  it("pickEncouragement 同一天同一时段确定性稳定", () => {
    const a = pickEncouragement(new Date("2026-06-19T10:00:00"));
    const b = pickEncouragement(new Date("2026-06-19T11:30:00")); // 同为 morning 档、同一天
    expect(a).toEqual(b);
    expect(a.title.length).toBeGreaterThan(0);
    expect(a.sub.length).toBeGreaterThan(0);
  });

  it("pickEncouragement 跨天可变化（不同 dayKey 走不同索引）", () => {
    // 取同一时段、跨多天,至少出现两种不同文案,证明按天轮换生效。
    const titles = new Set<string>();
    for (let d = 1; d <= 9; d++) {
      const day = String(d).padStart(2, "0");
      titles.add(pickEncouragement(new Date(`2026-06-${day}T10:00:00`)).title);
    }
    expect(titles.size).toBeGreaterThan(1);
  });
});
