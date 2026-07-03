// 日历空闲段计算与 HH:mm-HH:mm 摘要。逐函数移植自 ReplyClone CalendarSlotFormatter.swift，
// 并把 CalendarReader 的「3 天窗口 / 30 分钟阈值 / 最多 8 段 / 可用时间：前缀」封装为
// availabilityContext（core 侧只吃 helper 读出的忙碌区间，不触碰 EventKit）。
//
// 时间一律用 epoch 毫秒表示，保持纯逻辑、可脱离宿主时区测试。

/** 忙碌区间（helper 从系统日历读出的非全天事件）。start/end 为 epoch 毫秒。 */
export interface BusyEvent {
  start: number;
  end: number;
  title: string;
}

/** 计算出的空闲段。start/end 为 epoch 毫秒。 */
export interface FreeSlot {
  start: number;
  end: number;
}

/** 时间窗口（闭区间语义），start/end 为 epoch 毫秒。 */
export interface TimeWindow {
  start: number;
  end: number;
}

/** 默认空闲阈值：≥30 分钟才算一个可约空闲段（源项目常量）。 */
export const DEFAULT_MIN_SLOT_MS = 30 * 60 * 1000;
/** 摘要最多保留的空闲段数（源项目 CalendarReader.prefix(8)）。 */
export const MAX_SLOT_COUNT = 8;
/** 日历上下文段落前缀（源项目 "可用时间：..."）。 */
export const AVAILABILITY_PREFIX = "可用时间：";

/** 空闲段时长（分钟，向下取整）。 */
export function slotDurationMinutes(slot: FreeSlot): number {
  return Math.floor((slot.end - slot.start) / 60000);
}

/**
 * 在给定窗口内、扣除忙碌区间后，切出所有 ≥minimumDurationMs 的空闲段。
 * 忙碌区间先裁剪到窗口内、按开始时间排序、合并重叠，再用游标扫描出空隙。
 */
export function freeSlots(
  window: TimeWindow,
  busyEvents: readonly BusyEvent[],
  minimumDurationMs: number,
): FreeSlot[] {
  // 把每个事件裁剪到窗口内，交集为空 / 零时长的丢弃
  const clippedBusy = busyEvents
    .map((event) => intersect({ start: event.start, end: event.end }, window))
    .filter((interval): interval is TimeWindow => interval !== null)
    .sort((a, b) => a.start - b.start);

  const mergedBusy = mergeIntervals(clippedBusy);
  let cursor = window.start;
  const slots: FreeSlot[] = [];

  for (const busy of mergedBusy) {
    if (busy.start - cursor >= minimumDurationMs) {
      slots.push({ start: cursor, end: busy.start });
    }
    if (busy.end > cursor) cursor = busy.end;
  }

  if (window.end - cursor >= minimumDurationMs) {
    slots.push({ start: cursor, end: window.end });
  }
  return slots;
}

/**
 * 把空闲段格式化为 `HH:mm-HH:mm` 逗号分隔的摘要（24 小时制）。
 * timeZone 缺省用宿主本地时区；测试与确定性场景应显式传入（如 "UTC"）。
 */
export function summarizeSlots(slots: readonly FreeSlot[], timeZone?: string): string {
  if (slots.length === 0) return "";
  return slots
    .map((slot) => `${formatHHmm(slot.start, timeZone)}-${formatHHmm(slot.end, timeZone)}`)
    .join(", ");
}

/** availabilityContext 的可选参数。 */
export interface AvailabilityOptions {
  minimumDurationMs?: number;
  maxSlots?: number;
  timeZone?: string;
}

/**
 * 生成注入 prompt 的日历上下文段落：算空闲段 → 截断到 maxSlots → 加「可用时间：」前缀。
 * 无空闲段时返回空串，由 prompt 侧静默跳过该段落（对应源项目 CalendarReader.availabilitySummary）。
 */
export function availabilityContext(
  window: TimeWindow,
  busyEvents: readonly BusyEvent[],
  options: AvailabilityOptions = {},
): string {
  const minimumDurationMs = options.minimumDurationMs ?? DEFAULT_MIN_SLOT_MS;
  const maxSlots = options.maxSlots ?? MAX_SLOT_COUNT;
  const slots = freeSlots(window, busyEvents, minimumDurationMs).slice(0, maxSlots);
  const summary = summarizeSlots(slots, options.timeZone);
  return summary.length === 0 ? "" : `${AVAILABILITY_PREFIX}${summary}`;
}

/** 两个区间的交集；无交集或零时长返回 null。 */
function intersect(a: TimeWindow, b: TimeWindow): TimeWindow | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

/** 合并已按 start 排序的区间（重叠或相接的并成一段）。 */
function mergeIntervals(intervals: readonly TimeWindow[]): TimeWindow[] {
  const result: TimeWindow[] = [];
  for (const interval of intervals) {
    const last = result.at(-1);
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      result.push({ ...interval });
    }
  }
  return result;
}

/** 把 epoch 毫秒格式化为 24 小时制 `HH:mm`（en-US + h23，两位补零）。 */
function formatHHmm(ms: number, timeZone?: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  });
  return formatter.format(new Date(ms));
}
