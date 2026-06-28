// orchestrate.ts 单测：三段编排调度器的全路径覆盖。
//
// 覆盖场景：
//   - 三段 intent→subagent→refine 顺序执行，prompt 正确串接
//   - 各段事件携带正确 stage；中间段 result 不转发；三段完成后恰好一次合成 result+exit
//   - 段1失败：静默回退，stage2 用原始输入
//   - 段2失败有错误文本 → 进 stage3 prompt
//   - 段2失败无输出 → 连锁兜底路径
//   - 段3失败 → stage2结果 + 独立错误消息
//   - abort → 三段在途进程全 kill，不再推后续事件
//   - 子进程不出现在 cli.ts running Map（通过验证 startAgentProcess mock 参数而非真实 Map）
//   - killAllOrchestrations 终止全部在途编排子进程
//   - 分段超时触发：该段 kill 并按失败降级处理

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

// ipcMain.handle / ipcMain.on 捕获
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const ipcOnHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(ch, fn);
    },
    on: (ch: string, fn: (...args: unknown[]) => unknown) => {
      ipcOnHandlers.set(ch, fn);
    },
  },
}));

// startAgentProcess + pipeStdoutLines + spawnEnvForDef + assertSpawnCwd
// 注意：mock 路径与 orchestrate.ts 的 import 路径匹配（同目录 ./cli）
const startAgentProcessMock = vi.fn();
const pipeStdoutLinesMock = vi.fn();

vi.mock("./cli", () => ({
  startAgentProcess: (...args: unknown[]) => startAgentProcessMock(...args),
  pipeStdoutLines: (...args: unknown[]) => pipeStdoutLinesMock(...args),
  spawnEnvFor: vi.fn(() => ({})),
  spawnEnvForDef: vi.fn(() => ({})),
  assertSpawnCwd: vi.fn(),
}));

// getAgentDef + parseLineEvents
const getAgentDefMock = vi.fn();
const parseLineEventsMock = vi.fn();

vi.mock("../agents", () => ({
  getAgentDef: (...args: unknown[]) => getAgentDefMock(...args),
  parseLineEvents: (...args: unknown[]) => parseLineEventsMock(...args),
}));

vi.mock("./mcp-config", () => ({
  CODEX_MCP_CLEAR: ["-c", "mcp_servers={}"],
}));

// Pi RPC 三段编排依赖。默认测试仍走 CLI adapter；Pi 专属测试用 fake session 驱动事件。
const piMocks = vi.hoisted(() => {
  const fakePiSessions: any[] = [];
  const promptResults: Array<{ success: boolean; error?: string }> = [];
  class FakePiSession {
    ready = vi.fn(async () => ({ sessionId: "pi-ready", sessionFile: "/tmp/pi.jsonl" }));
    prompt = vi.fn(async () => promptResults.shift() ?? { success: true });
    stop = vi.fn();

    constructor(
      _transport: unknown,
      private readonly onEvent: (ev: unknown, runId?: string) => void,
      private readonly onUiRequest?: (req: unknown) => void,
    ) {
      fakePiSessions.push(this);
    }

    emit(ev: unknown) {
      this.onEvent(ev, "pi-stage-run");
    }

    ui(req: unknown) {
      this.onUiRequest?.(req);
    }
  }
  return {
    buildRpcArgsMock: vi.fn(),
    spawnPiRpcMock: vi.fn(),
    preparePiOpenRequestMock: vi.fn(),
    registerTransientPiUiRequestMock: vi.fn(),
    clearTransientPiUiRequestsForSessionMock: vi.fn(),
    fakePiSessions,
    promptResults,
    FakePiSession,
  };
});

const {
  buildRpcArgsMock,
  spawnPiRpcMock,
  preparePiOpenRequestMock,
  registerTransientPiUiRequestMock,
  clearTransientPiUiRequestsForSessionMock,
  fakePiSessions,
  promptResults,
} = piMocks;

vi.mock("../agents/pi-rpc", () => ({
  buildRpcArgs: (...args: unknown[]) => buildRpcArgsMock(...args),
  spawnPiRpc: (...args: unknown[]) => spawnPiRpcMock(...args),
  PiRpcSession: piMocks.FakePiSession,
}));
vi.mock("../agents/pi-rpc.js", () => ({
  buildRpcArgs: (...args: unknown[]) => buildRpcArgsMock(...args),
  spawnPiRpc: (...args: unknown[]) => spawnPiRpcMock(...args),
  PiRpcSession: piMocks.FakePiSession,
}));
vi.mock("../agents/pi-rpc.ts", () => ({
  buildRpcArgs: (...args: unknown[]) => buildRpcArgsMock(...args),
  spawnPiRpc: (...args: unknown[]) => spawnPiRpcMock(...args),
  PiRpcSession: piMocks.FakePiSession,
}));

vi.mock("./pi-session", () => ({
  preparePiOpenRequest: (...args: unknown[]) => preparePiOpenRequestMock(...args),
  registerTransientPiUiRequest: (...args: unknown[]) => registerTransientPiUiRequestMock(...args),
  clearTransientPiUiRequestsForSession: (...args: unknown[]) => clearTransientPiUiRequestsForSessionMock(...args),
}));

// ── 测试工具类 ────────────────────────────────────────────────────────────────

/**
 * 模拟子进程。每个 runStage 调用会 startAgentProcess 一次，返回一个 FakeProc。
 * kill() 记录 killed 状态，exit/error 手动触发回调。
 */
class FakeProc {
  stdout = null;
  stderr = null;
  pid = Math.floor(Math.random() * 10000);
  killed = false;
  private _exitCb?: (code: number | null) => void;
  private _errorCb?: (err: Error) => void;

