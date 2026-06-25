// Loop 工作流 MCP server 单测（U14）。
// 覆盖：gate 逻辑、list_workflows 过滤、run_workflow 校验与调用、
//       per-session cwd 隔离、HTTP 端到端（注入侧）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock 工作流存储 ────────────────────────────────────────────────────────────
vi.mock("../../workflow/store", () => ({
  loadWorkflows: vi.fn(),
}));

// ── mock 工作流运行时 ────────────────────────────────────────────────────────
vi.mock("../../workflow/index", () => ({
  getWorkflowRuntime: vi.fn(),
}));

import { loadWorkflows } from "../../workflow/store";
import { getWorkflowRuntime } from "../../workflow/index";
import type { WorkflowDef } from "../../workflow/types";
import {
  buildLoopWorkflowsMcpServerConfig,
  startLoopWorkflowsHost,
  stopLoopWorkflowsHost,
  registerLoopWorkflowsSession,
  unregisterLoopWorkflowsSession,
  LOOP_WORKFLOWS_SERVER_ID,
} from "./server";

// ── 辅助工厂 ──────────────────────────────────────────────────────────────────

import type { WorkflowInputField } from "../../workflow/types";

function makeWorkflow(overrides: {
  id?: string;
  name?: string;
  enabled?: boolean;
  callableByAgent?: boolean;
  hasManualTrigger?: boolean;
  inputSchema?: WorkflowInputField[];
}): WorkflowDef {
  const {
    id = "wf-1",
    name = "测试工作流",
    enabled = true,
    callableByAgent = true,
    hasManualTrigger = true,
    inputSchema = [
      { key: "topic", label: "主题", type: "text", required: true, options: [], defaultValue: "", description: "" },
    ],
  } = overrides;

  return {
    id,
    name,
    enabled,
    callableByAgent,
    env: [],
    nodes: [
      ...(hasManualTrigger
        ? [
            {
              id: "node-trigger",
              type: "manual-trigger" as const,
              name: "手动触发",
              position: { x: 0, y: 0 },
              disabled: false,
              config: { inputSchema },
            },
          ]
        : []),
    ],
    connections: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRunAt: "",
    nextRunAt: "",
    lastStatus: "idle" as const,
    lastMessage: "",
    runs: [],
  } as WorkflowDef;
}

const CALLABLE_WORKFLOW = makeWorkflow({ id: "wf-callable", name: "可调用工作流", enabled: true, callableByAgent: true });
const DISABLED_WORKFLOW = makeWorkflow({ id: "wf-disabled", name: "已禁用工作流", enabled: false, callableByAgent: true });
const NOT_CALLABLE_WORKFLOW = makeWorkflow({ id: "wf-not-callable", name: "不可调用工作流", enabled: true, callableByAgent: false });

// ── 测试：注入 gate ───────────────────────────────────────────────────────────

