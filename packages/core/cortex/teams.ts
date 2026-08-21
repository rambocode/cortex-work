// 团队(squad)前端数据层:建团 / 生成邀请码 / 凭码加入 / 退团的 React Query hooks +
// 错误码→文案 key 的纯映射。服务端态走 React Query(不复制进 Zustand);query key 含 wsId
// 命名空间——squad 随 workspace 变化(listSquads 经 X-Workspace-ID 头作用域化),切 workspace
// 不串场。join/leave 成功后连带失效通讯录(contacts)与会话(conversation):团队成员及其
// 共享分身即刻变化,须重取(遵守「事件只触发 invalidation」硬约定)。

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import type {
  ApiSquad,
  InvitationResponse,
  SquadJoinCodeResponse,
  SquadJoinResponse,
  SquadMember,
  SquadMemberType,
  SquadResponse,
  WorkspaceMember,
  WorkspaceRole,
} from "../api/types";
import { useCoreContext, useWorkspaceId } from "../provider";
import { contactKeys, conversationKeys } from "./queries";

// squad 列表 query key,含 wsId 命名空间(切 workspace 隔离缓存)。
export const teamKeys = {
  all: (wsId: string) => ["squads", wsId] as const,
  list: (wsId: string) => [...teamKeys.all(wsId), "list"] as const,
};

// workspace 级 query key。members 含 wsId 命名空间(切 workspace 隔离);list 非 ws 作用域(是「我所属的全部 workspace」)。
export const workspaceKeys = {
  all: () => ["workspaces"] as const,
  list: () => [...workspaceKeys.all(), "list"] as const,
  members: (wsId: string) => ["workspace-members", wsId] as const,
};

// 「我的邀请」query key。邀请是跨 workspace 的(收件人视角),不按 wsId 命名空间。
export const invitationKeys = {
  all: () => ["invitations"] as const,
  mine: () => [...invitationKeys.all(), "mine"] as const,
};

// squad 成员 query key,含 wsId 命名空间(squad 随 workspace 作用域化)。
export const squadMemberKeys = {
  all: (wsId: string) => ["squad-members", wsId] as const,
  detail: (wsId: string, squadId: string) => [...squadMemberKeys.all(wsId), squadId] as const,
};

// ── 失效范围(纯函数,供 hook onSuccess 与单测共用)──────────────────────────
// 建团只改团队列表本身(新团队里此刻只有自己,通讯录/会话不变)。
export function invalidateAfterCreateSquad(qc: QueryClient, wsId: string): void {
  void qc.invalidateQueries({ queryKey: teamKeys.all(wsId) });
}

// join/leave 改变团队成员集合 → 通讯录里成员及其共享分身即刻变化,连带失效 contacts + conversation。
export function invalidateAfterMembershipChange(qc: QueryClient, wsId: string): void {
  void qc.invalidateQueries({ queryKey: teamKeys.all(wsId) });
  void qc.invalidateQueries({ queryKey: contactKeys.all(wsId) });
  void qc.invalidateQueries({ queryKey: conversationKeys.all(wsId) });
}

// 接受邀请:加入了新的 workspace/squad → 工作区列表、通讯录、团队列表都要重取;
// 并从「我的邀请」pending 列表移除本条(整段失效重拉)。
export function invalidateAfterAcceptInvitation(qc: QueryClient, wsId: string): void {
  void qc.invalidateQueries({ queryKey: workspaceKeys.all() });
  void qc.invalidateQueries({ queryKey: contactKeys.all(wsId) });
  void qc.invalidateQueries({ queryKey: teamKeys.all(wsId) });
  void qc.invalidateQueries({ queryKey: invitationKeys.all() });
}

// 移除 squad 成员:成员集合变化,且移人类成员会联动注销其共享分身 → 失效 squad members + 通讯录。
export function invalidateAfterRemoveMember(qc: QueryClient, wsId: string): void {
  void qc.invalidateQueries({ queryKey: squadMemberKeys.all(wsId) });
  void qc.invalidateQueries({ queryKey: contactKeys.all(wsId) });
}

// ── 错误码 → i18n 文案 key(纯函数,UI 与测试共用)──────────────────────────
// 建团:403 = 无 workspace 管理员权限(服务端 requireWorkspaceRole owner/admin)。
export function createSquadErrorKey(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return "team.errNeedAdmin";
  return "team.errCreateFailed";
}

// 凭码加入:410 + code_expired = 码过期/不存在;其余归一为通用失败。
// 注:「已在团队」不是错误(服务端 200 + already_member=true),由成功分支呈现,不落此表。
export function joinSquadErrorKey(err: unknown): string {
  if (err instanceof ApiError && err.code === "code_expired") return "team.errCodeExpired";
  return "team.errJoinFailed";
}

