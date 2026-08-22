// React Query options + query keys for Cortex Desktop server-state.
// Keys are namespaced by workspace id (wsId) so switching workspace never
// leaks another workspace's cached data.

import { queryOptions } from "@tanstack/react-query";
import { getConversation, getFileDiff, listContacts, listOrganizations } from "../mock/api";
import type { ApiClient } from "../api/client";
import type { Contact, Conversation } from "../types";
import { mapAvatarsToContacts, mapServerWorkspacesToContacts } from "./contacts-map";
import { buildAvatarConversationFromTurns } from "./session-stream";

// Organizations are global (not workspace-scoped), so their key carries no wsId.
export const organizationKeys = {
  all: () => ["organizations"] as const,
  list: () => [...organizationKeys.all(), "list"] as const,
};

export const organizationListOptions = () =>
  queryOptions({
    queryKey: organizationKeys.list(),
    queryFn: () => listOrganizations(),
  });

export const contactKeys = {
  all: (wsId: string) => ["contacts", wsId] as const,
  list: (wsId: string) => [...contactKeys.all(wsId), "list"] as const,
};

export const conversationKeys = {
  all: (wsId: string) => ["conversation", wsId] as const,
  detail: (wsId: string, contactId: string) => [...conversationKeys.all(wsId), contactId] as const,
};

export const fileDiffKeys = {
  all: (wsId: string) => ["fileDiff", wsId] as const,
  detail: (wsId: string, path: string) => [...fileDiffKeys.all(wsId), path] as const,
};

// 团队通讯录：apiClient 可用时走真实服务端（GET /api/avatars → 成员/分身两级 Contact[]），
// 否则回落 mock。query key 不变（契约 §8 硬约定），apiClient 为可选加性参数，保持向后兼容
// ——旧调用点 contactListOptions(wsId) 未传 apiClient 时行为等同原 mock 路径。
export const contactListOptions = (wsId: string, api?: ApiClient | null) =>
  queryOptions({
    queryKey: contactKeys.list(wsId),
    queryFn: async () => {
      if (!api) return listContacts();
      // 分身与服务器工作区并行拉取；服务器工作区条目排在 shared 分组（点开即聊，
      // 不依赖任何成员共享分身）。server-workspaces 拉取失败不拖垮通讯录（降级只剩分身）。
      const [avatarsResp, swResp] = await Promise.all([
        api.listAvatars(),
        api.listServerWorkspaces().catch(() => null),
      ]);
      const contacts = mapAvatarsToContacts(avatarsResp.avatars);
      if (swResp) {
        contacts.push(...mapServerWorkspacesToContacts(swResp.server_workspaces ?? [], swResp.runtimes ?? []));
      }
      return contacts;
    },
  });

// 会话历史：apiClient + 分身联系人（contact.kind==="avatar"）→ 走真实后端。
// 多轮会话化后（migration 100）：listAvatarSessions 返回「一行一个会话」，取最近活跃的会话，
// 再经 getAvatarConversation 拉该会话的**全部轮次**，组装成完整多轮 Conversation（问1/答1/问2/答2…），
// 并挂上分身会话态（最后一轮在途则续接流式/取消）。刷新/重开后不再只剩最后一轮。
// 否则回落 mock getConversation。key 不变（契约硬约定）；api/contact 为可选加性参数——旧调用点
// 未传时行为等同原 mock 路径。
export const conversationOptions = (wsId: string, contactId: string, api?: ApiClient | null, contact?: Contact) =>
  queryOptions({
    queryKey: conversationKeys.detail(wsId, contactId),
    queryFn: async (): Promise<Conversation | null> => {
      if (!api || contact?.kind !== "avatar") return getConversation(contactId);
      // 服务器工作区条目：历史走工作区级 sessions 端点（当前调用者自己的会话）。
      // 端点缺失/无历史 → null（空态引导；流式在会话中实时构建）。
      if (contact.serverWorkspaceId) {
        const { sessions } = await api.listServerWorkspaceSessions(contact.serverWorkspaceId).catch(() => ({ sessions: [] }));
        const latest = [...sessions].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
        if (!latest) return null;
        const { turns } = await api.getAvatarConversation(latest.conversation_id);
        return buildAvatarConversationFromTurns(turns, { who: contact.name, conversationId: latest.conversation_id });
      }
      const runtimeId = contact.runtimeId ?? contact.id;
      const { sessions } = await api.listAvatarSessions(runtimeId);
      // 取最近活跃的会话（按 updated_at 降序首条）；无历史 → null（视图渲染空态引导）。
      const latest = [...sessions].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
      if (!latest) return null;
      const { turns } = await api.getAvatarConversation(latest.conversation_id);
      return buildAvatarConversationFromTurns(turns, {
        who: contact.role || contact.name,
        conversationId: latest.conversation_id,
      });
    },
  });

export const fileDiffOptions = (wsId: string, path: string) =>
  queryOptions({
    queryKey: fileDiffKeys.detail(wsId, path),
    queryFn: () => getFileDiff(path),
  });