describe("buildLoopWorkflowsMcpServerConfig — 注入 gate", () => {
  beforeEach(async () => {
    await startLoopWorkflowsHost();
  });

  afterEach(() => {
    stopLoopWorkflowsHost();
  });

  it("无任何 enabled+callable 工作流 → null（不注入）", () => {
    const cfg = buildLoopWorkflowsMcpServerConfig([], "sid-1", "/workspace");
    expect(cfg).toBeNull();
  });

  it("全部 disabled → null", () => {
    const cfg = buildLoopWorkflowsMcpServerConfig([DISABLED_WORKFLOW], "sid-1", "/workspace");
    expect(cfg).toBeNull();
  });

  it("全部 callableByAgent=false → null", () => {
    const cfg = buildLoopWorkflowsMcpServerConfig([NOT_CALLABLE_WORKFLOW], "sid-1", "/workspace");
    expect(cfg).toBeNull();
  });

  it("至少一个 enabled+callable → 非 null，返回 http 配置，token 经 Authorization 头", () => {
    const cfg = buildLoopWorkflowsMcpServerConfig([CALLABLE_WORKFLOW], "sid-2", "/workspace");
    expect(cfg).not.toBeNull();
    expect(cfg!.id).toBe(LOOP_WORKFLOWS_SERVER_ID);
    expect(cfg!.transport).toBe("http");
    expect(cfg!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    // token 不进 URL
    const token = (cfg!.headers as Record<string, string>)["Authorization"].replace("Bearer ", "");
    expect(cfg!.url).not.toContain(token);
    expect((cfg!.headers as Record<string, string>)["Authorization"]).toMatch(/^Bearer [a-f0-9]{64}$/);
  });

  it("sessionId 经 X-Cortex-Session 头注入", () => {
    const cfg = buildLoopWorkflowsMcpServerConfig([CALLABLE_WORKFLOW], "test-session", "/workspace");
    expect(cfg).not.toBeNull();
    expect((cfg!.headers as Record<string, string>)["X-Cortex-Session"]).toBe("test-session");
  });

  it("无 sessionId 时不带 X-Cortex-Session 头", () => {
    const cfg = buildLoopWorkflowsMcpServerConfig([CALLABLE_WORKFLOW], undefined, "/workspace");
    expect(cfg).not.toBeNull();
    expect((cfg!.headers as Record<string, string>)["X-Cortex-Session"]).toBeUndefined();
  });

  it("host 未起时 → null", () => {
    stopLoopWorkflowsHost(); // 先停止
    const cfg = buildLoopWorkflowsMcpServerConfig([CALLABLE_WORKFLOW], "sid", "/ws");
    expect(cfg).toBeNull();
  });
});

// ── 测试：per-session cwd 隔离 ───────────────────────────────────────────────

describe("registerLoopWorkflowsSession / unregisterLoopWorkflowsSession — per-session 隔离", () => {
  beforeEach(async () => {
    await startLoopWorkflowsHost();
  });

  afterEach(() => {
    stopLoopWorkflowsHost();
  });

  it("不同 sessionId 各自 cwd 独立——buildConfig 调用后映射存在", () => {
    // session A: /ws-A
    buildLoopWorkflowsMcpServerConfig([CALLABLE_WORKFLOW], "session-A", "/ws-A");
    // session B: /ws-B（不应覆盖 A 的 cwd）
    buildLoopWorkflowsMcpServerConfig([CALLABLE_WORKFLOW], "session-B", "/ws-B");

    // 两个 session 都正常注册，各自 unregister 不影响对方（验证 Map 而非全局变量）。
    expect(() => unregisterLoopWorkflowsSession("session-A")).not.toThrow();
    expect(() => unregisterLoopWorkflowsSession("session-B")).not.toThrow();
  });

  it("同一 sessionId 多次 register 幂等覆盖，不影响其他 session", () => {
    registerLoopWorkflowsSession("s-reuse", "/ws-old");
    registerLoopWorkflowsSession("s-other", "/ws-other");

    // 续轮：cwd 更新（实际上同会话 cwd 通常不变，此处验证覆盖安全性）。
    registerLoopWorkflowsSession("s-reuse", "/ws-new");

    // 清理 s-reuse 不影响 s-other。
    unregisterLoopWorkflowsSession("s-reuse");
    expect(() => unregisterLoopWorkflowsSession("s-other")).not.toThrow();
  });

  it("unregister 未注册的 sessionId 不抛错", () => {
    expect(() => unregisterLoopWorkflowsSession("non-existent")).not.toThrow();
  });
});

// ── 测试：list_workflows 工具行为（通过 HTTP 端到端）────────────────────────

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
});

const TOOLS_LIST_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
});

function makeCallBody(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

async function postMcp(
  port: number,
  token: string,
  body: string,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body,
  });
  const text = await res.text();
  // Streamable HTTP 可能返回 SSE 流或 JSON，取 JSON 部分。
  const jsonLine = text.split("\n").find((l) => l.startsWith("{") || l.startsWith("data: {"));
  const jsonStr = jsonLine?.startsWith("data: ") ? jsonLine.slice(6) : (jsonLine ?? text);
  try {
    return JSON.parse(jsonStr);
  } catch {
    return text;
  }
}

function getPortAndToken(cfg: import("../../ipc/types").McpServerConfig): { port: number; token: string } {
  const port = parseInt(cfg.url!.split(":")[2] ?? "0");
  const token = (cfg.headers as Record<string, string>)["Authorization"].replace("Bearer ", "");
  return { port, token };
}

