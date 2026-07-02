// 三栏项目工作台中列（U7）：按左树选择聚合任务清单 —— 分组 / 排序 / 快速新增 / 行内动作
//（完成、flag、删除、委派、打开详情）。服务端态全部来自 core hooks（React Query，main 是 owner，
// 不复制进 Zustand，KTD8）。本列运行在「项目管理」独立窗口：委派经 useDelegateTaskRelay 只发意图
// 给主窗口执行（sessions 不跨窗口，KTD10），不本地起会话、不关窗。
import { useEffect, useMemo, useRef, useState } from "react";
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
  matchedTaskIds,
  type TaskViewFilter,
} from "@cortex-work/core/personal/tasks";
import { descendantProjectIds } from "@cortex-work/core/personal/taskProjectTree";
import { buildTaskTree, taskDescendantIds, areAllChildrenDone, type TaskTreeNode } from "@cortex-work/core/personal/taskTree";
import { useDelegateTaskRelay } from "@cortex-work/core/personal/taskDelegate";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { TaskInlineInspector } from "./TaskInlineInspector";
import { useTaskDraftField } from "./useTaskDraftField";
import type { TaskMeta } from "@cortex-work/core/desktop/types";
import type { WorkbenchSelection } from "./ProjectsWorkbench";

// 子任务缩进步距（px）。每深一层左移一档，OmniFocus 风格（U3；U7 视觉细调）。
const INDENT_STEP = 22;

// 渲染行：任务 + 缩进深度 + 是否有子（决定折叠箭头）+ 是否为「上下文补行」。
// isContext（R15）：父任务被过滤档滤掉、但其子任务命中时，补一行灰显父作上下文——
// 该行不可勾选、不参与统计，仅用于让命中的子保持缩进层级可读。
interface FlatRow {
  task: TaskMeta;
  depth: number;
  hasChildren: boolean;
  isContext: boolean;
}

// 把一组（已排序的）任务按 parentTaskId 建树后 DFS 展平为渲染行，尊重折叠态。
// 折叠（collapsed[id]===true）的节点不展开其子。父不在本组 scope 的子由 buildTaskTree 自动升顶层
// （计算视图 Today/Inbox 天然扁平，KTD2）。带 seen 由 buildTaskTree 的 depth 回填保证不死循环。
// matchedIds 决定各行是否为上下文补行（不在命中集 = 补行，R15）。
function flattenForRender(
  items: TaskMeta[],
  collapsed: Record<string, boolean>,
  matchedIds: Set<string>,
): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (nodes: TaskTreeNode[]) => {
    for (const n of nodes) {
      const kids = n.children;
      out.push({ task: n, depth: n.depth, hasChildren: kids.length > 0, isContext: !matchedIds.has(n.id) });
      if (kids.length > 0 && !collapsed[n.id]) walk(kids);
    }
  };
  walk(buildTaskTree(items));
  return out;
}

// 为一个组补齐「命中子 + 灰显父上下文」的渲染集合（R15）。
// 入参：matchedItems=组内命中任务；inScopeById=组 scope 内全部任务（含未命中，供上溯父链）。
// 逻辑：对每个命中任务沿 parentTaskId 上溯，把 scope 内且未命中的祖先并入渲染集合作上下文补行；
// buildTaskTree 会据此把命中子嵌回补行父之下（补行父被排除时子会升顶层，故必须补父）。
function withContextRows(matchedItems: TaskMeta[], inScopeById: Map<string, TaskMeta>): TaskMeta[] {
  const includeIds = new Set(matchedItems.map((t) => t.id));
  for (const t of matchedItems) {
    let pid = t.parentTaskId;
    const guard = new Set<string>(); // 防悬空/自指环
    while (pid && !guard.has(pid)) {
      guard.add(pid);
      const parent = inScopeById.get(pid);
      if (!parent) break; // 父不在本组 scope（如 Today 计算视图）→ 由 buildTaskTree 自然扁平，不补
      includeIds.add(parent.id);
      pid = parent.parentTaskId;
    }
  }
  return [...includeIds].map((id) => inScopeById.get(id)!);
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
  matchedItems: TaskMeta[]; // 命中当前过滤档的任务（已排序），统计与渲染基
  scopeById: Map<string, TaskMeta>; // 组 scope 内全部任务（含未命中），供 R15 补上下文父行
}