  onExit(cb: (code: number | null) => void) {
    this._exitCb = cb;
  }
  onError(cb: (err: Error) => void) {
    this._errorCb = cb;
  }
  kill() {
    this.killed = true;
  }
  // 测试辅助：触发进程正常退出
  exit(code: number | null = 0) {
    this._exitCb?.(code);
  }
  // 测试辅助：触发 spawn 错误
  error(err: Error) {
    this._errorCb?.(err);
  }
}

/**
 * 假 Sender：记录所有 IPC send 调用，供断言。
 */
function makeSender() {
  const calls: { channel: string; payload: unknown }[] = [];
  return {
    calls,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => calls.push({ channel, payload }),
  };
}

/**
 * 假 IPC event（含 sender）。
 */
function makeEvent(sender: ReturnType<typeof makeSender>) {
  return { sender };
}

/**
 * 刷新 Promise 微任务队列（让 await 后的代码继续执行）。
 * 多轮 setTimeout(0) 确保多层 await 都能穿透。
 */
async function flushAsync(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** 过滤 cli:event 的 event.payload.event 列表 */
function cliEvents(calls: ReturnType<typeof makeSender>["calls"]) {
  return calls
    .filter((c) => c.channel === "cli:event")
    .map((c) => (c.payload as { event: unknown }).event);
}

/** 过滤 cli:exit */
function cliExits(calls: ReturnType<typeof makeSender>["calls"]) {
  return calls.filter((c) => c.channel === "cli:exit").map((c) => c.payload);
}

// ── 基础请求 ─────────────────────────────────────────────────────────────────

const baseReq = {
  orchestrationRunId: "orch-1",
  sessionId: "sess-1",
  agent: "claude",
  cwd: "/proj",
  prompt: "帮我写个排序算法",
  model: undefined,
};

// ── 测试套件 ─────────────────────────────────────────────────────────────────

import {
  registerOrchestrateHandlers,
  killAllOrchestrations,
  INTENT_TIMEOUT_MS,
  SUBAGENT_TIMEOUT_MS,
  REFINE_TIMEOUT_MS,
} from "./orchestrate";

// 假 adapter（buildArgs + parseLine）
const fakeAdapter = {
  id: "claude",
  buildArgs: vi.fn(() => ({ cmd: "claude", args: ["--prompt"], stdin: "prompt" })),
  parseLine: vi.fn(),
};

beforeEach(() => {
  ipcHandlers.clear();
  ipcOnHandlers.clear();
  startAgentProcessMock.mockReset();
  pipeStdoutLinesMock.mockReset();
  getAgentDefMock.mockReturnValue(fakeAdapter);
  fakeAdapter.buildArgs.mockClear();
  fakeAdapter.parseLine.mockClear();
  // parseLineEvents mock：把 JSON 行解析成事件数组
  parseLineEventsMock.mockImplementation((_adapter: unknown, line: string) => {
    try {
      const parsed = JSON.parse(line);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  });
  fakePiSessions.length = 0;
  buildRpcArgsMock.mockReset();
  spawnPiRpcMock.mockReset();
  preparePiOpenRequestMock.mockReset();
  registerTransientPiUiRequestMock.mockReset();
  clearTransientPiUiRequestsForSessionMock.mockReset();
  promptResults.length = 0;
  buildRpcArgsMock.mockImplementation((req: { uiSessionId?: string }) => ["--mode", "rpc", req.uiSessionId ?? ""]);
  spawnPiRpcMock.mockReturnValue({});
  preparePiOpenRequestMock.mockImplementation(async (req: unknown) => req);
  // 注册 handler（每个 beforeEach 都重新注册，避免状态污染）
  registerOrchestrateHandlers();
});

afterEach(() => {
  // 清理所有在途编排（防止测试间漏出定时器/进程引用）
  killAllOrchestrations();
  // 确保 fake timers 不泄漏到后续测试（若某个测试调用了 vi.useFakeTimers()）
  vi.useRealTimers();
});

// ── 三段顺序与 prompt 串接 ───────────────────────────────────────────────────

describe("三段顺序执行与 prompt 串接", () => {
  it("三段按 intent→subagent→refine 顺序执行，prompt 正确串接", async () => {
    const proc1 = new FakeProc();
    const proc2 = new FakeProc();
    const proc3 = new FakeProc();
    const procs = [proc1, proc2, proc3];
    startAgentProcessMock.mockImplementation(() => procs.shift());

    // 记录每次 pipeStdoutLines 的 onLine 回调
    const onLines: Array<(line: string) => void> = [];
    pipeStdoutLinesMock.mockImplementation(
      (_stdout: unknown, onLine: (line: string) => void) => {
        onLines.push(onLine);
        return () => {};
      },
    );

    const sender = makeSender();
    const event = makeEvent(sender);
    const handler = ipcHandlers.get("orchestrate:start")!;

    // 启动编排（不 await，分步控制各段）
    const handlerP = handler(event, baseReq) as Promise<void>;

    // ── 段1 ──
    await flushAsync(); // 等待段1 startAgentProcess + pipeStdoutLines 完成
    expect(onLines).toHaveLength(1);

    // 段1产出优化后的提示词
    onLines[0](JSON.stringify({ type: "text", delta: "优化后的提示词" }));
    onLines[0](JSON.stringify({ type: "result", ok: true, text: "优化后的提示词" }));
    proc1.exit(0);

    // ── 段2 ──
    await flushAsync(20);
    expect(onLines).toHaveLength(2);

    // 段2 prompt 应该是段1 text 输出
    const stage2CallArgs = (fakeAdapter.buildArgs.mock.calls as unknown[][])[1]?.[0] as { prompt?: string } | undefined;
    expect(stage2CallArgs?.prompt).toContain("优化后的提示词");
    expect(stage2CallArgs?.prompt).not.toContain(baseReq.prompt); // 不是原始输入

    onLines[1](JSON.stringify({ type: "text", delta: "子agent执行结果" }));
    onLines[1](JSON.stringify({ type: "result", ok: true }));
    proc2.exit(0);

    // ── 段3 ──
    await flushAsync(20);
    expect(onLines).toHaveLength(3);

    // 段3 prompt 应包含用户原始输入 + 段2结果
    const stage3CallArgs = (fakeAdapter.buildArgs.mock.calls as unknown[][])[2]?.[0] as { prompt?: string } | undefined;
    expect(stage3CallArgs?.prompt).toContain(baseReq.prompt);
    expect(stage3CallArgs?.prompt).toContain("子agent执行结果");

    onLines[2](JSON.stringify({ type: "text", delta: "最终回答" }));
    onLines[2](JSON.stringify({ type: "result", ok: true }));
    proc3.exit(0);

    await handlerP;

    // 验证三次 buildArgs 调用（三段各一次）
    expect(fakeAdapter.buildArgs).toHaveBeenCalledTimes(3);
  });

  it("Pi 三段使用临时 RPC 会话执行并按 stage 转发事件", async () => {
    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), {
      ...baseReq,
      agent: "pi",
      model: "pi-model",
      effort: "high",
      permissionMode: "plan",
      approvalPolicy: "ask",
      piOpen: {
        model: "pi-model",
        thinkingLevel: "high",
        toolWhitelist: ["read", "grep"],
      },
    }) as Promise<void>;

    await flushAsync(20);
    expect(startAgentProcessMock).not.toHaveBeenCalled();
    expect(preparePiOpenRequestMock).toHaveBeenCalled();
    expect(buildRpcArgsMock).toHaveBeenCalled();
    expect(spawnPiRpcMock).toHaveBeenCalled();
    expect(fakePiSessions).toHaveLength(1);
    expect(fakePiSessions[0]!.prompt).toHaveBeenCalledWith(
      expect.stringContaining("用户输入：帮我写个排序算法"),
      expect.any(String),
    );
    fakePiSessions[0]!.emit({ type: "text", delta: "优化后的提示词" });
    fakePiSessions[0]!.emit({ type: "result", willRetry: false });

    await flushAsync(20);
    expect(fakePiSessions).toHaveLength(2);
    expect(fakePiSessions[1]!.prompt).toHaveBeenCalledWith("优化后的提示词", expect.any(String));
    fakePiSessions[1]!.emit({ type: "tool-start", name: "Bash", toolCallId: "t1", detail: "ls" });
    fakePiSessions[1]!.emit({ type: "tool-end", name: "Bash", toolCallId: "t1", isError: false });
    fakePiSessions[1]!.emit({ type: "text", delta: "子执行结果" });
    fakePiSessions[1]!.emit({ type: "result", willRetry: false });

    await flushAsync(20);
    expect(fakePiSessions).toHaveLength(3);
    const refinePrompt = fakePiSessions[2]!.prompt.mock.calls[0]?.[0] as string;
    expect(refinePrompt).toContain(baseReq.prompt);
    expect(refinePrompt).toContain("子执行结果");
    fakePiSessions[2]!.emit({ type: "text", delta: "最终回答" });
    fakePiSessions[2]!.emit({ type: "result", willRetry: false });

    await handlerP;

    const events = cliEvents(sender.calls);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", delta: "优化后的提示词", stage: "intent" }),
        expect.objectContaining({ type: "tool", name: "Bash", phase: "start", stage: "subagent" }),
        expect.objectContaining({ type: "tool", name: "Bash", phase: "end", stage: "subagent" }),
        expect.objectContaining({ type: "text", delta: "最终回答", stage: "refine" }),
        expect.objectContaining({ type: "result", ok: true, stage: "refine" }),
      ]),
    );
    expect(fakePiSessions.every((s) => s.stop.mock.calls.length === 1)).toBe(true);
    expect(buildRpcArgsMock).toHaveBeenCalledTimes(3);
    expect(preparePiOpenRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/proj",
        model: "pi-model",
        thinkingLevel: "high",
        toolWhitelist: ["read", "grep"],
      }),
    );
  });

  it("Pi 临时 RPC UI 请求归属真实 chat session 并登记 response 路由", async () => {
    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), {
      ...baseReq,
      agent: "pi",
      piOpen: {},
    }) as Promise<void>;

    await flushAsync(20);
    fakePiSessions[0]!.emit({ type: "text", delta: "优化后的提示词" });
    fakePiSessions[0]!.emit({ type: "result", willRetry: false });

    await flushAsync();
    const req = { type: "extension_ui_request", id: "confirm-1", method: "confirm", title: "T", message: "M" };
    fakePiSessions[1]!.ui(req);
    fakePiSessions[1]!.emit({ type: "text", delta: "子执行结果" });
    fakePiSessions[1]!.emit({ type: "result", willRetry: false });

    await flushAsync();
    fakePiSessions[2]!.emit({ type: "text", delta: "最终回答" });
    fakePiSessions[2]!.emit({ type: "result", willRetry: false });
    await handlerP;

    expect(sender.calls).toContainEqual({
      channel: "pi:uiRequest",
      payload: { uiSessionId: baseReq.sessionId, request: req },
    });
    expect(registerTransientPiUiRequestMock).toHaveBeenCalledWith(baseReq.sessionId, "confirm-1", fakePiSessions[1]);
    expect(clearTransientPiUiRequestsForSessionMock).toHaveBeenCalledWith(fakePiSessions[1]);
  });

  it("Pi open 准备期间取消后不再 spawn 临时 RPC", async () => {
    let resolvePrepare!: (value: unknown) => void;
    preparePiOpenRequestMock.mockImplementationOnce(
      (req: unknown) =>
        new Promise((resolve) => {
          resolvePrepare = () => resolve(req);
        }),
    );
    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), {
      ...baseReq,
      agent: "pi",
      piOpen: {},
    }) as Promise<void>;

    await flushAsync();
    expect(preparePiOpenRequestMock).toHaveBeenCalledTimes(1);

    const killHandler = ipcOnHandlers.get("orchestrate:kill")!;
    killHandler({} as unknown, baseReq.orchestrationRunId);
    resolvePrepare({});
    await handlerP;

    expect(spawnPiRpcMock).not.toHaveBeenCalled();
    expect(fakePiSessions).toHaveLength(0);
    expect(cliExits(sender.calls)).toHaveLength(0);
  });

  it("Pi prompt 返回 success:false 时该段立即失败,不等超时", async () => {
    promptResults.push({ success: false, error: "prompt rejected" }, { success: true }, { success: true });
    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), {
      ...baseReq,
      agent: "pi",
      piOpen: {},
    }) as Promise<void>;

    await flushAsync(20);
    expect(fakePiSessions).toHaveLength(2);
    expect(fakePiSessions[0]!.stop).toHaveBeenCalledTimes(1);
    expect(fakePiSessions[1]!.prompt).toHaveBeenCalledWith(expect.stringContaining(baseReq.prompt), expect.any(String));

    fakePiSessions[1]!.emit({ type: "text", delta: "子执行结果" });
    fakePiSessions[1]!.emit({ type: "result", willRetry: false });
    await flushAsync(20);
    fakePiSessions[2]!.emit({ type: "text", delta: "最终回答" });
    fakePiSessions[2]!.emit({ type: "result", willRetry: false });
    await handlerP;

    expect(cliEvents(sender.calls)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "result", ok: true, stage: "refine" }),
      ]),
    );
  });

  it("Pi intent/refine 临时 open 不带持久 appendSystemPrompt,仅 subagent 段带", async () => {
    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), {
      ...baseReq,
      agent: "pi",
      piOpen: { appendSystemPrompt: "持久 Pi 人设" },
    }) as Promise<void>;

    await flushAsync(20);
    fakePiSessions[0]!.emit({ type: "text", delta: "优化后的提示词" });
    fakePiSessions[0]!.emit({ type: "result", willRetry: false });
    await flushAsync(20);
    fakePiSessions[1]!.emit({ type: "text", delta: "子执行结果" });
    fakePiSessions[1]!.emit({ type: "result", willRetry: false });
    await flushAsync(20);
    fakePiSessions[2]!.emit({ type: "text", delta: "最终回答" });
    fakePiSessions[2]!.emit({ type: "result", willRetry: false });
    await handlerP;

    const openReqs = preparePiOpenRequestMock.mock.calls.map((call) => call[0] as { appendSystemPrompt?: string });
    expect(openReqs[0]?.appendSystemPrompt).toBeUndefined();
    expect(openReqs[1]?.appendSystemPrompt).toBe("持久 Pi 人设");
    expect(openReqs[2]?.appendSystemPrompt).toBeUndefined();
  });
});

