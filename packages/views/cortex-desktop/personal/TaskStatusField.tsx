// 任务状态控件（U5/R9）：现 TaskDetail 无状态编辑控件（状态只能经 checkbox 完成 / 委派间接改），
// 本控件补齐 origin R8 的 5 态手动编辑，供内联 inspector 与右列详情共用（layout 无关，纯 {task} 驱动）。
// 置 done/dropped 的时间戳（completedAt/droppedAt）由 main store 状态迁移落点权威写入，本控件只发 patch。
// 状态机守卫（code-review P1）：迁移必须过 canTransition(by="user")——否则用户可手动置 agent-only 的
// in-progress、或把已委派(waiting)任务直接 done 而遗留悬空 delegation。非法目标置灰 + toast，与
// TaskListColumn.toggleDone 的 waiting 守卫同款策略；两条编辑路径共用同一状态机。
import type { ComponentType } from "react";
import { Icon, type IconProps } from "@cortex-work/ui/icons";
import { useUpdateTask, canTransition } from "@cortex-work/core/personal/tasks";
import type { TaskMeta, TaskStatus } from "@cortex-work/core/desktop/types";

// 枚举 + 中文标签 + icon（inbox 是计算态、不入枚举，故不在此）。
// icon 取 @cortex-work/ui/icons 的圆形状态族，对齐设计稿：空心圆=活动/未开始、圆心点=进行中、
// 时钟=等待、勾圈=已完成、叉圈=已放弃。label 文本保留（可访问性 + 分档语义），icon 只作视觉前缀。
const STATUS_OPTIONS: Array<{ value: TaskStatus; label: string; icon: ComponentType<IconProps> }> = [
  { value: "active", label: "活动", icon: Icon.Circle },
  { value: "in-progress", label: "进行中", icon: Icon.CircleDot },
  { value: "waiting", label: "等待", icon: Icon.Clock },
  { value: "done", label: "已完成", icon: Icon.CheckCircle },
  { value: "dropped", label: "已放弃", icon: Icon.XCircle },
];

export function TaskStatusField({ task, onToast }: { task: TaskMeta; onToast?: (text: string) => void }) {
  const updateTask = useUpdateTask();
  return (
    <div className="pw-task-status-seg" role="radiogroup" aria-label="状态">
      {STATUS_OPTIONS.map((o) => {
        const isCurrent = task.status === o.value;
        // 非当前态且用户不可迁移到该态 → 置灰不可选（in-progress 恒为 agent-only；waiting→done 须先取消委派）。
        const allowed = isCurrent || canTransition(task.status, o.value, "user");
        const StatusIcon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={isCurrent}
            disabled={!allowed}
            className={`pw-task-status-opt${isCurrent ? " is-on" : ""}`}
            onClick={() => {
              if (isCurrent) return;
              if (!canTransition(task.status, o.value, "user")) {
                onToast?.(o.value === "in-progress" ? "「进行中」由 agent 委派驱动，不能手动设置" : "无法从当前状态迁移到该状态");
                return;
              }
              updateTask.mutate({ id: task.id, patch: { status: o.value } });
            }}
          >
            {/* icon 在前、label 在后；不引入空白文本节点，保持 button.textContent 恰为标签文本。 */}
            <StatusIcon size={13} />
            <span className="pw-task-status-opt-label">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
