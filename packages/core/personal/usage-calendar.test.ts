import { describe, expect, it } from "vitest";
import type { DailyUsagePoint } from "../desktop/types";
import { buildTokenWeeks, tokenHeatLevel } from "./usage-calendar";

// 2026-06-10 是周三（与 home.test.ts 一致）。
const TODAY = new Date(2026, 5, 10, 9, 0, 0).getTime();

describe("tokenHeatLevel", () => {
  it("0 / 负数 → 档位 0", () => {
    expect(tokenHeatLevel(0)).toBe(0);
    expect(tokenHeatLevel(-100)).toBe(0);
  });

  it("各档边界值落到预期档位", () => {
    expect(tokenHeatLevel(1)).toBe(1);
    expect(tokenHeatLevel(50_000)).toBe(1);
    expect(tokenHeatLevel(50_001)).toBe(2);
    expect(tokenHeatLevel(200_000)).toBe(2);
    expect(tokenHeatLevel(200_001)).toBe(3);
    expect(tokenHeatLevel(1_000_000)).toBe(3);
    expect(tokenHeatLevel(1_000_001)).toBe(4);
    expect(tokenHeatLevel(9_999_999)).toBe(4);
  });
});

describe("buildTokenWeeks", () => {
  const points: DailyUsagePoint[] = [
    { day: "2026-06-08", tokens: 12345, msgs: 3 },
    { day: "2026-06-10", tokens: 600_000, msgs: 9 },
  ];

  it("复用活动日期骨架：26 周 × 7 天，今天所在周为末列", () => {
    const weeks = buildTokenWeeks(26, points, TODAY);
    expect(weeks).toHaveLength(26);
    for (const w of weeks) expect(w.cells).toHaveLength(7);
    const last = weeks.at(-1)!;
    expect(last.cells[0]?.day).toBe("2026-06-08");
    expect(last.cells[6]?.day).toBe("2026-06-14");
  });

  it("把每日 token 覆盖进对应 cell，命中正确日", () => {
    const cells = buildTokenWeeks(26, points, TODAY).flatMap((w) => w.cells);
    expect(cells.find((c) => c.day === "2026-06-08")?.tokens).toBe(12345);
    expect(cells.find((c) => c.day === "2026-06-10")?.tokens).toBe(600_000);
  });

  it("缺失天补零（tokens=0）", () => {
    const cells = buildTokenWeeks(26, points, TODAY).flatMap((w) => w.cells);
    expect(cells.find((c) => c.day === "2026-06-09")?.tokens).toBe(0);
  });

  it("空数据：所有格 tokens=0", () => {
    const cells = buildTokenWeeks(4, [], TODAY).flatMap((w) => w.cells);
    expect(cells.every((c) => c.tokens === 0)).toBe(true);
  });
});
