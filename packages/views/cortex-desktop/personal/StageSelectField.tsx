// 任务「阶段」字段（项目阶段管理）：把任务归入所属项目的某个阶段（写 task.stageId）。
// 仅当任务归属的 project 定义了 stages 时由 TaskFieldsPanel 渲染本字段；「未归阶段」= 清空。
import { useUpdateTask } from "@cortex-work/core/personal/tasks";
import { sortStages } from "@cortex-work/core/personal/projectStages";
import type { ProjectStage, TaskMeta } from "@cortex-work/core/desktop/types";

export function StageSelectField({ task, stages }: { task: TaskMeta; stages: ProjectStage[] }) {
  const updateTask = useUpdateTask();
  const sorted = sortStages(stages);
  // 悬空 stageId（阶段已删的竞态帧；store 会级联清理）按未归阶段显示。
  const value = task.stageId && sorted.some((s) => s.id === task.stageId) ? task.stageId : "";

  return (
    <select
      className="pw-task-meta-select"
      aria-label="所属阶段"
      value={value}
      onChange={(e) => updateTask.mutate({ id: task.id, patch: { stageId: e.target.value || undefined } })}
    >
      <option value="">未归阶段</option>
      {sorted.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}
