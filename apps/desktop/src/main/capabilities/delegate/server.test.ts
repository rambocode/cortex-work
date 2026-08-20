import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import {
  safeToolId,
  registerDelegateSession,
  unregisterDelegateSession,
  killAllDelegates,
  buildDelegateMcpServerConfig,
  startDelegateHost,
  stopDelegateHost,
  EXPLORE_AGENT_TOOL_NAME,
  type DelegateSessionState,
} from "./server";
import { __resetAgentTraceForTest, agentTraceList } from "../../ipc/agent-trace";

// 构造一个最小 DelegateSessionState（运行时回调用 noop / spy）。
function makeState(sessionId: string, abort: () => void = () => {}): DelegateSessionState {
  return {
    sessionId,
    runId: "run-" + sessionId,
    roles: [],
    signal: new AbortController().signal,
    abort,
    pushEvent: () => {},
    pushChildEvent: () => {},
    bumpWatchdog: () => {},
    maxParallel: 256,
    maxChildRuns: 25,
    childRunCount: 0,
    activeRuns: 0,
    waiters: [],
    runSubAgent: async () => ({ text: "", ok: true }),
  };
}

function contractArgs(
  objective: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title: objective,
    objective,
    target: { description: "The explicitly named task target", paths: [] },
    inScope: ["Complete only the stated objective"],
    outOfScope: ["Do not perform unrelated work or broaden the target"],
    constraints: { maxToolCalls: 20, maxDurationMinutes: 10, additional: [] },
    context: [],
    deliverable: "Return a concise evidence-backed result.",
    doneWhen: ["The stated objective is fully answered"],
    blockedWhen: ["Required target or context is missing"],
    ...overrides,
  };
}

afterEach(() => {
  // 清空模块级 sessionStateMap，隔离测试间状态。
  killAllDelegates();
  __resetAgentTraceForTest();
});

describe("safeToolId（ask_<id> 工具名安全化）", () => {
  it("转小写并保留字母数字与 -_", () => {
    expect(safeToolId("Codex")).toBe("codex");
    expect(safeToolId("my_role-1")).toBe("my_role-1");
  });

  it("非法字符（含中文/空格）折叠为 - 并去首尾", () => {
    // "设计师 A" → 连续非法折叠为一个 - → "-a" → 去首 - → "a"
    expect(safeToolId("设计师 A")).toBe("a");
  });

  it("空 / 全非法回退 role（避免空工具名）", () => {
    expect(safeToolId("")).toBe("role");
    expect(safeToolId("中文")).toBe("role");
  });
});

