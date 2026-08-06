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
//
// pi 覆盖（引擎已收敛,三段无条件走 openPiGatewaySession,不 spawn）：
//   - 释放：每段收尾恰好一次 stop（worker 侧 closeSession 自带 abort,主进程不重复）
//   - 构造期竞态：openPiGatewaySession 未决时取消/超时 → 会话建好后立即被释放，绝不留无主会话
//   - 并发隔离：一条链路的会话构造失败 / provider 静默失败（KTD5）不影响同批其它链路
//   - killAllOrchestrations：某会话 stop() 抛错，其余仍被释放

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

// Pi 三段编排依赖。默认测试仍走 CLI adapter；Pi 专属测试用 fake gateway session 驱动事件。
const piMocks = vi.hoisted(() => {
  const promptResults: Array<{ success: boolean; error?: string }> = [];
  /** gateway 会话替身。记录 stop 调用序列，便于断言释放次序与故障隔离。 */
  class FakePiSession {
    static instances: FakePiSession[] = [];
    /** 全局释放调用序列（跨会话），断言「一个会话炸了其余仍被释放」。 */
    static trace: string[] = [];

    readonly label: string;
    ready = vi.fn(async () => ({ sessionId: "pi-ready", sessionFile: "/tmp/pi.jsonl" }));
    prompt: ReturnType<typeof vi.fn>;
    stop = vi.fn(() => {
      FakePiSession.trace.push(`${this.label}:stop`);
      if (this.stopThrows) throw new Error(`${this.label} stop failed`);
    });
    stopThrows = false;

    constructor(
      private readonly onEvent: (ev: unknown, runId?: string) => void,
      private readonly onUiRequest?: (req: unknown) => void,
    ) {
      this.label = `pi-${FakePiSession.instances.length}`;
      this.prompt = vi.fn(async () => promptResults.shift() ?? { success: true });
      FakePiSession.instances.push(this);
    }

    emit(ev: unknown) {
      this.onEvent(ev, "pi-stage-run");
    }

    ui(req: unknown) {
      this.onUiRequest?.(req);
    }
  }
  return {
    openGatewayMock: vi.fn(),
    preparePiOpenRequestMock: vi.fn(),
    registerTransientPiUiRequestMock: vi.fn(),
    clearTransientPiUiRequestsForSessionMock: vi.fn(),
    promptResults,
    FakePiSession,
  };
});

const {
  openGatewayMock,
  preparePiOpenRequestMock,
  registerTransientPiUiRequestMock,
  clearTransientPiUiRequestsForSessionMock,
  promptResults,
  FakePiSession,
} = piMocks;

/** 全部 gateway 会话（按建立顺序）。 */
const fakePiSessions = FakePiSession.instances;

// gateway 客户端替身：编排对 pi 的唯一构造入口。
vi.mock("../agents/pi-gateway/client", () => ({
  openPiGatewaySession: (...args: unknown[]) => piMocks.openGatewayMock(...args),
}));

vi.mock("./pi-session", () => ({
  preparePiOpenRequest: (...args: unknown[]) => preparePiOpenRequestMock(...args),
  registerTransientPiUiRequest: (...args: unknown[]) => registerTransientPiUiRequestMock(...args),
  clearTransientPiUiRequestsForSession: (...args: unknown[]) => clearTransientPiUiRequestsForSessionMock(...args),
}));

