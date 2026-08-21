// 分身会话（owner 视角，W3）：拥有者在【个人工作区】查看「这个角色替我答了什么」——
// 列出自己名下每个共享分身被同事调用的全部会话，点开看完整问答。走 React Query（服务端权威态），
// query key 含 wsId（切 workspace 不串场），enabled 双闸（apiClient 存在 + wsId 非空 + 目标 id 非空）。
// 纯 query options + 展示纯函数（调用者/时间/终态标签），供 AvatarSessionsSection 与单测共用。

import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../api/client";
import type { ApiAvatar, AvatarSessionSummary, AvatarTaskMessage } from "../api/types";
import type { AvatarSessionOutcome } from "../desktop/avatar-types";
// 复用审计模块的终态文案与问题摘要,保证「同一终态 → 同一中文标签」跨列表一致(避免两处漂移)。
import { OUTCOME_LABELS, summarizePrompt } from "./avatar-audit";

// 会话详情/帧列表 30s 内视为新鲜:详情属回看场景,非高频,避免频繁重拉;WS 事件由消费端另行 invalidate。
const sessionStaleTime = 30 * 1000;

export const avatarSessionKeys = {
  all: (wsId: string) => ["avatar-sessions", wsId] as const,
  // 当前用户名下的分身清单(从 GET /api/avatars 过滤 owner)。
  avatars: (wsId: string) => [...avatarSessionKeys.all(wsId), "avatars"] as const,
  // 某个自有分身的 owner 视角会话列表(一行一个会话,含 caller 字段)。
  ownerList: (wsId: string, runtimeId: string) =>
    [...avatarSessionKeys.all(wsId), "owner", runtimeId] as const,
  // 某个 task 的保序帧(点开详情时拉取)。
  messages: (wsId: string, taskId: string) =>
    [...avatarSessionKeys.all(wsId), "messages", taskId] as const,
  // 某个多轮会话的完整历史(点开会话详情时拉取,migration 100)。
  conversation: (wsId: string, conversationId: string) =>
    [...avatarSessionKeys.all(wsId), "conversation", conversationId] as const,
};

// owner 会话列表轮询间隔:owner 侧无 WS 实时,挂载时必须立即拉取;空列表也要短轮询,
// 否则「先缓存空列表 → 团队工作区发起调用 → 立刻回个人工作区」会继续复用旧空缓存,看不到新会话。
// 看到全终态历史后停止轮询(返回 false),不空耗。
const OWNER_LIST_POLL_MS = 3000;

// 分身清单 query options。消费端再用 filterOwnedAvatars 过滤出「owner 为当前用户」的 runtime。
// enabled 双闸:apiClient 存在(真实后端)+ wsId 非空。
export function ownedAvatarsOptions(wsId: string, api?: ApiClient | null) {
  return queryOptions({
    queryKey: avatarSessionKeys.avatars(wsId),
    queryFn: async (): Promise<ApiAvatar[]> => (await api!.listAvatars()).avatars,
    enabled: !!api && !!wsId,
    staleTime: sessionStaleTime,
  });
}

// 某个自有分身的 owner 视角会话列表 query options（?view=owner，带 caller_id/caller_name）。
// enabled 三闸:额外要求 runtimeId 非空(逐 runtime 拉取,空 id 不发请求)。
export function avatarOwnerSessionsOptions(wsId: string, api: ApiClient | null | undefined, runtimeId: string) {
  return queryOptions({
    queryKey: avatarSessionKeys.ownerList(wsId, runtimeId),
    queryFn: async (): Promise<AvatarSessionSummary[]> =>
      (await api!.listAvatarSessions(runtimeId, "owner")).sessions,
    enabled: !!api && !!wsId && !!runtimeId,
    staleTime: 0,
    // 空列表/加载后无数据也轮询,用于发现刚被同事发起的新调用;全终态停轮询。
    refetchInterval: (query) => {
      const rows = query.state.data;
      const shouldPoll =
        !Array.isArray(rows) || rows.length === 0 || rows.some((s) => s.outcome === null);
      return shouldPoll ? OWNER_LIST_POLL_MS : false;
    },
  });
}

