// 真任务系统的 core 层：纯逻辑（状态/日期派生、tag 规范化、状态迁移矩阵）。
// React Query 读写 hooks 由 U4 追加于本文件底部；结构化触发 hook 由 U6 追加。
// 纯函数无 React/IO 依赖，便于表驱动单测（见 tasks.test.ts）。
// 数据类型定义在 ../desktop/types（与 apps/desktop/src/main/ipc/types.ts 逐字镜像）。

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DesktopBridge } from "../desktop/bridge";
import type { ArchivedTask, Member, ProjectStage, StageTemplate, TaskInput, TaskMeta, TaskProject, TaskProjectKind, TaskProjectMode, TaskProjectStatus, TaskStatus } from "../desktop/types";
import { buildTaskTree, type TaskTreeNode } from "./taskTree";
import { useDesktopBridge } from "../provider";

// 可执行的状态集：仅这两态视为「可用/可执行」，defer 门控叠加其上。
const ACTIONABLE: readonly TaskStatus[] = ["active", "in-progress"];

// 把 Date 格式化为本地日历日 YYYY-MM-DD（零填充）。
// 用本地日而非 UTC：任务的 due/defer 是用户心智里的「哪一天」，跨时区/DST 以本地日历为准。
export function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// available（可执行/可用）是派生属性：状态可执行 且 未被 defer 到未来。
// today 由调用方传入（本地日 YYYY-MM-DD），保持纯函数可测。
export function isAvailable(task: Pick<TaskMeta, "status" | "deferDate">, today: string): boolean {
  if (!ACTIONABLE.includes(task.status)) return false;
  if (task.deferDate && task.deferDate > today) return false;
  return true;
}

// Today 资格（KTD7）：状态门控统一前置；三条 OR 子句（今天到期/逾期、defer≤today、已 flag）；
// defer>due 时 due 优先（逾期/今天到期任务无视未来 defer 仍进）。
export function isTodayEligible(
  task: Pick<TaskMeta, "status" | "deferDate" | "dueDate" | "flagged">,
  today: string,
): boolean {
  if (!ACTIONABLE.includes(task.status)) return false;
  const dueReached = !!task.dueDate && task.dueDate <= today;
  const deferReached = !!task.deferDate && task.deferDate <= today;
  const deferInFuture = !!task.deferDate && task.deferDate > today;
  // defer 到未来：只有已逾期/今天到期的 due 能压过它，否则整条任务被 defer 压住不进 Today。
  if (deferInFuture) return dueReached;
  return dueReached || deferReached || !!task.flagged;
}

// ── 项目执行模式与顺序可用集（U8/KTD5，R23）────────────────────────────────
// mode 读时默认 parallel（与 store normalizeData 补默认一致；纯函数对旧档 undefined 容错）。
export function projectMode(p: Pick<TaskProject, "mode">): TaskProjectMode {
  return p.mode ?? "parallel";
}

// 终态：done/dropped 视为已完结，顺序项目「队首」跳过之。
const TERMINAL_STATUS: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "dropped"]);

// 顺序项目可用集（R23）：入参为**同一项目**下的全部任务（含子任务），须已按显示顺序排好。
// 语义（对齐 OmniFocus 顺序项目）：
//   1) 按顶层任务显示顺序取第一个非 done/dropped 者为「队首」；无（全部完结）→ 空集。
//   2) 队首被 defer 压到未来（deferDate > today）→ 整个项目阻塞、返回空集
//      （后续任务不得因自身无 defer 抢跑，与 OmniFocus 一致）。
//   3) 否则可用集 = 队首及其后代子树中各自 isAvailable 的任务 id
//      （子任务组内仍并行——action-group 级顺序/并行本期延后，见 Scope Boundaries）。
// 返回 id 集合，供 U5 四档过滤按 mode 派生消费。纯函数、无 IO。
export function sequentialAvailableIds(tasks: TaskMeta[], today: string): Set<string> {
  const out = new Set<string>();
  const roots = buildTaskTree(tasks);
  const front = roots.find((r) => !TERMINAL_STATUS.has(r.status));
  if (!front) return out; // 顶层任务全部完结 → 无可用
  if (front.deferDate && front.deferDate > today) return out; // 队首被 defer 压住 → 整体阻塞
  const visit = (node: TaskTreeNode) => {
    if (isAvailable(node, today)) out.add(node.id);
    for (const child of node.children) visit(child);
  };
  visit(front);
  return out;
}

