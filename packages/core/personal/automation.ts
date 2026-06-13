// 自动化（定时任务）数据层。main 是 owner —— 这是"服务端数据",走 React Query
// 而非 zustand。列表/历史经 bridge 拉取;main 的 automation:changed / run-event
// 事件驱动缓存更新（query-client 是 staleTime:Infinity + 不在聚焦时重取,全靠
// 事件 + mutation 乐观更新对账）。

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AutomationInput, AutomationMeta, AutomationRun } from "../desktop/types";
import { useDesktopBridge } from "../provider";
import { useCortexUIStore } from "../store/ui";

export const automationKeys = {
  list: ["personal", "automations"] as const,
  runs: (id: string) => ["personal", "automation-runs", id] as const,
};

// ── 纯函数：缓存 upsert（按 id 幂等,乐观更新与事件对账共用）──────────────

function upsertMeta(prev: AutomationMeta[] | undefined, meta: AutomationMeta): AutomationMeta[] {
  const list = prev ?? [];
  const idx = list.findIndex((a) => a.id === meta.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = meta;
    return next;
  }
  return [...list, meta];
}

function upsertRun(prev: AutomationRun[] | undefined, run: AutomationRun): AutomationRun[] {
  const list = (prev ?? []).filter((r) => r.id !== run.id);
  return [run, ...list]; // 最新在前
}

// ── 查询 ──────────────────────────────────────────────────────────────────

export function useAutomations() {
  const bridge = useDesktopBridge();
  return useQuery({
    queryKey: automationKeys.list,
    queryFn: () => bridge!.automationList!(),
    enabled: !!bridge?.automationList,
  });
}

export function useAutomationRuns(id: string | undefined) {
  const bridge = useDesktopBridge();
  return useQuery({
    queryKey: automationKeys.runs(id ?? ""),
    queryFn: () => bridge!.automationListRuns!(id!),
    enabled: !!bridge?.automationListRuns && !!id,
  });
}

// 自动化能力是否可用（无 bridge / web 端 → UI 隐藏入口）。
export function useAutomationsAvailable(): boolean {
  return !!useDesktopBridge()?.automationList;
}

// ── 变更（乐观 setQueryData + automation:changed 事件对账,按 id 幂等）─────

export function useCreateAutomation() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AutomationInput) => bridge!.automationCreate!(input),
    onSuccess: (meta) => {
      qc.setQueryData<AutomationMeta[]>(automationKeys.list, (prev) => upsertMeta(prev, meta));
    },
  });
}

export function useUpdateAutomation() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Partial<AutomationInput> }) =>
      bridge!.automationUpdate!(vars.id, vars.patch),
    onSuccess: (meta) => {
      if (meta) qc.setQueryData<AutomationMeta[]>(automationKeys.list, (prev) => upsertMeta(prev, meta));
    },
  });
}

export function useDeleteAutomation() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => bridge!.automationDelete!(id),
    onSuccess: (_v, id) => {
      qc.setQueryData<AutomationMeta[]>(automationKeys.list, (prev) =>
        (prev ?? []).filter((a) => a.id !== id),
      );
      qc.removeQueries({ queryKey: automationKeys.runs(id) });
    },
  });
}

export function useSetAutomationEnabled() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      bridge!.automationSetEnabled!(vars.id, vars.enabled),
    // 乐观切换 enabled,失败回滚,成功用 main 返回的完整 meta（含 nextRunAt）对账。
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: automationKeys.list });
      const prev = qc.getQueryData<AutomationMeta[]>(automationKeys.list);
      qc.setQueryData<AutomationMeta[]>(automationKeys.list, (p) =>
        (p ?? []).map((a) => (a.id === vars.id ? { ...a, enabled: vars.enabled } : a)),
      );
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(automationKeys.list, ctx.prev);
    },
    onSuccess: (meta) => {
      if (meta) qc.setQueryData<AutomationMeta[]>(automationKeys.list, (prev) => upsertMeta(prev, meta));
    },
  });
}

export function useRunAutomationNow() {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => bridge!.automationRunNow!(id),
    onSuccess: (run) => {
      if (run) qc.setQueryData<AutomationRun[]>(automationKeys.runs(run.automationId), (prev) => upsertRun(prev, run));
    },
  });
}

// ── 事件订阅（工作区根部挂载一次）──────────────────────────────────────────

export function useAutomationEvents(): void {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  const pushToast = useCortexUIStore((s) => s.pushToast);

  useEffect(() => {
    if (!bridge?.onAutomationChanged || !bridge?.onAutomationRunEvent) return;
    const offChanged = bridge.onAutomationChanged((list) => {
      qc.setQueryData(automationKeys.list, list);
    });
    const offRun = bridge.onAutomationRunEvent((ev) => {
      qc.setQueryData<AutomationRun[]>(automationKeys.runs(ev.automationId), (prev) => upsertRun(prev, ev.run));
      if (ev.phase === "end") {
        const list = qc.getQueryData<AutomationMeta[]>(automationKeys.list);
        const label = list?.find((a) => a.id === ev.automationId)?.name ?? "自动化";
        if (ev.run.status === "ok") pushToast(`「${label}」执行完成`, { kind: "success" });
        else if (ev.run.status === "error" || ev.run.status === "timeout")
          pushToast(`「${label}」执行失败：${ev.run.error ?? ""}`.trim(), { kind: "error" });
        // skipped / killed 不打扰用户。
      }
    });
    return () => {
      offChanged();
      offRun();
    };
  }, [bridge, qc, pushToast]);
}
