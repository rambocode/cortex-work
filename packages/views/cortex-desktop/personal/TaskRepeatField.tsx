// 任务重复录入控件（U12）。选周期 kind（无/每天/每周/每月）→ 写 TaskMeta.repeat。
// 「不重复」即清 repeat = 结束重复（届时完成才真正 done，见 store U12 滚动逻辑）。
import { useUpdateTask } from "@cortex-work/core/personal/tasks";
import type { TaskMeta, TaskRepeat } from "@cortex-work/core/desktop/types";

const KINDS: Array<{ v: "" | TaskRepeat["kind"]; label: string }> = [
  { v: "", label: "不重复" },
  { v: "daily", label: "每天" },
  { v: "weekly", label: "每周" },
  { v: "monthly", label: "每月" },
];

export function TaskRepeatField({ task }: { task: TaskMeta }) {
  const updateTask = useUpdateTask();
  const cur = task.repeat?.kind ?? "";
  const setKind = (v: string) => {
    if (!v) updateTask.mutate({ id: task.id, patch: { repeat: undefined } }); // 结束重复
    else updateTask.mutate({ id: task.id, patch: { repeat: { kind: v as TaskRepeat["kind"] } } });
  };
  // 重复任务需有截止/延后日期作滚动锚点，否则完成时无从顺延（会落正常 done）。
  const needsDate = !!task.repeat && !task.dueDate && !task.deferDate;
  return (
    <span className="pw-task-repeat">
      <select className="pw-task-meta-select" value={cur} onChange={(e) => setKind(e.target.value)}>
        {KINDS.map((k) => (
          <option key={k.v} value={k.v}>
            {k.label}
          </option>
        ))}
      </select>
      {needsDate && <span className="pw-task-meta-ro">需设截止/延后日期才会滚动</span>}
    </span>
  );
}