vi.mock("../log", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  isDevEnv: () => true,
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
  FakePiSession.instances.length = 0;
  FakePiSession.trace.length = 0;
  promptResults.length = 0;
  preparePiOpenRequestMock.mockReset();
  registerTransientPiUiRequestMock.mockReset();
  clearTransientPiUiRequestsForSessionMock.mockReset();
  preparePiOpenRequestMock.mockImplementation(async (req: unknown) => req);
  openGatewayMock.mockReset();
  openGatewayMock.mockImplementation(
    async (opts: { onEvent: (ev: unknown, runId?: string) => void; onUiRequest?: (req: unknown) => void }) =>
      new FakePiSession(opts.onEvent, opts.onUiRequest),
  );
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

  it("Pi 三段使用临时 gateway 会话执行并按 stage 转发事件", async () => {
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
    expect(openGatewayMock).toHaveBeenCalledTimes(1);
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
    expect(openGatewayMock).toHaveBeenCalledTimes(3);
    expect(preparePiOpenRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/proj",
        model: "pi-model",
        thinkingLevel: "high",
        toolWhitelist: ["read", "grep"],
      }),
    );
  });

  it("Pi 临时 gateway UI 请求归属真实 chat session 并登记 response 路由", async () => {
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

  it("Pi open 准备期间取消后不再建 gateway 会话", async () => {
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

    expect(openGatewayMock).not.toHaveBeenCalled();
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

// ══ pi gateway：无条件选路、并发隔离与资源释放 ═══════════════════════════════════════
//
// 三段共享常驻 worker,漏释放 = worker 里那份会话（agent loop / MCP 连接 / 挂起对话框）
// 与主进程侧句柄永久驻留，且**没有任何症状**。故释放路径必须逐条断言。

/** 驱动一段 gateway pi：等它建好会话，然后按给定事件收尾。 */
async function driveInProcStage(index: number, events: unknown[]) {
  await flushAsync(20);
  const s = FakePiSession.instances[index];
  expect(s, `第 ${index} 段 gateway 会话应已建立`).toBeDefined();
  for (const ev of events) s!.emit(ev);
  return s!;
}

/** 完整跑通三段编排（每段各发一条 text + result）。 */
async function runThreeInProcStages(handlerP: Promise<void>, texts = ["优化后的提示词", "子执行结果", "最终回答"]) {
  for (let i = 0; i < 3; i++) {
    await driveInProcStage(i, [{ type: "text", delta: texts[i] }, { type: "result", willRetry: false }]);
  }
  await handlerP;
}

function startPiOrchestration(overrides: Record<string, unknown> = {}) {
  const sender = makeSender();
  const handlerP = (ipcHandlers.get("orchestrate:start")!)(makeEvent(sender), {
    ...baseReq,
    agent: "pi",
    piOpen: {},
    ...overrides,
  }) as Promise<void>;
  return { sender, handlerP };
}

describe("引擎收敛：pi 三段无条件走 gateway", () => {
  it("三段全走 openPiGatewaySession，不 spawn 子进程", async () => {
    const { sender, handlerP } = startPiOrchestration();

    await runThreeInProcStages(handlerP);

    expect(openGatewayMock).toHaveBeenCalledTimes(3);
    expect(startAgentProcessMock).not.toHaveBeenCalled();
    // 事件映射/合成终态语义不变
    expect(cliEvents(sender.calls)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", delta: "优化后的提示词", stage: "intent" }),
        expect.objectContaining({ type: "text", delta: "最终回答", stage: "refine" }),
        expect.objectContaining({ type: "result", ok: true, stage: "refine" }),
      ]),
    );
    expect(cliExits(sender.calls)).toHaveLength(1);
  });

  it("gateway 会话拿到 preparePiOpenRequest 产出的 prepared request（共用前置)", async () => {
    const { handlerP } = startPiOrchestration({
      model: "pi-model",
      piOpen: { model: "pi-model", thinkingLevel: "high", toolWhitelist: ["read", "grep"], appendSystemPrompt: "持久人设" },
    });

    await runThreeInProcStages(handlerP);

    const openArgs = openGatewayMock.mock.calls.map((c) => c[0] as { request: Record<string, unknown> });
    expect(openArgs[0]!.request).toMatchObject({ cwd: "/proj", model: "pi-model", thinkingLevel: "high" });
    // 仅段2带持久 appendSystemPrompt —— 编排级规则不随引擎收敛改变
    expect(openArgs[0]!.request.appendSystemPrompt).toBeUndefined();
    expect(openArgs[1]!.request.appendSystemPrompt).toBe("持久人设");
    expect(openArgs[2]!.request.appendSystemPrompt).toBeUndefined();
  });
});

describe("gateway 资源释放（每段收尾恰好一次 stop）", () => {
  it("每段正常收尾 → stop 恰好一次；UI 路由同步摘除（worker 侧 closeSession 自带 abort,主进程不重复）", async () => {
    const { handlerP } = startPiOrchestration();
    await runThreeInProcStages(handlerP);

    expect(FakePiSession.instances).toHaveLength(3);
    for (const s of FakePiSession.instances) {
      expect(s.stop).toHaveBeenCalledTimes(1);
    }
    expect(FakePiSession.trace).toEqual(["pi-0:stop", "pi-1:stop", "pi-2:stop"]);
    expect(clearTransientPiUiRequestsForSessionMock).toHaveBeenCalledTimes(3);
  });

  it("构造期竞态：openPiGatewaySession 未决时取消 → 会话建好后立即被释放，不留无主会话", async () => {
    let finishOpen!: () => void;
    openGatewayMock.mockImplementationOnce(
      (opts: { onEvent: (ev: unknown) => void; onUiRequest?: (r: unknown) => void }) =>
        new Promise((resolve) => {
          finishOpen = () => resolve(new FakePiSession(opts.onEvent, opts.onUiRequest));
        }),
    );

    const { sender, handlerP } = startPiOrchestration();
    await flushAsync(5);
    expect(FakePiSession.instances).toHaveLength(0);

    // 会话仍在构造中就取消整条链路
    (ipcOnHandlers.get("orchestrate:kill")!)({} as unknown, baseReq.orchestrationRunId);
    finishOpen();
    await handlerP;
    await flushAsync(5);

    // 会话最终建好了 —— 它必须被立刻释放，否则再没有任何引用能停它（worker 侧那份资源永久挂着）
    expect(FakePiSession.instances).toHaveLength(1);
    const orphan = FakePiSession.instances[0]!;
    expect(orphan.stop).toHaveBeenCalledTimes(1);
    // 该会话从未被使用：prompt 未发出，也不推终态
    expect(orphan.prompt).not.toHaveBeenCalled();
    expect(cliExits(sender.calls)).toHaveLength(0);
  });

  it("段执行中取消 → 在途会话被 stop，后续段不再建会话", async () => {
    const { sender, handlerP } = startPiOrchestration();

    await driveInProcStage(0, [{ type: "text", delta: "优化" }, { type: "result", willRetry: false }]);
    await flushAsync(20);
    expect(FakePiSession.instances).toHaveLength(2);

    (ipcOnHandlers.get("orchestrate:kill")!)({} as unknown, baseReq.orchestrationRunId);
    await handlerP;

    expect(FakePiSession.instances[1]!.stop).toHaveBeenCalledTimes(1);
    // 段3从未启动
    expect(FakePiSession.instances).toHaveLength(2);
    expect(cliExits(sender.calls)).toHaveLength(0);
  });

  it("会话释放后到达的迟到事件不再转发（stop 后事件流必须彻底静默）", async () => {
    const { sender, handlerP } = startPiOrchestration();
    const s0 = await driveInProcStage(0, [{ type: "text", delta: "优化" }, { type: "result", willRetry: false }]);
    await flushAsync(20);

    const before = cliEvents(sender.calls).length;
    s0.emit({ type: "text", delta: "迟到的尾巴" });
    expect(cliEvents(sender.calls)).toHaveLength(before);

    (ipcOnHandlers.get("orchestrate:kill")!)({} as unknown, baseReq.orchestrationRunId);
    await handlerP;
  });

  it("killAllOrchestrations：一个会话 stop() 抛错，同批其余会话仍被释放", async () => {
    const senderA = makeSender();
    const senderB = makeSender();
    const start = ipcHandlers.get("orchestrate:start")!;
    const pA = start(makeEvent(senderA), { ...baseReq, orchestrationRunId: "orch-A", agent: "pi", piOpen: {} }) as Promise<void>;
    const pB = start(makeEvent(senderB), { ...baseReq, orchestrationRunId: "orch-B", agent: "pi", piOpen: {} }) as Promise<void>;

    await flushAsync(20);
    expect(FakePiSession.instances).toHaveLength(2);
    FakePiSession.instances[0]!.stopThrows = true;

    expect(() => killAllOrchestrations()).not.toThrow();

    // 抛错的那个也被调用过 stop；关键是**后一个没被漏掉**
    expect(FakePiSession.instances[0]!.stop).toHaveBeenCalledTimes(1);
    expect(FakePiSession.instances[1]!.stop).toHaveBeenCalledTimes(1);

    await Promise.all([pA, pB]);
  });
});

describe("并发隔离（一个会话的异常不能拖垮其它会话）", () => {
  it("两条并发链路：A 的会话构造失败，B 仍完整跑完三段并出终态", async () => {
    // 第一次 open（A 的段1）直接抛，其余走默认替身
    openGatewayMock.mockImplementationOnce(async () => {
      throw new Error("provider 初始化失败");
    });

    const senderA = makeSender();
    const senderB = makeSender();
    const start = ipcHandlers.get("orchestrate:start")!;
    const pA = start(makeEvent(senderA), { ...baseReq, orchestrationRunId: "orch-A", agent: "pi", piOpen: {} }) as Promise<void>;
    await flushAsync(20); // 让 A 先吃掉那次失败的 open
    const pB = start(makeEvent(senderB), { ...baseReq, orchestrationRunId: "orch-B", agent: "pi", piOpen: {} }) as Promise<void>;

    // 两条链路的剩余段交错推进：每轮把新建出来、已发过 prompt 且尚未释放的会话统一收尾
    for (let round = 0; round < 10; round++) {
      await flushAsync(10);
      for (const s of FakePiSession.instances) {
        if (s.prompt.mock.calls.length > 0 && s.stop.mock.calls.length === 0) {
          s.emit({ type: "text", delta: "ok" });
          s.emit({ type: "result", willRetry: false });
        }
      }
    }
    await Promise.all([pA, pB]);

    // A 的段1构造失败 → 静默降级（意图段是增强层），链路继续并正常收尾
    expect(cliEvents(senderA.calls).filter((e: any) => e.type === "result" && e.ok)).toHaveLength(1);
    // B 完全不受影响
    expect(cliEvents(senderB.calls).filter((e: any) => e.type === "result" && e.ok)).toHaveLength(1);
    expect(cliExits(senderB.calls)).toHaveLength(1);
  });

  it("provider 静默失败（KTD5：只有 error 事件、不抛异常）→ 该段降级，链路继续到段3", async () => {
    const { sender, handlerP } = startPiOrchestration();

    await driveInProcStage(0, [{ type: "text", delta: "优化后的提示词" }, { type: "result", willRetry: false }]);
    // 段2：模型/provider 失败只体现为事件流里的 error，没有退出码可依赖
    await driveInProcStage(1, [{ type: "text", delta: "部分输出" }, { type: "error", error: "provider 不可用" }]);
    const s2 = await driveInProcStage(2, []);

    // 段3 prompt 应带上段2的部分输出与错误信息（KTD7-2 降级）
    const refinePrompt = s2.prompt.mock.calls[0]?.[0] as string;
    expect(refinePrompt).toContain("部分输出");
    expect(refinePrompt).toContain("provider 不可用");

    s2.emit({ type: "text", delta: "最终回答" });
    s2.emit({ type: "result", willRetry: false });
    await handlerP;

    expect(cliEvents(sender.calls).filter((e: any) => e.type === "result")).toHaveLength(1);
    // 失败段同样被完整释放
    expect(FakePiSession.instances[1]!.stop).toHaveBeenCalledTimes(1);
  });

  it("prompt 受理即失败（success:false）→ 该段立即失败并释放，不等 30min 超时", async () => {
    promptResults.push({ success: false, error: "prompt rejected" });
    const { handlerP } = startPiOrchestration();

    await flushAsync(20);
    // 段1 立刻失败 → 已进段2
    expect(FakePiSession.instances).toHaveLength(2);
    expect(FakePiSession.instances[0]!.stop).toHaveBeenCalledTimes(1);

    await driveInProcStage(1, [{ type: "text", delta: "子执行结果" }, { type: "result", willRetry: false }]);
    await driveInProcStage(2, [{ type: "text", delta: "最终回答" }, { type: "result", willRetry: false }]);
    await handlerP;
  });

  it("prompt 的 Promise reject（fire-and-forget 之后没人接）→ 转成段失败，不挂起、不 unhandledRejection", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      openGatewayMock.mockImplementationOnce(
        async (opts: { onEvent: (ev: unknown) => void; onUiRequest?: (r: unknown) => void }) => {
          const s = new FakePiSession(opts.onEvent, opts.onUiRequest);
          s.prompt = vi.fn(async () => {
            throw new Error("轮次在受理后炸了");
          });
          return s;
        },
      );

      const { handlerP } = startPiOrchestration();
      await flushAsync(20);
      // 段1 已失败并释放，链路已进段2
      expect(FakePiSession.instances[0]!.stop).toHaveBeenCalledTimes(1);
      expect(FakePiSession.instances).toHaveLength(2);

      await driveInProcStage(1, [{ type: "text", delta: "子执行结果" }, { type: "result", willRetry: false }]);
      await driveInProcStage(2, [{ type: "text", delta: "最终回答" }, { type: "result", willRetry: false }]);
      await handlerP;

      await flushAsync(3);
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("gateway 的 UI 请求同样归属真实 chat session 并登记 response 路由", async () => {
    const { sender, handlerP } = startPiOrchestration();

    await driveInProcStage(0, [{ type: "text", delta: "优化" }, { type: "result", willRetry: false }]);
    const s1 = await driveInProcStage(1, []);
    const uiReq = { type: "extension_ui_request", id: "confirm-1", method: "confirm", title: "T", message: "M" };
    s1.ui(uiReq);
    s1.emit({ type: "text", delta: "子执行结果" });
    s1.emit({ type: "result", willRetry: false });
    await driveInProcStage(2, [{ type: "text", delta: "最终回答" }, { type: "result", willRetry: false }]);
    await handlerP;

    expect(sender.calls).toContainEqual({
      channel: "pi:uiRequest",
      payload: { uiSessionId: baseReq.sessionId, request: uiReq },
    });
    expect(registerTransientPiUiRequestMock).toHaveBeenCalledWith(baseReq.sessionId, "confirm-1", s1);
    expect(clearTransientPiUiRequestsForSessionMock).toHaveBeenCalledWith(s1);
  });
});