// ── 会话上下文仅段2透传（effort / permissionMode / approvalPolicy） ──────────────
// 回归保护：effort 曾在 handler 解构与 runStage 中漏接，导致段2用 adapter 默认推理强度而非会话设定。
// 段1/段3是轻量提示词转换，必须沿用 adapter 默认（不透传），否则 plan 会话也会被允许写盘、
// 高 effort 还会拖慢 60s 限时的轻量段。
describe("会话上下文仅段2透传", () => {
  it("effort/permissionMode/approvalPolicy 只进段2 buildArgs，段1/段3为 undefined", async () => {
    const proc1 = new FakeProc();
    const proc2 = new FakeProc();
    const proc3 = new FakeProc();
    const procs = [proc1, proc2, proc3];
    startAgentProcessMock.mockImplementation(() => procs.shift());

    const onLines: Array<(line: string) => void> = [];
    pipeStdoutLinesMock.mockImplementation(
      (_stdout: unknown, onLine: (line: string) => void) => {
        onLines.push(onLine);
        return () => {};
      },
    );

    const sender = makeSender();
    const event = makeEvent(sender);
    const handler = ipcHandlers.get("orchestrate:start")!;
    const req = { ...baseReq, effort: "high", permissionMode: "plan", approvalPolicy: "ask" };
    const handlerP = handler(event, req) as Promise<void>;

    // 段1
    await flushAsync();
    onLines[0](JSON.stringify({ type: "result", ok: true, text: "改写" }));
    proc1.exit(0);
    // 段2
    await flushAsync();
    onLines[1](JSON.stringify({ type: "result", ok: true, text: "执行结果" }));
    proc2.exit(0);
    // 段3
    await flushAsync();
    onLines[2](JSON.stringify({ type: "result", ok: true, text: "最终" }));
    proc3.exit(0);
    await handlerP;

    const argFor = (i: number) =>
      (fakeAdapter.buildArgs.mock.calls as unknown[][])[i]?.[0] as
        | { effort?: string; permissionMode?: string; approvalPolicy?: string }
        | undefined;
    // 段2（subagent）透传会话设定。
    expect(argFor(1)).toMatchObject({ effort: "high", permissionMode: "plan", approvalPolicy: "ask" });
    // 段1（intent）/段3（refine）均为 undefined → adapter 默认。
    expect(argFor(0)?.effort).toBeUndefined();
    expect(argFor(0)?.permissionMode).toBeUndefined();
    expect(argFor(2)?.effort).toBeUndefined();
    expect(argFor(2)?.permissionMode).toBeUndefined();
  });
});

