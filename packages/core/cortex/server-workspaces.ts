// 服务器工作区（server workspace）前端数据层：daemon 托管的持久命名 git checkout，
// 成员可浏览/选择并在其中发起会话式任务（shared=全队同一 checkout 按 instance 串行排队，
// isolated=每成员一份 worktree）。服务端态走 React Query（不复制进 Zustand）；query key
// 含 wsId 命名空间——切 workspace 不串场。占用/排队的权威实时态由 server_workspace:queue
// 事件驱动 invalidation（遵守「事件只触发 invalidation」硬约定），本模块只提供快照查询。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "../api/client";
import type {
  CreateServerWorkspaceRequest,
  ServerRuntime,
  ServerWorkspace,
  ServerWorkspaceQueueItem,
} from "../api/types";
import { useCoreContext, useWorkspaceId } from "../provider";

// 服务器工作区 query key，含 wsId 命名空间。
export const serverWorkspaceKeys = {
  all: (wsId: string) => ["server-workspaces", wsId] as const,
  list: (wsId: string) => [...serverWorkspaceKeys.all(wsId), "list"] as const,
  queue: (wsId: string, swId: string) => [...serverWorkspaceKeys.all(wsId), "queue", swId] as const,
};

// list 响应的规整结果：按 daemon 机器分组（同机的全部工作区 + 该机可用 runtime）。
export interface ServerWorkspaceGroup {
  daemonId: string;
  // 展示名：取该 daemon 下第一个 runtime 的名字（daemon 本身无独立展示字段）。
  label: string;
  online: boolean; // 该机任一 runtime 在线即视为在线
  runtimes: ServerRuntime[];
  workspaces: ServerWorkspace[];
}

// 纯函数：把 list 响应按 daemon_id 分组（选择器两级列表的数据形状）。
// archived 工作区不进选择器；分组按 label 排序保证渲染稳定。
export function groupServerWorkspaces(
  workspaces: ServerWorkspace[],
  runtimes: ServerRuntime[],
): ServerWorkspaceGroup[] {
  const byDaemon = new Map<string, ServerWorkspaceGroup>();
  const ensure = (daemonId: string): ServerWorkspaceGroup => {
    let g = byDaemon.get(daemonId);
    if (!g) {
      g = { daemonId, label: daemonId, online: false, runtimes: [], workspaces: [] };
      byDaemon.set(daemonId, g);
    }
    return g;
  };
  for (const rt of runtimes) {
    const g = ensure(rt.daemon_id);
    g.runtimes.push(rt);
    if (rt.online) g.online = true;
    if (g.label === g.daemonId && rt.name) g.label = rt.name;
  }
  for (const sw of workspaces) {
    if (sw.status === "archived") continue;
    ensure(sw.daemon_id).workspaces.push(sw);
  }
  return [...byDaemon.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// 纯函数：工作区此刻的占用态（QueuedComposer/选择器徽标共用）。
//  free     = 空闲；mine = 正在跑的是我自己的任务；occupied = 被他人占用（发消息会排队）。
export type ServerWorkspaceOccupancy = "free" | "mine" | "occupied";
export function workspaceOccupancy(sw: ServerWorkspace, myUserId: string): ServerWorkspaceOccupancy {
  if (!sw.running_task_id) return "free";
  return sw.running_caller_id === myUserId ? "mine" : "occupied";
}

// 纯函数：给定 daemon 分组，挑 invoke 用的 runtime（优先在线；全离线返回第一个以便
// 服务端给出明确的 offline 错误而非前端静默无按钮）。
export function pickRuntime(group: ServerWorkspaceGroup): ServerRuntime | undefined {
  return group.runtimes.find((r) => r.online) ?? group.runtimes[0];
}

// 错误码 → i18n 文案 key（纯函数，UI 与测试共用）。
export function createServerWorkspaceErrorKey(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "serverWs.errNeedAdmin";
    if (err.code === "slug_taken" || err.status === 409) return "serverWs.errNameConflict";
  }
  return "serverWs.errCreateFailed";
}
export function invokeServerWorkspaceErrorKey(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "instance_provisioning") return "serverWs.errProvisioning";
    if (err.code === "workspace_not_ready") return "serverWs.errNotReady";
    if (err.code === "runtime_offline" || err.code === "runtime_unavailable" || err.code === "avatar_offline")
      return "serverWs.errOffline";
  }
  return "serverWs.errInvokeFailed";
}

// ── React Query options / hooks ────────────────────────────────────────────

export interface ServerWorkspaceListData {
  groups: ServerWorkspaceGroup[];
  workspaces: ServerWorkspace[];
  runtimes: ServerRuntime[];
}

// 列表（api 为 null 的 Web/未登录场景 enabled=false，不发请求）。
export function serverWorkspaceListOptions(wsId: string, api: ApiClient | null) {
  return {
    queryKey: serverWorkspaceKeys.list(wsId),
    queryFn: async (): Promise<ServerWorkspaceListData> => {
      const resp = await api!.listServerWorkspaces();
      const workspaces = resp.server_workspaces ?? [];
      const runtimes = resp.runtimes ?? [];
      return { groups: groupServerWorkspaces(workspaces, runtimes), workspaces, runtimes };
    },
    enabled: !!api && !!wsId,
    staleTime: 30_000,
  };
}

// 占用/排队列表（打开某工作区的排队详情时用；实时增量由 queue 事件失效本 key）。
export function serverWorkspaceQueueOptions(wsId: string, swId: string, api: ApiClient | null) {
  return {
    queryKey: serverWorkspaceKeys.queue(wsId, swId),
    queryFn: async (): Promise<ServerWorkspaceQueueItem[]> => {
      const resp = await api!.listServerWorkspaceQueue(swId);
      return resp.items ?? resp.queue ?? [];
    },
    enabled: !!api && !!wsId && !!swId,
    staleTime: 10_000,
  };
}

export function useServerWorkspaces() {
  const wsId = useWorkspaceId();
  const { apiClient } = useCoreContext();
  return useQuery(serverWorkspaceListOptions(wsId, apiClient));
}

// 创建服务器工作区（admin/owner）。成功后失效列表（daemon provision 状态经
// server_workspace:updated 事件继续刷新）。
export function useCreateServerWorkspace() {
  const wsId = useWorkspaceId();
  const { apiClient } = useCoreContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateServerWorkspaceRequest) => apiClient!.createServerWorkspace(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: serverWorkspaceKeys.all(wsId) });
    },
  });
}

// 删除/归档服务器工作区（admin/owner 或 creator；daemon 侧收到 sync 后清盘）。
export function useDeleteServerWorkspace() {
  const wsId = useWorkspaceId();
  const { apiClient } = useCoreContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient!.deleteServerWorkspace(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: serverWorkspaceKeys.all(wsId) });
    },
  });
}