// ── 显示弹层四档过滤（U5/KTD5，R10）─────────────────────────────────────────
// 四档语义（对齐 OmniFocus「显示」弹层）：
//   all             = 全部任务（含 done/dropped）
//   remaining       = 未完成未丢弃（剩余）
//   available       = remaining 中按所属项目模式「可用」（并行走 isAvailable / 顺序走收窄集）
//   first-available = 每个项目可用集在显示顺序中的首项（每项目至多一条）
export type TaskViewFilter = "first-available" | "available" | "remaining" | "all";

// 弹层单选项元数据（值 + 中文标签），供 UI 渲染与遍历，避免各处硬编码顺序。
export const TASK_VIEW_FILTERS: readonly { value: TaskViewFilter; label: string }[] = [
  { value: "first-available", label: "首先可用" },
  { value: "available", label: "可用" },
  { value: "remaining", label: "剩余" },
  { value: "all", label: "全部" },
];

// 「剩余」谓词：未完结（非 done/dropped）。
function isRemaining(task: Pick<TaskMeta, "status">): boolean {
  return task.status !== "done" && task.status !== "dropped";
}

// 计算某过滤档下「直接命中」的任务 id 集合（不含被滤父的孤儿上下文补行——那由视图层 R15 另补）。
// 关键契约：`tasks` 须为**全量任务**且已按显示顺序排好——「首先可用」按数组顺序取每桶首个可用项，
// 顺序（sequential）项目的「队首」也依赖输入顺序（sequentialAvailableIds 以输入序建树）。
// `projects` 仅用于查项目 mode（缺省 parallel）。纯函数、无 IO，供中栏过滤与统计共用一份派生结果。
export function matchedTaskIds(
  tasks: TaskMeta[],
  projects: Pick<TaskProject, "id" | "mode">[],
  filter: TaskViewFilter,
  today: string,
): Set<string> {
  if (filter === "all") return new Set(tasks.map((t) => t.id));
  if (filter === "remaining") return new Set(tasks.filter(isRemaining).map((t) => t.id));

  // available / first-available：按所属项目分桶，按 mode 派生可用集。
  // 悬空/无项目（不在项目表）归入空串桶，按并行处理（收件箱无顺序语义）。
  const modeById = new Map(projects.map((p) => [p.id, projectMode(p)]));
  const knownIds = new Set(projects.map((p) => p.id));
  const buckets = new Map<string, TaskMeta[]>();
  for (const t of tasks) {
    const pid = t.projectId && knownIds.has(t.projectId) ? t.projectId : "";
    const arr = buckets.get(pid);
    if (arr) arr.push(t);
    else buckets.set(pid, [t]);
  }
  const available = new Set<string>();
  for (const [pid, items] of buckets) {
    const mode = pid ? (modeById.get(pid) ?? "parallel") : "parallel";
    if (mode === "sequential") {
      for (const id of sequentialAvailableIds(items, today)) available.add(id);
    } else {
      for (const t of items) if (isAvailable(t, today)) available.add(t.id);
    }
  }
  if (filter === "available") return available;
  // first-available：每桶取「队首」可用项（每项目至多一条）。
  // 队首语义对齐 OmniFocus——是顶层动作，而非因 flagged/更早 due 排到前面的子任务：
  // 故优先取桶内首个可用的顶层任务（parentTaskId 为空）；无顶层可用时才回退到首个可用项。
  const out = new Set<string>();
  for (const [, items] of buckets) {
    const firstTop = items.find((t) => !t.parentTaskId && available.has(t.id));
    const first = firstTop ?? items.find((t) => available.has(t.id));
    if (first) out.add(first.id);
  }
  return out;
}

