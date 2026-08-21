export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
export type IssuePriority = "urgent" | "high" | "medium" | "low" | "none";
export type IssueAssigneeType = "member" | "agent" | "squad";

export interface Issue {
  id: string;
  workspace_id: string;
  number: number;
  identifier: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assignee_type: IssueAssigneeType | null;
  assignee_id: string | null;
  creator_type: IssueAssigneeType;
  creator_id: string;
  parent_issue_id: string | null;
  project_id: string | null;
  position: number;
  start_date: string | null;
  due_date: string | null;
  labels?: { id: string; name: string; color: string }[];
  created_at: string;
  updated_at: string;
}

export interface ListIssuesResponse {
  issues: Issue[];
  total: number;
}

export type AgentStatus = "idle" | "working" | "blocked" | "error" | "offline";
export type AgentRuntimeMode = "local" | "cloud";
export type AgentVisibility = "workspace" | "private";

export interface Agent {
  id: string;
  workspace_id: string;
  runtime_id: string;
  name: string;
  description: string;
  instructions: string;
  avatar_url: string | null;
  runtime_mode: AgentRuntimeMode;
  runtime_config: Record<string, unknown>;
  custom_env: Record<string, string>;
  custom_args: string[];
  custom_env_redacted?: boolean;
  visibility: AgentVisibility;
  status: AgentStatus;
  max_concurrent_tasks: number;
  model: string;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  archived_by: string | null;
}

export type AgentTaskStatus = "queued" | "dispatched" | "running" | "completed" | "failed" | "cancelled";

export interface AgentTask {
  id: string;
  agent_id: string;
  runtime_id: string;
  issue_id: string;
  workspace_id?: string;
  status: AgentTaskStatus;
  priority: number;
  dispatched_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  result: unknown;
  error: string | null;
  failure_reason?: string;
  attempt?: number;
  max_attempts?: number;
  created_at: string;
  trigger_summary?: string;
  trigger_author_name?: string;
  chat_session_id?: string;
  autopilot_run_id?: string;
  quick_create_prompt?: string;
  kind?: "comment" | "autopilot" | "chat" | "quick_create" | "direct";
  work_dir?: string;
}

export interface AgentActivityBucket {
  agent_id: string;
  bucket_at: string;
  task_count: number;
  failed_count: number;
}

export interface AgentRunCount {
  agent_id: string;
  run_count: number;
}

export interface DashboardUsageDaily {
  date: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  task_count: number;
}

export interface DashboardUsageByAgent {
  agent_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  task_count: number;
}

export interface DashboardAgentRunTime {
  agent_id: string;
  total_seconds: number;
  task_count: number;
  failed_count: number;
}

export interface DashboardRunTimeDaily {
  date: string;
  total_seconds: number;
  task_count: number;
  failed_count: number;
}

// ── 团队分身（共享角色）调用 DTO ──────────────────────────────────────────────
// 服务端 JSON 原样（snake_case，不转 camelCase；与既有 DTO 风格一致）。对齐契约 §3/§5。

import type { AvatarApprovalPolicy, AvatarSessionPhase, AvatarSessionOutcome } from "../desktop/avatar-types";

// 分身两级在线态：online（可执行）/ online_unavailable（在线但 CLI 不可执行）/ offline。
export type ApiAvatarStatus = "online" | "online_unavailable" | "offline";

// GET /api/avatars 列表项（AvatarDTO）。daily_used = 今日已用次数（服务端按日 COUNT）。
export interface ApiAvatar {
  runtime_id: string;
  owner: { id: string; name: string; email: string };
  role_id: string;
  role_label: string;
  agent: string;
  approval_policy: AvatarApprovalPolicy;
  daily_limit: number;
  caller_daily_limit: number;
  daily_used: number;
  status: ApiAvatarStatus;
}

// POST /api/avatars/{runtimeId}/invoke 的 202 响应。approval_required = manual 策略待审批。
export interface AvatarInvokeResponse {
  conversation_id: string;
  turn_id: string;
  // 兼容旧客户端:服务端迁移期仍返回 task_id,新聊天链路应使用 turn_id。
  task_id?: string;
  approval_required: boolean;
}

// GET /api/avatars/{runtimeId}/sessions 列表项。多轮会话化后（migration 100）**一行 = 一个会话**
// （不再一 task 一行）：conversation_id 为会话容器 id，task_id 为该会话最近一轮 task（供兼容/兜底），
// prompt/phase/outcome 取自最近一轮，turn_count 为轮数。created_at 为会话创建、updated_at 为最近活跃。
// outcome 为 null 表示最近一轮尚未终态（phase 生效中，列表显示「进行中」）。
// caller_id/caller_name 仅在 owner 视角（?view=owner）下回填，标识发起该会话的调用者。
export interface AvatarSessionSummary {
  conversation_id: string;
  task_id: string;
  prompt: string;
  phase: AvatarSessionPhase;
  outcome: AvatarSessionOutcome | null;
  turn_count: number;
  created_at: string;
  updated_at: string;
  caller_id?: string;
  caller_name?: string;
}

