// 真任务系统主界面（U9，替换文档聚合式 TasksDocsView，占据右栏 "todos" 槽）。
// 内置固定视图：今日 / 收件箱 / 项目 / 标签（v1 无自定义 Perspectives）。数据全部来自 core hooks
//（main 是 owner，服务端态走 React Query）。今日聚合用 isTodayEligible（状态门控 + defer>due），
// 跨日靠 refetchOnWindowFocus 兜底。捕获任务在主窗口触发一次结构化（U6 引擎），建议以 chips
// 非破坏性呈现（U7）；结构渐进披露（无日期/标签/项目的任务只渲染一行）。
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge } from "@cortex-work/core";
import {
  useTasks,
  useTaskProjects,
  useAddTask,
  useUpdateTask,
  useDeleteTask,
  useAddTaskProject,
  useArchiveTask,
  useTasksChangeSubscription,
  tasksAvailable,
  isTodayEligible,
  isAvailable,
  canTransition,
  normalizeTag,
  localDay,
} from "@cortex-work/core/personal/tasks";
import { structureTask, type StructureSuggestion } from "@cortex-work/core/personal/taskStructure";
import { useDelegateTask } from "@cortex-work/core/personal/taskDelegate";
import { usePersonalStore } from "@cortex-work/core";
import type { TaskMeta, TaskProject } from "@cortex-work/core/desktop/types";
import { SuggestionChips } from "./SuggestionChips";
import { TaskDetail } from "./TaskDetail";

type ViewMode = "today" | "inbox" | "projects" | "tags";

const VIEW_LABEL: Record<ViewMode, string> = {
  today: "今日",
  inbox: "收件箱",
  projects: "项目",
  tags: "标签",
};

// 活动态（未 done/dropped）——各视图默认只展示这些。
function isActive(t: TaskMeta): boolean {
  return t.status !== "done" && t.status !== "dropped";
}