// 标签规范化：trim + 小写归一；空/纯空白返回 null（调用方据此丢弃）。
// 归一是为了 @Email 与 @email 视为同一标签、Tags 视图不被近重复撑爆。
export function normalizeTag(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  return t.length ? t : null;
}

// 状态迁移矩阵。关键不变式：任何「到达 in-progress」的迁移仅 agent 驱动（用户不可手动置）。
// 成功委派经 in-progress→done（用户确认）；waiting→done 无直接边（成功先归一化到 in-progress）。
const USER_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  active: ["waiting", "done", "dropped"], // 交给 agent(→waiting)、手动完成、放弃
  waiting: ["active", "dropped"], // 取消委派/回退、放弃
  "in-progress": ["done", "dropped"], // 确认 done、放弃(取消 session)
  done: ["active"], // 恢复
  dropped: ["active"], // 恢复
};
// 唯一的 agent 驱动边：waiting→in-progress（实际拉起）、in-progress→waiting（失败/取消回退）。
// 成功不走 agent 直达 done——先归一化到 in-progress，再由用户确认（in-progress→done，用户边）。
const AGENT_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  active: [],
  waiting: ["in-progress"],
  "in-progress": ["waiting"],
  done: [],
  dropped: [],
};

// 校验一次状态迁移是否合法。by 区分用户手动 vs agent 驱动。
export function canTransition(from: TaskStatus, to: TaskStatus, by: "user" | "agent"): boolean {
  if (from === to) return false;
  const table = by === "agent" ? AGENT_TRANSITIONS : USER_TRANSITIONS;
  return table[from].includes(to);
}

// 委派回写重校验（U12/研究 rank6/rank10 的数据安全核心）：agent 会话终态到达时，是否接受回写。
// 谓词：任务仍存在 且 status ∈ {waiting, in-progress} 且 delegation.sessionId 与本次回写匹配。
// 否则丢弃回写——不复活已删/已终态(done/dropped/active)任务、不 clobber 后一次委派(sessionId 不符)。
export function shouldAcceptDelegationWriteback(
  task: Pick<TaskMeta, "status" | "delegation"> | undefined,
  sessionId: string,
): boolean {
  if (!task) return false;
  if (task.status !== "waiting" && task.status !== "in-progress") return false;
  return task.delegation?.sessionId === sessionId;
}

// ── React Query 读写 hooks（U4；main 是 owner，服务端态走 RQ 不复制进 Zustand）──────
// query key 以 projectId 命名空间（桌面端无 wsId 概念，绝不用 wsId）。mutation 成功后
// 只 invalidate、不 setQueryData，让 RQ 重拉 main 权威值（遵 CLAUDE.md 事件只触发 invalidation）。

// 无归属占位段——绝不用 wsId。
const NO_PROJECT = "no-project";

export const tasksKeys = {
  all: ["personal", "tasks"] as const,
  byProject: (projectId: string) => ["personal", "tasks", projectId] as const,
  projects: ["personal", "task-projects"] as const,
};

// 任务能力是否可用（无 bridge / web / 旧壳缺方法 → UI 隐藏 Tasks 入口）。
export function tasksAvailable(bridge: DesktopBridge | null): boolean {
  return !!bridge?.tasksList;
}
export function useTasksAvailable(): boolean {
  return tasksAvailable(useDesktopBridge());
}

// 任务列表：无 projectId → 全部；有 → 该 project。
export function useTasks(projectId?: string) {
  const bridge = useDesktopBridge();
  return useQuery<TaskMeta[]>({
    queryKey: projectId === undefined ? tasksKeys.all : tasksKeys.byProject(projectId ?? NO_PROJECT),
    enabled: !!bridge?.tasksList,
    queryFn: () => bridge!.tasksList!(projectId),
    staleTime: Infinity,
    refetchOnWindowFocus: true, // 兜底事件丢失
  });
}

