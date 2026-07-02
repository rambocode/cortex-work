// 三栏项目工作台中列（U6 OmniFocus 大纲式）：顶部大标题 + 统计条「N 个动作，M 个项目」+「已选择」条；
// 按左树选择聚合任务清单 —— 分组（项目/文件夹；今日·收件箱按所属项目分组，R25）/ 组头（名称·计数·折叠·
// 顺序模式标识，R14）/ 组内排序 / 快速新增 / 行内动作。行渲染拆到 TaskOutlineRow（防单文件超 1200 行）。
// 服务端态全部来自 core hooks（React Query，main 是 owner，不复制进 Zustand，KTD8）。本列运行在「项目管理」
// 独立窗口：委派经 useDelegateTaskRelay 只发意图给主窗口执行（sessions 不跨窗口，KTD10），不本地起会话、不关窗。
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useTasks,
  useTaskProjects,
  useAddTask,
  useUpdateTask,
  useDeleteTask,
  isTodayEligible,
  canTransition,
  localDay,
  matchedTaskIds,
  projectMode,
  type TaskViewFilter,
} from "@cortex-work/core/personal/tasks";
import { descendantProjectIds } from "@cortex-work/core/personal/taskProjectTree";
import { buildTaskTree, taskDescendantIds, areAllChildrenDone, type TaskTreeNode } from "@cortex-work/core/personal/taskTree";
import { useDelegateTaskRelay } from "@cortex-work/core/personal/taskDelegate";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { TaskOutlineRow, ContextRow } from "./TaskOutlineRow";
import type { TaskMeta } from "@cortex-work/core/desktop/types";
import type { WorkbenchSelection } from "./ProjectsWorkbench";

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
  key: string; // project 组 = project id（供组头查 mode / 折叠态）；今日无项目组 = "inbox"
  label: string;
  showHead: boolean; // 多 project 子树 / 今日跨项目才显分组头；inbox / 单 project 无头
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
  // 选中任务离开命中集（切档 / 完成而隐藏，R18）→ 通知容器清选中回空态；亦作「已选择」条清除入口（R13）。
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
  // 组头折叠态（R14）：窗口内 UI 瞬态（本单元不落库；KTD9 持久化归窗口专属 KV，超本单元 Files 范围）。
  // 折叠仅隐藏该组行，不影响统计（统计按过滤命中而非可见性）。
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = (key: string) => setCollapsedGroups((m) => ({ ...m, [key]: !m[key] }));
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

    // 按所属项目分组（R25）：非项目视图（今日）用；scope 内任务按 effectiveProjectId 分桶——
    // 有项目 → 组头=项目名（按项目列表顺序）；无项目 → 「收件箱」组（置末，平铺）。
    const groupByProject = (scope: TaskMeta[]): TaskGroup[] => {
      const byPid = new Map<string, TaskMeta[]>();
      for (const t of scope) {
        const pid = effectiveProjectId(t) ?? "";
        const arr = byPid.get(pid);
        if (arr) arr.push(t);
        else byPid.set(pid, [t]);
      }
      const out: TaskGroup[] = [];
      for (const p of projects) {
        const items = byPid.get(p.id);
        if (items && items.length) out.push(mk(p.id, p.name, true, items));
      }
      const inboxItems = byPid.get("");
      if (inboxItems && inboxItems.length) out.push(mk("inbox", "收件箱", true, inboxItems));
      return out.filter((g) => g.matchedItems.length > 0);
    };

    if (selection.kind === "today") {
      // Today scope：today-eligible（状态门控到 active/in-progress，命中集在其上再收窄）→ 按项目分组（R25）。
      return groupByProject(tasks.filter((t) => isTodayEligible(t, today)));
    }
    if (selection.kind === "inbox") {
      // Inbox 视图全是无项目任务 → 单「收件箱」组，无头（顶部大标题已表明视图）。
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

  // 统计口径（R13/R26）：total=命中行数（不含上下文补行）；scopeTotal=scope 内任务总数（区分空态文案）。
  const total = groups.reduce((n, g) => n + g.matchedItems.length, 0);
  const scopeTotal = groups.reduce((n, g) => n + g.scopeById.size, 0);

  // 顶部大标题（R13）：视图名——今日/收件箱为固定名，project/folder 取其节点名（悬空兜底）。
  const viewTitle =
    selection.kind === "today"
      ? "今日"
      : selection.kind === "inbox"
        ? "收件箱"
        : projectById.get(selection.id)?.name ?? (selection.kind === "folder" ? "分组" : "项目");

  // 顺序项目模式标识（R14/R24）：单选一个顺序 project 时在大标题旁标注（多项目组头各自标注，见下）。
  const titleSequential =
    selection.kind === "project" && projectMode(projectById.get(selection.id) ?? {}) === "sequential";

  // 统计条项目数 M（R13）：项目/文件夹视图取选择范围内 project 节点数；
  // 今日/收件箱等非项目视图取命中任务所属去重项目数（无项目任务不计）。
  const projectCount = useMemo(() => {
    if (selection.kind === "project" || selection.kind === "folder") {
      return descendantProjectIds(projects, selection.id).length;
    }
    const s = new Set<string>();
    for (const g of groups) for (const t of g.matchedItems) {
      const pid = effectiveProjectId(t);
      if (pid) s.add(pid);
    }
    return s.size;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, projects, groups]);

  // 「已选择」条（R13）：选中任务仍存在时呈现清除入口。已删/加载中不误显。
  const hasSelection = !!selectedTaskId && tasks.some((t) => t.id === selectedTaskId);

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
      {/* 顶部大标题 + 统计条（R13）：视图名 + 「N 个动作，M 个项目」；选中时右侧「已选择」条（含清除）。 */}
      <div className="pw-outline-head">
        <div className="pw-outline-title">
          <span className="pw-outline-title-text">{viewTitle}</span>
          {titleSequential && <span className="pw-outline-mode" title="顺序项目">顺序</span>}
        </div>
        <div className="pw-outline-stats">
          <span className="pw-outline-count">
            {total} 个动作，{projectCount} 个项目
          </span>
          {hasSelection && (
            <span className="pw-outline-selected">
              已选择
              <button className="pw-outline-clear" title="清除选中" onClick={onSelectedHidden}>
                <Icon.Chevron size={10} /> 清除
              </button>
            </span>
          )}
        </div>
      </div>

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
        groups.map((g) => {
          // 组头顺序标识（R14）：project 组按其 mode 标注；今日无项目组（key="inbox"）无 project → 无标识。
          const groupSequential = projectMode(projectById.get(g.key) ?? {}) === "sequential";
          const groupCollapsed = !!collapsedGroups[g.key];
          return (
            <div key={g.key} className="pw-task-group">
              {g.showHead ? (
                // 组头（R14）：折叠三角 + 名称 + 计数 + 顺序模式标识。折叠只隐藏本组行，统计不变。
                <button
                  className="pw-task-group-head"
                  aria-expanded={!groupCollapsed}
                  onClick={() => toggleGroup(g.key)}
                >
                  <span className={`pw-task-group-twisty${groupCollapsed ? "" : " is-open"}`} aria-hidden>
                    <Icon.Chevron size={10} />
                  </span>
                  <span className="pw-task-group-name">{g.label}</span>
                  <span className="pw-task-group-count">{g.matchedItems.length}</span>
                  {groupSequential && <span className="pw-outline-mode" title="顺序项目">顺序</span>}
                </button>
              ) : null}
              {!groupCollapsed &&
                flattenForRender(withContextRows(g.matchedItems, g.scopeById), collapsedTasks, matched).map(
                  ({ task: t, depth, hasChildren, isContext }) =>
                    isContext ? (
                      // R15 上下文补行：灰显父标题，不可勾选、不参与统计、不可选中。
                      <ContextRow key={t.id} task={t} depth={depth} />
                    ) : (
                      <TaskOutlineRow
                        key={t.id}
                        task={t}
                        today={today}
                        depth={depth}
                        hasChildren={hasChildren}
                        collapsed={!!collapsedTasks[t.id]}
                        onToggleCollapse={() => toggleTaskCollapse(t.id)}
                        isSelected={t.id === selectedTaskId}
                        onToast={onToast}
                        // 分组头已显 project 名 → 组内行隐藏项目 chip（含占位），避免重复（R16）。
                        groupedByProject={g.showHead}
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
          );
        })
      )}
    </div>
  );
}
