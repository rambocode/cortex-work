// stageTimeline 纯数学表驱动单测：窗口、日宽、条形几何、今日线、周号、双层刻度。
import { describe, expect, it } from "vitest";
import {
  buildDateTicks,
  buildTimelineWindow,
  dayNumber,
  dayNumberOfString,
  dayWidthFor,
  getWeekNumber,
  scrollLeftForToday,
  stageBarGeometry,
  todayMarkerLeft,
} from "./stageTimeline";

// 固定基准日：2026-07-02（周四）。测试不依赖真实时钟。
const TODAY = new Date(2026, 6, 2);

describe("dayWidthFor", () => {
  it("day/week/month → 60/30/12（对齐 IFocus）", () => {
    expect(dayWidthFor("day")).toBe(60);
    expect(dayWidthFor("week")).toBe(30);
    expect(dayWidthFor("month")).toBe(12);
  });
});

describe("dayNumber / dayNumberOfString", () => {
  it("字符串与 Date 折算一致", () => {
    expect(dayNumberOfString("2026-07-02")).toBe(dayNumber(TODAY));
  });

  it("相邻两天差 1（跨月/跨年也成立）", () => {
    expect(dayNumberOfString("2026-07-01")! - dayNumberOfString("2026-06-30")!).toBe(1);
    expect(dayNumberOfString("2027-01-01")! - dayNumberOfString("2026-12-31")!).toBe(1);
  });

  it("非法输入返回 null", () => {
    expect(dayNumberOfString("not-a-date")).toBeNull();
    expect(dayNumberOfString("2026/07/02")).toBeNull();
    expect(dayNumberOfString("")).toBeNull();
  });
});

describe("buildTimelineWindow", () => {
  it("默认前 14 后 28，共 43 天，今天下标 14", () => {
    const w = buildTimelineWindow(TODAY);
    expect(w.totalDays).toBe(43);
    expect(w.todayOffset).toBe(14);
    expect(w.startDayNumber).toBe(dayNumber(TODAY) - 14);
  });
});

describe("stageBarGeometry", () => {
  const w = buildTimelineWindow(TODAY); // 窗口首日 = 2026-06-18

  it("单日阶段：宽度 = 1 × dayWidth", () => {
    expect(stageBarGeometry("2026-07-02", "2026-07-02", w, 30)).toEqual({ left: 14 * 30, width: 30 });
  });

  it("跨日阶段：含首尾天数（7/1~7/3 = 3 天）", () => {
    expect(stageBarGeometry("2026-07-01", "2026-07-03", w, 30)).toEqual({ left: 13 * 30, width: 3 * 30 });
  });

  it("窗口首日起始的阶段 left = 0", () => {
    expect(stageBarGeometry("2026-06-18", "2026-06-20", w, 12)!.left).toBe(0);
  });

  it("早于窗口的起始日允许负 left（条形被裁剪在容器外）", () => {
    expect(stageBarGeometry("2026-06-17", "2026-06-19", w, 30)!.left).toBe(-30);
  });

  it("due 早于 start（脏数据）按单日兜底", () => {
    expect(stageBarGeometry("2026-07-03", "2026-07-01", w, 30)!.width).toBe(30);
  });

  it("任一日期非法 → null（不画条）", () => {
    expect(stageBarGeometry("bad", "2026-07-02", w, 30)).toBeNull();
    expect(stageBarGeometry("2026-07-02", "bad", w, 30)).toBeNull();
  });
});

describe("todayMarkerLeft / scrollLeftForToday", () => {
  const w = buildTimelineWindow(TODAY);

  it("今日线落在当天格子中点", () => {
    expect(todayMarkerLeft(w, 30)).toBe(14 * 30 + 15);
  });

  it("「今天」滚动 = 今日线 − 视口一半，且不为负", () => {
    expect(scrollLeftForToday(w, 30, 600)).toBe(14 * 30 + 15 - 300);
    expect(scrollLeftForToday(w, 12, 10_000)).toBe(0);
  });
});

describe("getWeekNumber", () => {
  it.each<[string, number]>([
    ["2026-01-01", 1], // 元旦所在周恒为第 1 周
    ["2026-07-02", 27], // 与 IFocus 截图「7月 第27周」一致
    ["2026-06-24", 26],
    ["2026-12-31", 53],
  ])("%s → 第%i周", (s, expected) => {
    const [y = 0, m = 1, d = 1] = s.split("-").map(Number);
    expect(getWeekNumber(new Date(y, m - 1, d))).toBe(expected);
  });
});

describe("buildDateTicks", () => {
  const w = buildTimelineWindow(TODAY);

  it("三种粒度 groups/subs 的天数合计都等于窗口总天数", () => {
    for (const g of ["day", "week", "month"] as const) {
      const ticks = buildDateTicks(w, g);
      expect(ticks.groups.reduce((s, x) => s + x.days, 0)).toBe(w.totalDays);
      expect(ticks.subs.reduce((s, x) => s + x.days, 0)).toBe(w.totalDays);
      expect(ticks.cells).toHaveLength(w.totalDays);
    }
  });

  it("day 粒度：主表头逐日「M/D 周X」", () => {
    const ticks = buildDateTicks(w, "day");
    expect(ticks.groups[w.todayOffset]!.label).toBe("7/2 周四");
    expect(ticks.groups.every((x) => x.days === 1)).toBe(true);
  });

  it("week 粒度：从窗口首日起每 7 天一段（对齐 IFocus 截图 18-24/25-1/2-8）、子表头逐日数字", () => {
    const ticks = buildDateTicks(w, "week");
    // 窗口首日 2026-06-18：段序列 = 6/18-24（第25周）、6/25-7/1（第26周）、7/2-8（第27周）…
    expect(ticks.groups.slice(0, 3).map((x) => x.label)).toEqual(["6月 第25周", "6月 第26周", "7月 第27周"]);
    expect(ticks.groups.slice(0, 3).every((x) => x.days === 7)).toBe(true);
    expect(ticks.subs[w.todayOffset]).toEqual({ label: "2", days: 1, isToday: true });
  });

  it("month 粒度：主表头「YYYY年M月」按 1 号分段、子表头逐周 W 号", () => {
    const ticks = buildDateTicks(w, "month");
    expect(ticks.groups.map((x) => x.label)).toEqual(["2026年6月", "2026年7月"]);
    expect(ticks.groups[0]!.days).toBe(13); // 6/18 ~ 6/30
    expect(ticks.subs.some((x) => x.label === "W27" && x.isToday)).toBe(true);
  });

  it("cells 标记今天与周末", () => {
    const ticks = buildDateTicks(w, "week");
    expect(ticks.cells[w.todayOffset]!.isToday).toBe(true);
    // 2026-06-20 是周六（窗口第 2 格）。
    expect(ticks.cells[2]!.isWeekend).toBe(true);
    expect(ticks.cells[w.todayOffset]!.isWeekend).toBe(false);
  });
});
