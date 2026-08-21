import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";

describe("ApiClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends auth, workspace and client metadata headers", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({
      baseUrl: "http://localhost:8080/",
      token: "test-token",
      workspaceId: "ws-id",
      workspaceSlug: "acme",
      platform: "desktop",
      version: "0.1.0",
      os: "macos",
    });

    await client.listIssues();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/api/issues?limit=200",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "X-Workspace-ID": "ws-id",
          "X-Workspace-Slug": "acme",
          "X-Client-Platform": "desktop",
          "X-Client-Version": "0.1.0",
          "X-Client-OS": "macos",
        }),
      }),
    );
  });
});

// 团队分身端点的 happy-path 单测：验证 post 序列化、鉴权/workspace header 透传，
// 以及非 2xx 抛 ApiError 带 status 与业务 code（契约 §3）。
function makeAvatarClient() {
  return new ApiClient({
    baseUrl: "https://api.test/",
    token: "pat_abc",
    workspaceId: "ws_1",
    platform: "desktop",
  });
}

// 记录 fetch 调用并返回可配置响应；用 text() 桩覆盖 toApiError/readJson 的读取路径。
function mockFetch(response: { ok: boolean; status: number; statusText?: string; body?: string }) {
  const fn = vi.fn(async () => ({
    ok: response.ok,
    status: response.status,
    statusText: response.statusText ?? "",
    text: async () => response.body ?? "",
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("ApiClient avatar 端点", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("invokeAvatar：POST 到正确路径、序列化 body、带 Authorization/X-Workspace-ID header", async () => {
    const fetchMock = mockFetch({
      ok: true,
      status: 202,
      body: JSON.stringify({ conversation_id: "c1", turn_id: "t1", task_id: "t1", approval_required: false }),
    });
    const client = makeAvatarClient();

    const res = await client.invokeAvatar("rt_1", "帮我查一下 X");

    expect(res).toEqual({ conversation_id: "c1", turn_id: "t1", task_id: "t1", approval_required: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/avatars/rt_1/invoke");
    expect(init.method).toBe("POST");
    // body 必须是 JSON 序列化的 { prompt }
    expect(init.body).toBe(JSON.stringify({ prompt: "帮我查一下 X" }));
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer pat_abc");
    expect(headers["X-Workspace-ID"]).toBe("ws_1");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("listAvatars：GET /api/avatars 返回 avatars 封套", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: JSON.stringify({ avatars: [] }) });
    const client = makeAvatarClient();

    const res = await client.listAvatars();

    expect(res).toEqual({ avatars: [] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/avatars");
    expect(init.method).toBe("GET");
  });

  it("cancelAvatarTask：POST 到 cancel 路径、无请求体、空响应体不报错", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: "" });
    const client = makeAvatarClient();

    await expect(client.cancelAvatarTask("t_9")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/avatars/tasks/t_9/cancel");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("cancelAvatarTurn：POST 到 conversation turn cancel 路径、无请求体", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: JSON.stringify({ status: "cancelled" }) });
    const client = makeAvatarClient();

    await expect(client.cancelAvatarTurn("conv_9", "turn_9")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/avatars/conversations/conv_9/turns/turn_9/cancel");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("listTaskMessages：sinceSeq 经 since 查询参数下传", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: JSON.stringify({ messages: [] }) });
    const client = makeAvatarClient();

    await client.listTaskMessages("t_2", 12);

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/tasks/t_2/messages?since=12");
  });

  it("listTaskMessages：兼容服务端返回原始数组，归一化为 { messages }", async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: JSON.stringify([{ task_id: "t_2", seq: 1, type: "text", content: "答复" }]),
    });
    const client = makeAvatarClient();

    const res = await client.listTaskMessages("t_2");

    expect(res.messages).toEqual([{ task_id: "t_2", seq: 1, type: "text", content: "答复" }]);
  });

  it("listTaskMessages：省略 sinceSeq 时不带 query", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: JSON.stringify({ messages: [] }) });
    const client = makeAvatarClient();

    await client.listTaskMessages("t_2");

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/tasks/t_2/messages");
  });

  it("listAvatarSessions：GET /api/avatars/{runtimeId}/sessions", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: JSON.stringify({ sessions: [] }) });
    const client = makeAvatarClient();

    await client.listAvatarSessions("rt_7");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/avatars/rt_7/sessions");
    expect(init.method).toBe("GET");
  });

  it("getAvatarConversationTurn：GET 单轮消息并下传 since", async () => {
    const fetchMock = mockFetch({
      ok: true,
      status: 200,
      body: JSON.stringify({
        conversation_id: "conv_1",
        turn: {
          turn_id: "turn_1",
          prompt: "明天天气",
          phase: "running",
          outcome: null,
          created_at: "",
          messages: [{ turn_id: "turn_1", seq: 2, type: "text", content: "晴" }],
        },
      }),
    });
    const client = makeAvatarClient();

    const res = await client.getAvatarConversationTurn("conv_1", "turn_1", 1);

    expect(res.turn.messages[0]?.content).toBe("晴");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/avatars/conversations/conv_1/turns/turn_1/messages?since=1");
    expect(init.method).toBe("GET");
  });

  it("非 2xx：抛 ApiError 带 status 与 body 的 code 字段", async () => {
    mockFetch({ ok: false, status: 409, statusText: "Conflict", body: JSON.stringify({ code: "conversation_busy" }) });
    const client = makeAvatarClient();

    const err = await client.invokeAvatar("rt_1", "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(409);
    expect(apiErr.code).toBe("conversation_busy");
  });

  it("非 2xx：503 avatar_offline 的 code 可被读到", async () => {
    mockFetch({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      body: JSON.stringify({ code: "avatar_offline" }),
    });
    const client = makeAvatarClient();

    const err = (await client.invokeAvatar("rt_1", "hi").catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(503);
    expect(err.code).toBe("avatar_offline");
  });

  it("非 2xx：非 JSON body 时 code 为 undefined、message 保留原始文本", async () => {
    mockFetch({ ok: false, status: 500, statusText: "Internal", body: "boom" });
    const client = makeAvatarClient();

    const err = (await client.listAvatars().catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(500);
    expect(err.code).toBeUndefined();
    expect(err.message).toBe("boom");
  });
});

// U11：M2 端点（审计 / 团队加入码 / squad CRUD）的 URL/method/body 序列化 + 410 code 透传。
describe("ApiClient M2 端点", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("listAvatarAudit：runtime_id/limit 经 query 下传", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: JSON.stringify({ records: [] }) });
    const client = makeAvatarClient();

    const res = await client.listAvatarAudit({ runtime_id: "rt_1", limit: 20 });

    expect(res).toEqual({ records: [] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/avatars/audit?runtime_id=rt_1&limit=20");
    expect(init.method).toBe("GET");
  });

  it("listAvatarAudit：无参时不带 query", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: JSON.stringify({ records: [] }) });
    const client = makeAvatarClient();

    await client.listAvatarAudit();

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/avatars/audit");
  });

  it("createSquadJoinCode：POST 到 join-code 路径、无请求体", async () => {
    const fetchMock = mockFetch({
      ok: true,
      status: 200,
      body: JSON.stringify({ code: "ABCD2345", expires_at: "2026-07-11T00:00:00Z" }),
    });
    const client = makeAvatarClient();

    const res = await client.createSquadJoinCode("sq_1");

    expect(res).toEqual({ code: "ABCD2345", expires_at: "2026-07-11T00:00:00Z" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/squads/sq_1/join-code");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("joinSquadByCode：POST /api/squads/join、序列化 { code }", async () => {
    const fetchMock = mockFetch({
      ok: true,
      status: 200,
      body: JSON.stringify({ squad_id: "sq_1", already_member: false }),
    });
    const client = makeAvatarClient();

    const res = await client.joinSquadByCode("ABCD2345");

    expect(res).toEqual({ squad_id: "sq_1", already_member: false });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/squads/join");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ code: "ABCD2345" }));
  });

  it("joinSquadByCode：已是成员 → already_member=true 无 squad_id", async () => {
    mockFetch({ ok: true, status: 200, body: JSON.stringify({ already_member: true }) });
    const client = makeAvatarClient();

    const res = await client.joinSquadByCode("ABCD2345");

    expect(res).toEqual({ already_member: true });
  });

  it("joinSquadByCode：410 → ApiError.code === code_expired", async () => {
    mockFetch({ ok: false, status: 410, statusText: "Gone", body: JSON.stringify({ code: "code_expired" }) });
    const client = makeAvatarClient();

    const err = (await client.joinSquadByCode("EXPIRED0").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(410);
    expect(err.code).toBe("code_expired");
  });

  it("listSquads：GET /api/squads 返回数组", async () => {
    const fetchMock = mockFetch({
      ok: true,
      status: 200,
      body: JSON.stringify([{ id: "sq_1", name: "研发" }]),
    });
    const client = makeAvatarClient();

    const res = await client.listSquads();

    expect(res).toEqual([{ id: "sq_1", name: "研发" }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/squads");
    expect(init.method).toBe("GET");
  });

  it("createSquad：POST /api/squads、序列化 { name }", async () => {
    const fetchMock = mockFetch({
      ok: true,
      status: 201,
      body: JSON.stringify({ id: "sq_2", name: "设计" }),
    });
    const client = makeAvatarClient();

    const res = await client.createSquad("设计");

    expect(res).toEqual({ id: "sq_2", name: "设计" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/squads");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "设计" }));
  });

  it("removeSquadMember：DELETE /api/squads/{id}/members、序列化 member_type/member_id", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: "" });
    const client = makeAvatarClient();

    await expect(client.removeSquadMember("sq_1", "member", "m_9")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/squads/sq_1/members");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBe(JSON.stringify({ member_type: "member", member_id: "m_9" }));
  });
});

// W2：workspace 管理 / 邀请 / squad 成员 / 团队信息更新端点的 URL/method/body 序列化。
describe("ApiClient W2 端点", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("listWorkspaces：GET /api/workspaces", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: JSON.stringify([]) });
    const client = makeAvatarClient();

    await client.listWorkspaces();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/workspaces");
    expect(init.method).toBe("GET");
  });

  it("createWorkspace：POST /api/workspaces、序列化 { name, slug }", async () => {
    const fetchMock = mockFetch({
      ok: true,
      status: 201,
      body: JSON.stringify({ id: "ws_2", name: "Acme", slug: "acme", description: null, issue_prefix: "ACM" }),
    });
    const client = makeAvatarClient();

    const res = await client.createWorkspace({ name: "Acme", slug: "acme" });

    expect(res).toEqual({ id: "ws_2", name: "Acme", slug: "acme", description: null, issue_prefix: "ACM" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/workspaces");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "Acme", slug: "acme" }));
  });

  it("listWorkspaceMembers：GET /api/workspaces/{id}/members", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: JSON.stringify([]) });
    const client = makeAvatarClient();

    await client.listWorkspaceMembers("ws_1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/workspaces/ws_1/members");
    expect(init.method).toBe("GET");
  });

  it("createWorkspaceInvitation：POST /api/workspaces/{id}/members、序列化 { email, role }", async () => {
    const fetchMock = mockFetch({
      ok: true,
      status: 201,
      body: JSON.stringify({
        id: "inv_1",
        invitee_email: "a@b.com",
        role: "member",
        status: "pending",
        expires_at: "2026-07-11T00:00:00Z",
        inviter_name: "Me",
        workspace_name: "Acme",
      }),
    });
    const client = makeAvatarClient();

    const res = await client.createWorkspaceInvitation("ws_1", "a@b.com", "member");

    expect(res.id).toBe("inv_1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/workspaces/ws_1/members");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ email: "a@b.com", role: "member" }));
  });

  it("listMyInvitations：GET /api/invitations", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: JSON.stringify([]) });
    const client = makeAvatarClient();

    await client.listMyInvitations();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/invitations");
    expect(init.method).toBe("GET");
  });

  it("acceptInvitation：POST /api/invitations/{id}/accept、无请求体、空响应体不报错", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: "" });
    const client = makeAvatarClient();

    await expect(client.acceptInvitation("inv_1")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/invitations/inv_1/accept");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("acceptInvitation：410 已过期 → ApiError.status===410", async () => {
    mockFetch({ ok: false, status: 410, statusText: "Gone", body: JSON.stringify({ code: "invitation_expired" }) });
    const client = makeAvatarClient();

    const err = (await client.acceptInvitation("inv_x").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(410);
  });

  it("declineInvitation：POST /api/invitations/{id}/decline、204 空响应体不报错", async () => {
    const fetchMock = mockFetch({ ok: true, status: 204, body: "" });
    const client = makeAvatarClient();

    await expect(client.declineInvitation("inv_1")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/invitations/inv_1/decline");
    expect(init.method).toBe("POST");
  });

  it("listSquadMembers：GET /api/squads/{id}/members", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: JSON.stringify([]) });
    const client = makeAvatarClient();

    await client.listSquadMembers("sq_1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/squads/sq_1/members");
    expect(init.method).toBe("GET");
  });

  it("updateSquad：PUT /api/squads/{id}、序列化补丁 body", async () => {
    const fetchMock = mockFetch({
      ok: true,
      status: 200,
      body: JSON.stringify({ id: "sq_1", name: "新名", description: "desc" }),
    });
    const client = makeAvatarClient();

    const res = await client.updateSquad("sq_1", { name: "新名", description: "desc" });

    expect(res).toEqual({ id: "sq_1", name: "新名", description: "desc" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/squads/sq_1");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ name: "新名", description: "desc" }));
  });

  it("listAvatarSessions：view=owner 经 ?view=owner 下传", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: JSON.stringify({ sessions: [] }) });
    const client = makeAvatarClient();

    await client.listAvatarSessions("rt_7", "owner");

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/avatars/rt_7/sessions?view=owner");
  });

  it("listAvatarSessions：省略 view 时不带 query(调用者本人视角)", async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: JSON.stringify({ sessions: [] }) });
    const client = makeAvatarClient();

    await client.listAvatarSessions("rt_7");

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/avatars/rt_7/sessions");
  });
});
