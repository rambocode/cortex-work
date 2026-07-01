// 任务结构字段面板（U5/KTD7）：从 TaskDetail 抽出的字段簇，供**右列详情**（layout=column）与
// **中列行内 inspector**（layout=inline，U6）共用同一实现，防两套字段逻辑漂移。
// 含：状态（新控件 U5）/ 项目 / 截止 / 延后 / 标记 / 标签 / 完成·丢弃时间戳 / 渐进披露富字段
//（时长 / 提醒 / 重复 / 附件）。全部 {task} prop + useUpdateTask 直驱，无 selection 依赖。
// layout 仅切外层类（is-inline / is-column），不分叉逻辑；具体紧凑排布样式见 CSS（U6/U7）。
import { useEffect, useState, type ReactNode } from "react";
import { useUpdateTask, useTaskProjects, useAddTaskProject, normalizeTag } from "@cortex-work/core/personal/tasks";
import { onlyProjects } from "@cortex-work/core/personal/taskProjectTree";
import { TaskStatusField } from "./TaskStatusField";
import { TaskDateField } from "./TaskDateField";
import { TaskDurationField } from "./TaskDurationField";
import { TaskReminderField } from "./TaskReminderField";
import { TaskRepeatField } from "./TaskRepeatField";
import { TaskAttachments } from "./TaskAttachments";
import type { TaskMeta } from "@cortex-work/core/desktop/types";