// ── stage 字段正确注入 ────────────────────────────────────────────────────────

describe("各段事件携带正确 stage", () => {
  it("intent/subagent/refine 各段事件均带正确 stage", async () => {
    const proc1 = new FakeProc();
    const proc2 = new FakeProc();
    const proc3 = new FakeProc();
    const procs = [proc1, proc2, proc3];
    startAgentProcessMock.mockImplementation(() => procs.shift());

    const onLines: Array<(line: string) => void> = [];
    pipeStdoutLinesMock.mockImplementation(
      (_stdout: unknown, onLine: (line: string) => void) => {
        onLines.push(onLine);
        return () => {};
      },
    );

    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), baseReq) as Promise<void>;

    // 段1：text 事件
    await flushAsync();
    onLines[0](JSON.stringify({ type: "text", delta: "s1" }));
    proc1.exit(0);

    // 段2：tool 事件
    await flushAsync();
    onLines[1](JSON.stringify({ type: "tool", name: "bash", detail: "ls" }));
    onLines[1](JSON.stringify({ type: "text", delta: "s2" }));
    proc2.exit(0);

    // 段3：thinking + text 事件
    await flushAsync();
    onLines[2](JSON.stringify({ type: "thinking", delta: "分析中" }));
    onLines[2](JSON.stringify({ type: "text", delta: "s3" }));
    proc3.exit(0);

    await handlerP;

    const events = cliEvents(sender.calls);

    // 找各段事件（过滤掉段边界 thinking 空 delta 事件）
    const intentTextEvents = events.filter(
      (e: any) => e.stage === "intent" && e.type === "text",
    );
    const subagentToolEvents = events.filter(
      (e: any) => e.stage === "subagent" && e.type === "tool",
    );
    const refineThinkingEvents = events.filter(
      (e: any) => e.stage === "refine" && e.type === "thinking" && e.delta === "分析中",
    );
    const refineTextEvents = events.filter(
      (e: any) => e.stage === "refine" && e.type === "text" && e.delta === "s3",
    );

    expect(intentTextEvents).toHaveLength(1);
    expect(subagentToolEvents).toHaveLength(1);
    expect(refineThinkingEvents).toHaveLength(1);
    expect(refineTextEvents).toHaveLength(1);
  });
});

