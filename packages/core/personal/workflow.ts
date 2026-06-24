// 工作流（loop）数据层。main 是 owner —— 这是"服务端数据",走 React Query
// 而非 zustand。列表/历史经 bridge 拉取;main 的 workflow:changed / run-event
// 事件驱动缓存更新（query-client 是 staleTime:Infinity + 不在聚焦时重取,全靠
// 事件 + mutation 乐观更新对账）。

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkflowDef, WorkflowRun } from "../desktop/workflow-types";
import { useDesktopBridge } from "../provider";

export const workflowKeys = {
  list: ["personal", "workflows"] as const,
  runs: (id: string) => ["personal", "workflow-runs", id] as const,
};

// ── 纯函数：缓存 upsert（按 id 幂等,乐观更新与事件对账共用）──────────────

/**
 * 工作流列表 upsert：按 id 定位，存在则更新，否则追加。
 * 乐观更新与 onWorkflowChanged 事件均复用此函数，保证幂等。
 */
export function upsertDef(prev: WorkflowDef[] | undefined, def: WorkflowDef): WorkflowDef[] {
  const list = prev ?? [];
  const idx = list.findIndex((w) => w.id === def.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = def;
    return next;
  }
  return [...list, def];
}

/**
 * 运行记录 upsert：先剔除同 id 旧记录，再将最新记录置顶（最新在前）。
 * 重复事件（如 start 与 end 携带相同 id）不产生重复行。
 */
export function upsertRun(prev: WorkflowRun[] | undefined, run: WorkflowRun): WorkflowRun[] {
  const list = (prev ?? []).filter((r) => r.id !== run.id);
  return [run, ...list]; // 最新在前
}

// ── 查询 ──────────────────────────────────────────────────────────────────

/** 查询工作流列表。staleTime:Infinity，完全由事件驱动缓存更新，不轮询。 */
export function useWorkflows() {
  const bridge = useDesktopBridge();
  return useQuery({
    queryKey: workflowKeys.list,
    queryFn: () => bridge!.workflowList!(),
    enabled: !!bridge?.workflowList,
    staleTime: Infinity,
  });
}

/** 查询指定工作流的运行历史。staleTime:Infinity，由 onWorkflowRunEvent 驱动更新。 */
export function useWorkflowRuns(id: string | undefined) {
  const bridge = useDesktopBridge();
  return useQuery({
    queryKey: workflowKeys.runs(id ?? ""),
    queryFn: () => bridge!.workflowListRuns!(id!),
    enabled: !!bridge?.workflowListRuns && !!id,
    staleTime: Infinity,
  });
}

/** 工作流能力是否可用（无 bridge / web 端 → UI 隐藏入口）。 */
export function useWorkflowsAvailable(): boolean {
  return !!useDesktopBridge()?.workflowList;
}

// ── 变更（乐观 setQueryData + workflow:changed 事件对账,按 id 幂等）────────

export function useCreateWorkflow() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<WorkflowDef>) => bridge!.workflowCreate!(input),
    onSuccess: (def) => {
      qc.setQueryData<WorkflowDef[]>(workflowKeys.list, (prev) => upsertDef(prev, def));
    },
  });
}

export function useUpdateWorkflow() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Partial<WorkflowDef> }) =>
      bridge!.workflowUpdate!(vars.id, vars.patch),
    onSuccess: (def) => {
      if (def) qc.setQueryData<WorkflowDef[]>(workflowKeys.list, (prev) => upsertDef(prev, def));
    },
  });
}

export function useDeleteWorkflow() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => bridge!.workflowDelete!(id),
    onSuccess: (_v, id) => {
      qc.setQueryData<WorkflowDef[]>(workflowKeys.list, (prev) =>
        (prev ?? []).filter((w) => w.id !== id),
      );
      // 清理该工作流的运行历史缓存
      qc.removeQueries({ queryKey: workflowKeys.runs(id) });
    },
  });
}

export function useSetWorkflowEnabled() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      bridge!.workflowSetEnabled!(vars.id, vars.enabled),
    // 乐观切换 enabled,失败回滚,成功用 main 返回的完整 def（含 nextRunAt）对账。
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: workflowKeys.list });
      const prev = qc.getQueryData<WorkflowDef[]>(workflowKeys.list);
      qc.setQueryData<WorkflowDef[]>(workflowKeys.list, (p) =>
        (p ?? []).map((w) => (w.id === vars.id ? { ...w, enabled: vars.enabled } : w)),
      );
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(workflowKeys.list, ctx.prev);
    },
    onSuccess: (def) => {
      if (def) qc.setQueryData<WorkflowDef[]>(workflowKeys.list, (prev) => upsertDef(prev, def));
    },
  });
}

