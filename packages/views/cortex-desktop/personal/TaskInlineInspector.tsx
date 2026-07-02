// 中列行内属性检查器（问题2，对齐参考图 OmniFocus 新建任务样式）：紧凑单行属性栏，
// 每项为「图标 + 值/灰占位」的 chip，点击就地展开该字段的编辑器；末行「添加备注」。
// 与右列 TaskDetail 的完整堆叠面板（TaskFieldsPanel）分工：行内求紧凑一行、按需就地编辑；
// 二者共用底层字段控件（时长/提醒/重复）与同一 useUpdateTask + RQ cache，编辑即时同步。
// 不含 5 态状态分段（那是右列详情的完整编辑面）——行内只给「已完成」这一动作，符合参考图。
import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useUpdateTask, useTaskProjects, normalizeTag, canTransition } from "@cortex-work/core/personal/tasks";
import { onlyProjects } from "@cortex-work/core/personal/taskProjectTree";
import { TaskDurationField } from "./TaskDurationField";
import { TaskReminderField } from "./TaskReminderField";
import { TaskRepeatField } from "./TaskRepeatField";
import { useTaskDraftField } from "./useTaskDraftField";
import type { TaskMeta } from "@cortex-work/core/desktop/types";

// 当前就地展开编辑的字段（一次一个；再次点同一 chip 收起）。
type Field = "project" | "tags" | "duration" | "defer" | "due" | "repeat" | "reminder" | "notes" | "done" | null;