export function useTaskProjects() {
  const bridge = useDesktopBridge();
  return useQuery<TaskProject[]>({
    queryKey: tasksKeys.projects,
    enabled: !!bridge?.tasksListProjects,
    queryFn: () => bridge!.tasksListProjects!(),
    staleTime: Infinity,
    refetchOnWindowFocus: true,
  });
}

export type TaskPatch = Partial<Omit<TaskMeta, "id" | "createdAt">>;

export function useAddTask() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<TaskMeta, Error, TaskInput>({
    mutationFn: (input) => bridge!.tasksAdd!(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: tasksKeys.all }),
  });
}

export function useUpdateTask() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<TaskMeta | null, Error, { id: string; patch: TaskPatch }>({
    mutationFn: (v) => bridge!.tasksUpdate!(v.id, v.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: tasksKeys.all }),
  });
}

export function useDeleteTask() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => bridge!.tasksDelete!(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: tasksKeys.all }),
  });
}

// 新建 task-project（U3 加层级）：入参兼容 string（旧字符串调用点）与对象 {name,parentId?,kind?}。
// stages 承接「创建项目时选模板」的实例化结果（instantiateStages 产出），随 addProject 一次落库。
export type AddTaskProjectVars =
  | string
  | { name: string; parentId?: string; kind?: TaskProjectKind; stages?: ProjectStage[]; note?: string; status?: TaskProjectStatus };
export function useAddTaskProject() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<TaskProject, Error, AddTaskProjectVars>({
    mutationFn: (v) => {
      const input = typeof v === "string" ? { name: v } : v;
      return bridge!.tasksAddProject!(input.name, {
        parentId: input.parentId,
        kind: input.kind,
        stages: input.stages,
        note: input.note,
        status: input.status,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: tasksKeys.projects }),
  });
}

// 更新 task-project（U3/U8）：rename + reparent + 切换 mode（并行/顺序，KTD5）+
// note/status/stages（项目设置面板与阶段管理）。替换 stages 时 store 同锁清孤儿 stageId、
// 可能改任务，故 tasks + projects 两个 key 都失效。
export type UpdateTaskProjectPatch = {
  name?: string;
  parentId?: string | null;
  mode?: TaskProjectMode;
  note?: string;
  status?: TaskProjectStatus;
  stages?: ProjectStage[];
};
export function useUpdateTaskProject() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<TaskProject | null, Error, { id: string; patch: UpdateTaskProjectPatch }>({
    mutationFn: (v) => bridge!.tasksUpdateProject!(v.id, v.patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tasksKeys.all });
      qc.invalidateQueries({ queryKey: tasksKeys.projects });
    },
  });
}

// 删除 task-project：其下任务 reparent 到 Inbox（KTD10）；任务与项目两个 key 都失效。
export function useDeleteTaskProject() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (projectId) => bridge!.tasksDeleteProject!(projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tasksKeys.all });
      qc.invalidateQueries({ queryKey: tasksKeys.projects });
    },
  });
}

// 归档 done/dropped 任务（U13/R27）。summary 由调用方生成（best-effort 摘要或标题兜底）。
export function useArchiveTask() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<boolean, Error, { id: string; summary: string }>({
    mutationFn: (v) => bridge!.tasksArchive!(v.id, v.summary),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tasksKeys.all });
      qc.invalidateQueries({ queryKey: ["personal", "tasks-archived"] });
    },
  });
}

export function useArchivedTasks() {
  const bridge = useDesktopBridge();
  return useQuery<ArchivedTask[]>({
    queryKey: ["personal", "tasks-archived"],
    enabled: !!bridge?.tasksListArchived,
    queryFn: () => bridge!.tasksListArchived!(),
    staleTime: Infinity,
    refetchOnWindowFocus: true,
  });
}

// tasks:changed 推全量快照，但这里只 invalidate（任务 + 项目两个 key），让 RQ 重拉权威值。
// 工作区根部挂载一次；onTasksChanged 返回 removeListener，卸载即清。
export function useTasksChangeSubscription(): void {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  useEffect(() => {
    if (!bridge?.onTasksChanged) return;
    return bridge.onTasksChanged(() => {
      qc.invalidateQueries({ queryKey: tasksKeys.all });
      qc.invalidateQueries({ queryKey: tasksKeys.projects });
    });
  }, [bridge, qc]);
}