// 邀请成员:403 = 非 workspace owner/admin(无邀请权限);其余通用失败。
export function inviteMemberErrorKey(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return "team.errNeedAdmin";
  return "team.errInviteFailed";
}

// 接受邀请:410 = 已过期;409 = 已是成员(非致命,提示即可);其余通用失败。
export function acceptInvitationErrorKey(err: unknown): string {
  if (err instanceof ApiError && err.status === 410) return "team.errInviteExpired";
  if (err instanceof ApiError && err.status === 409) return "team.alreadyMember";
  return "team.errAcceptFailed";
}

// 更新团队信息 / 移除成员:均需 owner/admin,403 → 需要管理员权限;其余给各自通用失败。
export function updateSquadErrorKey(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return "team.errNeedAdmin";
  return "team.errSaveFailed";
}

export function removeMemberErrorKey(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return "team.errNeedAdmin";
  return "team.removeFailed";
}

// ── 纯 transform ────────────────────────────────────────────────────────────
// 当前用户在 workspace 中的角色(owner/admin 可管理团队);找不到成员记录返回 null。
export function resolveWorkspaceRole(members: WorkspaceMember[], userId: string): WorkspaceRole | null {
  return members.find((m) => m.user_id === userId)?.role ?? null;
}

// 可管理 = workspace owner 或 admin(建/邀请/移除/改团队信息均要求此权限)。
export function canManageWorkspace(role: WorkspaceRole | null): boolean {
  return role === "owner" || role === "admin";
}

// 单个 squad 成员的可渲染行(名字已解析)。
export interface SquadMemberRow {
  key: string;
  memberType: SquadMemberType;
  memberId: string;
  role: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  isAgent: boolean;
  isLeader: boolean;
}

// 把 squad 成员(无用户名)与 workspace 成员(带名字)映射为可渲染行:
// 人类成员按 member_id === user_id 关联出名字/邮箱/头像;智能体成员无用户信息,置 isAgent 供 UI 打「智能体」标。
// leader(role === "leader")不可移除,置 isLeader 供 UI 禁用移除按钮。找不到对应人类成员时名字回落 member_id。
export function mapSquadMemberRows(members: SquadMember[], wsMembers: WorkspaceMember[]): SquadMemberRow[] {
  const byUserId = new Map(wsMembers.map((m) => [m.user_id, m]));
  return members.map((m) => {
    const human = m.member_type === "member" ? byUserId.get(m.member_id) : undefined;
    return {
      key: m.id,
      memberType: m.member_type,
      memberId: m.member_id,
      role: m.role,
      name: human?.name ?? m.member_id,
      email: human?.email ?? null,
      avatarUrl: human?.avatar_url ?? null,
      isAgent: m.member_type === "agent",
      isLeader: m.role === "leader",
    };
  });
}

// ── Hooks ────────────────────────────────────────────────────────────────
// 列出当前 workspace 的 squad;仅 apiClient 存在(真实后端)时启用,mock/web 无后端 → 空闲。
export function useSquadsQuery() {
  const wsId = useWorkspaceId();
  const { apiClient } = useCoreContext();
  return useQuery<ApiSquad[]>({
    queryKey: teamKeys.list(wsId),
    enabled: !!apiClient,
    queryFn: () => apiClient!.listSquads(),
  });
}

// 建团(名称)。403(非 owner/admin)由 createSquadErrorKey 映射为「需要管理员权限」提示。
export function useCreateSquad() {
  const wsId = useWorkspaceId();
  const { apiClient } = useCoreContext();
  const qc = useQueryClient();
  return useMutation<ApiSquad, Error, string>({
    mutationFn: (name) => apiClient!.createSquad(name),
    onSuccess: () => invalidateAfterCreateSquad(qc, wsId),
  });
}

// 生成邀请码:不改成员集合,故无 invalidation;返回码 + 过期时间供 UI 展示/复制。
export function useCreateJoinCode() {
  const { apiClient } = useCoreContext();
  return useMutation<SquadJoinCodeResponse, Error, string>({
    mutationFn: (squadId) => apiClient!.createSquadJoinCode(squadId),
  });
}

// 凭码加入(幂等):成功后 already_member=true 表示已在团(UI 走 info 呈现,非错误)。
export function useJoinByCode() {
  const wsId = useWorkspaceId();
  const { apiClient } = useCoreContext();
  const qc = useQueryClient();
  return useMutation<SquadJoinResponse, Error, string>({
    mutationFn: (code) => apiClient!.joinSquadByCode(code),
    onSuccess: () => invalidateAfterMembershipChange(qc, wsId),
  });
}