const fmtDur = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`);

export function TaskInlineInspector({
  task,
  today,
  onToast,
}: {
  task: TaskMeta;
  today: string;
  onToast: (text: string) => void;
}) {
  const updateTask = useUpdateTask();
  const { data: projectData } = useTaskProjects();
  const projects = projectData ?? [];

  const [field, setField] = useState<Field>(null);
  const [tagDraft, setTagDraft] = useState("");
  // 备注走共享草稿守卫（U1/KTD6）：原先无重置 effect，切任务/外部改备注都不刷新——
  // 换 hook 后切任务重置、未聚焦时跟随外部值、聚焦中不被冲掉、blur 提交。
  const noteDraft = useTaskDraftField({
    taskId: task.id,
    external: task.notes ?? "",
    onCommit: (n) => updateTask.mutate({ id: task.id, patch: { notes: n } }),
  });

  const toggle = (f: Exclude<Field, null>) => setField((cur) => (cur === f ? null : f));
  const overdue = !!task.dueDate && task.dueDate < today;

  const setDue = (v: string) => updateTask.mutate({ id: task.id, patch: { dueDate: v || undefined } });
  const setDefer = (v: string) => updateTask.mutate({ id: task.id, patch: { deferDate: v || undefined } });
  const assignProject = (val: string) => updateTask.mutate({ id: task.id, patch: { projectId: val || undefined } });
  const addTag = () => {
    const norm = normalizeTag(tagDraft);
    if (norm && !task.tags.includes(norm)) updateTask.mutate({ id: task.id, patch: { tags: [...task.tags, norm] } });
    setTagDraft("");
  };
  const removeTag = (tag: string) =>
    updateTask.mutate({ id: task.id, patch: { tags: task.tags.filter((t) => t !== tag) } });
  const toggleDone = () => {
    const to = task.status === "done" ? "active" : "done";
    if (!canTransition(task.status, to, "user")) {
      onToast(task.status === "waiting" ? "该任务已委派给 agent，先取消委派" : "无法在当前状态完成");
      return;
    }
    updateTask.mutate({ id: task.id, patch: { status: to } });
  };
  const projectName = task.projectId ? projects.find((p) => p.id === task.projectId)?.name : undefined;

  // chip：有值高亮、无值灰占位；on 表示对应编辑器已展开。
  const chip = (
    key: Exclude<Field, null>,
    icon: React.ReactNode,
    active: boolean,
    label: string,
    opts?: { danger?: boolean; onClick?: () => void },
  ) => (
    <button
      type="button"
      className={`pw-task-chip${active ? " is-set" : ""}${opts?.danger ? " is-danger" : ""}${field === key ? " is-editing" : ""}`}
      onClick={opts?.onClick ?? (() => toggle(key))}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div className="pw-task-inspect">
      <div className="pw-task-inspect-bar">
        {chip("project", <Icon.Task size={12} />, !!projectName, projectName ?? "项目")}
        {chip("tags", <Icon.Tags size={12} />, task.tags.length > 0, task.tags.length ? task.tags.join("、") : "标签")}
        {chip("duration", <Icon.Clock size={12} />, task.estimatedDuration != null, task.estimatedDuration != null ? fmtDur(task.estimatedDuration) : "持续时间")}
        {chip("defer", <Icon.Fwd size={12} />, !!task.deferDate, task.deferDate ?? "推迟至")}
        {chip("due", <Icon.Clock size={12} />, !!task.dueDate, task.dueDate ?? "截止", { danger: overdue })}
        {chip("done", <Icon.Check size={12} />, task.status === "done", "已完成", { onClick: toggleDone })}
        {chip("repeat", <Icon.Retry size={12} />, task.repeat != null, task.repeat ? "重复中" : "重复")}
        {chip("reminder", <Icon.Bell size={12} />, task.reminder?.at != null, task.reminder?.at != null ? "已设提醒" : "通知")}
      </div>

      {/* 就地编辑区：一次展开一个字段的编辑器。*/}
      {field === "project" && (
        <div className="pw-task-inspect-edit">
          <select className="pw-task-meta-select" value={task.projectId ?? ""} onChange={(e) => assignProject(e.target.value)}>
            <option value="">收件箱（无项目）</option>
            {onlyProjects(projects).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )}
      {field === "tags" && (
        <div className="pw-task-inspect-edit pw-task-meta-tagrow">
          {task.tags.map((tag) => (
            <span key={tag} className="pw-task-badge is-tag">
              {tag}
              <button className="pw-task-tag-x" title="移除标签" onClick={() => removeTag(tag)}>×</button>
            </span>
          ))}
          <input
            className="pw-task-meta-input pw-task-meta-taginput"
            autoFocus
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            placeholder="加标签，回车"
            onKeyDown={(e) => { if (e.key === "Enter") addTag(); }}
          />
        </div>
      )}
      {field === "duration" && (
        <div className="pw-task-inspect-edit"><TaskDurationField task={task} /></div>
      )}
      {field === "defer" && (
        <div className="pw-task-inspect-edit">
          <input className="pw-task-meta-date" type="date" autoFocus value={task.deferDate ?? ""} onChange={(e) => setDefer(e.target.value)} />
        </div>
      )}
      {field === "due" && (
        <div className="pw-task-inspect-edit">
          <input className="pw-task-meta-date" type="date" autoFocus value={task.dueDate ?? ""} onChange={(e) => setDue(e.target.value)} />
        </div>
      )}
      {field === "repeat" && (
        <div className="pw-task-inspect-edit"><TaskRepeatField task={task} /></div>
      )}
      {field === "reminder" && (
        <div className="pw-task-inspect-edit"><TaskReminderField task={task} /></div>
      )}

      {/* 添加备注：点开就地 textarea，失焦保存。*/}
      <button
        type="button"
        className={`pw-task-note-toggle${field === "notes" ? " is-editing" : ""}`}
        onClick={() => toggle("notes")}
      >
        <Icon.Comment size={12} /> {task.notes ? "备注" : "添加备注"}
      </button>
      {field === "notes" && (
        <textarea
          className="pw-task-note-input"
          autoFocus
          value={noteDraft.value}
          placeholder="备注…"
          onFocus={noteDraft.onFocus}
          onChange={(e) => noteDraft.setValue(e.target.value)}
          onBlur={noteDraft.onBlur}
        />
      )}
    </div>
  );
}