// GET /api/avatars/conversations/{conversationId}/messages 的一轮：提问 prompt + 该轮 agent 帧 + 终态。
// messages 为该轮 task 的保序帧子集（无 id/created_at，仅折叠渲染所需字段）。
export interface AvatarConversationTurn {
  turn_id: string;
  // 旧完整历史接口迁移期仍可能带 task_id；新单轮接口不会暴露 task_id。
  task_id?: string;
  prompt: string;
  phase: AvatarSessionPhase;
  outcome: AvatarSessionOutcome | null;
  created_at: string;
  messages: Array<{
    turn_id: string;
    task_id?: string;
    seq: number;
    type: "text" | "thinking" | "tool" | "tool_use" | "tool_result" | "avatar_status" | "result" | "error";
    tool?: string;
    content?: string;
    input?: unknown;
    output?: string;
  }>;
}

// 会话详情响应：容器下按轮升序排列的完整多轮历史。
export interface AvatarConversationDetail {
  conversation_id: string;
  turns: AvatarConversationTurn[];
}

// GET /api/avatars/conversations/{conversationId}/turns/{turnId}/messages 的单轮增量响应。
export interface AvatarConversationTurnDetail {
  conversation_id: string;
  turn: AvatarConversationTurn;
}

// task_message 行（保序 = seq）。input/output 为 JSONB（工具入参/结果，形状不定 → unknown）。
// type 取值兼容服务端真实行：text/thinking/tool_use/tool_result/error，以及旧前端契约
// tool/avatar_status/result。tool/content 仅部分类型有值。
export interface AvatarTaskMessage {
  id: string;
  task_id?: string;
  turn_id?: string;
  seq: number;
  type: "text" | "thinking" | "tool" | "tool_use" | "tool_result" | "avatar_status" | "result" | "error";
  tool: string | null;
  content: string | null;
  input: unknown;
  output: unknown;
  created_at: string;
}

// ── M2 分身调用审计 / 团队(squad)加入码 DTO ───────────────────────────────────
// 均为服务端 JSON 原样（snake_case，不转 camelCase）。对齐契约 §6 与 M2 端点约定。

// 审计动作三态：受理(invocation)、终态(finished)、受理即拒(rejected，超限等)。
export type AvatarAuditAction =
  | "avatar.invocation"
  | "avatar.invocation.finished"
  | "avatar.invocation.rejected";

// 单条审计记录的 details（activity_log 落库形状）。
// outcome 仅 finished 记录有值；input/output_tokens 从 task_usage 取，可空（尚无用量时为 null）。
export interface AvatarAuditRecordDetails {
  runtime_id: string;
  role_label: string;
  // 可空:早期 finished/rejected 行未落 prompt(服务端后补),消费端须防御。
  prompt?: string | null;
  task_id: string;
  outcome?: AvatarSessionOutcome;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

// GET /api/avatars/audit 列表项（仅「当前用户是 runtime owner」的记录）。
export interface AvatarAuditRecord {
  id: string;
  action: AvatarAuditAction;
  actor_id: string;
  caller_name: string;
  created_at: string;
  details: AvatarAuditRecordDetails;
}

export interface AvatarAuditResponse {
  records: AvatarAuditRecord[];
}

// POST /api/squads/{id}/join-code 响应：8 位大写 base32 加入码 + 过期时间。
// 重复调用生成新码，旧码仍有效至过期（服务端语义，前端不缓存）。
export interface SquadJoinCodeResponse {
  code: string;
  expires_at: string;
}

// POST /api/squads/join 响应：加入成功返回 squad_id；已是成员时仅 already_member=true（无 squad_id）。
// 过期/不存在的码由服务端返回 410 + { code: "code_expired" }，走 ApiError（不落此类型）。
export interface SquadJoinResponse {
  squad_id?: string;
  already_member: boolean;
}

// listSquads 用的最小 squad 形状（以服务端 GET /api/squads 现状为准，只取消费方需要的 id/name）。
export interface ApiSquad {
  id: string;
  name: string;
}

// ── W2：团队管理完整化 / workspace 邀请 DTO ───────────────────────────────────
// 均为服务端 JSON 原样（snake_case，不转 camelCase）。

export type WorkspaceRole = "owner" | "admin" | "member";

// GET /api/workspaces 列表项（仅当前用户为成员的 workspace）。
export interface Workspace {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  issue_prefix: string;
  created_at?: string;
  updated_at?: string;
}

// GET /api/workspaces/{id}/members 列表项：已 join 用户信息（user_id 关联真实用户）。
export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
  name: string;
  email: string;
  avatar_url: string | null;
}

