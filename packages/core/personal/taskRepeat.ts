// 任务重复的日期推进纯逻辑（U12/KTD7）。无 React/IO 依赖，便于表驱动单测。
// 与「到点触发」（U11 调度器）解耦：本模块只算「完成后下一次日期」，不管通知。
// 日期一律本地日历日 YYYY-MM-DD（与 dueDate/deferDate 语义一致）。
import type { TaskRepeat } from "../desktop/tasks-types";

// 本地日历日格式化（不引 tasks.ts 的 localDay 以保持本模块纯净、不拉入 React Query）。
function fmt(dt: Date): string {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// 给定本地日历日 YYYY-MM-DD + 周期，算下一次日期。
// monthly 遇目标月无该日（如 1/31→2 月）夹到目标月末。
export function computeNextOccurrence(dateStr: string, repeat: TaskRepeat): string {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const interval = repeat.interval && repeat.interval > 0 ? repeat.interval : 1;
  const dt = new Date(y, m - 1, d); // 本地时间构造，避免 UTC 偏移
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

// 完成即滚动：把任务的 dueDate / deferDate 各自推进到下一周期（无 repeat 或两日期皆无 → 原样返回）。
// 返回新的日期对；调用方（store）据此把状态回 active、清 completedAt。
export function rollRepeat(task: {
  dueDate?: string;
  deferDate?: string;
  repeat?: TaskRepeat;
}): { dueDate?: string; deferDate?: string } {
  if (!task.repeat) return { dueDate: task.dueDate, deferDate: task.deferDate };
  return {
    dueDate: task.dueDate ? computeNextOccurrence(task.dueDate, task.repeat) : undefined,
    deferDate: task.deferDate ? computeNextOccurrence(task.deferDate, task.repeat) : undefined,
  };
}

// 是否可滚动：有 repeat 且至少一个日期锚点（无锚点无从顺延 → 视为普通完成）。
export function canRoll(task: { dueDate?: string; deferDate?: string; repeat?: TaskRepeat }): boolean {
  return !!task.repeat && !!(task.dueDate || task.deferDate);
}
