// 阶段 timeline（甘特图）纯数学（参照 IFocus Timeline 组件）：时间窗口、日宽、条形定位、
// 今日线、双层日期刻度。全部以「本地日历日序号」计算——先取 y/m/d 再经 Date.UTC 折算天数，
// 天数差与 DST/时区偏移无关（直接毫秒差在夏令时切换日会差 1 小时导致 floor 错位）。
// 命名 stageTimeline 避让已被「项目活动时间线」占用的 timeline.ts。
// 纯函数无 IO，表驱动单测见 stageTimeline.test.ts。

export type TimelineGranularity = "day" | "week" | "month";

// 粒度 → 每天像素宽（对齐 IFocus：day 60 / week 30 / month 12）。
export function dayWidthFor(g: TimelineGranularity): number {
  return g === "day" ? 60 : g === "week" ? 30 : 12;
}

// 本地日历日序号（自 epoch 起的天数）：由本地 y/m/d 折算，DST 安全。
export function dayNumber(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

// 解析 YYYY-MM-DD（任务/阶段日期的存储格式）为本地日历日序号；非法输入返回 null。
export function dayNumberOfString(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

// 时间窗口：固定「今天前 before 天 ~ 后 after 天」（对齐 IFocus 前14/后28），含首尾共 before+after+1 天。
export interface TimelineWindow {
  startDayNumber: number; // 窗口首日的日历日序号
  totalDays: number;
  todayOffset: number; // 今天在窗口内的下标（= before）
}
export function buildTimelineWindow(today: Date, before = 14, after = 28): TimelineWindow {
  return { startDayNumber: dayNumber(today) - before, totalDays: before + after + 1, todayOffset: before };
}

// 阶段条形定位：left = 起始日距窗口首日的天数 × dayWidth；width = 含首尾天数 × dayWidth。
// due 早于 start（脏数据）按单日兜底；任一日期非法返回 null（该阶段不画条）。
export function stageBarGeometry(
  startDate: string,
  dueDate: string,
  window: TimelineWindow,
  dayWidth: number,
): { left: number; width: number } | null {
  const start = dayNumberOfString(startDate);
  const due = dayNumberOfString(dueDate);
  if (start === null || due === null) return null;
  const duration = Math.max(due - start + 1, 1);
  return { left: (start - window.startDayNumber) * dayWidth, width: duration * dayWidth };
}

// 今日竖线横向位置：落在当天格子中点（对齐 IFocus TodayMarker）。
export function todayMarkerLeft(window: TimelineWindow, dayWidth: number): number {
  return window.todayOffset * dayWidth + dayWidth / 2;
}

// 「今天」按钮的目标 scrollLeft：把今日线滚到视口水平中央（不为负）。
export function scrollLeftForToday(window: TimelineWindow, dayWidth: number, viewportWidth: number): number {
  return Math.max(0, todayMarkerLeft(window, dayWidth) - viewportWidth / 2);
}

// 年内周号（对齐 IFocus getWeekNumber）：以 1月1日 所在周为第 1 周、周日为一周首日。
export function getWeekNumber(d: Date): number {
  const firstDay = new Date(d.getFullYear(), 0, 1);
  const days = dayNumber(d) - dayNumber(firstDay);
  return Math.ceil((days + firstDay.getDay() + 1) / 7);
}

// ── 双层日期刻度 ─────────────────────────────────────────────────────────────
// groups = 主表头（day: "M/D 周X" 每日一格；week: "M月 第N周" 每周一格；month: "YYYY年M月" 每月一格）；
// subs   = 子表头（day/week: 日期数字逐日；month: "W周号" 逐周）；
// cells  = 逐日单元（网格底色用：今天/周末），三种粒度都按天定位。
export interface TimelineTickGroup {
  label: string;
  days: number; // 该格横跨的天数（渲染宽度 = days × dayWidth）
}
export interface TimelineSubTick {
  label: string;
  days: number;
  isToday: boolean;
}
export interface TimelineDayCell {
  dayOfMonth: number;
  isToday: boolean;
  isWeekend: boolean;
}
export interface TimelineTicks {
  groups: TimelineTickGroup[];
  subs: TimelineSubTick[];
  cells: TimelineDayCell[];
}

const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"];

// 日历日序号 → 本地 Date（窗口内逐日枚举用；取本地正午避免任何边界歧义后再读 y/m/d 也可，
// 这里直接用 UTC 毫秒还原 y/m/d——序号本身即由 y/m/d 折算，往返无损）。
function dateOfDayNumber(n: number): Date {
  const utc = new Date(n * 86_400_000);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

export function buildDateTicks(window: TimelineWindow, g: TimelineGranularity): TimelineTicks {
  const cells: TimelineDayCell[] = [];
  const groups: TimelineTickGroup[] = [];
  const subs: TimelineSubTick[] = [];
  // 持有「当前段」引用做累加（而非 groups[groups.length-1]），兼容 noUncheckedIndexedAccess。
  let curGroup: TimelineTickGroup | null = null;
  let curSub: TimelineSubTick | null = null;
  for (let i = 0; i < window.totalDays; i++) {
    const d = dateOfDayNumber(window.startDayNumber + i);
    const isToday = i === window.todayOffset;
    const dow = d.getDay();
    cells.push({ dayOfMonth: d.getDate(), isToday, isWeekend: dow === 0 || dow === 6 });

    // 主表头分组：day 逐日；week 从窗口首日起每 7 天一段（对齐 IFocus——窗口首日 6/18 时
    // 分段为 18-24 / 25-1 / 2-8…，非自然周日分段），段标签取段首日的「M月 第N周」；
    // month 按自然月（1 号）分段。用「与当前段同段则累加天数」实现。
    if (g === "day") {
      groups.push({ label: `${d.getMonth() + 1}/${d.getDate()} 周${WEEKDAY_CN[dow]}`, days: 1 });
    } else if (g === "week") {
      if (i % 7 === 0 || curGroup === null) {
        curGroup = { label: `${d.getMonth() + 1}月 第${getWeekNumber(d)}周`, days: 1 };
        groups.push(curGroup);
      } else {
        curGroup.days += 1;
      }
    } else {
      if (d.getDate() === 1 || curGroup === null) {
        curGroup = { label: `${d.getFullYear()}年${d.getMonth() + 1}月`, days: 1 };
        groups.push(curGroup);
      } else {
        curGroup.days += 1;
      }
    }

    // 子表头：day/week 逐日显示日期数字；month 每 7 天一段显示 "W周号"（分段规则同 week 主表头）。
    if (g === "month") {
      if (i % 7 === 0 || curSub === null) {
        curSub = { label: `W${getWeekNumber(d)}`, days: 1, isToday };
        subs.push(curSub);
      } else {
        curSub.days += 1;
        if (isToday) curSub.isToday = true;
      }
    } else {
      subs.push({ label: String(d.getDate()), days: 1, isToday });
    }
  }
  return { groups, subs, cells };
}