// ── 中间段 result 不转发，合成终态精确一次 ──────────────────────────────────

describe("result 事件路由（KTD4）", () => {
  it("各段的 result 事件不转发；三段完成后恰好一次合成 result(ok:true) + cli:exit", async () => {
    const proc1 = new FakeProc();
    const proc2 = new FakeProc();
    const proc3 = new FakeProc();
    const procs = [proc1, proc2, proc3];
    startAgentProcessMock.mockImplementation(() => procs.shift());

    const onLines: Array<(line: string) => void> = [];
    pipeStdoutLinesMock.mockImplementation(
      (_stdout: unknown, onLine: (line: string) => void) => {
        onLines.push(onLine);
        return () => {};
      },
    );

    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), baseReq) as Promise<void>;

    await flushAsync();
    // 段1 发 result
    onLines[0](JSON.stringify({ type: "result", ok: true, text: "optimized" }));
    proc1.exit(0);

    await flushAsync();
    // 段2 发 result
    onLines[1](JSON.stringify({ type: "text", delta: "result" }));
    onLines[1](JSON.stringify({ type: "result", ok: true }));
    proc2.exit(0);

    await flushAsync();
    // 段3 发 result
    onLines[2](JSON.stringify({ type: "text", delta: "final" }));
    onLines[2](JSON.stringify({ type: "result", ok: true }));
    proc3.exit(0);

    await handlerP;

    const events = cliEvents(sender.calls);
    const resultEvents = events.filter((e: any) => e.type === "result");
    const exits = cliExits(sender.calls);

    // 只有一次合成 result
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0]).toMatchObject({ type: "result", ok: true, stage: "refine" });

    // 只有一次 cli:exit
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ runId: baseReq.orchestrationRunId, code: 0 });
  });
});

// ── 段1失败：静默回退 ────────────────────────────────────────────────────────

describe("段1失败降级（KTD7-1）", () => {
  it("段1非零退出 → 静默回退，段2使用原始 prompt，链路继续", async () => {
    const proc1 = new FakeProc();
    const proc2 = new FakeProc();
    const proc3 = new FakeProc();
    const procs = [proc1, proc2, proc3];
    startAgentProcessMock.mockImplementation(() => procs.shift());

    const onLines: Array<(line: string) => void> = [];
    pipeStdoutLinesMock.mockImplementation(
      (_stdout: unknown, onLine: (line: string) => void) => {
        onLines.push(onLine);
        return () => {};
      },
    );

    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), baseReq) as Promise<void>;

    // 段1：无任何 text 输出，非零退出（失败）
    await flushAsync();
    proc1.exit(1);

    // 段2 应该使用原始 prompt（静默回退）
    await flushAsync();
    const stage2Args = (fakeAdapter.buildArgs.mock.calls as unknown[][])[1]?.[0] as { prompt?: string } | undefined;
    expect(stage2Args?.prompt).toContain(baseReq.prompt); // 包含原始输入

    onLines[1](JSON.stringify({ type: "text", delta: "sub result" }));
    proc2.exit(0);

    await flushAsync();
    onLines[2](JSON.stringify({ type: "text", delta: "refined" }));
    proc3.exit(0);

    await handlerP;

    // 链路成功完成，最终推合成 result
    const events = cliEvents(sender.calls);
    const resultEvents = events.filter((e: any) => e.type === "result");
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0]).toMatchObject({ ok: true });
  });

  it("段1 text 为空 → 静默回退用原始输入，而非空字符串", async () => {
    const proc1 = new FakeProc();
    const proc2 = new FakeProc();
    const proc3 = new FakeProc();
    const procs = [proc1, proc2, proc3];
    startAgentProcessMock.mockImplementation(() => procs.shift());

    const onLines: Array<(line: string) => void> = [];
    pipeStdoutLinesMock.mockImplementation(
      (_stdout: unknown, onLine: (line: string) => void) => {
        onLines.push(onLine);
        return () => {};
      },
    );

    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), baseReq) as Promise<void>;

    // 段1：result ok 但 text 为空（改写失败场景）
    await flushAsync();
    onLines[0](JSON.stringify({ type: "result", ok: true, text: "" }));
    proc1.exit(0);

    await flushAsync();
    // 段2 prompt 应该是原始输入
    const stage2Args = (fakeAdapter.buildArgs.mock.calls as unknown[][])[1]?.[0] as { prompt?: string } | undefined;
    expect(stage2Args?.prompt).toContain(baseReq.prompt);

    onLines[1](JSON.stringify({ type: "text", delta: "x" }));
    proc2.exit(0);
    await flushAsync();
    proc3.exit(0);
    await handlerP;
  });
});