export function TaskListColumn({
  selection,
  selectedTaskId,
  filter,
  forcedVisibleId,
  onOpenTask,
  onCreated,
  onSelectedHidden,
  onToast,
}: {
  selection: WorkbenchSelection;
  selectedTaskId?: string | null;
  // 四档过滤（U5/R10）：由容器持久化并下发；中栏据此派生命中集，不再自持三态筛选。
  filter: TaskViewFilter;
  // 刚新建的任务 id（R11）：无视当前过滤强制可见（否则「首先可用」等档下新建可能立即隐身）。
  forcedVisibleId?: string | null;
  onOpenTask: (id: string) => void;
  // 新建任务（快速新增 / 子任务）→ 通知容器选中并置为 forcedVisible（R11）。
  onCreated: (id: string) => void;
  // 选中任务离开命中集（切档 / 完成而隐藏，R18）→ 通知容器清选中回空态。
  onSelectedHidden: () => void;
  onToast: (text: string) => void;
}) {
  const tasks = useTasks().data ?? [];
  const projects = useTaskProjects().data ?? [];
  const addTask = useAddTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const delegate = useDelegateTaskRelay();
  const collapsedTasks = usePersonalStore((s) => s.collapsedTasks);
  const toggleTaskCollapse = usePersonalStore((s) => s.toggleTaskCollapse);

  const [draft, setDraft] = useState("");
  // 删除含子任务的父任务须两击确认（首击置 pending + toast，再击真删，KTD5）。
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  // 切换左树选择即清除待确认删除（code-review）：否则遗忘的首击会让下一次单击变成无二次确认的级联删除。
  useEffect(() => setPendingDelete(null), [selection]);
  const today = localDay(new Date());

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  // 读时兜底（KTD10）：projectId 不在当前项目表（悬空/已删）→ 视为 Inbox（无项目）。
  const effectiveProjectId = (t: TaskMeta): string | undefined =>
    t.projectId && projectById.has(t.projectId) ? t.projectId : undefined;

  // 命中集（R10）：按全量任务 + 项目模式派生四档命中 id；forcedVisibleId 强制并入（R11 新建无视过滤）。
  // 须传**排序后**的全量任务：sequentialAvailableIds / 首先可用均依赖显示顺序取「队首」。
  const matched = useMemo(() => {
    const sortedAll = [...tasks].sort((a, b) => compareTasks(a, b, today));
    const set = matchedTaskIds(sortedAll, projects, filter, today);
    if (forcedVisibleId) set.add(forcedVisibleId);
    return set;
  }, [tasks, projects, filter, today, forcedVisibleId]);

  // 按左树选择聚合 + 分组 + 组内排序。scope 不再按完成度预筛（改由命中集决定），
  // 但需保留 scope 内全部任务（含未命中）供 R15 上下文补行。
  const groups = useMemo<TaskGroup[]>(() => {
    const sort = (items: TaskMeta[]) => [...items].sort((a, b) => compareTasks(a, b, today));
    const mk = (key: string, label: string, showHead: boolean, scope: TaskMeta[]): TaskGroup => ({
      key,
      label,
      showHead,
      matchedItems: sort(scope.filter((t) => matched.has(t.id))),
      scopeById: new Map(scope.map((t) => [t.id, t])),
    });

    if (selection.kind === "today") {
      // Today scope：today-eligible（状态门控到 active/in-progress，命中集在其上再收窄）。
      return [mk("today", "今日", false, tasks.filter((t) => isTodayEligible(t, today)))];
    }
    if (selection.kind === "inbox") {
      return [mk("inbox", "收件箱", false, tasks.filter((t) => !effectiveProjectId(t)))];
    }

    // project / folder：统一走 descendantProjectIds 聚合子树内全部 project 的任务。
    const ids = descendantProjectIds(projects, selection.id);
    const idSet = new Set(ids);
    const scoped = tasks.filter((t) => {
      const pid = effectiveProjectId(t);
      return !!pid && idSet.has(pid);
    });
    // 单 project（或空子树）→ 单组无头；多 project 子树 → 按 project 分组（组头=project 名，
    // 组间顺序沿用 useTaskProjects 的项目列表顺序）。
    if (ids.length <= 1) {
      return [mk(ids[0] ?? "single", "", false, scoped)];
    }
    return projects
      .filter((p) => idSet.has(p.id))
      .map<TaskGroup>((p) => mk(p.id, p.name, true, scoped.filter((t) => effectiveProjectId(t) === p.id)))
      .filter((g) => g.matchedItems.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, projects, selection, today, matched]);

  // 统计口径（R15/R26）：total=命中行数（不含上下文补行）；scopeTotal=scope 内任务总数（区分空态文案）。
  const total = groups.reduce((n, g) => n + g.matchedItems.length, 0);
  const scopeTotal = groups.reduce((n, g) => n + g.scopeById.size, 0);

  // R18：选中任务存在于 tasks 但离开命中集（切档 / 完成而隐藏）→ 通知容器清选中。
  // 仅在任务仍存在时触发（已删/加载中不误清；forcedVisibleId 已并入 matched 故新建不误伤）。
  useEffect(() => {
    if (!selectedTaskId) return;
    const exists = tasks.some((t) => t.id === selectedTaskId);
    if (exists && !matched.has(selectedTaskId)) onSelectedHidden();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskId, matched, tasks]);

  // R11：新建任务滚动到可见。forcedVisibleId 落地后按 data-task-id 定位其行滚入视口
  //（jsdom 无 scrollIntoView，可选链兜底不报错）。
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!forcedVisibleId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-task-id="${forcedVisibleId}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [forcedVisibleId, matched]);

  // 快速新增归属（对照 plan U7）：
  //   project → 落该 project；folder → 落 Inbox（folder 只分组、无从定归属，KTD2）；
  //   today   → 落 Inbox 且 dueDate=today（今日视图新建即「今天要做」）；inbox → 无 project。
  const onQuickAdd = async () => {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    const projectId = selection.kind === "project" ? selection.id : undefined;
    try {
      if (selection.kind === "today") {
        // TaskInput 无 dueDate 字段 → 先建再 patch（add 成功后拿 id 补日期）。
        const created = await addTask.mutateAsync({ title, source: "manual" });
        updateTask.mutate({ id: created.id, patch: { dueDate: today } });
        onCreated(created.id); // R11：无视过滤选中 + 强制可见
      } else {
        const created = await addTask.mutateAsync({ title, projectId, source: "manual" });
        onCreated(created.id);
      }
    } catch {
      onToast("新建任务失败，请重试");
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
    // try/catch（code-review）：store 拒写（corrupt 态 / IPC 失败）时不产生 unhandled rejection，给用户反馈。
    // 空标题创建（问题2）：行内标题显「未命名的动作」占位并自动聚焦，用户直接就地输入。
    try {
      const created = await addTask.mutateAsync({
        title: "",
        projectId: parent.projectId,
        parentId: parent.id,
        source: "manual",
      });
      onCreated(created.id); // R11：无视过滤选中 + 强制可见
    } catch {
      onToast("新建子任务失败，请重试");
    }
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

  // 空态双文案（R26）：scope 内本就无任务 → 「暂无动作」；有任务但被当前过滤档全部滤掉 → 「无匹配动作」。
  const emptyText =
    scopeTotal === 0
      ? selection.kind === "today"
        ? "今天没有到期或已安排的任务。"
        : selection.kind === "inbox"
          ? "收件箱已清空。"
          : selection.kind === "folder"
            ? "此分组下暂无任务。"
            : "此项目下暂无任务。"
      : "当前「显示」档下无匹配动作。";

  return (
    <div className="pw-projects-list" ref={listRef}>
      {/* 快速新增：归属按当前 selection 推导（见 onQuickAdd）。三态筛选已迁至工具栏「显示」弹层（U5）。*/}
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
            {flattenForRender(withContextRows(g.matchedItems, g.scopeById), collapsedTasks, matched).map(
              ({ task: t, depth, hasChildren, isContext }) =>
                isContext ? (
                  // R15 上下文补行：灰显父标题，不可勾选、不参与统计、不可选中。
                  <ContextRow key={t.id} task={t} depth={depth} />
                ) : (
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
                    onRename={(title) => updateTask.mutate({ id: t.id, patch: { title } })}
                    onToggleDone={() => toggleDone(t)}
                    onToggleFlag={() => updateTask.mutate({ id: t.id, patch: { flagged: !t.flagged } })}
                    onDelete={() => onDelete(t)}
                    onAddSubtask={() => onAddSubtask(t)}
                    onCompleteSuggested={() => onCompleteSuggested(t)}
                    // 委派只发意图给主窗口执行（sessions 不跨窗口，KTD10）；本地即时 toast。
                    onDelegate={() => delegate(t, onToast)}
                  />
                ),
            )}
          </div>
        ))
      )}
    </div>
  );
}

