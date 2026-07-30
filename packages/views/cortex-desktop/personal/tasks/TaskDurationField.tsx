// 预计时长录入控件（U10）。无现成 duration stepper，新建：快捷 chips 累加 + 清除。
// 值存 TaskMeta.estimatedDuration（分钟）。仿 ScheduleEditor 的分段按钮手感。
import { useUpdateTask } from "@cortex-work/core/personal/tasks";
import type { TaskMeta } from "@cortex-work/core/desktop/types";

// 分钟 → 「N 分钟 / N 小时 M 分」友好展示。
function fmtDuration(m: number): string {
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return min ? `${h} 小时 ${min} 分` : `${h} 小时`;
}

export function TaskDurationField({ task }: { task: TaskMeta }) {
  const updateTask = useUpdateTask();
  const cur = task.estimatedDuration ?? 0;
  const add = (m: number) =>
    updateTask.mutate({ id: task.id, patch: { estimatedDuration: Math.max(0, cur + m) } });
  const clear = () => updateTask.mutate({ id: task.id, patch: { estimatedDuration: undefined } });

  return (
    <span className="pw-task-duration">
      <span className="pw-task-duration-val">{cur > 0 ? fmtDuration(cur) : "无"}</span>
      <button className="pw-task-meta-btn" onClick={() => add(1)}>
        +1 分
      </button>
      <button className="pw-task-meta-btn" onClick={() => add(5)}>
        +5 分
      </button>
      <button className="pw-task-meta-btn" onClick={() => add(15)}>
        +15 分
      </button>
      <button className="pw-task-meta-btn" onClick={() => add(60)}>
        +1 时
      </button>
      {cur > 0 && (
        <button className="pw-task-meta-btn" title="清除时长" onClick={clear}>
          清除
        </button>
      )}
    </span>
  );
}