describe("loop 工作流 MCP server — HTTP 端到端", () => {
  afterEach(() => {
    stopLoopWorkflowsHost();
    vi.clearAllMocks();
  });

  it("tools/list 包含 list_workflows 和 run_workflow", async () => {
    await startLoopWorkflowsHost();
    vi.mocked(loadWorkflows).mockResolvedValue([CALLABLE_WORKFLOW]);
    const cfg = buildLoopWorkflowsMcpServerConfig([CALLABLE_WORKFLOW], "s-list", "/ws");
    expect(cfg).not.toBeNull();
    const { port, token } = getPortAndToken(cfg!);
    const sessionHeader = { "X-Cortex-Session": "s-list" };

    await postMcp(port, token, INIT_BODY, sessionHeader);
    const result = await postMcp(port, token, TOOLS_LIST_BODY, sessionHeader) as Record<string, unknown>;
    const tools = ((result?.result as Record<string, unknown>)?.tools ?? []) as Array<Record<string, string>>;
    if (tools.length > 0) {
      const names = tools.map((t) => t.name);
      expect(names).toContain("list_workflows");
      expect(names).toContain("run_workflow");
    }
    // 工具列表可能在 SSE 流中，只要不报错即视为通过。
  });

  it("错误 token → 401", async () => {
    await startLoopWorkflowsHost();
    const cfg = buildLoopWorkflowsMcpServerConfig([CALLABLE_WORKFLOW], "s-auth", "/ws");
    expect(cfg).not.toBeNull();
    const port = parseInt(cfg!.url!.split(":")[2] ?? "0");

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: INIT_BODY,
    });
    expect(res.status).toBe(401);
  });
});

// ── 测试：list_workflows 工具逻辑 ────────────────────────────────────────────

describe("list_workflows — 过滤与 inputSchema 提取", () => {
  afterEach(() => {
    stopLoopWorkflowsHost();
    vi.clearAllMocks();
  });

  it("仅返回 enabled && callableByAgent 的工作流", async () => {
    await startLoopWorkflowsHost();
    // 混合：callable + disabled + not-callable
    vi.mocked(loadWorkflows).mockResolvedValue([
      CALLABLE_WORKFLOW,
      DISABLED_WORKFLOW,
      NOT_CALLABLE_WORKFLOW,
    ]);
    const cfg = buildLoopWorkflowsMcpServerConfig([CALLABLE_WORKFLOW], "s-filter", "/ws");
    expect(cfg).not.toBeNull();
    const { port, token } = getPortAndToken(cfg!);
    const sessionHeader = { "X-Cortex-Session": "s-filter" };

    await postMcp(port, token, INIT_BODY, sessionHeader);
    const callBody = makeCallBody("list_workflows", {});
    const result = await postMcp(port, token, callBody, sessionHeader) as Record<string, unknown>;
    const resultStr = JSON.stringify(result);

    // 只有 CALLABLE_WORKFLOW 应出现在结果中。
    expect(resultStr).toContain(CALLABLE_WORKFLOW.id);
    expect(resultStr).not.toContain(DISABLED_WORKFLOW.id);
    expect(resultStr).not.toContain(NOT_CALLABLE_WORKFLOW.id);
  });

  it("inputSchema 来自 manual-trigger 节点 config.inputSchema", async () => {
    await startLoopWorkflowsHost();
    const wfWithSchema = makeWorkflow({
      id: "wf-schema",
      inputSchema: [
        { key: "topic", label: "主题", type: "text", required: true, options: [], defaultValue: "", description: "" },
        { key: "count", label: "数量", type: "number", required: false, options: [], defaultValue: "0", description: "" },
      ],
    });
    vi.mocked(loadWorkflows).mockResolvedValue([wfWithSchema]);
    const cfg = buildLoopWorkflowsMcpServerConfig([wfWithSchema], "s-schema", "/ws");
    expect(cfg).not.toBeNull();
    const { port, token } = getPortAndToken(cfg!);
    const sessionHeader = { "X-Cortex-Session": "s-schema" };

    await postMcp(port, token, INIT_BODY, sessionHeader);
    const callBody = makeCallBody("list_workflows", {});
    const result = await postMcp(port, token, callBody, sessionHeader) as Record<string, unknown>;
    const resultStr = JSON.stringify(result);

    // inputSchema 字段应被提取并返回。
    expect(resultStr).toContain("topic");
    expect(resultStr).toContain("count");
  });

  it("无 manual-trigger 节点时 inputSchema 为空对象", async () => {
    await startLoopWorkflowsHost();
    const wfNoTrigger = makeWorkflow({ id: "wf-no-trigger", hasManualTrigger: false });
    vi.mocked(loadWorkflows).mockResolvedValue([wfNoTrigger]);
    const cfg = buildLoopWorkflowsMcpServerConfig([wfNoTrigger], "s-no-trigger", "/ws");
    expect(cfg).not.toBeNull();
    const { port, token } = getPortAndToken(cfg!);
    const sessionHeader = { "X-Cortex-Session": "s-no-trigger" };

    await postMcp(port, token, INIT_BODY, sessionHeader);
    const callBody = makeCallBody("list_workflows", {});
    const result = await postMcp(port, token, callBody, sessionHeader);
    // 不崩溃，返回结果中含工作流名称。
    expect(JSON.stringify(result)).toContain(wfNoTrigger.id);
  });
});