// ── 段2失败 ──────────────────────────────────────────────────────────────────

describe("段2失败降级（KTD7-2/3）", () => {
  it("段2失败有错误文本 → 错误文本进段3 prompt（KTD7-2）", async () => {
    const proc1 = new FakeProc();
    const proc2 = new FakeProc();
    const proc3 = new FakeProc();
    const procs = [proc1, proc2, proc3];
    startAgentProcessMock.mockImplementation(() => procs.shift());

    const onLines: Array<(line: string) => void> = [];
    pipeStdoutLinesMock.mockImplementation(
      (_stdout: unknown, onLine: (line: string) => void) => {
        onLines.push(onLine);
        return () => {};
      },
    );

    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), baseReq) as Promise<void>;

    await flushAsync();
    onLines[0](JSON.stringify({ type: "text", delta: "optimized" }));
    proc1.exit(0);

    // 段2：有部分输出但失败
    await flushAsync();
    onLines[1](JSON.stringify({ type: "text", delta: "部分错误输出" }));
    onLines[1](JSON.stringify({ type: "result", ok: false, error: "工具超限" }));
    proc2.exit(1);

    await flushAsync();
    // 段3 prompt 应包含段2的错误文本
    const stage3Args = (fakeAdapter.buildArgs.mock.calls as unknown[][])[2]?.[0] as { prompt?: string } | undefined;
    expect(stage3Args?.prompt).toContain("部分错误输出");
    expect(stage3Args?.prompt).toContain("工具超限");

    onLines[2](JSON.stringify({ type: "text", delta: "降级回答" }));
    proc3.exit(0);

    await handlerP;

    // 链路仍然完成（段3降级成功）
    const events = cliEvents(sender.calls);
    expect(events.filter((e: any) => e.type === "result")).toHaveLength(1);
  });

  it("段2失败且无有效输出 → 连锁兜底（KTD7-3），段3 prompt 不含错误文本", async () => {
    const proc1 = new FakeProc();
    const proc2 = new FakeProc();
    const proc3 = new FakeProc();
    const procs = [proc1, proc2, proc3];
    startAgentProcessMock.mockImplementation(() => procs.shift());

    const onLines: Array<(line: string) => void> = [];
    pipeStdoutLinesMock.mockImplementation(
      (_stdout: unknown, onLine: (line: string) => void) => {
        onLines.push(onLine);
        return () => {};
      },
    );

    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), baseReq) as Promise<void>;

    await flushAsync();
    proc1.exit(0); // 段1无输出（会用原始 prompt）

    // 段2：完全无输出，失败
    await flushAsync();
    onLines[1](JSON.stringify({ type: "result", ok: false, error: "crash" }));
    proc2.exit(1);

    await flushAsync();
    // 段3 prompt 应触发连锁兜底路径（包含「执行失败」说明，不包含错误文本当子结果）
    const stage3Args = (fakeAdapter.buildArgs.mock.calls as unknown[][])[2]?.[0] as { prompt?: string } | undefined;
    expect(stage3Args?.prompt).toContain(baseReq.prompt); // 原始问题
    expect(stage3Args?.prompt).toContain("执行失败"); // 兜底说明
    // 不应把空错误文本当子结果传进去
    expect(stage3Args?.prompt).not.toContain("crash"); // 技术报错不进段3

    onLines[2](JSON.stringify({ type: "text", delta: "兜底回答" }));
    proc3.exit(0);

    await handlerP;
  });
});

// ── 段3失败 ──────────────────────────────────────────────────────────────────