export function useSetWorkflowCallableByAgent() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; callableByAgent: boolean }) =>
      bridge!.workflowSetCallableByAgent!(vars.id, vars.callableByAgent),
    // 乐观切换 callableByAgent，失败回滚
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: workflowKeys.list });
      const prev = qc.getQueryData<WorkflowDef[]>(workflowKeys.list);
      qc.setQueryData<WorkflowDef[]>(workflowKeys.list, (p) =>
        (p ?? []).map((w) => (w.id === vars.id ? { ...w, callableByAgent: vars.callableByAgent } : w)),
      );
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(workflowKeys.list, ctx.prev);
    },
    onSuccess: (def) => {
      if (def) qc.setQueryData<WorkflowDef[]>(workflowKeys.list, (prev) => upsertDef(prev, def));
    },
  });
}

export function useRunWorkflowNow() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => bridge!.workflowRunNow!(id),
    onSuccess: (run, id) => {
      // 把即时运行的 run 记录推入对应工作流的 runs 缓存
      if (run) qc.setQueryData<WorkflowRun[]>(workflowKeys.runs(id), (prev) => upsertRun(prev, run));
    },
  });
}

export function useStopWorkflowRun() {
  const bridge = useDesktopBridge();
  return useMutation({
    mutationFn: (vars: { workflowId: string; runId: string }) =>
      bridge!.workflowStop!(vars.workflowId, vars.runId),
    // stop 成功后 onWorkflowRunEvent(phase=end) 会广播,不在此乐观更新
  });
}

/** 删除单条运行记录：乐观从 runs 缓存剔除（main 删历史,不广播 changed,故纯靠此对账）。 */
export function useDeleteWorkflowRun() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { workflowId: string; runId: string }) =>
      bridge!.workflowDeleteRun!(vars.workflowId, vars.runId),
    onSuccess: (_v, vars) => {
      qc.setQueryData<WorkflowRun[]>(workflowKeys.runs(vars.workflowId), (prev) =>
        (prev ?? []).filter((r) => r.id !== vars.runId),
      );
    },
  });
}

export function useImportWorkflow() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dsl: unknown) => bridge!.workflowImport!(dsl),
    onSuccess: (def) => {
      qc.setQueryData<WorkflowDef[]>(workflowKeys.list, (prev) => upsertDef(prev, def));
    },
  });
}

export function useExportWorkflow() {
  const bridge = useDesktopBridge();
  return useMutation({
    mutationFn: (id: string) => bridge!.workflowExport!(id),
    // 导出只读取数据，不修改缓存
  });
}

export function useValidateWorkflowCron() {
  const bridge = useDesktopBridge();
  return useMutation({
    mutationFn: (vars: { expression: string; timezone?: string }) =>
      bridge!.workflowValidateCron!(vars.expression, vars.timezone),
  });
}

// ── 事件订阅（工作区根部挂载一次）──────────────────────────────────────────

/**
 * 订阅工作流事件并驱动 React Query 缓存更新。
 * - `onWorkflowChanged`：全量替换列表缓存（main 广播最新 WorkflowDef[]）。
 * - `onWorkflowRunEvent`：按 id 幂等 upsert 到对应工作流的 runs 缓存，
 *   重复事件（start/end 同 id）不产生重复行。
 * 应在工作区根组件挂载一次，随组件卸载自动退订。
 */
export function useWorkflowEvents(): void {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();

  useEffect(() => {
    if (!bridge?.onWorkflowChanged || !bridge?.onWorkflowRunEvent) return;

    // 全量替换列表缓存：main 推送最新完整列表（非增量 patch），直接 setQueryData。
    const offChanged = bridge.onWorkflowChanged((list) => {
      qc.setQueryData(workflowKeys.list, list);
    });

    // 运行事件：按 workflowId 定位 runs 缓存，幂等 upsert（最新记录置顶）。
    const offRun = bridge.onWorkflowRunEvent((ev) => {
      qc.setQueryData<WorkflowRun[]>(workflowKeys.runs(ev.workflowId), (prev) =>
        upsertRun(prev, ev.run),
      );
    });

    return () => {
      offChanged();
      offRun();
    };
  }, [bridge, qc]);
}