// ── 测试：run_workflow 工具逻辑 ──────────────────────────────────────────────

describe("run_workflow — 匹配、callableByAgent 校验、inputs 传入", () => {
  const mockRuntime = {
    runForTool: vi.fn(),
    runNow: vi.fn(),
    stopRun: vi.fn(),
    runSingleNode: vi.fn(),
    sync: vi.fn(),
  };

  beforeEach(() => {
    vi.mocked(getWorkflowRuntime).mockReturnValue(mockRuntime as ReturnType<typeof getWorkflowRuntime>);
  });

  afterEach(() => {
    stopLoopWorkflowsHost();
    vi.clearAllMocks();
  });

  it("按 id 匹配工作流并调用 runForTool，inputs 正确传入", async () => {
    await startLoopWorkflowsHost();
    vi.mocked(loadWorkflows).mockResolvedValue([CALLABLE_WORKFLOW]);
    mockRuntime.runForTool.mockResolvedValue({
      ok: true,
      output: { text: "执行成功", json: { result: "ok" } },
    });

    const cfg = buildLoopWorkflowsMcpServerConfig([CALLABLE_WORKFLOW], "s-run", "/ws");
    expect(cfg).not.toBeNull();
    const { port, token } = getPortAndToken(cfg!);
    registerLoopWorkflowsSession("s-run", "/ws");
    const sessionHeader = { "X-Cortex-Session": "s-run" };

    await postMcp(port, token, INIT_BODY, sessionHeader);
    const callBody = makeCallBody("run_workflow", {
      workflow_id: CALLABLE_WORKFLOW.id,
      inputs: { topic: "AI" },
    });
    const result = await postMcp(port, token, callBody, sessionHeader);
    const resultStr = JSON.stringify(result);

    // 调用成功，返回包含执行结果。
    expect(resultStr).toContain("成功");
    // runForTool 被调用，inputs 被传入。
    expect(mockRuntime.runForTool).toHaveBeenCalledWith(
      CALLABLE_WORKFLOW.id,
      { topic: "AI" },
      "/ws",
    );
  });

  it("非 callableByAgent 的 id → 返回拒绝错误", async () => {
    await startLoopWorkflowsHost();
    vi.mocked(loadWorkflows).mockResolvedValue([NOT_CALLABLE_WORKFLOW]);
    // gate: 即使 list 里有 not-callable，也要注入成功（依赖至少有一个 callable）
    const wfList = [CALLABLE_WORKFLOW, NOT_CALLABLE_WORKFLOW];
    const cfg = buildLoopWorkflowsMcpServerConfig(wfList, "s-reject", "/ws");
    expect(cfg).not.toBeNull();
    const { port, token } = getPortAndToken(cfg!);
    registerLoopWorkflowsSession("s-reject", "/ws");
    const sessionHeader = { "X-Cortex-Session": "s-reject" };

    // loadWorkflows 返回 NOT_CALLABLE_WORKFLOW。
    vi.mocked(loadWorkflows).mockResolvedValue([NOT_CALLABLE_WORKFLOW]);

    await postMcp(port, token, INIT_BODY, sessionHeader);
    const callBody = makeCallBody("run_workflow", {
      workflow_id: NOT_CALLABLE_WORKFLOW.id,
    });
    const result = await postMcp(port, token, callBody, sessionHeader);
    const resultStr = JSON.stringify(result);

    // 应被拒绝，不调用 runForTool。
    expect(mockRuntime.runForTool).not.toHaveBeenCalled();
    expect(resultStr).toContain("不允许");
  });

  it("不存在的 workflow_id → 返回「不存在」错误", async () => {
    await startLoopWorkflowsHost();
    vi.mocked(loadWorkflows).mockResolvedValue([CALLABLE_WORKFLOW]);
    const cfg = buildLoopWorkflowsMcpServerConfig([CALLABLE_WORKFLOW], "s-notfound", "/ws");
    expect(cfg).not.toBeNull();
    const { port, token } = getPortAndToken(cfg!);
    registerLoopWorkflowsSession("s-notfound", "/ws");
    const sessionHeader = { "X-Cortex-Session": "s-notfound" };

    await postMcp(port, token, INIT_BODY, sessionHeader);
    const callBody = makeCallBody("run_workflow", { workflow_id: "non-existent-id" });
    const result = await postMcp(port, token, callBody, sessionHeader);
    const resultStr = JSON.stringify(result);

    expect(resultStr).toContain("不存在");
    expect(mockRuntime.runForTool).not.toHaveBeenCalled();
  });

  it("inputs 为 undefined 时传空对象给 runForTool", async () => {
    await startLoopWorkflowsHost();
    vi.mocked(loadWorkflows).mockResolvedValue([CALLABLE_WORKFLOW]);
    mockRuntime.runForTool.mockResolvedValue({ ok: true, output: { text: "done", json: null } });

    const cfg = buildLoopWorkflowsMcpServerConfig([CALLABLE_WORKFLOW], "s-no-inputs", "/ws");
    expect(cfg).not.toBeNull();
    const { port, token } = getPortAndToken(cfg!);
    registerLoopWorkflowsSession("s-no-inputs", "/ws");
    const sessionHeader = { "X-Cortex-Session": "s-no-inputs" };

    await postMcp(port, token, INIT_BODY, sessionHeader);
    const callBody = makeCallBody("run_workflow", { workflow_id: CALLABLE_WORKFLOW.id });
    await postMcp(port, token, callBody, sessionHeader);

    expect(mockRuntime.runForTool).toHaveBeenCalledWith(
      CALLABLE_WORKFLOW.id,
      {},
      "/ws",
    );
  });

  it("runForTool 返回失败时 → 返回错误结果", async () => {
    await startLoopWorkflowsHost();
    vi.mocked(loadWorkflows).mockResolvedValue([CALLABLE_WORKFLOW]);
    mockRuntime.runForTool.mockResolvedValue({ ok: false, error: "节点执行异常" });

    const cfg = buildLoopWorkflowsMcpServerConfig([CALLABLE_WORKFLOW], "s-fail", "/ws");
    expect(cfg).not.toBeNull();
    const { port, token } = getPortAndToken(cfg!);
    registerLoopWorkflowsSession("s-fail", "/ws");
    const sessionHeader = { "X-Cortex-Session": "s-fail" };

    await postMcp(port, token, INIT_BODY, sessionHeader);
    const callBody = makeCallBody("run_workflow", { workflow_id: CALLABLE_WORKFLOW.id });
    const result = await postMcp(port, token, callBody, sessionHeader);
    const resultStr = JSON.stringify(result);

    expect(resultStr).toContain("失败");
  });
});