describe("段3失败降级（KTD7-4）", () => {
  it("段3失败且无输出 → 段2结果推渲染端 + 独立友好错误消息", async () => {
    const proc1 = new FakeProc();
    const proc2 = new FakeProc();
    const proc3 = new FakeProc();
    const procs = [proc1, proc2, proc3];
    startAgentProcessMock.mockImplementation(() => procs.shift());

    const onLines: Array<(line: string) => void> = [];
    pipeStdoutLinesMock.mockImplementation(
      (_stdout: unknown, onLine: (line: string) => void) => {
        onLines.push(onLine);
        return () => {};
      },
    );

    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), baseReq) as Promise<void>;

    await flushAsync();
    onLines[0](JSON.stringify({ type: "text", delta: "optimized" }));
    proc1.exit(0);

    await flushAsync();
    onLines[1](JSON.stringify({ type: "text", delta: "子agent结果内容" }));
    proc2.exit(0);

    // 段3：无任何输出，失败
    await flushAsync();
    onLines[2](JSON.stringify({ type: "result", ok: false, error: "二次加工失败" }));
    proc3.exit(1);

    await handlerP;

    const events = cliEvents(sender.calls);
    const refineTextEvents = events.filter(
      (e: any) => e.stage === "refine" && e.type === "text",
    );

    // 应包含段2结果（回退文本）
    expect(refineTextEvents.some((e: any) => e.delta.includes("子agent结果内容"))).toBe(true);
    // 应包含独立友好错误消息
    expect(refineTextEvents.some((e: any) => e.delta.includes("技术问题"))).toBe(true);

    // 仍然推合成终态（编排从用户视角"完成了"）
    const resultEvents = events.filter((e: any) => e.type === "result");
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0]).toMatchObject({ ok: true });
  });

  it("段3失败但有部分输出 → 已发的流式文本保留，追加错误消息", async () => {
    const proc1 = new FakeProc();
    const proc2 = new FakeProc();
    const proc3 = new FakeProc();
    const procs = [proc1, proc2, proc3];
    startAgentProcessMock.mockImplementation(() => procs.shift());

    const onLines: Array<(line: string) => void> = [];
    pipeStdoutLinesMock.mockImplementation(
      (_stdout: unknown, onLine: (line: string) => void) => {
        onLines.push(onLine);
        return () => {};
      },
    );

    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), baseReq) as Promise<void>;

    await flushAsync();
    proc1.exit(0);
    await flushAsync();
    onLines[1](JSON.stringify({ type: "text", delta: "s2result" }));
    proc2.exit(0);

    await flushAsync();
    // 段3有部分流式输出后失败
    onLines[2](JSON.stringify({ type: "text", delta: "部分三次输出" }));
    onLines[2](JSON.stringify({ type: "result", ok: false, error: "crash" }));
    proc3.exit(1);

    await handlerP;

    const events = cliEvents(sender.calls);
    const refineTexts = events
      .filter((e: any) => e.stage === "refine" && e.type === "text")
      .map((e: any) => e.delta);

    // 段3的流式 text 已发出（在 runStage 内转发）
    expect(refineTexts.some((d: string) => d.includes("部分三次输出"))).toBe(true);
    // 追加了错误消息
    expect(refineTexts.some((d: string) => d.includes("技术问题"))).toBe(true);
  });
});

// ── abort 取消 ───────────────────────────────────────────────────────────────

describe("abort 取消（KTD5）", () => {
  it("orchestrate:kill 终止在途进程，不再推后续事件", async () => {
    const proc1 = new FakeProc();
    const proc2 = new FakeProc();
    const proc3 = new FakeProc();
    const procs = [proc1, proc2, proc3];
    startAgentProcessMock.mockImplementation(() => procs.shift());

    const onLines: Array<(line: string) => void> = [];
    pipeStdoutLinesMock.mockImplementation(
      (_stdout: unknown, onLine: (line: string) => void) => {
        onLines.push(onLine);
        return () => {};
      },
    );

    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), baseReq) as Promise<void>;

    // 段1 开始后，发起 kill
    await flushAsync();
    expect(onLines).toHaveLength(1);

    // 触发 orchestrate:kill
    const killHandler = ipcOnHandlers.get("orchestrate:kill")!;
    killHandler({} as unknown, baseReq.orchestrationRunId);

    // 段1 进程被 abort → kill
    expect(proc1.killed).toBe(true);

    // 触发进程退出（被 kill 后退出）
    proc1.exit(null);

    await handlerP;

    // 取消后不推任何 result 或 exit（handler 在 aborted 检查后直接 return）
    const resultEvents = cliEvents(sender.calls).filter((e: any) => e.type === "result");
    expect(resultEvents).toHaveLength(0);
    const exits = cliExits(sender.calls);
    expect(exits).toHaveLength(0);
  });

  it("段2 中 abort → proc2 被 kill，段3 不启动", async () => {
    const proc1 = new FakeProc();
    const proc2 = new FakeProc();
    const proc3 = new FakeProc();
    const procs = [proc1, proc2, proc3];
    startAgentProcessMock.mockImplementation(() => procs.shift());

    const onLines: Array<(line: string) => void> = [];
    pipeStdoutLinesMock.mockImplementation(
      (_stdout: unknown, onLine: (line: string) => void) => {
        onLines.push(onLine);
        return () => {};
      },
    );

    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), baseReq) as Promise<void>;

    await flushAsync();
    proc1.exit(0); // 段1 正常完成

    await flushAsync();
    // 段2 进行中，发起 kill
    const killHandler = ipcOnHandlers.get("orchestrate:kill")!;
    killHandler({} as unknown, baseReq.orchestrationRunId);

    expect(proc2.killed).toBe(true);
    proc2.exit(null);

    await handlerP;

    // 段3 从未启动（startAgentProcess 只被调用 2 次）
    expect(startAgentProcessMock).toHaveBeenCalledTimes(2);
    // 无合成终态
    expect(cliEvents(sender.calls).filter((e: any) => e.type === "result")).toHaveLength(0);
  });
});

// ── killAllOrchestrations ─────────────────────────────────────────────────────

describe("killAllOrchestrations", () => {
  it("killAllOrchestrations 终止所有在途编排进程", async () => {
    const proc1 = new FakeProc();
    const proc2 = new FakeProc();
    startAgentProcessMock
      .mockReturnValueOnce(proc1)
      .mockReturnValueOnce(proc2);

    const onLines: Array<(line: string) => void> = [];
    pipeStdoutLinesMock.mockImplementation(
      (_stdout: unknown, onLine: (line: string) => void) => {
        onLines.push(onLine);
        return () => {};
      },
    );

    const sender1 = makeSender();
    const sender2 = makeSender();

    // 两条并发编排链路（两个不同 runId）
    const req1 = { ...baseReq, orchestrationRunId: "orch-A" };
    const req2 = { ...baseReq, orchestrationRunId: "orch-B" };

    const p1 = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender1), req1) as Promise<void>;
    const p2 = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender2), req2) as Promise<void>;

    await flushAsync();

    // 两条链路的段1子进程都在途
    expect(proc1.killed).toBe(false);
    expect(proc2.killed).toBe(false);

    // 全局终止
    killAllOrchestrations();

    expect(proc1.killed).toBe(true);
    expect(proc2.killed).toBe(true);

    proc1.exit(null);
    proc2.exit(null);

    await Promise.all([p1, p2]);
  });
});