export type InvitationStatus = "pending" | "accepted" | "declined" | "expired";

// POST /api/workspaces/{id}/members 及 GET /api/invitations 的邀请返回体。
// 被邀请人无需已注册（invitee_email 为其邮箱）。role 只可能是 admin|member（owner 不可邀请）。
export interface InvitationResponse {
  id: string;
  invitee_email: string;
  role: WorkspaceRole;
  status: InvitationStatus;
  expires_at: string;
  inviter_name: string;
  workspace_name: string;
  workspace_id?: string;
  created_at?: string;
}

export type SquadMemberType = "agent" | "member";

// GET /api/squads/{id}/members 列表项：无用户名，人类成员名字须用 workspace members 映射（见 mapSquadMemberRows）。
// role 取值含 "leader"（不可被移除）与普通成员角色。
export interface SquadMember {
  id: string;
  squad_id: string;
  member_type: SquadMemberType;
  member_id: string;
  role: string;
  created_at: string;
}

// PUT /api/squads/{id} 返回体（全可选补丁后的 squad 全貌）。
export interface SquadResponse {
  id: string;
  name: string;
  description?: string | null;
  instructions?: string | null;
  avatar_url?: string | null;
}

// ── 服务器工作区（server workspace）：内网服务器 daemon 托管的持久命名 git checkout ──
// 契约见 docs/plans（前后端裁定）：mode='shared'（全队同一 checkout，任务按 instance 串行排队）
// | 'isolated'（每成员一份 worktree）。字段 snake_case 与 Go 服务端对齐。

export type ServerWorkspaceMode = "shared" | "isolated";
export type ServerWorkspaceStatus = "provisioning" | "ready" | "error" | "archived";
export type ServerWorkspaceVisibility = "workspace" | "squad";

export interface ServerWorkspace {
  id: string;
  workspace_id: string;
  // 绑定 daemon 机器（同机全部 provider runtime 共享）；invoke 时服务端校验所选
  // runtime.daemon_id == server_workspace.daemon_id。
  daemon_id: string;
  name: string;
  slug: string;
  description?: string;
  repo_url: string;
  default_branch?: string;
  mode: ServerWorkspaceMode;
  visibility: ServerWorkspaceVisibility;
  squad_id?: string | null;
  status: ServerWorkspaceStatus;
  status_detail?: string;
  root_path?: string;
  disk_usage_bytes?: number;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
  // 列表端点附带的占用/排队摘要（权威实时态走 server_workspace:queue 事件）。
  running_task_id?: string | null;
  running_caller_id?: string | null;
  queue_depth?: number;
  // isolated 模式：当前用户自己的实例状态（无则尚未 provision）。
  my_instance?: ServerWorkspaceInstance | null;
}

export interface ServerWorkspaceInstance {
  id: string;
  server_workspace_id: string;
  member_user_id?: string | null; // null = shared 单例
  path?: string;
  branch?: string;
  status: "provisioning" | "ready" | "error";
}

export interface CreateServerWorkspaceRequest {
  name: string;
  repo_url: string;
  branch?: string;
  mode: ServerWorkspaceMode;
  runtime_id: string; // 服务端由 runtime 反查 daemon_id
  visibility?: ServerWorkspaceVisibility;
  squad_id?: string;
}

// POST /api/server-workspaces/{id}/invoke 响应。排队不是错误：受理即返回
// queue_position（0=立即执行，>0=前方还有 N 个任务）。
export interface ServerWorkspaceInvokeResponse {
  conversation_id: string;
  turn_id: string;
  task_id: string;
  queue_position: number;
}

// 服务器侧 runtime 摘要（list 响应附带）：把「daemon 机器 → 可用 runtime」绑定起来，
// invoke 与创建都必须带 runtime_id，而 ServerWorkspace 上只有 daemon_id。
export interface ServerRuntime {
  id: string;
  daemon_id: string;
  name: string;
  provider?: string;
  online: boolean;
}

// GET /api/server-workspaces/{id}/queue 列表项（占用中/排队中任务的展示摘要）。
export interface ServerWorkspaceQueueItem {
  task_id: string;
  caller_id: string;
  caller_name?: string;
  status: "queued" | "dispatched" | "running";
  created_at: string;
}
