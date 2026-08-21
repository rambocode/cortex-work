import type {
  Agent,
  AgentActivityBucket,
  AgentRunCount,
  AgentTask,
  ApiAvatar,
  ApiSquad,
  AvatarAuditResponse,
  AvatarConversationDetail,
  AvatarConversationTurnDetail,
  AvatarInvokeResponse,
  AvatarSessionSummary,
  AvatarTaskMessage,
  DashboardAgentRunTime,
  DashboardRunTimeDaily,
  DashboardUsageByAgent,
  DashboardUsageDaily,
  InvitationResponse,
  ListIssuesResponse,
  SquadJoinCodeResponse,
  SquadJoinResponse,
  SquadMember,
  SquadResponse,
  Workspace,
  WorkspaceMember,
} from "./types";

export interface ApiClientConfig {
  baseUrl: string;
  token?: string;
  workspaceId?: string;
  workspaceSlug?: string;
  platform?: "web" | "desktop";
  version?: string;
  os?: "macos" | "windows" | "linux" | "unknown";
}

// 后端错误封套：非 2xx 时抛出，携带 HTTP status 供调用方分支处理。
// `code` 为可选业务错误码（如 conversation_busy/quota_exceeded/avatar_offline，见契约 §3），
// 从 JSON body 的 code 字段解析而来；加性字段，不破坏既有三参构造。
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function appendSearch(path: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === false || value === "") continue;
    search.set(key, value === true ? "true" : String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

export class ApiClient {
  private readonly config: ApiClientConfig;

  constructor(config: ApiClientConfig) {
    this.config = { ...config, baseUrl: cleanBaseUrl(config.baseUrl) };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    if (this.config.workspaceSlug) headers["X-Workspace-Slug"] = this.config.workspaceSlug;
    if (this.config.workspaceId) headers["X-Workspace-ID"] = this.config.workspaceId;
    if (this.config.platform) headers["X-Client-Platform"] = this.config.platform;
    if (this.config.version) headers["X-Client-Version"] = this.config.version;
    if (this.config.os) headers["X-Client-OS"] = this.config.os;
    return headers;
  }

  // 把非 2xx 响应体解析成 ApiError：优先从 JSON body 抽 code（业务错误码）与 message，
  // 非 JSON body 保留原始文本作为 message（与既有行为一致）。
  private async toApiError(response: Response, fallbackLabel: string): Promise<ApiError> {
    const raw = await response.text().catch(() => "");
    let code: string | undefined;
    let message = raw;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown; error?: unknown };
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.code === "string") code = parsed.code;
          if (typeof parsed.message === "string") message = parsed.message;
          else if (typeof parsed.error === "string") message = parsed.error;
        }
      } catch {
        // 非 JSON body：保留原始文本作为 message
      }
    }
    return new ApiError(message || `${fallbackLabel} failed`, response.status, response.statusText, code);
  }

  // 读取成功响应体为 JSON；空 body（如 cancel 的 200/202 无内容）返回 undefined，避免 JSON.parse 抛错。
  private async readJson<T>(response: Response): Promise<T> {
    const raw = await response.text();
    return (raw ? JSON.parse(raw) : undefined) as T;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers(),
      credentials: "include",
    });
    if (!response.ok) throw await this.toApiError(response, `GET ${path}`);
    return this.readJson<T>(response);
  }

  // POST helper：JSON 序列化 body（body 省略时不带请求体），复用 headers()/ApiError/credentials。
  private async post<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw await this.toApiError(response, `POST ${path}`);
    return this.readJson<T>(response);
  }

  // DELETE helper：部分服务端 DELETE 端点（如移除 squad 成员）带 JSON body，
  // 故 body 可选并在存在时序列化；复用 headers()/ApiError/credentials 约定。
  private async del<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.headers(),
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw await this.toApiError(response, `DELETE ${path}`);
    return this.readJson<T>(response);
  }

  // PUT helper：部分幂等更新端点（如 PUT /api/squads/{id} 团队信息）使用，body 全可选补丁。
  private async put<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method: "PUT",
      headers: this.headers(),
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw await this.toApiError(response, `PUT ${path}`);
    return this.readJson<T>(response);
  }

  listIssues(params: { limit?: number; offset?: number; open_only?: boolean } = {}): Promise<ListIssuesResponse> {
    return this.get<ListIssuesResponse>(appendSearch("/api/issues", { limit: 200, ...params }));
  }

  listAgents(params: { include_archived?: boolean } = {}): Promise<Agent[]> {
    return this.get<Agent[]>(appendSearch("/api/agents", params));
  }

  listAgentTaskSnapshot(): Promise<AgentTask[]> {
    return this.get<AgentTask[]>("/api/agent-task-snapshot");
  }

  listAgentRunCounts30d(): Promise<AgentRunCount[]> {
    return this.get<AgentRunCount[]>("/api/agent-run-counts");
  }

  listAgentActivity30d(): Promise<AgentActivityBucket[]> {
    return this.get<AgentActivityBucket[]>("/api/agent-activity-30d");
  }

  getDashboardUsageDaily(params: { days: number; projectId?: string | null }): Promise<DashboardUsageDaily[]> {
    return this.get<DashboardUsageDaily[]>(
      appendSearch("/api/dashboard/usage/daily", { days: params.days, project_id: params.projectId }),
    );
  }

  getDashboardUsageByAgent(params: { days: number; projectId?: string | null }): Promise<DashboardUsageByAgent[]> {
    return this.get<DashboardUsageByAgent[]>(
      appendSearch("/api/dashboard/usage/by-agent", { days: params.days, project_id: params.projectId }),
    );
  }

  getDashboardAgentRunTime(params: { days: number; projectId?: string | null }): Promise<DashboardAgentRunTime[]> {
    return this.get<DashboardAgentRunTime[]>(
      appendSearch("/api/dashboard/agent-runtime", { days: params.days, project_id: params.projectId }),
    );
  }

  getDashboardRunTimeDaily(params: { days: number; projectId?: string | null }): Promise<DashboardRunTimeDaily[]> {
    return this.get<DashboardRunTimeDaily[]>(
      appendSearch("/api/dashboard/runtime/daily", { days: params.days, project_id: params.projectId }),
    );
  }

  // ── 团队分身（共享角色）调用端点（契约 §3/§5）───────────────────────────────
  // 响应保持服务端 snake_case 原样，不转 camelCase（与既有 DTO 风格一致）。

  // GET /api/avatars：列出当前 workspace 内对调用者可见的共享分身。
  listAvatars(): Promise<{ avatars: ApiAvatar[] }> {
    return this.get<{ avatars: ApiAvatar[] }>("/api/avatars");
  }

  // POST /api/avatars/{runtimeId}/invoke：向分身发起一轮会话。
  // 202 返回 { conversation_id, turn_id, approval_required }；task_id 仅为旧客户端兼容字段。
  // 受理失败按 §3 抛 ApiError 带 code
  // （409 conversation_busy / 503 avatar_offline|avatar_unavailable / 429 quota_exceeded 等）。
  invokeAvatar(runtimeId: string, prompt: string): Promise<AvatarInvokeResponse> {
    return this.post<AvatarInvokeResponse>(`/api/avatars/${encodeURIComponent(runtimeId)}/invoke`, { prompt });
  }

  // POST /api/avatars/conversations/{conversationId}/turns/{turnId}/cancel：调用者取消在途会话轮次。
  async cancelAvatarTurn(conversationId: string, turnId: string): Promise<void> {
    await this.post<unknown>(
      `/api/avatars/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/cancel`,
    );
  }

  // POST /api/avatars/tasks/{taskId}/cancel：旧客户端兼容路径；新聊天链路使用 cancelAvatarTurn。
  async cancelAvatarTask(taskId: string): Promise<void> {
    await this.post<unknown>(`/api/avatars/tasks/${encodeURIComponent(taskId)}/cancel`);
  }

  // GET /api/avatars/{runtimeId}/sessions：列出与该分身的会话历史。
  // view="owner"（?view=owner）为 runtime 拥有者视角，返回全部调用者的会话并带 caller_id/caller_name；
  // 省略 view = 调用者本人视角，仅自己的会话、无 caller 字段（服务端契约见 §5 owner 视角约定）。
  listAvatarSessions(runtimeId: string, view?: "owner"): Promise<{ sessions: AvatarSessionSummary[] }> {
    return this.get<{ sessions: AvatarSessionSummary[] }>(
      appendSearch(`/api/avatars/${encodeURIComponent(runtimeId)}/sessions`, { view }),
    );
  }

  // GET /api/tasks/{taskId}/messages：取会话保序帧（seq 递增）。
  // sinceSeq 增量拉取，经 appendSearch 以 since 查询参数下传。
  async listTaskMessages(taskId: string, sinceSeq?: number): Promise<{ messages: AvatarTaskMessage[] }> {
    const res = await this.get<AvatarTaskMessage[] | { messages: AvatarTaskMessage[] }>(
      appendSearch(`/api/tasks/${encodeURIComponent(taskId)}/messages`, { since: sinceSeq }),
    );
    return Array.isArray(res) ? { messages: res } : res;
  }

  // GET /api/avatars/conversations/{conversationId}/messages：取某多轮会话（migration 100）的完整
  // 历史，按轮聚合（每轮带 prompt + agent 帧）。授权同 R19——仅会话双方（owner 或 caller 本人）可读。
  getAvatarConversation(conversationId: string): Promise<AvatarConversationDetail> {
    return this.get<AvatarConversationDetail>(
      `/api/avatars/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
  }

  // GET /api/avatars/conversations/{conversationId}/turns/{turnId}/messages：取单轮会话增量帧。
  // 这是用户侧聊天的轮询入口；task messages endpoint 仅保留给旧兼容/内部执行视角。
  getAvatarConversationTurn(
    conversationId: string,
    turnId: string,
    sinceSeq?: number,
  ): Promise<AvatarConversationTurnDetail> {
    return this.get<AvatarConversationTurnDetail>(
      appendSearch(
        `/api/avatars/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/messages`,
        { since: sinceSeq },
      ),
    );
  }

  // ── M2：分身调用审计 / 团队(squad)加入码端点（契约 §6）─────────────────────
  // 响应保持服务端 snake_case 原样，不转 camelCase。

  // GET /api/avatars/audit：拥有者读自己分身的调用记录（仅当前用户为 runtime owner 的记录）。
  // runtime_id 可选（不传则跨该用户全部分身）；limit 默认由服务端取 50，未传则不下发该参数。
  listAvatarAudit(params: { runtime_id?: string; limit?: number } = {}): Promise<AvatarAuditResponse> {
    return this.get<AvatarAuditResponse>(
      appendSearch("/api/avatars/audit", { runtime_id: params.runtime_id, limit: params.limit }),
    );
  }

  // POST /api/squads/{id}/join-code：为 squad 生成新加入码（成员权限，重复调用换新码，旧码至过期仍有效）。
  createSquadJoinCode(squadId: string): Promise<SquadJoinCodeResponse> {
    return this.post<SquadJoinCodeResponse>(`/api/squads/${encodeURIComponent(squadId)}/join-code`);
  }

  // POST /api/squads/join：凭码加入 squad（幂等）。
  // 过期/不存在的码服务端返回 410 + { code: "code_expired" } → 由 toApiError 透传为 ApiError.code。
  joinSquadByCode(code: string): Promise<SquadJoinResponse> {
    return this.post<SquadJoinResponse>("/api/squads/join", { code });
  }

  // GET /api/squads：列出当前 workspace 的 squad（服务端返回数组，非封套）。
  listSquads(): Promise<ApiSquad[]> {
    return this.get<ApiSquad[]>("/api/squads");
  }

  // POST /api/squads：建团（返回新建 squad）。签名对齐 U11 契约仅取 name。
  createSquad(name: string): Promise<ApiSquad> {
    return this.post<ApiSquad>("/api/squads", { name });
  }

  // DELETE /api/squads/{id}/members：移除 squad 成员（body 带 member_type/member_id，服务端既有形状）。
  // 不能移 leader；移人类成员会联动注销其共享分身（服务端语义）。
  removeSquadMember(squadId: string, memberType: string, memberId: string): Promise<void> {
    return this.del<void>(`/api/squads/${encodeURIComponent(squadId)}/members`, {
      member_type: memberType,
      member_id: memberId,
    });
  }

  // GET /api/squads/{id}/members：列出 squad 成员（agent|member，无用户名，须与 workspace members 映射出名字）。
  listSquadMembers(squadId: string): Promise<SquadMember[]> {
    return this.get<SquadMember[]>(`/api/squads/${encodeURIComponent(squadId)}/members`);
  }

  // PUT /api/squads/{id}：更新团队信息（请求全可选，需 owner/admin）→ SquadResponse。
  updateSquad(
    squadId: string,
    patch: { name?: string; description?: string; instructions?: string; avatar_url?: string },
  ): Promise<SquadResponse> {
    return this.put<SquadResponse>(`/api/squads/${encodeURIComponent(squadId)}`, patch);
  }

  // ── W2：workspace 管理与邀请端点 ───────────────────────────────────────────
  // 响应保持服务端 snake_case 原样。

  // GET /api/workspaces：列出当前用户为成员的全部 workspace。
  listWorkspaces(): Promise<Workspace[]> {
    return this.get<Workspace[]>("/api/workspaces");
  }

  // POST /api/workspaces：建 workspace（创建者自动 owner）；slug 须小写字母数字连字符，冲突 409。
  createWorkspace(body: { name: string; slug: string }): Promise<Workspace> {
    return this.post<Workspace>("/api/workspaces", body);
  }

  // GET /api/workspaces/{id}/members：列出 workspace 已 join 成员（带用户名/邮箱/头像）。
  listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    return this.get<WorkspaceMember[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`);
  }

  // POST /api/workspaces/{id}/members：按邮箱邀请成员（role∈admin|member，需 owner/admin，403 无权限）。
  // 被邀请人无需已注册，返回 InvitationResponse（pending）。
  createWorkspaceInvitation(workspaceId: string, email: string, role: string): Promise<InvitationResponse> {
    return this.post<InvitationResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`, { email, role });
  }

  // GET /api/invitations：我的 pending 邀请（带 workspace_name/inviter_name）。
  listMyInvitations(): Promise<InvitationResponse[]> {
    return this.get<InvitationResponse[]>("/api/invitations");
  }

  // POST /api/invitations/{id}/accept：接受邀请（过期 410 / 已是成员 409），无响应体。
  acceptInvitation(invitationId: string): Promise<void> {
    return this.post<void>(`/api/invitations/${encodeURIComponent(invitationId)}/accept`);
  }

  // POST /api/invitations/{id}/decline：拒绝邀请（204 无响应体）。
  declineInvitation(invitationId: string): Promise<void> {
    return this.post<void>(`/api/invitations/${encodeURIComponent(invitationId)}/decline`);
  }
}
