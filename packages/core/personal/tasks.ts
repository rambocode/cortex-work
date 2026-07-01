// 真任务系统的 core 层：纯逻辑（状态/日期派生、tag 规范化、状态迁移矩阵）。
// React Query 读写 hooks 由 U4 追加于本文件底部；结构化触发 hook 由 U6 追加。
// 纯函数无 React/IO 依赖，便于表驱动单测（见 tasks.test.ts）。
// 数据类型定义在 ../desktop/types（与 apps/desktop/src/main/ipc/types.ts 逐字镜像）。

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DesktopBridge } from "../desktop/bridge";
import type { ArchivedTask, TaskInput, TaskMeta, TaskProject, TaskProjectKind, TaskStatus } from "../desktop/types";
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
export type AddTaskProjectVars = string | { name: string; parentId?: string; kind?: TaskProjectKind };
export function useAddTaskProject() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<TaskProject, Error, AddTaskProjectVars>({
    mutationFn: (v) => {
      const input = typeof v === "string" ? { name: v } : v;
      return bridge!.tasksAddProject!(input.name, { parentId: input.parentId, kind: input.kind });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: tasksKeys.projects }),
  });
}

// 更新 task-project（U3）：rename + reparent。reparent 影响任务归属 → 同时失效 tasks + projects 两个 key。
export function useUpdateTaskProject() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation<TaskProject | null, Error, { id: string; patch: { name?: string; parentId?: string | null } }>({
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
