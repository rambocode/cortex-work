// 任务状态控件（U5/R9）：现 TaskDetail 无状态编辑控件（状态只能经 checkbox 完成 / 委派间接改），
// 本控件补齐 origin R8 的 5 态手动编辑，供内联 inspector 与右列详情共用（layout 无关，纯 {task} 驱动）。
// 置 done/dropped 的时间戳（completedAt/droppedAt）由 main store 状态迁移落点权威写入，本控件只发 patch。
import { useUpdateTask } from "@cortex-work/core/personal/tasks";
import type { TaskMeta, TaskStatus } from "@cortex-work/core/desktop/types";

// 枚举与中文标签（inbox 是计算态、不入枚举，故不在此）。
const STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: "active", label: "活动" },
  { value: "in-progress", label: "进行中" },
  { value: "waiting", label: "等待" },
  { value: "done", label: "已完成" },
  { value: "dropped", label: "已放弃" },
];

export function TaskStatusField({ task }: { task: TaskMeta }) {
  const updateTask = useUpdateTask();
  return (
    <div className="pw-task-status-seg" role="radiogroup" aria-label="状态">
      {STATUS_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={task.status === o.value}
          className={`pw-task-status-opt${task.status === o.value ? " is-on" : ""}`}
          onClick={() => {
            if (task.status !== o.value) updateTask.mutate({ id: task.id, patch: { status: o.value } });
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
