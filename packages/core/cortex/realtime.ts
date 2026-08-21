// 团队实时层（W3）：浏览器 WS 直连后端 /ws 的接线枢纽。全部在 renderer/core 层，
// 不经主进程（团队侧实时与个人侧 sync:invalidate 总线是两条平行通道）。
//
// 纪律（与个人侧同款，务必遵守）：
//   - 流式帧（avatar:task_message / task_state）→ foldSessionIntoCache 写 React Query
//     会话缓存（服务端态，seq 去重保证与 HTTP 轮询交叠安全）——这是唯一的「数据推送」例外，
//     因为帧本身就是权威数据且带保序 seq。
//   - 其余一切事件（分身上下线/成员/邀请/服务器工作区变化）**只做 invalidation**，
//     不 setQueryData 塞数据，不写 Zustand。
//
// 任务登记表：mutations 发起 invoke 后把「task/turn id → (contactId, contact, generation)」
// 登记进模块级 registry；本 hook 监听登记变化向 WS 订阅对应 task scope，收帧按登记折叠。
// 终态/取消/代际接管时注销。registry 是模块级单例（与 QueryClient 生命周期同长），
// 不放 Zustand——它是纯管线状态，UI 不渲染它。

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCoreContext } from "../provider";
import {
  AvatarSessionClient,
  getAvatarSession,
  mapTaskStateToOutcome,
  type AvatarTaskMessageFrame,
  type AvatarTaskStatePayload,
} from "./session-stream";
import { foldSessionIntoCache } from "./mutations";
import {
  getActiveTaskBinding,
  listActiveTaskIds,
  subscribeTaskRegistry,
  unregisterAvatarTask,
} from "./task-registry";
import { contactKeys, conversationKeys } from "./queries";
import { serverWorkspaceKeys } from "./server-workspaces";
import { teamKeys, workspaceKeys, invitationKeys, squadMemberKeys } from "./teams";
import type { Conversation } from "../types";

// 纯函数：http(s) baseUrl → ws(s) /ws 端点（带 workspace 命名空间参数）。
export function deriveWsUrl(baseUrl: string, params: { workspaceId?: string; workspaceSlug?: string }): string {
  const ws = baseUrl.replace(/^http/i, "ws").replace(/\/+$/, "");
  const qs = params.workspaceId
    ? `?workspace_id=${encodeURIComponent(params.workspaceId)}`
    : params.workspaceSlug
      ? `?workspace_slug=${encodeURIComponent(params.workspaceSlug)}`
      : "";
  return `${ws}/ws${qs}`;
}

// ── hook：CortexDesktopView 团队分支挂载一次 ────────────────────────────────
export function useTeamRealtime(): void {
  const { apiConfig, wsId } = useCoreContext();
  const qc = useQueryClient();

  useEffect(() => {
    if (!apiConfig?.token) return; // 未登录/无后端：不建 WS
    const invalidate = (key: readonly unknown[]) => void qc.invalidateQueries({ queryKey: key });

    const client = new AvatarSessionClient({
      url: deriveWsUrl(apiConfig.baseUrl, apiConfig),
      token: apiConfig.token,
      onTaskMessage: (frame: AvatarTaskMessageFrame) => {
        const taskId = frame.turn_id || frame.task_id;
        const binding = taskId ? getActiveTaskBinding(taskId) : undefined;
        if (!binding || !taskId) return;
        // 折帧：phase 保持缓存现值（消息帧不携带阶段语义；开跑纠正由 task_state/轮询负责）。
        const cur = getAvatarSession(qc.getQueryData<Conversation | null>(conversationKeys.detail(wsId, binding.contactId)));
        foldSessionIntoCache(qc, wsId, binding.contactId, binding.contact, binding.generation, [frame], {
          taskId,
          conversationId: binding.conversationId,
          phase: cur?.phase ?? "running",
          outcome: null,
        });
      },
      onTaskState: (payload: AvatarTaskStatePayload) => {
        const binding = getActiveTaskBinding(payload.task_id);
        if (!binding) return;
        const outcome = mapTaskStateToOutcome(payload.status, payload.failure_reason, undefined);
        // running/dispatched：把 queued 阶段纠正为 running；终态：落 outcome + 收尾失效。
        const phase = payload.status === "queued" ? "queued" : "running";
        const { terminal } = foldSessionIntoCache(qc, wsId, binding.contactId, binding.contact, binding.generation, [], {
          taskId: payload.task_id,
          conversationId: binding.conversationId,
          phase,
          outcome,
        });
        if (terminal) {
          unregisterAvatarTask(payload.task_id);
          // 终态权威补齐（可能漏末帧）+ 通讯录在线态/已用次数刷新——与轮询终态分支同款。
          invalidate(conversationKeys.detail(wsId, binding.contactId));
          invalidate(contactKeys.list(wsId));
        }
      },
      onAvatarUpdated: () => invalidate(contactKeys.all(wsId)),
      onWorkspaceEvent: (type) => {
        // 低频「某数据变了」类事件 → 只失效对应 query（与个人侧 sync:invalidate 同纪律）。
        if (type.startsWith("server_workspace:")) {
          invalidate(serverWorkspaceKeys.all(wsId));
          return;
        }
        if (type.startsWith("member:") || type.startsWith("workspace:")) {
          invalidate(workspaceKeys.members(wsId));
          invalidate(contactKeys.all(wsId));
          return;
        }
        if (type.startsWith("squad:")) {
          invalidate(teamKeys.all(wsId));
          invalidate(squadMemberKeys.all(wsId));
          return;
        }
        if (type.startsWith("invitation:")) invalidate(invitationKeys.all());
      },
    });
    client.connect();

    // 登记变化 → 订阅/退订 task scope；已在途的（先登记后挂载）立即补订。
    const unsubscribeRegistry = subscribeTaskRegistry((taskId, added) => {
      if (added) client.subscribeTask(taskId);
      else client.unsubscribeTask(taskId);
    });
    for (const taskId of listActiveTaskIds()) client.subscribeTask(taskId);

    return () => {
      unsubscribeRegistry();
      client.close();
    };
    // apiConfig 是 provider memo 的稳定快照：变化即代表连接参数真的变了（登录/切 workspace）。
  }, [apiConfig, wsId, qc]);
}