describe("buildDelegateMcpServerConfig（注入配置纯函数）", () => {
  it("sessionId 为空 → null", () => {
    expect(buildDelegateMcpServerConfig(undefined)).toBeNull();
  });

  it("host 未启动（getHandle=null）→ null，避免给 agent 连不上的 url", () => {
    expect(buildDelegateMcpServerConfig("s1")).toBeNull();
  });

  it("startDelegateHost 后返回 http config（桥接注入的前提：host 可用）", async () => {
    const handle = await startDelegateHost();
    try {
      expect(handle.serverAvailable).toBe(true);
      expect(handle.port).toBeGreaterThan(0);
      const cfg = buildDelegateMcpServerConfig("s1");
      expect(cfg).not.toBeNull();
      expect(cfg?.transport).toBe("http");
      expect(cfg?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(cfg?.headers?.["X-Cortex-Session"]).toBe("s1");
    } finally {
      stopDelegateHost();
    }
    expect(buildDelegateMcpServerConfig("s1")).toBeNull(); // stop 后回到 null
  });
});

describe("delegate session 注册与清理", () => {
  it("killAllDelegates 调用所有已注册 session 的 abort 并清空", () => {
    const a1 = vi.fn();
    const a2 = vi.fn();
    registerDelegateSession(makeState("s1", a1));
    registerDelegateSession(makeState("s2", a2));
    killAllDelegates();
    expect(a1).toHaveBeenCalledTimes(1);
    expect(a2).toHaveBeenCalledTimes(1);
    // 已清空：再次 kill 不重复触发。
    killAllDelegates();
    expect(a1).toHaveBeenCalledTimes(1);
  });

  it("unregisterDelegateSession 后 killAll 不再触发其 abort", () => {
    const a1 = vi.fn();
    registerDelegateSession(makeState("s1", a1));
    unregisterDelegateSession("s1");
    killAllDelegates();
    expect(a1).not.toHaveBeenCalled();
  });

  it("registerDelegateSession 幂等覆盖：同 sessionId 后注册覆盖前者", () => {
    const aOld = vi.fn();
    const aNew = vi.fn();
    registerDelegateSession(makeState("s1", aOld));
    registerDelegateSession(makeState("s1", aNew)); // 覆盖（每轮 run 更新 runId/roles/回调）
    killAllDelegates();
    expect(aOld).not.toHaveBeenCalled();
    expect(aNew).toHaveBeenCalledTimes(1);
  });

  it("旧运行按 expected state 迟到注销时不删除同 sessionId 的新 state", () => {
    const oldAbort = vi.fn();
    const newAbort = vi.fn();
    const oldState = makeState("s1", oldAbort);
    const newState = makeState("s1", newAbort);
    registerDelegateSession(oldState);
    registerDelegateSession(newState);

    unregisterDelegateSession("s1", oldState);
    killAllDelegates();

    expect(oldAbort).not.toHaveBeenCalled();
    expect(newAbort).toHaveBeenCalledTimes(1);
  });
});

// 端到端：模拟 pi 桥接的 HTTP 握手（initialize → tools/list），验证无状态 host（每请求新建
// server/transport）是否真能返回 ask_<id>。这是 pi 找不到 ask_codex 的关键验证点。
describe("delegate host HTTP 端到端（pi 桥接握手）", () => {
  function post(
    cfg: { url: string; headers?: Record<string, string> },
    body: unknown,
    signal?: AbortSignal,
  ) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(cfg.url);
      const r = http.request(
        {
          hostname: u.hostname,
          port: Number(u.port),
          path: u.pathname,
          method: "POST",
          headers: { ...(cfg.headers ?? {}), "content-type": "application/json", accept: "application/json, text/event-stream" },
        },
        (res) => {
          let d = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (d += c));
          res.on("end", () => resolve({ status: res.statusCode || 0, body: d }));
        },
      );
      r.on("error", reject);
      const abort = () => r.destroy(new Error("调用方已取消"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      r.on("close", () => signal?.removeEventListener("abort", abort));
      r.write(JSON.stringify(body));
      r.end();
    });
  }

  it("register session 后 initialize→tools/list 返回 ask_<id>", async () => {
    await startDelegateHost();
    const sid = "e2e-session";
    registerDelegateSession({
      sessionId: sid,
      runId: "r-e2e",
      roles: [{ id: "codex", label: "Codex", agent: "codex", systemPrompt: "", createdAt: "", updatedAt: "" }],
      signal: new AbortController().signal,
      abort: () => {},
      pushEvent: () => {},
      pushChildEvent: () => {},
      bumpWatchdog: () => {},
      maxParallel: 256,
      maxChildRuns: 25,
      childRunCount: 0,
      activeRuns: 0,
      waiters: [],
      runSubAgent: async () => ({ text: "", ok: true }),
    });
    const cfg = buildDelegateMcpServerConfig(sid) as { url: string; headers?: Record<string, string> };
    try {
      const init = await post(cfg, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      });
      expect(init.status).toBe(200);
      const list = await post(cfg, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      expect(list.status).toBe(200);
      // 真实 host 返回 SSE，body 含注册的工具名（端到端验证 tools/list 真返回 ask_codex）。
      expect(list.body).toContain("ask_codex");
    } finally {
      stopDelegateHost();
      unregisterDelegateSession(sid);
    }
  });

  it("Repository Explorer 暴露完整结构化合同，并以显式根目录启动 child", async () => {
    await startDelegateHost();
    const sid = "explore-session";
    const runSubAgent = vi.fn<DelegateSessionState["runSubAgent"]>(async () => ({ text: "结构分析完成", ok: true }));
    const pushEvent = vi.fn();
    const state = makeState(sid);
    state.roles = [{ id: "explore", label: "Repository Explorer", agent: "pi", systemPrompt: "", toolPolicy: "readOnly", createdAt: "", updatedAt: "" }];
    state.runSubAgent = runSubAgent;
    state.pushEvent = pushEvent;
    registerDelegateSession(state);
    const cfg = buildDelegateMcpServerConfig(sid) as { url: string; headers?: Record<string, string> };
    try {
      const list = await post(cfg, { jsonrpc: "2.0", id: 21, method: "tools/list", params: {} });
      expect(list.body).toContain(EXPLORE_AGENT_TOOL_NAME);
      expect(list.body).not.toContain("ask_explore");
      expect(list.body).toContain("title");
      expect(list.body).toContain("objective");
      expect(list.body).toContain("rootPath");
      expect(list.body).toContain("inScope");
      expect(list.body).toContain("outOfScope");
      expect(list.body).toContain("doneWhen");
      expect(list.body).toContain("blockedWhen");
      expect(list.body).not.toContain('"query"');
      expect(list.body).toContain("never use this tool to guess a project");
      const call = await post(cfg, {
        jsonrpc: "2.0", id: 22, method: "tools/call",
        params: {
          name: EXPLORE_AGENT_TOOL_NAME,
          arguments: contractArgs("只读分析目录与技术栈", {
            title: "Project structure",
            target: {
              description: "delegate capability source",
              rootPath: process.cwd(),
              paths: ["src/main/capabilities/delegate"],
            },
          }),
        },
      });
      expect(call.status).toBe(200);
      expect(call.body).toContain("结构分析完成");
      expect(runSubAgent).toHaveBeenCalledWith(
        expect.objectContaining({ id: "explore" }),
        expect.stringContaining('"objective": "只读分析目录与技术栈"'),
        expect.any(Function),
        expect.any(String),
        expect.any(AbortSignal),
        process.cwd(),
      );
      expect(pushEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
        type: "init",
        subagentTask: expect.stringContaining("<delegation_contract>"),
        subagentTitle: "Project structure",
        subagentReadOnly: true,
      }));
    } finally {
      stopDelegateHost();
      unregisterDelegateSession(sid);
    }
  });

  it("子结果作为 tool_result 回主会话，并在 trace 记录上下文交接", async () => {
    await startDelegateHost();
    const sid = "context-session";
    const runSubAgent = vi.fn<DelegateSessionState["runSubAgent"]>(
      async (_role, _task, onEvent) => {
        // 模拟子 Agent 的一个流式事件,验证父/子双发契约。
        onEvent({ type: "text", delta: "分析中" });
        return { text: "子 Agent 的分析结果", ok: true };
      },
    );
    const pushEvent = vi.fn();
    const pushChildEvent = vi.fn();
    registerDelegateSession({
      sessionId: sid,
      runId: "main-run",
      roles: [{ id: "codex", label: "Codex", agent: "codex", systemPrompt: "", createdAt: "", updatedAt: "" }],
      signal: new AbortController().signal,
      abort: () => {},
      pushEvent,
      pushChildEvent,
      bumpWatchdog: () => {},
      maxParallel: 256,
      maxChildRuns: 25,
      childRunCount: 0,
      activeRuns: 0,
      waiters: [],
      runSubAgent,
    });
    const cfg = buildDelegateMcpServerConfig(sid) as { url: string; headers?: Record<string, string> };
    try {
      const list = await post(cfg, { jsonrpc: "2.0", id: 30, method: "tools/list", params: {} });
      expect(list.body).toContain("objective");
      expect(list.body).toContain("outOfScope");
      expect(list.body).not.toContain('"task"');
      await post(cfg, {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "ask_codex", arguments: { task: "旧自由文本调用" } },
      });
      expect(runSubAgent).not.toHaveBeenCalled();

      const call = await post(cfg, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "ask_codex",
          arguments: contractArgs("结合必要材料完成子任务", {
            context: ["父会话已确认接口定义"],
            deliverable: "返回实现建议和风险清单。",
          }),
        },
      });
      expect(call.status).toBe(200);
      expect(call.body).toContain("子 Agent 的分析结果");
      expect(runSubAgent).toHaveBeenCalledWith(
        expect.objectContaining({ id: "codex" }),
        expect.stringContaining('"objective": "结合必要材料完成子任务"'),
        expect.any(Function),
        expect.any(String),
        expect.any(AbortSignal),
        undefined,
      );
      expect(pushEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
        type: "init",
        roleId: "codex",
        stage: "subagent",
        subagentCallId: expect.any(String),
        childSessionId: expect.any(String),
        subagentTask: expect.stringContaining('"context"'),
        subagentAgentId: "codex",
      }));
      const subagentCallId = pushEvent.mock.calls[0]?.[0]?.subagentCallId;
      const childSessionId = pushEvent.mock.calls[0]?.[0]?.childSessionId;
      expect(runSubAgent.mock.calls[0]?.[3]).toBe(childSessionId);
      expect(pushEvent).toHaveBeenLastCalledWith(expect.objectContaining({
        type: "result",
        ok: true,
        text: "子 Agent 的分析结果",
        roleId: "codex",
        subagentCallId,
      }));
      // 信封归一 P2(双发契约):子流以 (childSessionId, callId) 为地址,事件剥净父会话过滤标记。
      expect(pushChildEvent).toHaveBeenCalledWith(
        childSessionId,
        subagentCallId,
        expect.objectContaining({
          type: "init",
          subagentTask: expect.stringContaining('"objective": "结合必要材料完成子任务"'),
        }),
      );
      expect(pushChildEvent).toHaveBeenCalledWith(
        childSessionId,
        subagentCallId,
        expect.objectContaining({ type: "text", delta: "分析中", roleId: undefined, subagentCallId: undefined }),
      );
      expect(pushChildEvent).toHaveBeenLastCalledWith(
        childSessionId,
        subagentCallId,
        expect.objectContaining({ type: "result", ok: true, text: "子 Agent 的分析结果" }),
      );
      expect(agentTraceList()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scope: "delegate",
            phase: "context-return",
            runId: "main-run",
            sessionId: sid,
            data: expect.objectContaining({
              contractTitle: "结合必要材料完成子任务",
              objectivePreview: "结合必要材料完成子任务",
              resultPreview: "子 Agent 的分析结果",
              returnedToMain: true,
            }),
          }),
        ]),
      );
    } finally {
      stopDelegateHost();
      unregisterDelegateSession(sid);
    }
  });

  it("同一失败工具调用反复出现时只终止当前 child，父会话和并行 child 继续运行", async () => {
    await startDelegateHost();
    const sid = "tool-loop-session";
    const parentController = new AbortController();
    const state = makeState(sid, () => parentController.abort());
    state.roles = [{
      id: "review",
      label: "Reviewer",
      agent: "pi",
      systemPrompt: "",
      createdAt: "",
      updatedAt: "",
    }];
    state.signal = parentController.signal;
    state.maxChildRuns = 2;
    let failedAttempts = 0;
    let finishHealthy: (() => void) | undefined;
    let healthySignal: AbortSignal | undefined;
    state.runSubAgent = vi.fn(async (_role, task, onEvent, _childSessionId, signal) => {
      if (task.includes('"objective": "正常任务"')) {
        healthySignal = signal;
        await new Promise<void>((resolve) => { finishHealthy = resolve; });
        return { text: "正常完成", ok: true };
      }

      for (let index = 0; index < 4; index += 1) {
        if (signal?.aborted) break;
        failedAttempts += 1;
        onEvent({
          type: "tool",
          name: "ls",
          phase: "start",
          toolCallId: `missing-${index}`,
          input: { path: "/tmp/dxtun 代理" },
        });
        onEvent({
          type: "tool",
          name: "ls",
          phase: "end",
          toolCallId: `missing-${index}`,
          output: "Path not found: /tmp/dxtun 代理",
          isError: true,
        });
        onEvent({
          type: "tool",
          name: "ls",
          phase: "start",
          toolCallId: `valid-${index}`,
          input: { path: "/tmp/dxtun代理" },
        });
        onEvent({
          type: "tool",
          name: "ls",
          phase: "end",
          toolCallId: `valid-${index}`,
          output: "需求文档/",
          isError: false,
        });
      }
      return signal?.aborted
        ? { text: "已找到正确目录", ok: false, error: "已取消" }
        : { text: "不应执行到这里", ok: true };
    });
    registerDelegateSession(state);
    const cfg = buildDelegateMcpServerConfig(sid) as { url: string; headers?: Record<string, string> };
    try {
      // 先让健康 child 保持在途，再启动会熔断的 child，验证取消信号不会跨调用传播。
      const healthyPromise = post(cfg, {
        jsonrpc: "2.0",
        id: 24,
        method: "tools/call",
        params: { name: "ask_review", arguments: contractArgs("正常任务") },
      });
      await vi.waitFor(() => expect(healthySignal).toBeDefined());

      const looped = await post(cfg, {
        jsonrpc: "2.0",
        id: 23,
        method: "tools/call",
        params: { name: "ask_review", arguments: contractArgs("循环任务") },
      });
      expect(looped.body).toContain("相同参数和错误重复失败 3 次");
      expect(looped.body).toContain("已找到正确目录");
      expect(failedAttempts).toBe(3);
      expect(parentController.signal.aborted).toBe(false);
      expect(healthySignal?.aborted).toBe(false);

      const guardTrace = agentTraceList().find((event) => event.phase === "watchdog");
      expect(guardTrace).toMatchObject({
        scope: "delegate",
        runId: expect.any(String),
        sessionId: expect.any(String),
        data: expect.objectContaining({
          kind: "repeated-failure",
          toolName: "ls",
          repeatCount: 3,
          parentRunId: state.runId,
          parentSessionId: sid,
        }),
      });
      expect(JSON.stringify(guardTrace?.data)).not.toContain("dxtun");

      finishHealthy?.();
      const healthy = await healthyPromise;
      expect(healthy.body).toContain("正常完成");
      expect(state.runSubAgent).toHaveBeenCalledTimes(2);
      expect(state.activeRuns).toBe(0);
    } finally {
      finishHealthy?.();
      stopDelegateHost();
      unregisterDelegateSession(sid);
    }
  });

  it("合同工具调用预算耗尽时只终止当前 child，并返回权威失败原因", async () => {
    await startDelegateHost();
    const sid = "contract-budget-session";
    const parentController = new AbortController();
    const state = makeState(sid, () => parentController.abort());
    state.roles = [{
      id: "review",
      label: "Reviewer",
      agent: "pi",
      systemPrompt: "",
      createdAt: "",
      updatedAt: "",
    }];
    let childSignal: AbortSignal | undefined;
    state.runSubAgent = vi.fn(async (_role, _task, onEvent, _childSessionId, signal) => {
      childSignal = signal;
      for (let index = 0; index < 3; index += 1) {
        onEvent({
          type: "tool",
          name: "read",
          phase: "start",
          toolCallId: `read-${index}`,
          input: { path: `src/${index}.ts` },
        });
      }
      return { text: "partial evidence", ok: false, error: "已取消" };
    });
    registerDelegateSession(state);
    const cfg = buildDelegateMcpServerConfig(sid) as { url: string; headers?: Record<string, string> };
    try {
      const call = await post(cfg, {
        jsonrpc: "2.0",
        id: 25,
        method: "tools/call",
        params: {
          name: "ask_review",
          arguments: contractArgs("预算检查", {
            constraints: { maxToolCalls: 2, maxDurationMinutes: 10, additional: [] },
          }),
        },
      });
      expect(call.body).toContain("超过合同约定的 2 次工具调用上限");
      expect(call.body).toContain("partial evidence");
      expect(childSignal?.aborted).toBe(true);
      expect(parentController.signal.aborted).toBe(false);
      expect(agentTraceList()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          scope: "delegate",
          phase: "budget",
          data: expect.objectContaining({ kind: "tool-call-limit", limit: 2, observed: 3 }),
        }),
      ]));
    } finally {
      stopDelegateHost();
      unregisterDelegateSession(sid);
    }
  });

  it("子执行异常时返回 tool error，并向 renderer 发送失败完成帧", async () => {
    await startDelegateHost();
    const sid = "failure-session";
    const pushEvent = vi.fn();
    registerDelegateSession({
      sessionId: sid,
      runId: "failure-run",
      roles: [{ id: "review", label: "Reviewer", agent: "codex", systemPrompt: "", createdAt: "", updatedAt: "" }],
      signal: new AbortController().signal,
      abort: () => {},
      pushEvent,
      pushChildEvent: () => {},
      bumpWatchdog: () => {},
      maxParallel: 256,
      maxChildRuns: 25,
      childRunCount: 0,
      activeRuns: 0,
      waiters: [],
      runSubAgent: async () => { throw new Error("spawn failed"); },
    });
    const cfg = buildDelegateMcpServerConfig(sid) as { url: string; headers?: Record<string, string> };
    try {
      const call = await post(cfg, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "ask_review", arguments: contractArgs("审查") },
      });
      expect(call.status).toBe(200);
      expect(call.body).toContain("spawn failed");
      const subagentCallId = pushEvent.mock.calls[0]?.[0]?.subagentCallId;
      expect(pushEvent).toHaveBeenLastCalledWith(expect.objectContaining({
        type: "result",
        ok: false,
        error: "spawn failed",
        roleId: "review",
        subagentCallId,
      }));
    } finally {
      stopDelegateHost();
      unregisterDelegateSession(sid);
    }
  });

  it("达到单会话子任务上限后拒绝继续创建，不限制同一角色的合理重复调用", async () => {
    await startDelegateHost();
    const sid = "child-limit-session";
    const state = makeState(sid);
    state.roles = [{ id: "review", label: "Reviewer", agent: "codex", systemPrompt: "", createdAt: "", updatedAt: "" }];
    state.maxChildRuns = 1;
    state.runSubAgent = vi.fn(async () => ({ text: "ok", ok: true }));
    registerDelegateSession(state);
    const cfg = buildDelegateMcpServerConfig(sid) as { url: string; headers?: Record<string, string> };
    try {
      const first = await post(cfg, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "ask_review", arguments: contractArgs("第一次") },
      });
      const second = await post(cfg, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "ask_review", arguments: contractArgs("第二次") },
      });
      expect(first.body).toContain("ok");
      expect(second.body).toContain("上限 1");
      expect(state.runSubAgent).toHaveBeenCalledTimes(1);
    } finally {
      stopDelegateHost();
      unregisterDelegateSession(sid);
    }
  });

  it("达到最大并行数后按顺序排队，前一任务释放槽位后再启动下一任务", async () => {
    await startDelegateHost();
    const sid = "parallel-limit-session";
    const state = makeState(sid);
    state.roles = [{ id: "review", label: "Reviewer", agent: "codex", systemPrompt: "", createdAt: "", updatedAt: "" }];
    state.maxParallel = 1;
    let finishFirst: (() => void) | undefined;
    state.runSubAgent = vi.fn(async (_role, task) => {
      if (task.includes('"objective": "第一项"')) await new Promise<void>((resolve) => { finishFirst = resolve; });
      return { text: task, ok: true };
    });
    registerDelegateSession(state);
    const cfg = buildDelegateMcpServerConfig(sid) as { url: string; headers?: Record<string, string> };
    try {
      const first = post(cfg, {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "ask_review", arguments: contractArgs("第一项") },
      });
      await vi.waitFor(() => expect(state.runSubAgent).toHaveBeenCalledTimes(1));
      const second = post(cfg, {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "ask_review", arguments: contractArgs("第二项") },
      });
      await vi.waitFor(() => expect(state.waiters).toHaveLength(1));
      expect(state.runSubAgent).toHaveBeenCalledTimes(1);

      finishFirst?.();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.body).toContain("第一项");
      expect(secondResult.body).toContain("第二项");
      expect(state.runSubAgent).toHaveBeenCalledTimes(2);
      expect(state.activeRuns).toBe(0);
      expect(state.waiters).toHaveLength(0);
    } finally {
      stopDelegateHost();
      unregisterDelegateSession(sid);
    }
  });

  it("排队中的单次 MCP 调用取消后移除 waiter，不得再启动无调用方 child", async () => {
    await startDelegateHost();
    const sid = "request-abort-session";
    const state = makeState(sid);
    state.roles = [{ id: "review", label: "Reviewer", agent: "pi", systemPrompt: "", createdAt: "", updatedAt: "" }];
    state.maxParallel = 1;
    let finishFirst: (() => void) | undefined;
    state.runSubAgent = vi.fn(async (_role, task) => {
      if (task.includes('"objective": "占用槽位"')) await new Promise<void>((resolve) => { finishFirst = resolve; });
      return { text: task, ok: true };
    });
    registerDelegateSession(state);
    const cfg = buildDelegateMcpServerConfig(sid) as { url: string; headers?: Record<string, string> };
    try {
      const first = post(cfg, {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "ask_review", arguments: contractArgs("占用槽位") },
      });
      await vi.waitFor(() => expect(state.runSubAgent).toHaveBeenCalledTimes(1));

      const controller = new AbortController();
      const second = post(cfg, {
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: { name: "ask_review", arguments: contractArgs("不应启动") },
      }, controller.signal);
      const rejected = expect(second).rejects.toThrow("调用方已取消");
      await vi.waitFor(() => expect(state.waiters).toHaveLength(1));
      controller.abort();
      await rejected;
      await vi.waitFor(() => expect(state.waiters).toHaveLength(0));

      finishFirst?.();
      await first;
      expect(state.runSubAgent).toHaveBeenCalledTimes(1);
      expect(state.activeRuns).toBe(0);
    } finally {
      finishFirst?.();
      stopDelegateHost();
      unregisterDelegateSession(sid);
    }
  });
});