// ── 子进程不进 cli.ts running Map ────────────────────────────────────────────

describe("独立进程注册表（KTD5）", () => {
  it("startAgentProcess 被调用但结果不注册进 cli.ts running Map（由独立 Set 管理）", async () => {
    const proc1 = new FakeProc();
    const proc2 = new FakeProc();
    const proc3 = new FakeProc();
    const procs = [proc1, proc2, proc3];
    startAgentProcessMock.mockImplementation(() => procs.shift());

    const onLines: Array<(line: string) => void> = [];
    pipeStdoutLinesMock.mockImplementation(
      (_stdout: unknown, onLine: (line: string) => void) => {
        onLines.push(onLine);
        return () => {};
      },
    );

    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), baseReq) as Promise<void>;

    await flushAsync();
    // startAgentProcess 被调用（段1已 spawn）
    expect(startAgentProcessMock).toHaveBeenCalledTimes(1);
    // 验证：调用参数（cmd/args）来自 fakeAdapter.buildArgs，不是 running Map 的读写
    // orchestrate.ts 内部不导入 running Map，此测试通过模拟调用链验证隔离性
    const callArgs = (startAgentProcessMock.mock.calls as unknown[][])[0];
    expect(callArgs?.[0]).toBe("claude"); // cmd 来自 fakeAdapter.buildArgs

    proc1.exit(0);
    await flushAsync();
    proc2.exit(0);
    await flushAsync();
    proc3.exit(0);
    await handlerP;
  });
});

// ── 分段超时 ─────────────────────────────────────────────────────────────────

describe("分段超时（KTD7-5）", () => {
  it("段1超时 → kill 进程（fake timer 验证超时触发机制）", async () => {
    // 用 fake timers 验证：超时计时器在 runStage Promise 构造器中同步注册，
    // advanceTimersByTime 触发后进程被 kill。
    vi.useFakeTimers();

    const proc1 = new FakeProc();
    startAgentProcessMock.mockReturnValueOnce(proc1);
    pipeStdoutLinesMock.mockReturnValue(() => {});

    const sender = makeSender();
    // 启动 handler（Promise 构造器同步执行：setTimeout 已注册在 fake timer 里）
    (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), { ...baseReq, orchestrationRunId: "timeout-test" }) as Promise<void>;

    expect(proc1.killed).toBe(false);

    // 推进到段1超时
    vi.advanceTimersByTime(INTENT_TIMEOUT_MS + 100);

    // 超时回调触发：timedOut = true, proc.kill()
    expect(proc1.killed).toBe(true);

    // 恢复真实计时器后终止编排（避免 handlerP 阻塞）
    vi.useRealTimers();
    const killHandler = ipcOnHandlers.get("orchestrate:kill")!;
    killHandler({} as unknown, "timeout-test");

    // 触发 proc1 退出（kill 后进程退出），让 runStage resolve
    proc1.exit(null);
    await Promise.resolve();
    await Promise.resolve();

    // 段1超时按静默降级处理（不通知用户）：后续段的 buildArgs 若被调用则应含原始 prompt
    // （因 abort 提前终止，可能段2从未 spawn，此处仅验证超时 kill 本身）
    expect(proc1.killed).toBe(true);
  });

  it("超时常量值：意图段 60s，子执行段 30min，二次加工段 60s", () => {
    expect(INTENT_TIMEOUT_MS).toBe(60_000);
    expect(SUBAGENT_TIMEOUT_MS).toBe(30 * 60_000);
    expect(REFINE_TIMEOUT_MS).toBe(60_000);
  });
});

// ── stageLabel 段切换通知 ─────────────────────────────────────────────────────

describe("stageLabel 段切换通知（R9）", () => {
  it("每段开始时发 thinking 空 delta 事件，携带 stage + stageLabel", async () => {
    const proc1 = new FakeProc();
    const proc2 = new FakeProc();
    const proc3 = new FakeProc();
    const procs = [proc1, proc2, proc3];
    startAgentProcessMock.mockImplementation(() => procs.shift());

    const onLines: Array<(line: string) => void> = [];
    pipeStdoutLinesMock.mockImplementation(
      (_stdout: unknown, onLine: (line: string) => void) => {
        onLines.push(onLine);
        return () => {};
      },
    );

    const sender = makeSender();
    const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), baseReq) as Promise<void>;

    await flushAsync();
    proc1.exit(0);
    await flushAsync();
    proc2.exit(0);
    await flushAsync();
    proc3.exit(0);
    await handlerP;

    const events = cliEvents(sender.calls);
    // 每段开始时都应有空 delta 的 thinking 事件携带 stageLabel
    const stageBoundaries = events.filter(
      (e: any) => e.type === "thinking" && e.delta === "" && e.stageLabel,
    );
    expect(stageBoundaries.length).toBeGreaterThanOrEqual(3); // 至少三次段切换通知

    const labels = stageBoundaries.map((e: any) => e.stageLabel);
    expect(labels).toContain("理解意图中…");
    expect(labels).toContain("子 agent 执行中…");
    expect(labels).toContain("整理回复中…");
  });
});