export function TaskFieldsPanel({
  task,
  layout,
  onToast,
}: {
  task: TaskMeta;
  layout: "inline" | "column";
  onToast: (text: string) => void;
}) {
  const updateTask = useUpdateTask();
  const { data: projectData } = useTaskProjects();
  const addProject = useAddTaskProject();
  const projects = projectData ?? [];

  const [newProject, setNewProject] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  // 富字段渐进披露：用户显式点开的字段 key 集合（已填字段无需在此，isSet 直接显）。
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  // 切换到另一条任务时重置本面板的瞬态草稿。
  useEffect(() => {
    setShowNewProject(false);
    setNewProject("");
    setTagDraft("");
    setRevealed(new Set());
  }, [task.id]);

  const assignProject = (val: string) => updateTask.mutate({ id: task.id, patch: { projectId: val || undefined } });
  const createAndAssign = async () => {
    const name = newProject.trim();
    if (!name) {
      setShowNewProject(false);
      return;
    }
    const proj = await addProject.mutateAsync(name);
    updateTask.mutate({ id: task.id, patch: { projectId: proj.id } });
    setNewProject("");
    setShowNewProject(false);
    onToast(`已归入项目「${name}」`);
  };
  const toggleFlag = () => updateTask.mutate({ id: task.id, patch: { flagged: !task.flagged } });
  const addTag = () => {
    const norm = normalizeTag(tagDraft);
    if (norm && !task.tags.includes(norm)) updateTask.mutate({ id: task.id, patch: { tags: [...task.tags, norm] } });
    setTagDraft("");
  };
  const removeTag = (tag: string) =>
    updateTask.mutate({ id: task.id, patch: { tags: task.tags.filter((t) => t !== tag) } });

  // origin R11：新富字段（时长/提醒/重复/附件）空时不常驻，藏在「＋添加属性」后；
  // 已填(isSet)或用户点开(revealed)才渲染其区块——绝不把空字段堆一屏（防 AI slop）。
  const richFields: Array<{ key: string; label: string; isSet: boolean; node: ReactNode }> = [
    { key: "duration", label: "预计时长", isSet: task.estimatedDuration != null, node: <TaskDurationField task={task} /> },
    { key: "reminder", label: "提醒", isSet: task.reminder?.at != null, node: <TaskReminderField task={task} /> },
    { key: "repeat", label: "重复", isSet: task.repeat != null, node: <TaskRepeatField task={task} /> },
    { key: "attachments", label: "附件", isSet: (task.attachments?.length ?? 0) > 0, node: <TaskAttachments task={task} onToast={onToast} /> },
  ];
  const shownRich = richFields.filter((f) => f.isSet || revealed.has(f.key));
  const addableRich = richFields.filter((f) => !f.isSet && !revealed.has(f.key));

  return (
    <div className={`pw-task-fields is-${layout}`}>
      {/* 结构栏：状态 / 项目 / 日期 / 标记 / 标签 */}
      <div className="pw-task-detail-meta">
        <div className="pw-task-meta-row">
          <span className="pw-task-meta-label">状态</span>
          <TaskStatusField task={task} onToast={onToast} />
        </div>

        <div className="pw-task-meta-row">
          <span className="pw-task-meta-label">项目</span>
          {showNewProject ? (
            <>
              <input
                className="pw-task-meta-input"
                autoFocus
                value={newProject}
                onChange={(e) => setNewProject(e.target.value)}
                placeholder="新项目名，回车创建并归入"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createAndAssign();
                  if (e.key === "Escape") setShowNewProject(false);
                }}
              />
              <button className="pw-task-meta-btn" onClick={() => void createAndAssign()}>
                创建
              </button>
              <button className="pw-task-meta-btn" onClick={() => setShowNewProject(false)}>
                取消
              </button>
            </>
          ) : (
            <>
              <select
                className="pw-task-meta-select pw-task-project-select"
                value={task.projectId ?? ""}
                onChange={(e) => assignProject(e.target.value)}
              >
                <option value="">收件箱（无项目）</option>
                {/* 只列 project（过滤 folder，任务不挂 folder，KTD2）。 */}
                {onlyProjects(projects).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button className="pw-task-meta-btn" title="新建项目并归入" onClick={() => setShowNewProject(true)}>
                ＋新建
              </button>
            </>
          )}
        </div>

        <div className="pw-task-meta-row pw-task-meta-tagrow">
          <span className="pw-task-meta-label">标签</span>
          {task.tags.map((tag) => (
            <span key={tag} className="pw-task-badge is-tag">
              {tag}
              <button className="pw-task-tag-x" title="移除标签" onClick={() => removeTag(tag)}>
                ×
              </button>
            </span>
          ))}
          <input
            className="pw-task-meta-input pw-task-meta-taginput"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            placeholder="加标签，回车"
            onKeyDown={(e) => {
              if (e.key === "Enter") addTag();
            }}
          />
        </div>

        {/* 推迟至 / 截止：日期 + 快捷 chips（今天/+1天/+1周/+1月/清除），对齐设计稿右列检查器。 */}
        <div className="pw-task-meta-row">
          <span className="pw-task-meta-label">推迟至</span>
          <TaskDateField task={task} kind="defer" />
        </div>

        <div className="pw-task-meta-row">
          <span className="pw-task-meta-label">截止</span>
          <TaskDateField task={task} kind="due" />
        </div>

        <div className="pw-task-meta-row pw-task-meta-flagrow">
          <span className="pw-task-meta-label">标记</span>
          <button className={`pw-task-meta-btn${task.flagged ? " is-on" : ""}`} onClick={toggleFlag}>
            ⚑ {task.flagged ? "已标记" : "标记"}
          </button>
        </div>

        {/* 已完成 / 已丢弃 时间戳：只读，仅在设置后显示（U10，非可添加字段故不入 richFields）。 */}
        {task.completedAt != null && (
          <div className="pw-task-meta-row">
            <span className="pw-task-meta-label">已完成</span>
            <span className="pw-task-meta-ro">{new Date(task.completedAt).toLocaleString()}</span>
          </div>
        )}
        {task.droppedAt != null && (
          <div className="pw-task-meta-row">
            <span className="pw-task-meta-label">已丢弃</span>
            <span className="pw-task-meta-ro">{new Date(task.droppedAt).toLocaleString()}</span>
          </div>
        )}
      </div>

      {/* 富字段区（渐进披露）：richFields 全空时整段不渲染，绝不显空字段。 */}
      {(shownRich.length > 0 || addableRich.length > 0) && (
        <div className="pw-task-detail-meta pw-task-rich">
          {shownRich.map((f) => (
            <div key={f.key} className="pw-task-meta-row">
              <span className="pw-task-meta-label">{f.label}</span>
              {f.node}
            </div>
          ))}
          {addableRich.length > 0 && (
            <div className="pw-task-meta-row pw-task-rich-add">
              {addableRich.map((f) => (
                <button
                  key={f.key}
                  className="pw-task-meta-btn"
                  title={`添加${f.label}`}
                  onClick={() => setRevealed((prev) => new Set(prev).add(f.key))}
                >
                  ＋{f.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