export function TasksView({ onToast }: { onToast: (text: string) => void }) {
  const bridge = useDesktopBridge();
  const { data } = useTasks();
  const { data: projectData } = useTaskProjects();
  useTasksChangeSubscription();
  const addTask = useAddTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const addProject = useAddTaskProject();
  const archiveTask = useArchiveTask();
  const delegate = useDelegateTask();
  const setActiveSession = usePersonalStore((s) => s.setActiveSession);

  const [view, setView] = useState<ViewMode>("today");
  const [showDone, setShowDone] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  // 瞬态结构化建议（不持久化，KTD3）：taskId → 建议。
  const [suggestions, setSuggestions] = useState<Record<string, StructureSuggestion>>({});
  const attempted = useRef<Set<string>>(new Set());

  const tasks = useMemo(() => data ?? [], [data]);
  const projects = useMemo<TaskProject[]>(() => projectData ?? [], [projectData]);
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const today = localDay(new Date());

  // 读时兜底（KTD10）：projectId 不在当前项目表 → 视为 Inbox（无项目）。
  const effectiveProjectId = (t: TaskMeta): string | undefined =>
    t.projectId && projectName.has(t.projectId) ? t.projectId : undefined;

  // ── 捕获任务的自动结构化（触发在主窗口，single-flight）───────────────────────
  useEffect(() => {
    if (!bridge?.tasksUpdate) return;
    for (const t of tasks) {
      if (t.source !== "capture" || !isActive(t)) continue;
      if (t.dueDate || t.deferDate || t.tags.length || t.projectId) continue; // 已有结构，跳过
      if (attempted.current.has(t.id)) continue;
      attempted.current.add(t.id);
      structureTask(bridge, t.title, { today }).then((s) => {
        if (Object.keys(s).length) setSuggestions((prev) => ({ ...prev, [t.id]: s }));
      });
    }
  }, [tasks, bridge, today]);

  if (!tasksAvailable(bridge)) {
    return (
      <div className="pw-rp-view pw-todos">
        <div className="pw-empty-hint">任务系统在当前环境不可用。</div>
      </div>
    );
  }

  const onQuickAdd = () => {
    const title = draft.trim();
    if (!title) return;
    const projectId = view === "projects" && selectedProjectId ? selectedProjectId : undefined;
    addTask.mutate({ title, projectId, source: "manual" });
    setDraft("");
  };

  // 完成/取消完成（active↔done，canTransition 守卫）。
  const toggleDone = (t: TaskMeta) => {
    const to = t.status === "done" ? "active" : "done";
    if (!canTransition(t.status, to, "user")) {
      onToast(t.status === "waiting" ? "该任务已委派给 agent，先取消委派" : "无法在当前状态完成");
      return;
    }
    updateTask.mutate({ id: t.id, patch: { status: to } });
  };

  const toggleFlag = (t: TaskMeta) => updateTask.mutate({ id: t.id, patch: { flagged: !t.flagged } });

  // 接受一条建议字段（显式用户动作，不受迟到冲突限制；projectName 匹配已有或新建）。
  const acceptField = async (t: TaskMeta, field: keyof StructureSuggestion) => {
    const s = suggestions[t.id];
    if (!s) return;
    if (field === "dueDate" && s.dueDate) updateTask.mutate({ id: t.id, patch: { dueDate: s.dueDate } });
    else if (field === "deferDate" && s.deferDate) updateTask.mutate({ id: t.id, patch: { deferDate: s.deferDate } });
    else if (field === "tags" && s.tags) {
      const merged = Array.from(new Set([...t.tags, ...s.tags.map((x) => normalizeTag(x)).filter((x): x is string => !!x)]));
      updateTask.mutate({ id: t.id, patch: { tags: merged } });
    } else if (field === "projectName" && s.projectName) {
      const existing = projects.find((p) => p.name.toLowerCase() === s.projectName!.toLowerCase());
      if (existing) updateTask.mutate({ id: t.id, patch: { projectId: existing.id } });
      else {
        const created = await addProject.mutateAsync(s.projectName);
        updateTask.mutate({ id: t.id, patch: { projectId: created.id } });
      }
    }
    dismissField(t.id, field);
  };
  const dismissField = (taskId: string, field: keyof StructureSuggestion) =>
    setSuggestions((prev) => {
      const cur = { ...prev[taskId] };
      delete cur[field];
      const next = { ...prev };
      if (Object.keys(cur).length) next[taskId] = cur;
      else delete next[taskId];
      return next;
    });
  const dismissAll = (taskId: string) =>
    setSuggestions((prev) => {
      const next = { ...prev };
      delete next[taskId];
      return next;
    });

  // 所有标签（去重）。
  const allTags = useMemo(() => Array.from(new Set(tasks.flatMap((t) => t.tags))).sort(), [tasks]);

  // 当前视图下要展示的任务分组。
  const groups = useMemo<Array<{ key: string; label: string; items: TaskMeta[] }>>(() => {
    const active = tasks.filter(isActive);
    if (view === "today") {
      const items = active.filter((t) => isTodayEligible(t, today));
      return [{ key: "today", label: "今日", items }];
    }
    if (view === "inbox") {
      const inbox = active.filter((t) => !effectiveProjectId(t));
      const scheduled = inbox.filter((t) => t.dueDate || t.deferDate);
      const plain = inbox.filter((t) => !t.dueDate && !t.deferDate);
      return [
        { key: "plain", label: "收件箱", items: plain },
        { key: "scheduled", label: "已排期", items: scheduled },
      ].filter((g) => g.items.length > 0);
    }
    if (view === "tags") {
      if (!selectedTag) return [];
      return [{ key: selectedTag, label: selectedTag, items: active.filter((t) => t.tags.includes(selectedTag)) }];
    }
    // projects
    if (selectedProjectId) {
      const items = active.filter((t) => effectiveProjectId(t) === selectedProjectId);
      return [{ key: selectedProjectId, label: projectName.get(selectedProjectId) ?? "项目", items }];
    }
    const byProject = projects.map((p) => ({
      key: p.id,
      label: p.name,
      items: active.filter((t) => effectiveProjectId(t) === p.id),
    }));
    const noProject = active.filter((t) => !effectiveProjectId(t));
    return [...byProject, { key: "__none", label: "无项目", items: noProject }].filter((g) => g.items.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, projects, view, selectedTag, selectedProjectId, today]);

  const totalShown = groups.reduce((n, g) => n + g.items.length, 0);
  // 已完成/已放弃（可归档/恢复，U13/R27）。
  const finished = useMemo(
    () => tasks.filter((t) => t.status === "done" || t.status === "dropped"),
    [tasks],
  );

  // 详情态：编辑任务正文（复用 markdown 编辑器）。放在所有 hooks 之后，避免提前 return 破坏 hooks 顺序。
  // 根节点带 .is-detail，复用右栏「展宽 + 左缘拖拽」的既有 CSS 档位。
  const selectedTask = selectedId ? tasks.find((t) => t.id === selectedId) : undefined;
  if (selectedTask) {
    return (
      <div className="pw-rp-view pw-todos is-detail">
        <TaskDetail task={selectedTask} onBack={() => setSelectedId(null)} onToast={onToast} />
      </div>
    );
  }

  return (
    <div className="pw-rp-view pw-todos">
      {/* 视图切换 */}
      <div className="pw-task-tabs">
        {(Object.keys(VIEW_LABEL) as ViewMode[]).map((v) => (
          <button
            key={v}
            className={`pw-task-tab${view === v ? " is-active" : ""}`}
            onClick={() => {
              setView(v);
              setSelectedProjectId(null);
              setSelectedTag(null);
            }}
          >
            {VIEW_LABEL[v]}
          </button>
        ))}
      </div>

      {/* 快速新增（应用内入口，R1）*/}
      <div className="pw-task-add">
        <input
          className="pw-task-add-input"
          placeholder="添加任务，回车即建…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onQuickAdd();
          }}
        />
      </div>

      {/* 标签视图：先列标签供筛选 */}
      {view === "tags" && !selectedTag && (
        <div className="pw-task-taglist">
          {allTags.length === 0 ? (
            <div className="pw-empty-hint">还没有标签。</div>
          ) : (
            allTags.map((tag) => (
              <button key={tag} className="pw-task-tagchip" onClick={() => setSelectedTag(tag)}>
                {tag}
              </button>
            ))
          )}
        </div>
      )}

      {/* 项目视图顶部：可返回全部 */}
      {view === "projects" && selectedProjectId && (
        <button className="pw-task-back" onClick={() => setSelectedProjectId(null)}>
          ← 全部项目
        </button>
      )}
      {view === "tags" && selectedTag && (
        <button className="pw-task-back" onClick={() => setSelectedTag(null)}>
          ← 全部标签
        </button>
      )}

      {/* 空态 */}
      {totalShown === 0 && view !== "tags" && (
        <div className="pw-empty-hint">
          {view === "today"
            ? "今天没有到期或已安排的任务。"
            : view === "inbox"
              ? "收件箱已清空。"
              : "还没有任务，在上面输入一条试试。"}
        </div>
      )}

      {/* 任务分组列表 */}
      {groups.map((g) => (
        <div key={g.key} className="pw-task-group">
          {(view === "projects" && !selectedProjectId) || (view === "inbox" && groups.length > 1) ? (
            <div className="pw-task-group-head">{g.label}</div>
          ) : null}
          {view === "projects" && !selectedProjectId ? (
            <button className="pw-task-open-project" onClick={() => setSelectedProjectId(g.key === "__none" ? null : g.key)}>
              {g.items.length} 项
            </button>
          ) : null}
          {g.items.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              today={today}
              projectName={effectiveProjectId(t) ? projectName.get(effectiveProjectId(t)!) : undefined}
              suggestion={suggestions[t.id]}
              onToggleDone={() => toggleDone(t)}
              onToggleFlag={() => toggleFlag(t)}
              onDelete={() => deleteTask.mutate(t.id)}
              onAccept={(f) => acceptField(t, f)}
              onDismiss={(f) => dismissField(t.id, f)}
              onDismissAll={() => dismissAll(t.id)}
              onAcceptAll={() => {
                const s = suggestions[t.id];
                if (s) (Object.keys(s) as Array<keyof StructureSuggestion>).forEach((f) => acceptField(t, f));
              }}
              onDelegate={() => delegate(t, onToast)}
              onConfirmDone={() => updateTask.mutate({ id: t.id, patch: { status: "done", delegation: undefined } })}
              onCancelDelegation={() => updateTask.mutate({ id: t.id, patch: { status: "active", delegation: undefined } })}
              onViewSession={() => t.delegation && setActiveSession(t.delegation.sessionId)}
              onOpen={() => setSelectedId(t.id)}
            />
          ))}
        </div>
      ))}

      {/* 已完成 / 已放弃：可归档（摘要落 archived）或恢复为进行（U13/R27）*/}
      {finished.length > 0 && (
        <div className="pw-task-done-section">
          <button className="pw-task-done-toggle" onClick={() => setShowDone((v) => !v)}>
            {showDone ? "▾" : "▸"} 已完成/已放弃（{finished.length}）
          </button>
          {showDone &&
            finished.map((t) => (
              <div key={t.id} className="pw-task-row is-done">
                <span className="pw-task-title">{t.title || "(无标题)"}</span>
                <span className="pw-task-badge">{t.status === "done" ? "已完成" : "已放弃"}</span>
                <div className="spacer" />
                <button
                  className="pw-icon-btn"
                  title="恢复为进行"
                  onClick={() => updateTask.mutate({ id: t.id, patch: { status: "active" } })}
                >
                  ↩
                </button>
                <button
                  className="pw-icon-btn"
                  title="归档"
                  onClick={() => archiveTask.mutate({ id: t.id, summary: t.notes?.trim()?.slice(0, 200) || t.title })}
                >
                  <Icon.Archive size={13} />
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// 单任务行：完成勾选 + 标题 + 渐进披露的结构徽标（有才显）+ flag/删除 + 建议 chips。
function TaskRow({
  task,
  today,
  projectName,
  suggestion,
  onToggleDone,
  onToggleFlag,
  onDelete,
  onAccept,
  onDismiss,
  onDismissAll,
  onAcceptAll,
  onDelegate,
  onConfirmDone,
  onCancelDelegation,
  onViewSession,
  onOpen,
}: {
  task: TaskMeta;
  today: string;
  projectName?: string;
  suggestion?: StructureSuggestion;
  onToggleDone: () => void;
  onToggleFlag: () => void;
  onDelete: () => void;
  onAccept: (field: keyof StructureSuggestion) => void;
  onDismiss: (field: keyof StructureSuggestion) => void;
  onDismissAll: () => void;
  onAcceptAll: () => void;
  onDelegate: () => void;
  onConfirmDone: () => void;
  onCancelDelegation: () => void;
  onViewSession: () => void;
  onOpen: () => void;
}) {
  const overdue = !!task.dueDate && task.dueDate < today;
  const delegated = task.status === "waiting" && !!task.delegation;
  return (
    <div className={`pw-task-row${task.status === "done" ? " is-done" : ""}`}>
      <div className="pw-task-row-main">
        <input
          type="checkbox"
          className="pw-task-check"
          checked={task.status === "done"}
          onChange={onToggleDone}
          title="完成"
        />
        <button className="pw-task-title pw-task-title-btn" title="打开详情 / 编辑正文" onClick={onOpen}>
          {task.title || "(无标题)"}
        </button>
        {/* 渐进披露：仅在有值时显示徽标 */}
        {task.flagged && <span className="pw-task-badge is-flag" title="已标记">⚑</span>}
        {delegated && <span className="pw-task-badge is-wait" title="已委派 agent">委派中</span>}
        {task.status === "in-progress" && <span className="pw-task-badge is-run">进行中</span>}
        {task.dueDate && <span className={`pw-task-badge is-due${overdue ? " is-overdue" : ""}`}>截止 {task.dueDate}</span>}
        {task.deferDate && !isAvailable(task, today) && <span className="pw-task-badge is-defer">延后 {task.deferDate}</span>}
        {task.tags.map((tag) => (
          <span key={tag} className="pw-task-badge is-tag">
            {tag}
          </span>
        ))}
        {projectName && <span className="pw-task-badge is-proj">{projectName}</span>}
        <div className="spacer" />
        {task.status === "active" && (
          <button className="pw-icon-btn" title="交给 agent 执行" onClick={onDelegate}>
            <Icon.Bot size={13} />
          </button>
        )}
        {delegated && (
          <>
            <button className="pw-icon-btn" title="查看会话" onClick={onViewSession}>
              <Icon.Eye size={13} />
            </button>
            <button className="pw-icon-btn" title="确认完成" onClick={onConfirmDone}>
              <Icon.Check size={13} />
            </button>
            <button className="pw-icon-btn" title="取消委派" onClick={onCancelDelegation}>
              <Icon.XCircle size={13} />
            </button>
          </>
        )}
        <button
          className={`pw-icon-btn pw-task-flag${task.flagged ? " is-on" : ""}`}
          title={task.flagged ? "取消标记" : "标记"}
          onClick={onToggleFlag}
        >
          ⚑
        </button>
        <button className="pw-icon-btn" title="删除" onClick={onDelete}>
          <Icon.Trash size={13} />
        </button>
      </div>
      {suggestion && (
        <SuggestionChips
          suggestion={suggestion}
          onAccept={onAccept}
          onDismiss={onDismiss}
          onDismissAll={onDismissAll}
          onAcceptAll={onAcceptAll}
        />
      )}
    </div>
  );
}
