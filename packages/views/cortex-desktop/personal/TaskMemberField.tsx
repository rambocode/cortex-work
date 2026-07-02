// 任务「成员」字段（资源管理）：多选分配全局成员库成员（写 task.memberIds）。
// 已选成员显示为头像 chip（× 移除）；追加经下拉选择（选项排除已选）。成员库为空时引导去设置页。
import { useMembers, useUpdateTask } from "@cortex-work/core/personal/tasks";
import type { TaskMeta } from "@cortex-work/core/desktop/types";
import { MemberAvatar } from "./MemberAvatar";

export function TaskMemberField({ task }: { task: TaskMeta }) {
  const updateTask = useUpdateTask();
  const members = useMembers().data ?? [];
  const selectedIds = task.memberIds ?? [];
  // 悬空 id（成员已删的竞态帧；store deleteMember 会级联清理）不渲染。
  const selected = selectedIds.map((id) => members.find((m) => m.id === id)).filter((m) => m != null);
  const addable = members.filter((m) => !selectedIds.includes(m.id));

  const commit = (next: string[]) =>
    updateTask.mutate({ id: task.id, patch: { memberIds: next.length ? next : undefined } });

  if (members.length === 0) {
    return <span className="pw-task-meta-ro">成员库为空，请在工作台「设置 › 项目资源」添加成员</span>;
  }

  return (
    <span className="pw-task-members">
      {selected.map((m) => (
        <span key={m.id} className="pw-task-badge pw-task-member-chip" title={m.role ? `${m.name}（${m.role}）` : m.name}>
          <MemberAvatar name={m.name} size={16} />
          {m.name}
          <button
            className="pw-task-tag-x"
            title={`移除成员 ${m.name}`}
            aria-label={`移除成员 ${m.name}`}
            onClick={() => commit(selectedIds.filter((id) => id !== m.id))}
          >
            ×
          </button>
        </span>
      ))}
      {addable.length > 0 ? (
        // 受控空值下拉作「追加」入口：每次选择即提交并复位回占位项。
        <select
          className="pw-task-meta-select pw-task-member-add"
          aria-label="分配成员"
          value=""
          onChange={(e) => {
            if (e.target.value) commit([...selectedIds, e.target.value]);
          }}
        >
          <option value="">＋分配成员</option>
          {addable.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.role ? `（${m.role}）` : ""}
            </option>
          ))}
        </select>
      ) : null}
    </span>
  );
}
