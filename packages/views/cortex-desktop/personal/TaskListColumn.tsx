// 三栏项目工作台中列（U7）：按左树选择聚合任务清单 —— 分组 / 排序 / 快速新增 / 行内动作
//（完成、flag、删除、委派、打开详情）。服务端态全部来自 core hooks（React Query，main 是 owner，
// 不复制进 Zustand，KTD8）。委派走 keepView 后台模式，不关工作台（对抗研究 #3）。
import { useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useTasks,
  useTaskProjects,
  useAddTask,
  useUpdateTask,
  useDeleteTask,
  isTodayEligible,
  isAvailable,
  canTransition,
  localDay,
} from "@cortex-work/core/personal/tasks";
import { descendantProjectIds } from "@cortex-work/core/personal/taskProjectTree";
import { buildTaskTree, taskDescendantIds, areAllChildrenDone, type TaskTreeNode } from "@cortex-work/core/personal/taskTree";
import { useDelegateTask } from "@cortex-work/core/personal/taskDelegate";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { TaskFieldsPanel } from "./TaskFieldsPanel";
import type { TaskMeta } from "@cortex-work/core/desktop/types";
import type { WorkbenchSelection } from "./ProjectsWorkbench";

// 子任务缩进步距（px）。每深一层左移一档，OmniFocus 风格（U3；U7 视觉细调）。
const INDENT_STEP = 22;

// 渲染行：任务 + 缩进深度 + 是否有子（决定折叠箭头）。
interface FlatRow {
  task: TaskMeta;
  depth: number;
  hasChildren: boolean;
}

// 把一组（已排序的）任务按 parentTaskId 建树后 DFS 展平为渲染行，尊重折叠态。
// 折叠（collapsed[id]===true）的节点不展开其子。父不在本组 scope 的子由 buildTaskTree 自动升顶层
// （计算视图 Today/Inbox 天然扁平，KTD2）。带 seen 由 buildTaskTree 的 depth 回填保证不死循环。
function flattenForRender(items: TaskMeta[], collapsed: Record<string, boolean>): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (nodes: TaskTreeNode[]) => {
    for (const n of nodes) {
      const kids = n.children;
      out.push({ task: n, depth: n.depth, hasChildren: kids.length > 0 });
      if (kids.length > 0 && !collapsed[n.id]) walk(kids);
    }
  };
  walk(buildTaskTree(items));
  return out;
}

// 活动态（未 done/dropped）——中列只展示这些。已完成/已放弃在右栏详情/归档处理。
function isActive(t: TaskMeta): boolean {
  return t.status !== "done" && t.status !== "dropped";
}

// 组内默认排序（对照 plan U7）：flag 优先 → 逾期(due<today) → 有 due 按 due 升序 → 无 due 末尾。
// flag 是最高优先级（用户显式置顶信号）；其余按到期紧迫度降序（逾期最急、未逾期按 due 早晚、无 due 最松）。
function compareTasks(a: TaskMeta, b: TaskMeta, today: string): number {
  // 1. flag 优先。
  if (!!a.flagged !== !!b.flagged) return a.flagged ? -1 : 1;
  // 2/3/4. due 紧迫度：逾期(0) → 有 due 未逾期(1) → 无 due(2)。
  const dueRank = (t: TaskMeta): number => {
    if (!t.dueDate) return 2;
    return t.dueDate < today ? 0 : 1;
  };
  const ra = dueRank(a);
  const rb = dueRank(b);
  if (ra !== rb) return ra - rb;
  // 同为有 due（逾期或未逾期）→ 按 due 升序（早的在前）。
  if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  return 0;
}

interface TaskGroup {
  key: string;
  label: string;
  showHead: boolean; // 多 project 子树才显分组头；today/inbox/单 project 无头
  items: TaskMeta[];
}