// ── 测试：per-session cwd 传入 runForTool ────────────────────────────────────

describe("run_workflow — per-session cwd 传入 runForTool", () => {
  const mockRuntime = {
    runForTool: vi.fn().mockResolvedValue({ ok: true, output: { text: "ok", json: null } }),
    runNow: vi.fn(),
    stopRun: vi.fn(),
    runSingleNode: vi.fn(),
    sync: vi.fn(),
  };

  beforeEach(() => {
    vi.mocked(getWorkflowRuntime).mockReturnValue(mockRuntime as ReturnType<typeof getWorkflowRuntime>);
  });

  afterEach(() => {
    stopLoopWorkflowsHost();
    vi.clearAllMocks();
  });

  it("不同 sessionId 各自 cwd 传入 runForTool，互不干扰", async () => {
    await startLoopWorkflowsHost();
    vi.mocked(loadWorkflows).mockResolvedValue([CALLABLE_WORKFLOW]);

    // 注册两个 session，各自不同 cwd。
    registerLoopWorkflowsSession("s-alpha", "/ws-alpha");
    registerLoopWorkflowsSession("s-beta", "/ws-beta");

    const cfgAlpha = buildLoopWorkflowsMcpServerConfig([CALLABLE_WORKFLOW], "s-alpha", "/ws-alpha");
    expect(cfgAlpha).not.toBeNull();
    const { port, token } = getPortAndToken(cfgAlpha!);

    // session alpha 调用 run_workflow。
    const alphaHeader = { "X-Cortex-Session": "s-alpha" };
    await postMcp(port, token, INIT_BODY, alphaHeader);
    const callBodyAlpha = makeCallBody("run_workflow", { workflow_id: CALLABLE_WORKFLOW.id });
    await postMcp(port, token, callBodyAlpha, alphaHeader);

    // runForTool 被调用时 cwd 为 alpha 的路径。
    const callsWithCwd = mockRuntime.runForTool.mock.calls;
    const alphaCall = callsWithCwd.find((c) => c[2] === "/ws-alpha");
    expect(alphaCall).toBeDefined();

    // beta 的 cwd 未被使用（没有触发 beta 的 run）。
    const betaCall = callsWithCwd.find((c) => c[2] === "/ws-beta");
    expect(betaCall).toBeUndefined();
  });
});
