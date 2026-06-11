import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../api/client";

const liveStaleTime = 60 * 1000;

export const issueKeys = {
  all: (wsId: string) => ["issues", wsId] as const,
  list: (wsId: string) => [...issueKeys.all(wsId), "list"] as const,
};

export const agentKeys = {
  all: (wsId: string) => ["agents", wsId] as const,
  list: (wsId: string) => [...agentKeys.all(wsId), "list"] as const,
  taskSnapshot: (wsId: string) => [...agentKeys.all(wsId), "task-snapshot"] as const,
  runCounts30d: (wsId: string) => [...agentKeys.all(wsId), "run-counts-30d"] as const,
  activity30d: (wsId: string) => [...agentKeys.all(wsId), "activity-30d"] as const,
};

export const dashboardKeys = {
  all: (wsId: string) => ["dashboard", wsId] as const,
  usageDaily: (wsId: string, days: number, projectId: string | null) =>
    [...dashboardKeys.all(wsId), "usage-daily", days, projectId] as const,
  usageByAgent: (wsId: string, days: number, projectId: string | null) =>
    [...dashboardKeys.all(wsId), "usage-by-agent", days, projectId] as const,
  agentRunTime: (wsId: string, days: number, projectId: string | null) =>
    [...dashboardKeys.all(wsId), "agent-runtime", days, projectId] as const,
  runTimeDaily: (wsId: string, days: number, projectId: string | null) =>
    [...dashboardKeys.all(wsId), "runtime-daily", days, projectId] as const,
};

export function issueListOptions(wsId: string, api?: ApiClient | null) {
  return queryOptions({
    queryKey: issueKeys.list(wsId),
    queryFn: () => api!.listIssues({ limit: 200, open_only: false }),
    enabled: !!api && !!wsId,
    staleTime: liveStaleTime,
  });
}

export function agentListOptions(wsId: string, api?: ApiClient | null) {
  return queryOptions({
    queryKey: agentKeys.list(wsId),
    queryFn: () => api!.listAgents(),
    enabled: !!api && !!wsId,
    staleTime: liveStaleTime,
  });
}

export function agentTaskSnapshotOptions(wsId: string, api?: ApiClient | null) {
  return queryOptions({
    queryKey: agentKeys.taskSnapshot(wsId),
    queryFn: () => api!.listAgentTaskSnapshot(),
    enabled: !!api && !!wsId,
    staleTime: 30 * 1000,
  });
}

export function agentRunCounts30dOptions(wsId: string, api?: ApiClient | null) {
  return queryOptions({
    queryKey: agentKeys.runCounts30d(wsId),
    queryFn: () => api!.listAgentRunCounts30d(),
    enabled: !!api && !!wsId,
    staleTime: liveStaleTime,
  });
}

export function agentActivity30dOptions(wsId: string, api?: ApiClient | null) {
  return queryOptions({
    queryKey: agentKeys.activity30d(wsId),
    queryFn: () => api!.listAgentActivity30d(),
    enabled: !!api && !!wsId,
    staleTime: liveStaleTime,
  });
}

export function dashboardUsageDailyOptions(wsId: string, api: ApiClient | null | undefined, days = 30, projectId: string | null = null) {
  return queryOptions({
    queryKey: dashboardKeys.usageDaily(wsId, days, projectId),
    queryFn: () => api!.getDashboardUsageDaily({ days, projectId }),
    enabled: !!api && !!wsId,
    staleTime: liveStaleTime,
  });
}

export function dashboardUsageByAgentOptions(wsId: string, api: ApiClient | null | undefined, days = 30, projectId: string | null = null) {
  return queryOptions({
    queryKey: dashboardKeys.usageByAgent(wsId, days, projectId),
    queryFn: () => api!.getDashboardUsageByAgent({ days, projectId }),
    enabled: !!api && !!wsId,
    staleTime: liveStaleTime,
  });
}

export function dashboardAgentRunTimeOptions(wsId: string, api: ApiClient | null | undefined, days = 30, projectId: string | null = null) {
  return queryOptions({
    queryKey: dashboardKeys.agentRunTime(wsId, days, projectId),
    queryFn: () => api!.getDashboardAgentRunTime({ days, projectId }),
    enabled: !!api && !!wsId,
    staleTime: liveStaleTime,
  });
}

export function dashboardRunTimeDailyOptions(wsId: string, api: ApiClient | null | undefined, days = 30, projectId: string | null = null) {
  return queryOptions({
    queryKey: dashboardKeys.runTimeDaily(wsId, days, projectId),
    queryFn: () => api!.getDashboardRunTimeDaily({ days, projectId }),
    enabled: !!api && !!wsId,
    staleTime: liveStaleTime,
  });
}