// R15 上下文补行：父被过滤档滤掉但其子命中时，灰显父标题占位以保留缩进层级。
// 无勾选、无操作、不可选中；纯上下文，避免误改被滤父。补行不承担折叠——其命中子由
// buildTaskTree 直接嵌在其下逐行渲染，无需在补行上再挂折叠箭头。
function ContextRow({ task, depth }: { task: TaskMeta; depth: number }) {
  return (
    <div className="pw-task-row is-context" aria-hidden>
      <div className="pw-task-row-main">
        {depth > 0 && <span className="pw-task-indent" style={{ width: depth * INDENT_STEP }} aria-hidden />}
        <span className="pw-task-twisty pw-task-twisty-spacer" aria-hidden />
        <span className="pw-task-check pw-task-check-ghost" aria-hidden />
        <span className="pw-task-title-input pw-task-context-title">{task.title || "未命名的动作"}</span>
      </div>
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
  onRename,
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
  onRename: (title: string) => void;
  onToggleDone: () => void;
  onToggleFlag: () => void;
  onDelete: () => void;
  onAddSubtask: () => void;
  onCompleteSuggested: () => void;
  onDelegate: () => void;
}) {
  const overdue = !!task.dueDate && task.dueDate < today;
  const delegated = task.status === "waiting" && !!task.delegation;
  const done = task.status === "done";
  return (
    <div className={`pw-task-row${isSelected ? " is-selected" : ""}${done ? " is-done" : ""}`} data-task-id={task.id}>
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
        <input
          type="checkbox"
          className="pw-task-check"
          checked={done}
          onChange={onToggleDone}
          title={done ? "取消完成" : "完成"}
        />
        {/* 行内可编辑标题（问题2）：空标题显「未命名的动作」占位；聚焦即选中该行（展开 inspector）。*/}
        <TaskTitleInput taskId={task.id} value={task.title} done={done} onFocus={onOpen} onSave={onRename} />
        {/* 未选中时显示紧凑徽标（快速一览）；选中时属性交由行内 inspector 编辑，避免重复。*/}
        {!isSelected && (
          <>
            {task.flagged && <span className="pw-task-badge is-flag" title="已标记">⚑</span>}
            {delegated && <span className="pw-task-badge is-wait" title="已委派 agent">委派中</span>}
            {task.status === "in-progress" && <span className="pw-task-badge is-run">进行中</span>}
            {task.dueDate && <span className={`pw-task-badge is-due${overdue ? " is-overdue" : ""}`}>截止 {task.dueDate}</span>}
            {task.deferDate && !isAvailable(task, today) && <span className="pw-task-badge is-defer">延后 {task.deferDate}</span>}
            {task.tags.map((tag) => (
              <span key={tag} className="pw-task-badge is-tag">{tag}</span>
            ))}
            {projectName && <span className="pw-task-badge is-proj">{projectName}</span>}
          </>
        )}
        {/* 完成 rollup 建议（R5/KTD4）：全部子任务已完成时浮现，点击确认才置父 done（不自动）。*/}
        {suggestComplete && !done && (
          <button className="pw-task-badge is-suggest" title="全部子任务已完成，点击完成此任务" onClick={onCompleteSuggested}>
            ✓ 完成此任务
          </button>
        )}
        <div className="spacer" />
        {/* 添加子任务（U4）。*/}
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
      {/* 行内 inspector（问题2）：选中时在标题行下展开紧凑属性栏（图 #2 样式），作为主编辑面；
          右列 TaskDetail 仍随同一 selectedTaskId 显示完整面板，两处经同一 useUpdateTask + RQ cache 同步。 */}
      {isSelected && (
        <div className="pw-task-inspector" style={depth > 0 ? { marginLeft: depth * INDENT_STEP } : undefined}>
          <TaskInlineInspector task={task} today={today} onToast={onToast} />
        </div>
      )}
    </div>
  );
}

// 行内可编辑标题：受控草稿走共享守卫 hook（U1/KTD6）——切任务重置、未聚焦时跟随外部值
// （跨列/跨窗口热更）、聚焦中不被冲掉。失焦 / 回车保存（trim 归一）。聚焦即选中该行。
function TaskTitleInput({
  taskId,
  value,
  done,
  onFocus,
  onSave,
}: {
  taskId: string;
  value: string;
  done: boolean;
  onFocus: () => void;
  onSave: (title: string) => void;
}) {
  const draft = useTaskDraftField({
    taskId,
    external: value,
    onCommit: onSave,
    normalize: (v) => v.trim(),
  });
  return (
    <input
      className={`pw-task-title-input${done ? " is-done" : ""}`}
      value={draft.value}
      placeholder="未命名的动作"
      autoFocus={!value}
      onFocus={() => {
        draft.onFocus();
        onFocus();
      }}
      onChange={(e) => draft.setValue(e.target.value)}
      onBlur={draft.onBlur}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          draft.commit();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