// 退团 = 移除自己(member_type='member', member_id=当前用户 id)。服务端联动注销该成员
// 全部共享分身 + 中断在途 avatar 会话,故按成员变更全量失效。
// 注:服务端该端点要求调用者具 workspace owner/admin 角色,非管理员退团将得 403(UI 透传提示)。
export function useLeaveSquad() {
  const wsId = useWorkspaceId();
  const { apiClient, identity } = useCoreContext();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (squadId) => apiClient!.removeSquadMember(squadId, "member", identity.userId),
    onSuccess: () => invalidateAfterMembershipChange(qc, wsId),
  });
}

// ── W2：workspace 成员 / 邀请 / squad 成员管理 hooks ──────────────────────────

// 当前 workspace 的成员列表(带名字/邮箱/角色);供成员名字映射与「我是否可管理」判定。
export function useWorkspaceMembers() {
  const wsId = useWorkspaceId();
  const { apiClient } = useCoreContext();
  return useQuery<WorkspaceMember[]>({
    queryKey: workspaceKeys.members(wsId),
    enabled: !!apiClient,
    queryFn: () => apiClient!.listWorkspaceMembers(wsId),
  });
}

// 邀请成员(email+role)。403(非 owner/admin)由 inviteMemberErrorKey 映射为「需要管理员权限」。
// 不改成员集合(受邀者尚未 accept),故无 invalidation。
export function useInviteMember() {
  const wsId = useWorkspaceId();
  const { apiClient } = useCoreContext();
  return useMutation<InvitationResponse, Error, { email: string; role: string }>({
    mutationFn: ({ email, role }) => apiClient!.createWorkspaceInvitation(wsId, email, role),
  });
}

// 我的 pending 邀请(跨 workspace);仅 apiClient 存在时启用。
export function useMyInvitations() {
  const { apiClient } = useCoreContext();
  return useQuery<InvitationResponse[]>({
    queryKey: invitationKeys.mine(),
    enabled: !!apiClient,
    queryFn: () => apiClient!.listMyInvitations(),
  });
}

// 接受邀请:成功后全量失效(workspaces + contacts + squads + invitations),使新工作区/团队/成员即刻可见。
export function useAcceptInvitation() {
  const wsId = useWorkspaceId();
  const { apiClient } = useCoreContext();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiClient!.acceptInvitation(id),
    onSuccess: () => invalidateAfterAcceptInvitation(qc, wsId),
  });
}

// 拒绝邀请:仅从「我的邀请」pending 列表移除,失效 invitations 即可。
export function useDeclineInvitation() {
  const { apiClient } = useCoreContext();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiClient!.declineInvitation(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: invitationKeys.all() }),
  });
}

// 更新团队信息(名称/描述等,全可选补丁)。名称变化 → 失效团队列表(teamKeys)使卡片标题重取。
export function useUpdateSquad() {
  const wsId = useWorkspaceId();
  const { apiClient } = useCoreContext();
  const qc = useQueryClient();
  return useMutation<
    SquadResponse,
    Error,
    { squadId: string; patch: { name?: string; description?: string; instructions?: string; avatar_url?: string } }
  >({
    mutationFn: ({ squadId, patch }) => apiClient!.updateSquad(squadId, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: teamKeys.all(wsId) }),
  });
}

// 某 squad 的成员列表;enabled 需 apiClient 且 squadId 存在。
export function useSquadMembers(squadId: string) {
  const wsId = useWorkspaceId();
  const { apiClient } = useCoreContext();
  return useQuery<SquadMember[]>({
    queryKey: squadMemberKeys.detail(wsId, squadId),
    enabled: !!apiClient && !!squadId,
    queryFn: () => apiClient!.listSquadMembers(squadId),
  });
}

// 移除任意 squad 成员(owner/admin)。不能移 leader(UI 已禁用);移人类成员联动注销其共享分身,
// 故按 invalidateAfterRemoveMember 失效 members + contacts。
export function useRemoveSquadMember() {
  const wsId = useWorkspaceId();
  const { apiClient } = useCoreContext();
  const qc = useQueryClient();
  return useMutation<void, Error, { squadId: string; memberType: string; memberId: string }>({
    mutationFn: ({ squadId, memberType, memberId }) => apiClient!.removeSquadMember(squadId, memberType, memberId),
    onSuccess: () => invalidateAfterRemoveMember(qc, wsId),
  });
}