// 某个多轮会话完整历史的 query options(owner 详情弹层用,GET conversations/{id}/messages)。
// enabled 三闸:conversationId 非空(弹层关闭/无选中时不发请求)。会话若最近一轮在途,弹层内也轮询。
export function avatarConversationOptions(wsId: string, api: ApiClient | null | undefined, conversationId: string) {
  return queryOptions({
    queryKey: avatarSessionKeys.conversation(wsId, conversationId),
    queryFn: async () => (await api!.getAvatarConversation(conversationId)).turns,
    enabled: !!api && !!wsId && !!conversationId,
    staleTime: sessionStaleTime,
    // 详情最后一轮非终态时轮询,让 owner 打开的会话也能看到实时收敛。
    refetchInterval: (query) => {
      const turns = query.state.data;
      const last = Array.isArray(turns) && turns.length > 0 ? turns[turns.length - 1] : undefined;
      return last && last.outcome === null ? OWNER_LIST_POLL_MS : false;
    },
  });
}

// 某个 task 的完整保序帧 query options（点开详情弹层时才拉取）。
// enabled 三闸:taskId 非空(弹层关闭/无选中时不发请求)。
export function taskMessagesOptions(wsId: string, api: ApiClient | null | undefined, taskId: string) {
  return queryOptions({
    queryKey: avatarSessionKeys.messages(wsId, taskId),
    queryFn: async (): Promise<AvatarTaskMessage[]> => (await api!.listTaskMessages(taskId)).messages,
    enabled: !!api && !!wsId && !!taskId,
    staleTime: sessionStaleTime,
  });
}

// ── 展示纯函数 ────────────────────────────────────────────────────────────────

// 过滤出「owner 为当前用户」的分身:owner 视角会话仅 runtime 拥有者可读(否则服务端 403),
// 故渲染前先按 owner.id 过滤,避免对他人分身发起注定 403 的请求。
export function filterOwnedAvatars(avatars: ApiAvatar[], ownerId: string): ApiAvatar[] {
  if (!ownerId) return [];
  return avatars.filter((a) => a.owner.id === ownerId);
}

// 终态 → 中文标签:复用审计的 OUTCOME_LABELS;outcome 为 null(尚未终态)显示「进行中」。
export function sessionOutcomeLabel(outcome: AvatarSessionOutcome | null | undefined): string {
  if (!outcome) return "进行中";
  return OUTCOME_LABELS[outcome] ?? outcome;
}

// 调用者展示名:优先 caller_name;缺失时退回 caller_id 前 8 位;再无则「未知调用者」。
// owner 视角服务端本应回填 caller_name,此处仅为异常/历史数据的防御兜底。
export function sessionCallerName(session: AvatarSessionSummary): string {
  if (session.caller_name && session.caller_name.trim()) return session.caller_name;
  if (session.caller_id) return session.caller_id.slice(0, 8);
  return "未知调用者";
}

// 会话列表一行的展示摘要（一行 = 一个多轮会话）。conversationId 供点开详情;turnCount 为轮数;
// promptSummary/outcomeLabel 取自最近一轮。纯函数便于单测。
export interface AvatarOwnerSessionRow {
  conversationId: string;
  taskId: string; // 最近一轮 task(兼容/兜底)
  callerName: string;
  createdAt: string;
  updatedAt: string;
  promptSummary: string;
  outcomeLabel: string;
  turnCount: number;
}

// 单条 owner 视角会话 → 展示行。问题摘要复用审计的 summarizePrompt(截断 + 空值防御)。
export function sessionRowLabel(session: AvatarSessionSummary): AvatarOwnerSessionRow {
  return {
    conversationId: session.conversation_id,
    taskId: session.task_id,
    callerName: sessionCallerName(session),
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    promptSummary: summarizePrompt(session.prompt),
    outcomeLabel: sessionOutcomeLabel(session.outcome),
    turnCount: session.turn_count,
  };
}

// 会话列表映射 + 排序:按 updated_at 降序(最近活跃在前),再逐条转展示行。
export function toOwnerSessionRows(sessions: AvatarSessionSummary[]): AvatarOwnerSessionRow[] {
  return [...sessions]
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .map(sessionRowLabel);
}
