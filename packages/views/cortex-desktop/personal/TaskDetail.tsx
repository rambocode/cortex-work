// 任务详情态：编辑任务的结构（项目/日期/标记/标签，U8 手动编辑控件）与内联正文
//（TaskMeta.notes，KTD8）。正文复用与闪记同一套 markdown 编辑器 NoteCodeMirrorEditor
//（CM6 + 实时预览），value/onChange 受控，Cmd/Ctrl+S 或点返回即保存。
// 移动收件箱任务到项目 = 在此选项目（或新建）→ 落 projectId；选「收件箱（无项目）」即移出项目。
// 详情态根节点在 TasksView 侧带 .pw-todos.is-detail，复用右栏「展宽 + 左缘拖拽」的既有 CSS 档位。
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useUpdateTask, useTaskProjects, useAddTaskProject, normalizeTag } from "@cortex-work/core/personal/tasks";
import { onlyProjects } from "@cortex-work/core/personal/taskProjectTree";
import { TaskDurationField } from "./TaskDurationField";
import type { TaskMeta } from "@cortex-work/core/desktop/types";
import { NoteCodeMirrorEditor, type NoteEditorAppearance } from "./editor/NoteCodeMirrorEditor";

export function TaskDetail({
  task,
  onBack,
  onToast,
}: {
  task: TaskMeta;
  onBack: () => void;
  onToast: (text: string) => void;
}) {
  const updateTask = useUpdateTask();
  const { data: projectData } = useTaskProjects();
  const addProject = useAddTaskProject();
  const projects = projectData ?? [];

  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [mode, setMode] = useState<NoteEditorAppearance>("live");
  const [loadFailed, setLoadFailed] = useState(false);
  const [newProject, setNewProject] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  // 富字段渐进披露：用户显式点开的字段 key 集合（已填字段无需在此，isSet 直接显）。
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  // 切换到另一条任务时重置草稿（同 id 保留正在编辑的草稿，不被后台 invalidate 冲掉）。
  useEffect(() => {
    setTitle(task.title);
    setNotes(task.notes ?? "");
    setShowNewProject(false);
    setNewProject("");
    setTagDraft("");
    setRevealed(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const saveTitle = () => {
    const t = title.trim();
    if (t && t !== task.title) updateTask.mutate({ id: task.id, patch: { title: t } });
  };
  const saveNotes = () => {
    if (notes !== (task.notes ?? "")) updateTask.mutate({ id: task.id, patch: { notes } });
  };
  const back = () => {
    saveTitle();
    saveNotes();
    onBack();
  };

  // ── 结构编辑（U8）─────────────────────────────────────────────────────────
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
  const setDue = (v: string) => updateTask.mutate({ id: task.id, patch: { dueDate: v || undefined } });
  const setDefer = (v: string) => updateTask.mutate({ id: task.id, patch: { deferDate: v || undefined } });
  const toggleFlag = () => updateTask.mutate({ id: task.id, patch: { flagged: !task.flagged } });
  const addTag = () => {
    const norm = normalizeTag(tagDraft);
    if (norm && !task.tags.includes(norm)) updateTask.mutate({ id: task.id, patch: { tags: [...task.tags, norm] } });
    setTagDraft("");
  };
  const removeTag = (tag: string) =>
    updateTask.mutate({ id: task.id, patch: { tags: task.tags.filter((t) => t !== tag) } });

  // ── 富字段渐进披露（U8 脚手架）─────────────────────────────────────────────
  // origin R11：新富字段（时长/提醒/重复/附件）空时不常驻，藏在「＋添加属性」后；
  // 已填(isSet)或用户点开(revealed)才渲染其区块——绝不把空字段堆一屏（防 AI slop）。
  // U10-U13 往 richFields 追加条目；richFields 为空时本段不渲染任何内容。
  const richFields: Array<{ key: string; label: string; isSet: boolean; node: ReactNode }> = [
    {
      key: "duration",
      label: "预计时长",
      isSet: task.estimatedDuration != null,
      node: <TaskDurationField task={task} />,
    },
    // U11: reminder；U12: repeat；U13: attachments
  ];
  const shownRich = richFields.filter((f) => f.isSet || revealed.has(f.key));
  const addableRich = richFields.filter((f) => !f.isSet && !revealed.has(f.key));

  return (
    <div className="pw-task-detail">
      <div className="pw-task-detail-head">
        <button className="pw-icon-btn" title="返回列表" onClick={back}>
          <Icon.ChevronLeft size={16} />
        </button>
        <input
          className="pw-task-detail-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              saveTitle();
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="任务标题"
        />
        <button
          className="pw-icon-btn"
          title={mode === "live" ? "切换源码模式" : "切换实时预览"}
          onClick={() => setMode(mode === "live" ? "source" : "live")}
        >
          <Icon.Eye size={14} />
        </button>
      </div>

      {/* 结构栏：项目 / 日期 / 标记 / 标签 */}
      <div className="pw-task-detail-meta">
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
                className="pw-task-meta-select"
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

        <div className="pw-task-meta-row">
          <span className="pw-task-meta-label">截止</span>
          <input className="pw-task-meta-date" type="date" value={task.dueDate ?? ""} onChange={(e) => setDue(e.target.value)} />
          <span className="pw-task-meta-label">延后</span>
          <input className="pw-task-meta-date" type="date" value={task.deferDate ?? ""} onChange={(e) => setDefer(e.target.value)} />
          <button className={`pw-task-meta-btn${task.flagged ? " is-on" : ""}`} onClick={toggleFlag}>
            ⚑ {task.flagged ? "已标记" : "标记"}
          </button>
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

      {/* 富字段区（渐进披露，U8 脚手架）：richFields 为空时整段不渲染，绝不显空字段。 */}
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

      <div className="pw-task-detail-body">
        {loadFailed ? (
          <div className="pw-empty-hint">编辑器加载失败，可返回后重试。</div>
        ) : (
          <NoteCodeMirrorEditor
            key={task.id}
            value={notes}
            appearance={mode}
            onChange={setNotes}
            onSave={() => {
              saveNotes();
              onToast("已保存");
            }}
            onLoadError={() => {
              setLoadFailed(true);
              onToast("编辑器加载失败");
            }}
          />
        )}
      </div>
    </div>
  );
}
