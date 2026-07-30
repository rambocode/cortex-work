// 任务日期字段（推迟至 / 截止）：<input type=date> + 快捷 chips（今天/+1天/+1周/+1月/清除），
// 对齐设计稿右列检查器（OmniFocus 风）。值以本地日历日 YYYY-MM-DD 存储，与 deferDate/dueDate 同构。
// 快捷 chip 以「今天」为基点做相对偏移（用户诉求：一键设到今天/一周后），不依赖已有值；清除 → undefined。
// 与右列详情、行内 inspector 共用同一 useUpdateTask + RQ cache，编辑即时同步。
import { useUpdateTask, localDay } from "@cortex-work/core/personal/tasks";
import type { TaskMeta } from "@cortex-work/core/desktop/types";

// 本地日历日偏移：解析 YYYY-MM-DD → 本地构造 Date 加 n 天 → 重新格式化。
// 用本地构造（非 UTC）避免跨时区把日期漂到前后一天（与 dueDate/deferDate 的本地日语义一致）。
function shiftDay(base: string, days: number): string {
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(y || 1970, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + days);
  return localDay(dt);
}

// 按日历月推进 + 月末夹取：与「+1 月」的用户直觉一致（1/31 + 1 月 → 2/28，而非固定 +30 天越过 2 月）。
// 不用固定 30 天近似（review：跨月末反直觉）；先落目标月，再把日夹到该月最大天数。
function shiftMonth(base: string, months: number): string {
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(y || 1970, (m || 1) - 1, 1);
  dt.setMonth(dt.getMonth() + months);
  const lastDay = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
  dt.setDate(Math.min(d || 1, lastDay));
  return localDay(dt);
}

// days | months 二选一：天/周走精确日加法，月走日历月推进（语义各自正确）。
const CHIPS: Array<{ label: string; days?: number; months?: number }> = [
  { label: "今天", days: 0 },
  { label: "+1 天", days: 1 },
  { label: "+1 周", days: 7 },
  { label: "+1 月", months: 1 },
];

export function TaskDateField({ task, kind }: { task: TaskMeta; kind: "defer" | "due" }) {
  const updateTask = useUpdateTask();
  const value = kind === "defer" ? task.deferDate : task.dueDate;
  const today = localDay(new Date());
  // 分支写具体字段（不用计算键）以保持 patch 完全类型化。空串 → undefined（清除）。
  const set = (v: string | undefined) =>
    updateTask.mutate({
      id: task.id,
      patch: kind === "defer" ? { deferDate: v || undefined } : { dueDate: v || undefined },
    });

  return (
    <div className="pw-task-datefield">
      <input
        type="date"
        className="pw-task-meta-date pw-task-datefield-input"
        value={value ?? ""}
        onChange={(e) => set(e.target.value)}
      />
      <div className="pw-task-date-chips">
        {CHIPS.map((c) => (
          <button
            key={c.label}
            type="button"
            className="pw-task-date-chip"
            onClick={() => set(c.months != null ? shiftMonth(today, c.months) : shiftDay(today, c.days ?? 0))}
          >
            {c.label}
          </button>
        ))}
        {value && (
          <button type="button" className="pw-task-date-chip is-clear" title="清除日期" onClick={() => set(undefined)}>
            清除
          </button>
        )}
      </div>
    </div>
  );
}