// ── 团队成员 / 岗位标签 / 阶段模板 hooks（项目管理扩展，参照 IFocus）────────────────
// 与 tasks 同一约定：mutation 成功只 invalidate；跨窗口同步靠 useTaskResourcesSubscription。

export const membersKey = ["personal", "task-members"] as const;
export const jobTypesKey = ["personal", "task-job-types"] as const;
export const stageTemplatesKey = ["personal", "task-stage-templates"] as const;

export function useMembers() {
  const bridge = useDesktopBridge();
  return useQuery<Member[]>({
    queryKey: membersKey,
    enabled: !!bridge?.membersList,
    queryFn: () => bridge!.membersList!(),
    staleTime: Infinity,
    refetchOnWindowFocus: true,
  });
}

export function useAddMember() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<Member, Error, { name: string; role?: string }>({
    mutationFn: (input) => bridge!.membersAdd!(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: membersKey }),
  });
}

export function useUpdateMember() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<Member | null, Error, { id: string; patch: { name?: string; role?: string } }>({
    mutationFn: (v) => bridge!.membersUpdate!(v.id, v.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: membersKey }),
  });
}

// 删成员会级联清任务 memberIds（store 同锁），故 tasks key 一并失效。
export function useDeleteMember() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => bridge!.membersDelete!(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: membersKey });
      qc.invalidateQueries({ queryKey: tasksKeys.all });
    },
  });
}

// 岗位标签库：undefined = 用户从未编辑（消费端经 resolveJobTypes 取默认表）。
export function useJobTypes() {
  const bridge = useDesktopBridge();
  return useQuery<string[] | undefined>({
    queryKey: jobTypesKey,
    enabled: !!bridge?.jobTypesList,
    queryFn: () => bridge!.jobTypesList!(),
    staleTime: Infinity,
    refetchOnWindowFocus: true,
  });
}

export function useSetJobTypes() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<string[], Error, string[]>({
    mutationFn: (next) => bridge!.jobTypesSet!(next),
    onSuccess: () => qc.invalidateQueries({ queryKey: jobTypesKey }),
  });
}

// 自定义阶段模板（内置模板由消费端 mergeTemplates 合并，不走查询）。
export function useStageTemplates() {
  const bridge = useDesktopBridge();
  return useQuery<StageTemplate[]>({
    queryKey: stageTemplatesKey,
    enabled: !!bridge?.stageTemplatesList,
    queryFn: () => bridge!.stageTemplatesList!(),
    staleTime: Infinity,
    refetchOnWindowFocus: true,
  });
}

export function useAddStageTemplate() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<StageTemplate, Error, { name: string; description?: string; stages: string[] }>({
    mutationFn: (input) => bridge!.stageTemplatesAdd!(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: stageTemplatesKey }),
  });
}

export function useUpdateStageTemplate() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<
    StageTemplate | null,
    Error,
    { id: string; patch: { name?: string; description?: string; stages?: string[] } }
  >({
    mutationFn: (v) => bridge!.stageTemplatesUpdate!(v.id, v.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: stageTemplatesKey }),
  });
}

export function useDeleteStageTemplate() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => bridge!.stageTemplatesDelete!(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: stageTemplatesKey }),
  });
}

// tasks:resources-changed 轻量信号 → 三个资源 key 全部 invalidate（跨窗口同步）。
// 与 useTasksChangeSubscription 并列挂在工作台/工作区根部。
export function useTaskResourcesSubscription(): void {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  useEffect(() => {
    if (!bridge?.onTaskResourcesChanged) return;
    return bridge.onTaskResourcesChanged(() => {
      qc.invalidateQueries({ queryKey: membersKey });
      qc.invalidateQueries({ queryKey: jobTypesKey });
      qc.invalidateQueries({ queryKey: stageTemplatesKey });
    });
  }, [bridge, qc]);
}
