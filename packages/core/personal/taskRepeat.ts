// 任务重复的日期推进纯逻辑（U12/U14/KTD7）。无 React/IO 依赖，便于表驱动单测。
// 与「到点触发」（U11 调度器）解耦：本模块只算「完成后下一次日期（及提醒时刻）」，不管通知投递。
// 日期一律本地日历日 YYYY-MM-DD（与 dueDate/deferDate 语义一致）。
import type { TaskRepeat, TaskReminder } from "../desktop/tasks-types";

const DAY_MS = 86_400_000;

// 本地日历日格式化（不引 tasks.ts 的 localDay 以保持本模块纯净、不拉入 React Query）。
function fmt(dt: Date): string {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// 周首（周日=0 为一周起点）：把日期归到所在周的周日 0 点，用于按「每 N 周」判活跃周。
function startOfWeek(dt: Date): Date {
  const s = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  s.setDate(s.getDate() - s.getDay());
  return s;
}

// 某月第 N 个 / 最后一个 weekday 的日期；不存在（如第 5 个但当月只有 4 个）→ null。
function nthWeekdayOfMonth(
  year: number,
  month0: number,
  weekday: number,
  ordinal: NonNullable<TaskRepeat["ordinal"]>,
): Date | null {
  if (ordinal === "last") {
    const last = new Date(year, month0 + 1, 0); // 当月最后一天
    const back = (last.getDay() - weekday + 7) % 7;
    return new Date(year, month0, last.getDate() - back);
  }
  const n = Number(ordinal); // "1".."5"
  const first = new Date(year, month0, 1);
  const offset = (weekday - first.getDay() + 7) % 7; // 首个该 weekday 的日
  const day = 1 + offset + (n - 1) * 7;
  const dt = new Date(year, month0, day);
  return dt.getMonth() === month0 ? dt : null; // 溢出到下月 → 当月无第 N 个
}

// 某月内 monthDays 解析出的命中日集合（升序）：数字超出当月天数则丢弃；"last"→当月最后一天。
function resolveMonthDays(year: number, month0: number, monthDays: Array<number | "last">): number[] {
  const lastDay = new Date(year, month0 + 1, 0).getDate();
  const set = new Set<number>();
  for (const md of monthDays) {
    if (md === "last") set.add(lastDay);
    else if (typeof md === "number" && md >= 1 && md <= lastDay) set.add(md);
  }
  return [...set].sort((a, b) => a - b);
}

// weekly 自定：anchor 之后、weekday∈weekdays 且所在周相对 anchor 周为 interval 整数倍的最近一天。
// interval=1 时即「下一个选中的星期几」；interval>1 时只在活跃周（相对 anchor 周整数倍）命中。
function nextCustomWeekly(anchor: Date, weekdays: number[], interval: number): Date {
  const set = new Set(weekdays.filter((w) => Number.isInteger(w) && w >= 0 && w <= 6));
  if (set.size === 0) {
    const dt = new Date(anchor);
    dt.setDate(dt.getDate() + 7 * interval); // 空集合防呆：回退简单每 N 周
    return dt;
  }
  const anchorWeekStart = startOfWeek(anchor).getTime();
  const cand = new Date(anchor);
  for (let i = 0; i < 366; i++) {
    cand.setDate(cand.getDate() + 1);
    if (!set.has(cand.getDay())) continue;
    const days = Math.round((startOfWeek(cand).getTime() - anchorWeekStart) / DAY_MS);
    if ((days / 7) % interval === 0) return cand;
  }
  return cand; // 理论不可达（366 天内必有解）
}

// monthly 自定 · 月中的一天：找 anchor 之后最近的命中日；活跃月 = anchor 月 + k*interval。
function nextCustomMonthlyDay(anchor: Date, monthDays: Array<number | "last">, interval: number): Date {
  let year = anchor.getFullYear();
  let month0 = anchor.getMonth();
  const anchorDay = anchor.getDate();
  for (let k = 0; k < 120; k++) {
    const days = resolveMonthDays(year, month0, monthDays);
    // k=0（anchor 当月）只取 > anchorDay 的日；后续活跃月取最小日。
    const pick = k === 0 ? days.find((dd) => dd > anchorDay) : days[0];
    if (pick != null) return new Date(year, month0, pick);
    month0 += interval;
    year += Math.floor(month0 / 12);
    month0 = ((month0 % 12) + 12) % 12;
  }
  const fb = new Date(anchor); // 兜底（monthDays 全非法）：简单每 interval 月
  fb.setDate(1);
  fb.setMonth(fb.getMonth() + interval);
  return fb;
}

// monthly 自定 · 周中的第 N 个星期几：活跃月 = anchor 月 + k*interval，取该月 (ordinal,weekday) 日，找 > anchor 的最近一个。
function nextCustomMonthlyWeekday(
  anchor: Date,
  ordinal: NonNullable<TaskRepeat["ordinal"]>,
  weekday: number,
  interval: number,
): Date {
  let year = anchor.getFullYear();
  let month0 = anchor.getMonth();
  for (let k = 0; k < 120; k++) {
    const dt = nthWeekdayOfMonth(year, month0, weekday, ordinal);
    if (dt && dt.getTime() > anchor.getTime()) return dt;
    month0 += interval;
    year += Math.floor(month0 / 12);
    month0 = ((month0 % 12) + 12) % 12;
  }
  const fb = new Date(anchor); // 兜底：简单每 interval 月
  fb.setDate(1);
  fb.setMonth(fb.getMonth() + interval);
  return fb;
}

// 给定本地日历日 YYYY-MM-DD + 周期，算下一次日期。
// 自定义分支（custom 且细则有效）优先；否则按 interval 简单顺延（monthly 遇目标月无该日夹到月末）。
export function computeNextOccurrence(dateStr: string, repeat: TaskRepeat): string {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const interval = repeat.interval && repeat.interval > 0 ? repeat.interval : 1;
  const anchor = new Date(y, m - 1, d); // 本地时间构造，避免 UTC 偏移

  // 子日单位（分/时）不移动日历日：时间在 reminder.at 上顺延（见 rollRepeat），日期原样返回。
  if (repeat.kind === "minutely" || repeat.kind === "hourly") return dateStr;

  // ── 自定义（custom=true 且对应细则完整才走；细则缺失/为空回退简单顺延，防呆避免死循环/卡住滚动）──
  if (repeat.custom) {
    if (repeat.kind === "weekly" && repeat.weekdays && repeat.weekdays.length > 0) {
      return fmt(nextCustomWeekly(anchor, repeat.weekdays, interval));
    }
    if (repeat.kind === "monthly" && repeat.monthMode === "weekday" && repeat.ordinal && repeat.weekday != null) {
      return fmt(nextCustomMonthlyWeekday(anchor, repeat.ordinal, repeat.weekday, interval));
    }
    // day 模式为缺省（monthMode!=="weekday" 即视为 day）：与 UI 的 `?? "day"` 对齐，
    // 同时覆盖「切单位遗留 custom 但未落 monthMode」与「agent 直发缺 monthMode」两条路径（review major）。
    if (repeat.kind === "monthly" && repeat.monthMode !== "weekday" && repeat.monthDays && repeat.monthDays.length > 0) {
      return fmt(nextCustomMonthlyDay(anchor, repeat.monthDays, interval));
    }
  }

  // ── 简单顺延（原逻辑）──
  const dt = new Date(y, m - 1, d);
  if (repeat.kind === "daily") {
    dt.setDate(dt.getDate() + interval);
  } else if (repeat.kind === "weekly") {
    dt.setDate(dt.getDate() + 7 * interval);
  } else {
    // monthly：先记目标日，跳到目标月 1 号再夹日，避免 setMonth 在 31 号溢出到下下月。
    const targetDay = dt.getDate();
    dt.setDate(1);
    dt.setMonth(dt.getMonth() + interval);
    const lastDay = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
    dt.setDate(Math.min(targetDay, lastDay));
  }
  return fmt(dt);
}

// 每分钟/小时步长（ms）。
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

// 本地日历日 YYYY-MM-DD → 当日 0 点 epoch ms。
function dateMidnight(s: string): number {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime();
}
// 两个本地日历日相差的整天数（b - a）。
function dayDiff(a: string, b: string): number {
  return Math.round((dateMidnight(b) - dateMidnight(a)) / DAY_MS);
}
// 本地日历日加减 n 天（复用 fmt）。
function shiftDays(s: string, n: number): string {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return fmt(dt);
}
// 提醒时刻按整天平移（用 setDate 走本地日历日，DST 安全——保持墙钟时刻不漂）。
function shiftReminderDays(atMs: number, n: number): number {
  const d = new Date(atMs);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

// 完成即滚动，按单位分两类：
//   分/时（子日）：锚在提醒时刻 reminder.at，按间隔顺延时间戳、清 firedAt；日期原样不动（纯日期无时分语义）。
//   天/周/月（日期）：把 dueDate / deferDate 各自推进到下一周期；custom 下用 due 的位移平移 defer 以保持提前量；
//     带提醒时把提醒按主锚点(due>defer)的整天位移平移、清 firedAt，使每周期都再次触发（review：否则只响一次）。
// 返回新的日期对（及可选 reminder）；调用方（store）据此把状态回 active、清 completedAt、应用提醒。
export function rollRepeat(task: {
  dueDate?: string;
  deferDate?: string;
  reminder?: TaskReminder;
  repeat?: TaskRepeat;
}): { dueDate?: string; deferDate?: string; reminder?: TaskReminder } {
  const repeat = task.repeat;
  if (!repeat) return { dueDate: task.dueDate, deferDate: task.deferDate };
  const interval = repeat.interval && repeat.interval > 0 ? repeat.interval : 1;

  // 子日单位（分/时）：提醒时刻 +间隔、清 firedAt；日期不动。
  if (repeat.kind === "minutely" || repeat.kind === "hourly") {
    const step = (repeat.kind === "minutely" ? MINUTE_MS : HOUR_MS) * interval;
    const result: { dueDate?: string; deferDate?: string; reminder?: TaskReminder } = {
      dueDate: task.dueDate,
      deferDate: task.deferDate,
    };
    if (task.reminder) result.reminder = { at: task.reminder.at + step, firedAt: undefined };
    return result;
  }

  // 日期类（天/周/月）。
  const dueDate = task.dueDate ? computeNextOccurrence(task.dueDate, repeat) : undefined;
  let deferDate = task.deferDate ? computeNextOccurrence(task.deferDate, repeat) : undefined;
  // custom（weekly/monthly）下 due/defer 各自 snap 到各自命中日会扭曲甚至抹平 defer→due 提前量（review）；
  // 有 due 时以 due 的整天位移平移 defer 保持间隔。简单顺延（等步长）无此问题，保持各自顺延。
  if (repeat.custom && task.dueDate && task.deferDate && dueDate) {
    deferDate = shiftDays(task.deferDate, dayDiff(task.dueDate, dueDate));
  }
  const result: { dueDate?: string; deferDate?: string; reminder?: TaskReminder } = { dueDate, deferDate };
  // 带提醒：按主锚点(due 优先，其次 defer)的整天位移平移提醒、清 firedAt，保持提醒相对锚点的天数偏移与墙钟时刻。
  if (task.reminder) {
    const oldAnchor = task.dueDate ?? task.deferDate;
    const newAnchor = dueDate ?? deferDate;
    if (oldAnchor && newAnchor) {
      result.reminder = { at: shiftReminderDays(task.reminder.at, dayDiff(oldAnchor, newAnchor)), firedAt: undefined };
    }
  }
  return result;
}

// 是否可滚动：分/时锚在提醒（需有 reminder）；天/周/月锚在日期（需 due 或 defer）。无锚点 → 视为普通完成。
export function canRoll(task: {
  dueDate?: string;
  deferDate?: string;
  reminder?: TaskReminder;
  repeat?: TaskRepeat;
}): boolean {
  if (!task.repeat) return false;
  if (task.repeat.kind === "minutely" || task.repeat.kind === "hourly") return !!task.reminder;
  return !!(task.dueDate || task.deferDate);
}