export function TaskListColumn({
  selection,
  selectedTaskId,
  onOpenTask,
  onToast,
}: {
  selection: WorkbenchSelection;
  selectedTaskId?: string | null;
  onOpenTask: (id: string) => void;
  onToast: (text: string) => void;
}) {
  const tasks = useTasks().data ?? [];
  const projects = useTaskProjects().data ?? [];
  const addTask = useAddTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const delegate = useDelegateTask();
  const collapsedTasks = usePersonalStore((s) => s.collapsedTasks);
  const toggleTaskCollapse = usePersonalStore((s) => s.toggleTaskCollapse);

  const [draft, setDraft] = useState("");
  // 删除含子任务的父任务须两击确认（首击置 pending + toast，再击真删，KTD5）。
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const today = localDay(new Date());

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  // 读时兜底（KTD10）：projectId 不在当前项目表（悬空/已删）→ 视为 Inbox（无项目）。
  const effectiveProjectId = (t: TaskMeta): string | undefined =>
    t.projectId && projectById.has(t.projectId) ? t.projectId : undefined;

  // 按左树选择聚合 + 分组 + 组内排序。
  const groups = useMemo<TaskGroup[]>(() => {
    const active = tasks.filter(isActive);
    const sort = (items: TaskMeta[]) => [...items].sort((a, b) => compareTasks(a, b, today));

    if (selection.kind === "today") {
      return [{ key: "today", label: "今日", showHead: false, items: sort(active.filter((t) => isTodayEligible(t, today))) }];
    }
    if (selection.kind === "inbox") {
      return [{ key: "inbox", label: "收件箱", showHead: false, items: sort(active.filter((t) => !effectiveProjectId(t))) }];
    }

    // project / folder：统一走 descendantProjectIds 聚合子树内全部 project 的任务。
    const ids = descendantProjectIds(projects, selection.id);
    const idSet = new Set(ids);
    const scoped = active.filter((t) => {
      const pid = effectiveProjectId(t);
      return !!pid && idSet.has(pid);
    });
    // 单 project（或空子树）→ 单组无头；多 project 子树 → 按 project 分组（组头=project 名，
    // 组间顺序沿用 useTaskProjects 的项目列表顺序）。
    if (ids.length <= 1) {
      return [{ key: ids[0] ?? "single", label: "", showHead: false, items: sort(scoped) }];
    }
    return projects
      .filter((p) => idSet.has(p.id))
      .map<TaskGroup>((p) => ({
        key: p.id,
        label: p.name,
        showHead: true,
        items: sort(scoped.filter((t) => effectiveProjectId(t) === p.id)),
      }))
      .filter((g) => g.items.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, projects, selection, today]);

  const total = groups.reduce((n, g) => n + g.items.length, 0);

  // 快速新增归属（对照 plan U7）：
  //   project → 落该 project；folder → 落 Inbox（folder 只分组、无从定归属，KTD2）；
  //   today   → 落 Inbox 且 dueDate=today（今日视图新建即「今天要做」）；inbox → 无 project。
  const onQuickAdd = async () => {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    const projectId = selection.kind === "project" ? selection.id : undefined;
    if (selection.kind === "today") {
      // TaskInput 无 dueDate 字段 → 先建再 patch（add 成功后拿 id 补日期）。
      const created = await addTask.mutateAsync({ title, source: "manual" });
      updateTask.mutate({ id: created.id, patch: { dueDate: today } });
    } else {
      addTask.mutate({ title, projectId, source: "manual" });
    }
  };

  // 完成/取消完成（canTransition 守卫；waiting 任务需先取消委派，不能直接完成）。
  const toggleDone = (t: TaskMeta) => {
    const to = t.status === "done" ? "active" : "done";
    if (!canTransition(t.status, to, "user")) {
      onToast(t.status === "waiting" ? "该任务已委派给 agent，先取消委派" : "无法在当前状态完成");
      return;
    }
    updateTask.mutate({ id: t.id, patch: { status: to } });
  };

  // 新建子任务（U4，用户核心诉求）：继承父项目、挂到父下；若父被折叠则展开使新子可见；
  // 建后打开详情供改标题。默认标题占位，避免空标题任务。
  const onAddSubtask = async (parent: TaskMeta) => {
    if (collapsedTasks[parent.id]) toggleTaskCollapse(parent.id); // 展开父使新子可见
    const created = await addTask.mutateAsync({
      title: "新建子任务",
      projectId: parent.projectId,
      parentId: parent.id,
      source: "manual",
    });
    onOpenTask(created.id);
  };

  // 删除（U4/KTD5）：含子任务时两击确认（一并级联删子树，删除在 store 层）；无子任务直接删。
  const onDelete = (t: TaskMeta) => {
    const childCount = taskDescendantIds(tasks, t.id).length;
    if (childCount > 0 && pendingDelete !== t.id) {
      setPendingDelete(t.id);
      onToast(`此任务含 ${childCount} 个子任务，再次点击删除将一并删除`);
      return;
    }
    setPendingDelete(null);
    deleteTask.mutate(t.id);
  };

  // 完成 rollup 确认（U4/R5/KTD4）：全部子任务完成时父置 done（用户点击才触发，绝不自动）。
  const onCompleteSuggested = (t: TaskMeta) => {
    if (!canTransition(t.status, "done", "user")) {
      onToast("无法在当前状态完成");
      return;
    }
    updateTask.mutate({ id: t.id, patch: { status: "done" } });
  };

  const emptyText =
    selection.kind === "today"
      ? "今天没有到期或已安排的任务。"
      : selection.kind === "inbox"
        ? "收件箱已清空。"
        : selection.kind === "folder"
          ? "此分组下暂无任务。"
          : "此项目下暂无任务。";

  return (
    <div className="pw-projects-list">
      {/* 快速新增：归属按当前 selection 推导（见 onQuickAdd）。*/}
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

      {total === 0 ? (
        <div className="pw-empty-hint">{emptyText}</div>
      ) : (
        groups.map((g) => (
          <div key={g.key} className="pw-task-group">
            {g.showHead ? <div className="pw-task-group-head">{g.label}</div> : null}
            {flattenForRender(g.items, collapsedTasks).map(({ task: t, depth, hasChildren }) => (
              <TaskListRow
                key={t.id}
                task={t}
                today={today}
                depth={depth}
                hasChildren={hasChildren}
                collapsed={!!collapsedTasks[t.id]}
                onToggleCollapse={() => toggleTaskCollapse(t.id)}
                isSelected={t.id === selectedTaskId}
                onToast={onToast}
                // 分组头已显 project 名 → 组内行不再重复 project 徽标；无头（today/inbox/单组）才显。
                projectName={!g.showHead ? projectById.get(effectiveProjectId(t) ?? "")?.name : undefined}
                // 全部子任务完成 → 父行浮现「完成此任务」建议（派生，不自动 done，R5/KTD4）。
                suggestComplete={areAllChildrenDone(tasks, t.id)}
                onOpen={() => onOpenTask(t.id)}
                onToggleDone={() => toggleDone(t)}
                onToggleFlag={() => updateTask.mutate({ id: t.id, patch: { flagged: !t.flagged } })}
                onDelete={() => onDelete(t)}
                onAddSubtask={() => onAddSubtask(t)}
                onCompleteSuggested={() => onCompleteSuggested(t)}
                // keepView：委派为后台动作，不关工作台；toast 由 delegate 内部反映目标 cwd。
                onDelegate={() => delegate(t, onToast, { keepView: true })}
              />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

// 精简任务行：完成勾选 + 标题按钮（点开详情）+ 渐进披露徽标（有值才显）+ flag/删除/委派。
// 相比 TasksView 的 TaskRow 去掉结构化建议 chips（工作台不做捕获结构化，那是右栏主界面的职责）。
function TaskListRow({
  task,
  today,
  depth,
  hasChildren,
  collapsed,
  onToggleCollapse,
  isSelected,
  onToast,
  suggestComplete,
  projectName,
  onOpen,
  onToggleDone,
  onToggleFlag,
  onDelete,
  onAddSubtask,
  onCompleteSuggested,
  onDelegate,
}: {
  task: TaskMeta;
  today: string;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  isSelected: boolean;
  onToast: (text: string) => void;
  suggestComplete: boolean;
  projectName?: string;
  onOpen: () => void;
  onToggleDone: () => void;
  onToggleFlag: () => void;
  onDelete: () => void;
  onAddSubtask: () => void;
  onCompleteSuggested: () => void;
  onDelegate: () => void;
}) {
  const overdue = !!task.dueDate && task.dueDate < today;
  const delegated = task.status === "waiting" && !!task.delegation;
  return (
    <div className={`pw-task-row${isSelected ? " is-selected" : ""}`}>
      <div className="pw-task-row-main">
        {/* 子任务缩进：按 depth 留白（U3；U7 视觉细调）。*/}
        {depth > 0 && <span className="pw-task-indent" style={{ width: depth * INDENT_STEP }} aria-hidden />}
        {/* 折叠箭头：有子任务才显，否则占位对齐。*/}
        {hasChildren ? (
          <button
            className={`pw-task-twisty${collapsed ? "" : " is-open"}`}
            title={collapsed ? "展开子任务" : "折叠子任务"}
            aria-expanded={!collapsed}
            onClick={onToggleCollapse}
          >
            <Icon.Chevron size={11} />
          </button>
        ) : (
          <span className="pw-task-twisty pw-task-twisty-spacer" aria-hidden />
        )}
        <input type="checkbox" className="pw-task-check" checked={false} onChange={onToggleDone} title="完成" />
        <button className="pw-task-title pw-task-title-btn" title="打开详情" onClick={onOpen}>
          {task.title || "(无标题)"}
        </button>
        {/* 渐进披露：仅在有值时显示徽标（无日期/标签/项目的任务只渲染一行标题）。*/}
        {task.flagged && (
          <span className="pw-task-badge is-flag" title="已标记">
            ⚑
          </span>
        )}
        {delegated && (
          <span className="pw-task-badge is-wait" title="已委派 agent">
            委派中
          </span>
        )}
        {task.status === "in-progress" && <span className="pw-task-badge is-run">进行中</span>}
        {task.dueDate && <span className={`pw-task-badge is-due${overdue ? " is-overdue" : ""}`}>截止 {task.dueDate}</span>}
        {task.deferDate && !isAvailable(task, today) && <span className="pw-task-badge is-defer">延后 {task.deferDate}</span>}
        {task.tags.map((tag) => (
          <span key={tag} className="pw-task-badge is-tag">
            {tag}
          </span>
        ))}
        {projectName && <span className="pw-task-badge is-proj">{projectName}</span>}
        {/* 完成 rollup 建议（R5/KTD4）：全部子任务已完成时浮现，点击确认才置父 done（不自动）。*/}
        {suggestComplete && task.status !== "done" && (
          <button className="pw-task-badge is-suggest" title="全部子任务已完成，点击完成此任务" onClick={onCompleteSuggested}>
            ✓ 完成此任务
          </button>
        )}
        <div className="spacer" />
        {/* 添加子任务（U4）：新建子任务并打开详情供改标题。*/}
        <button className="pw-icon-btn" title="添加子任务" onClick={onAddSubtask}>
          <Icon.Plus size={13} />
        </button>
        {/* 委派仅对 active 任务开放（waiting 已在跑，避免二次委派）。*/}
        {task.status === "active" && (
          <button className="pw-icon-btn" title="交给 agent 执行" onClick={onDelegate}>
            <Icon.Bot size={13} />
          </button>
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
      {/* 行内 inspector（U6）：选中时在标题行下展开共享字段面板（inline 布局），作为主编辑面；
          右列 TaskDetail 仍随同一 selectedTaskId 显示，两处经同一 useUpdateTask + RQ cache 同步。 */}
      {isSelected && (
        <div className="pw-task-inspector" style={depth > 0 ? { marginLeft: depth * INDENT_STEP } : undefined}>
          <TaskFieldsPanel task={task} layout="inline" onToast={onToast} />
        </div>
      )}
    </div>
  );
}
