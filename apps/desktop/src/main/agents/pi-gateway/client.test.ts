// gateway 客户端单测。用假承载（不真起进程）覆盖六类：
//   1. `PiSessionEngine` 19 个方法的转发（含协议 `ENGINE_METHODS` 的逐项对账与 sessionId 归属）；
//   2. 应答归一化与失败语义（命令级 success:false vs 传输级 reject）；
//   3. 反向调用——UI 请求（含 id 映射、无出口自动 cancel）与凭据（含解密失败）；
//   4. worker 退出 → `crashed` 扇出到**每个**活跃会话（R5），以及主动 stop 之后**不得**上报 crashed；
//   5. 会话 `stop()` = closeSession（进程不退）与进程级 `shutdownPiGatewayRuntime()` 的两段式 kill；
//   6. 常驻 runtime 生命周期：多会话复用单 worker、崩溃后懒重启、预热幂等。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const logMocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() },
}));
vi.mock("../../log", () => ({ createLogger: () => logMocks.logger, isDevEnv: () => true }));
vi.mock("electron", () => ({ app: {} }));
vi.mock("../../ipc/agent-trace", () => ({ recordAgentTrace: vi.fn(), recordStreamDelta: vi.fn() }));

// 金库替身：`accessGatewayCredential` 是懒加载 import，故这里 mock 的是模块而不是注入点。
const vaultMocks = vi.hoisted(() => ({
  readStoredCredential: vi.fn(),
  listStoredCredentialMetas: vi.fn(),
  modifyStoredCredential: vi.fn(),
  deleteStoredCredential: vi.fn(),
  readSecrets: vi.fn(),
}));
vi.mock("../../providers/credentials", () => vaultMocks);

import {
  __resetPiGatewayRuntimeForTests,
  accessGatewayCredential,
  openPiGatewaySession,
  primePiGatewayRuntime,
  shutdownPiGatewayRuntime,
  type PiGatewaySession,
} from "./client";
import { FakePiGatewayTransport } from "./fake-transport";
import { ENGINE_METHODS, type HostCall, type HostUiResponse, type WorkerCredentialRequest } from "./protocol";
import type { PiOpenRequest, PiSessionEvent, PiUiRequest } from "../../ipc/types";

// ── 夹具 ────────────────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<PiOpenRequest> = {}): PiOpenRequest {
  return { uiSessionId: "ui-1", cwd: "/work", ...overrides } as PiOpenRequest;
}

/**
 * 排空微任务队列。常驻 runtime 下 `openPiGatewaySession` 要过「ensureRuntime → 会话 open 写出」
 * 若干跳微任务（单个 `await Promise.resolve()` 不够），统一用这个多轮排空。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** 排空定时器一跳。凭据反向调用要过「读金库 → 写应答」两跳异步，微任务排空不够。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 一套 runtime 级夹具：transport 工厂 + 凭据替身。
 * runtime 级 deps 只在「创建单例那一次」生效，所以同一用例内的多次 open 必须复用同一个 rig。
 */
interface Rig {
  forks: FakePiGatewayTransport[];
  createTransport: Mock<() => FakePiGatewayTransport>;
  credentialCalls: string[];
  deps: {
    createTransport: () => FakePiGatewayTransport;
    readCredential: (req: WorkerCredentialRequest) => Promise<string | null>;
    killDelayMs?: number;
  };
  /** 当前 runtime 的承载（最近一次 fork 出来的假 transport）。 */
  readonly transport: FakePiGatewayTransport;
}

function makeRig(options: { readCredential?: (key: string) => Promise<string | null>; killDelayMs?: number } = {}): Rig {
  const forks: FakePiGatewayTransport[] = [];
  const createTransport = vi.fn(() => {
    const transport = new FakePiGatewayTransport();
    forks.push(transport);
    return transport;
  });
  const credentialCalls: string[] = [];
  return {
    forks,
    createTransport,
    credentialCalls,
    deps: {
      createTransport,
      readCredential: async (req) => {
        credentialCalls.push(req.key);
        return options.readCredential ? options.readCredential(req.key) : `secret-of-${req.key}`;
      },
      ...(options.killDelayMs === undefined ? {} : { killDelayMs: options.killDelayMs }),
    },
    get transport() {
      return forks.at(-1)!;
    },
  };
}

interface OpenedSession {
  session: PiGatewaySession;
  events: Array<{ ev: PiSessionEvent; runId?: string }>;
  uiRequests: PiUiRequest[];
}

/** 在指定 rig 上开一个会话（open 的应答由本函数即时回掉），返回该会话专属的事件/UI 收集器。 */
async function openOn(
  rig: Rig,
  options: { onUiRequest?: boolean; onDispose?: () => void; request?: Partial<PiOpenRequest> } = {},
): Promise<OpenedSession> {
  const events: Array<{ ev: PiSessionEvent; runId?: string }> = [];
  const uiRequests: PiUiRequest[] = [];
  const pending = openPiGatewaySession({
    request: makeRequest(options.request ?? {}),
    onEvent: (ev, runId) => events.push({ ev, ...(runId === undefined ? {} : { runId }) }),
    ...(options.onUiRequest === false ? {} : { onUiRequest: (req: PiUiRequest) => uiRequests.push(req) }),
    deps: {
      ...rig.deps,
      ...(options.onDispose ? { onDispose: options.onDispose } : {}),
    },
  });
  await settle();
  rig.transport.replyOk();
  const session = await pending;
  return { session, events, uiRequests };
}

interface Harness extends OpenedSession {
  rig: Rig;
  transport: FakePiGatewayTransport;
  credentialCalls: string[];
}

/** 单会话便捷入口（旧用例形态）：建 rig + 开一个会话。 */
async function open(
  options: {
    onUiRequest?: boolean;
    readCredential?: (key: string) => Promise<string | null>;
    onDispose?: () => void;
    killDelayMs?: number;
  } = {},
): Promise<Harness> {
  const rig = makeRig(options);
  const opened = await openOn(rig, options);
  return { rig, transport: rig.transport, credentialCalls: rig.credentialCalls, ...opened };
}

beforeEach(() => {
  // 先复位单例（关掉上个用例的 runtime），再清 mock——顺序反了会把复位期间的日志断言弄脏。
  vi.useRealTimers();
  __resetPiGatewayRuntimeForTests();
  vi.clearAllMocks();
});

// ── 1. 方法转发 ─────────────────────────────────────────────────────────────────────

describe("PiSessionEngine 方法转发", () => {
  it("open 写出带 sessionId 的 HostOpen，带上已 prepare 的 request 与 hasUiOutlet", async () => {
    const { transport, session } = await open();
    const msg = transport.firstOf("open");
    expect(msg?.kind).toBe("open");
    expect(msg?.sessionId).toBe(session.sessionId);
    expect((msg?.request as PiOpenRequest).uiSessionId).toBe("ui-1");
    expect(msg?.hasUiOutlet).toBe(true);
  });

  it("ask 审批字段经 HostOpen JSON 原样交给 worker", async () => {
    const rig = makeRig();
    await openOn(rig, {
      request: {
        enableToolApproval: true,
        approvalTools: ["bash", "write", "edit"],
      },
    });

    expect(rig.transport.firstOf("open")?.request).toMatchObject({
      enableToolApproval: true,
      approvalTools: ["bash", "write", "edit"],
    });
  });

  it("无 onUiRequest 时 hasUiOutlet=false（决定 worker 侧审批 hook 的无 UI 语义）", async () => {
    const { transport } = await open({ onUiRequest: false });
    expect(transport.firstOf("open")?.hasUiOutlet).toBe(false);
  });

  // 逐条对账：协议侧 ENGINE_METHODS 的每个方法名都得能在客户端上调起来，
  // 并且真的写出一条 method 相符、sessionId 归属正确的 HostCall。漏一个的表现是「某命令静默失效」。
  const invocations: Record<(typeof ENGINE_METHODS)[number], [(s: PiGatewaySession) => Promise<unknown>, unknown[]]> =
    {
      ready: [(s) => s.ready(), []],
      loadSlashCommands: [(s) => s.loadSlashCommands(), []],
      prompt: [(s) => s.prompt("hi", "run-1"), ["hi", "run-1"]],
      steer: [(s) => s.steer("turn left"), ["turn left"]],
      followUp: [(s) => s.followUp("more"), ["more"]],
      abort: [(s) => s.abort(), []],
      fork: [(s) => s.fork("entry-9"), ["entry-9"]],
      getForkMessages: [(s) => s.getForkMessages(), []],
      setModel: [(s) => s.setModel("anthropic", "claude"), ["anthropic", "claude"]],
      setThinkingLevel: [(s) => s.setThinkingLevel("high"), ["high"]],
      compact: [(s) => s.compact("keep todos"), ["keep todos"]],
      getState: [(s) => s.getState(), []],
      getSessionStats: [(s) => s.getSessionStats(), []],
      newSession: [(s) => s.newSession("parent.jsonl"), ["parent.jsonl"]],
      switchSession: [(s) => s.switchSession("/p/s.jsonl"), ["/p/s.jsonl"]],
      getLastAssistantText: [(s) => s.getLastAssistantText(), []],
      getCommands: [(s) => s.getCommands(), []],
    };

  it.each(ENGINE_METHODS)("%s 转成一条 HostCall", async (method) => {
    const { transport, session } = await open();
    const [invoke, expectedArgs] = invocations[method];
    const pending = invoke(session);
    await settle();

    const call = transport.last() as HostCall;
    expect(call.kind).toBe("call");
    expect(call.method).toBe(method);
    expect(call.sessionId).toBe(session.sessionId);
    expect(call.args).toEqual(expectedArgs);

    // ready 需要一个合法结果，其余任意；回掉以免用例留下未处理 Promise。
    transport.replyOk(method === "ready" ? { sessionId: "s-1" } : { type: "response", command: method, success: true });
    await pending;
  });

  it("ENGINE_METHODS 与本用例表逐项对齐（协议增删方法时这里必须同步）", () => {
    expect(Object.keys(invocations).sort()).toEqual([...ENGINE_METHODS].sort());
  });

  it("stop 与 respondUi 不走 call 通道（stop 走 closeSession，respondUi 走 uiResponse）", async () => {
    const { transport, session } = await open();
    session.respondUi("pi-id", { confirmed: true });
    session.stop();
    expect(transport.sent().some((m) => m.kind === "call")).toBe(false);
    expect(transport.sent().map((m) => m.kind)).toEqual(["open", "uiResponse", "closeSession"]);
  });

  it("裁掉尾部 undefined 参数（否则 JSON 往返会把它变成 null，worker 侧判定走错分支）", async () => {
    const { transport, session } = await open();
    const pending = session.prompt("only message");
    await settle();
    expect((transport.last() as HostCall).args).toEqual(["only message"]);
    // 回掉应答：不回的话这条在途 RPC 会在下个用例的 runtime 复位时被 reject 成无主 rejection。
    transport.replyOk({ type: "response", command: "prompt", success: true });
    await pending;
  });
});

// ── 2. 应答语义 ─────────────────────────────────────────────────────────────────────

describe("应答归一化与失败语义", () => {
  it("worker 回 RpcResponse 时原样透出（含命令级 success:false）", async () => {
    const { transport, session } = await open();
    const pending = session.getState();
    await settle();
    transport.replyOk({ type: "response", command: "get_state", success: false, error: "boom" });
    await expect(pending).resolves.toEqual({
      type: "response",
      command: "get_state",
      success: false,
      error: "boom",
    });
  });

  it("worker 只回裸 data 时帮它裹一层 RpcResponse", async () => {
    const { transport, session } = await open();
    const pending = session.getCommands();
    await settle();
    transport.replyOk({ commands: [] });
    await expect(pending).resolves.toEqual({
      type: "response",
      command: "getCommands",
      success: true,
      data: { commands: [] },
    });
  });

  it("reply.ok=false（worker 转发层失败）转成 rejection，与 binary 路径同义", async () => {
    const { transport, session } = await open();
    const pending = session.abort();
    await settle();
    transport.replyErr("会话未建立");
    await expect(pending).rejects.toThrow("会话未建立");
  });

  it("命令超时 reject 且不留下 pending（否则渲染端 invoke 永久挂起）", async () => {
    vi.useFakeTimers();
    const { session } = await open();
    const pending = session.getState();
    await settle();
    vi.advanceTimersByTime(30_000);
    await expect(pending).rejects.toThrow("pi 命令超时: getState");
    expect(session.pendingCount).toBe(0);
    vi.useRealTimers();
  });

  it("迟到的 reply（id 已被超时清掉）不会串到别的命令", async () => {
    vi.useFakeTimers();
    const { transport, session } = await open();
    const first = session.getState();
    await settle();
    vi.advanceTimersByTime(30_000);
    await expect(first).rejects.toThrow();
    vi.useRealTimers();

    const second = session.getSessionStats();
    await settle();
    // 回一条 id 属于第一次调用的应答：必须被忽略，第二次调用仍在途。
    transport.emit({ id: "pg_2", kind: "reply", ok: true, result: { stale: true } });
    expect(session.pendingCount).toBe(1);
    transport.replyOk({ fresh: true });
    await expect(second).resolves.toMatchObject({ data: { fresh: true } });
  });

  it("ready 缺 sessionId 时响亮失败（会话不可用必须让 pi:open 抛出去）", async () => {
    const { transport, session } = await open();
    const pending = session.ready();
    await settle();
    transport.replyOk({});
    await expect(pending).rejects.toThrow("缺少 sessionId");
  });

  it("ready 成功时透出 sessionId 与 sessionFile", async () => {
    const { transport, session } = await open();
    const pending = session.ready();
    await settle();
    transport.replyOk({ sessionId: "s-7", sessionFile: "/p/s.jsonl" });
    await expect(pending).resolves.toEqual({ sessionId: "s-7", sessionFile: "/p/s.jsonl" });
  });

  it("loadSlashCommands 失败静默降级（只影响补发判定精度，不得阻断会话）", async () => {
    const { transport, session } = await open();
    const pending = session.loadSlashCommands();
    await settle();
    transport.replyErr("no commands");
    await expect(pending).resolves.toBeUndefined();
  });

  it("坏 JSON 行只丢弃、不中断通道", async () => {
    const { transport, session } = await open();
    transport.emit("{ not json");
    const pending = session.abort();
    await settle();
    transport.replyOk({ type: "response", command: "abort", success: true });
    await expect(pending).resolves.toMatchObject({ success: true });
  });
});

// ── 3. 事件与反向调用 ───────────────────────────────────────────────────────────────

describe("事件流", () => {
  it("WorkerEvent 按 sessionId 路由到 onEvent（runId 一并带过去）", async () => {
    const { transport, session, events } = await open();
    transport.emit({ kind: "event", sessionId: session.sessionId, event: { type: "text", delta: "hi" }, runId: "run-3" });
    expect(events).toEqual([{ ev: { type: "text", delta: "hi" }, runId: "run-3" }]);
  });

  it("无主 sessionId 的事件被丢弃（不砸进任何会话）", async () => {
    const { transport, events } = await open();
    transport.emit({ kind: "event", sessionId: "sess_404", event: { type: "settled" } });
    expect(events).toEqual([]);
  });

  it("onEvent 抛错被吞掉，通道继续可用（抛出去会让 runtime 上全部会话的事件一起消失）", async () => {
    const rig = makeRig();
    let calls = 0;
    const pending = openPiGatewaySession({
      request: makeRequest(),
      onEvent: () => {
        calls += 1;
        throw new Error("renderer gone");
      },
      deps: rig.deps,
    });
    await settle();
    rig.transport.replyOk();
    const session = await pending;

    rig.transport.emit({ kind: "event", sessionId: session.sessionId, event: { type: "settled" } });
    rig.transport.emit({ kind: "event", sessionId: session.sessionId, event: { type: "settled" } });
    expect(calls).toBe(2);
    expect(session.pendingCount).toBe(0);
  });

  it("worker 日志转发到主进程 logger", async () => {
    const { transport } = await open();
    transport.emit({ kind: "log", level: "warn", message: "mcp 连接失败" });
    expect(logMocks.logger.warn).toHaveBeenCalledWith("[pi-host] mcp 连接失败");
  });
});

describe("反向调用：UI 请求", () => {
  const uiRequest: PiUiRequest = {
    type: "extension_ui_request",
    id: "pi-uuid-1",
    method: "confirm",
    title: "执行 bash?",
    message: "rm -rf /tmp/x",
  };

  it("uiRequest 转给 onUiRequest；回写按 pi 的 id 找回协议 requestId 并带 sessionId", async () => {
    const { transport, session, uiRequests } = await open();
    transport.emit({ kind: "uiRequest", sessionId: session.sessionId, requestId: "rq-42", request: uiRequest });
    expect(uiRequests).toEqual([uiRequest]);

    // 渲染端只知道 pi 的 id（pi-uuid-1），主进程必须把它翻回 rq-42。
    session.respondUi("pi-uuid-1", { confirmed: true });
    const resp = transport.last() as HostUiResponse;
    expect(resp.kind).toBe("uiResponse");
    expect(resp.sessionId).toBe(session.sessionId);
    expect(resp.requestId).toBe("rq-42");
    expect(resp.payload).toEqual({ confirmed: true });
  });

  it("open 应答前暴露已登记 handle，startup UI 可在建会话期间完成回写", async () => {
    const rig = makeRig();
    let openingSession: PiGatewaySession | undefined;
    const uiRequests: PiUiRequest[] = [];
    const pending = openPiGatewaySession({
      request: makeRequest(),
      onEvent: () => {},
      onSessionCreated: (session) => {
        openingSession = session;
      },
      onUiRequest: (request) => uiRequests.push(request),
      deps: rig.deps,
    });
    await settle();
    expect(openingSession).toBeDefined();
    expect(rig.transport.firstOf("open")).toBeDefined();

    rig.transport.emit({
      kind: "uiRequest",
      sessionId: openingSession!.sessionId,
      requestId: "startup-rq",
      request: uiRequest,
    });
    expect(uiRequests).toEqual([uiRequest]);
    openingSession!.respondUi(uiRequest.id, { confirmed: false });
    expect(rig.transport.last()).toMatchObject({
      kind: "uiResponse",
      sessionId: openingSession!.sessionId,
      requestId: "startup-rq",
      payload: { confirmed: false },
    });

    rig.transport.replyOk();
    await expect(pending).resolves.toBe(openingSession);
  });

  it("无 UI 出口时立即回 cancelled（不回的话 worker 的工具执行栈永久冻住）", async () => {
    const { transport, session } = await open({ onUiRequest: false });
    transport.emit({ kind: "uiRequest", sessionId: session.sessionId, requestId: "rq-1", request: uiRequest });
    expect(transport.last()).toEqual({
      id: expect.any(String),
      kind: "uiResponse",
      sessionId: session.sessionId,
      requestId: "rq-1",
      payload: { cancelled: true },
    });
  });

  it("目标会话已不存在的 uiRequest 也回 cancelled（会话关了不能让 worker 挂死）", async () => {
    const { transport } = await open();
    transport.emit({ kind: "uiRequest", sessionId: "sess_404", requestId: "rq-9", request: uiRequest });
    expect(transport.last()).toMatchObject({
      kind: "uiResponse",
      sessionId: "sess_404",
      requestId: "rq-9",
      payload: { cancelled: true },
    });
  });

  it("onUiRequest 抛错时同样兜底回 cancelled", async () => {
    const rig = makeRig();
    const pending = openPiGatewaySession({
      request: makeRequest(),
      onEvent: () => {},
      onUiRequest: () => {
        throw new Error("sender destroyed");
      },
      deps: rig.deps,
    });
    await settle();
    rig.transport.replyOk();
    const session = await pending;

    rig.transport.emit({ kind: "uiRequest", sessionId: session.sessionId, requestId: "rq-9", request: uiRequest });
    expect((rig.transport.last() as HostUiResponse).payload).toEqual({ cancelled: true });
  });

  it("停止后的 respondUi 静默丢弃", async () => {
    const { transport, session } = await open();
    session.stop();
    const before = transport.writes.length;
    session.respondUi("pi-uuid-1", { cancelled: true });
    expect(transport.writes.length).toBe(before);
  });
});

describe("反向调用：凭据（KTD1）", () => {
  it("credentialRequest → 主进程解密 → credentialResponse（全局路由，不带 sessionId）", async () => {
    const { transport, credentialCalls } = await open();
    transport.emit({ kind: "credentialRequest", requestId: "cr-1", key: "provider:anthropic" });
    await flush();
    expect(credentialCalls).toEqual(["provider:anthropic"]);
    expect(transport.last()).toEqual({
      id: expect.any(String),
      kind: "credentialResponse",
      requestId: "cr-1",
      value: "secret-of-provider:anthropic",
    });
  });

  it("未配置返回 null（而非空串——空串是合法凭据值）", async () => {
    const { transport } = await open({ readCredential: async () => null });
    transport.emit({ kind: "credentialRequest", requestId: "cr-2", key: "provider:none" });
    await flush();
    expect(transport.last()).toMatchObject({ requestId: "cr-2", value: null });
  });

  it("解密失败回 value:null + error，而不是让整个 runtime 崩掉", async () => {
    const { transport } = await open({
      readCredential: async () => {
        throw new Error("keychain locked");
      },
    });
    transport.emit({ kind: "credentialRequest", requestId: "cr-3", key: "provider:x" });
    await flush();
    expect(transport.last()).toMatchObject({ requestId: "cr-3", value: null, error: "keychain locked" });
  });
});

// ── 4. 崩溃上报（R5）───────────────────────────────────────────────────────────────

describe("worker 退出", () => {
  it("非主动退出上报 crashed，并把 stderr 尾环拼进原因", async () => {
    const { transport, events } = await open();
    transport.emitExit(1, "ERR_MODULE_NOT_FOUND: pi-agent-core");
    expect(events.at(-1)?.ev).toEqual({
      type: "crashed",
      error: "退出码 1: ERR_MODULE_NOT_FOUND: pi-agent-core",
    });
  });

  it("code=0 且有 stderr 也算崩溃（KTD2/KTD3 的失败正是这个形态）", async () => {
    const { transport, events } = await open();
    transport.emitExit(0, "cannot find module");
    expect(events.at(-1)?.ev).toEqual({ type: "crashed", error: "退出码 0: cannot find module" });
  });

  it("退出时了结全部在途 RPC（否则上层重开会话后旧 pending 泄漏）", async () => {
    const { transport, session } = await open();
    const pending = session.getState();
    await settle();
    transport.emitExit(1, "boom");
    await expect(pending).rejects.toThrow("退出码 1: boom");
    expect(session.pendingCount).toBe(0);
  });

  it("exit 与 error 先后到达时 crashed 只报一次", async () => {
    const { transport, events } = await open();
    transport.emitExit(1, "boom");
    transport.emitError(new Error("pipe broken"));
    expect(events.filter((e) => e.ev.type === "crashed")).toHaveLength(1);
  });

  it("退出后的残余消息一律丢弃（避免串到懒重启后的新会话）", async () => {
    const { transport, session, events } = await open();
    transport.emitExit(1);
    const crashedCount = events.length;
    transport.emit({ kind: "event", sessionId: session.sessionId, event: { type: "text", delta: "late" } });
    expect(events.length).toBe(crashedCount);
  });

  it("崩溃后再发命令直接 reject（不静默挂起）", async () => {
    const { transport, session } = await open();
    transport.emitExit(1, "boom");
    await expect(session.getState()).rejects.toThrow("退出码 1: boom");
  });
});

// ── 5. 会话 stop（closeSession）与进程级 shutdown ────────────────────────────────────

describe("stop = closeSession（进程不退）", () => {
  it("stop 发 closeSession，不杀进程、不发进程级 shutdown", async () => {
    const { transport, session } = await open();
    session.stop();
    expect(transport.last()).toMatchObject({ kind: "closeSession", sessionId: session.sessionId });
    expect(transport.sent().some((m) => m.kind === "shutdown")).toBe(false);
    expect(transport.killed).toBe(0);
  });

  it("stop 后主动停止的退出不上报 crashed，且在途 RPC 被了结", async () => {
    const { transport, session, events } = await open();
    const pending = session.getState();
    await settle();
    session.stop();
    await expect(pending).rejects.toThrow("pi 会话已停止退出");
    transport.emitExit(0);
    expect(events.some((e) => e.ev.type === "crashed")).toBe(false);
  });

  it("stop 幂等：重复调用只写一条 closeSession", async () => {
    const { transport, session } = await open();
    session.stop();
    session.stop();
    expect(transport.sent().filter((m) => m.kind === "closeSession")).toHaveLength(1);
  });

  it("stop 调用注入的 onDispose（外部资源释放的唯一收口）", async () => {
    let disposed = 0;
    const { session } = await open({ onDispose: () => void (disposed += 1) });
    session.stop();
    await settle();
    expect(disposed).toBe(1);
  });

  it("管道已断时 stop 不抛（写 closeSession 失败是正常竞态）", async () => {
    const { transport, session } = await open();
    transport.writeThrows = true;
    expect(() => session.stop()).not.toThrow();
  });

  it("停止后再发命令直接 reject，不静默挂起", async () => {
    const { session } = await open();
    session.stop();
    await expect(session.getState()).rejects.toThrow("pi 会话已停止退出");
  });
});

describe("shutdownPiGatewayRuntime（进程级）", () => {
  it("发 shutdown + 优雅 kill，宽限期后强杀", async () => {
    vi.useFakeTimers();
    const { transport } = await open({ killDelayMs: 3_000 });
    shutdownPiGatewayRuntime();
    expect(transport.last()?.kind).toBe("shutdown");
    expect(transport.killed).toBe(1);
    expect(transport.forceKilled).toBe(0);
    vi.advanceTimersByTime(3_000);
    expect(transport.forceKilled).toBe(1);
    vi.useRealTimers();
  });

  it("worker 在宽限期内自己退出则不再强杀，且不上报 crashed（主动关闭不是崩溃）", async () => {
    vi.useFakeTimers();
    const { transport, events } = await open({ killDelayMs: 3_000 });
    shutdownPiGatewayRuntime();
    transport.emitExit(0);
    vi.advanceTimersByTime(10_000);
    expect(transport.forceKilled).toBe(0);
    expect(events.some((e) => e.ev.type === "crashed")).toBe(false);
    vi.useRealTimers();
  });

  it("shutdown 后会话命令快速失败；再 open 会重新 fork（单例已清）", async () => {
    const rig = makeRig();
    const { session } = await openOn(rig);
    shutdownPiGatewayRuntime();
    await expect(session.getState()).rejects.toThrow("pi gateway runtime 已关闭");

    const reopened = await openOn(rig);
    expect(rig.createTransport).toHaveBeenCalledTimes(2);
    expect(reopened.session.sessionId).toBeTruthy();
  });
});

// ── 6. 常驻 runtime：多会话复用 / 崩溃扇出 / 懒重启 / 预热 ───────────────────────────

describe("常驻 runtime 多会话", () => {
  it("两个会话复用同一个 worker（只 fork 一次），sessionId 互不相同", async () => {
    const rig = makeRig();
    const a = await openOn(rig);
    const b = await openOn(rig);
    expect(rig.createTransport).toHaveBeenCalledTimes(1);
    expect(rig.forks).toHaveLength(1);
    expect(a.session.sessionId).not.toBe(b.session.sessionId);
    const opens = rig.transport.sent().filter((m) => m.kind === "open");
    expect(opens.map((m) => (m as { sessionId: string }).sessionId)).toEqual([
      a.session.sessionId,
      b.session.sessionId,
    ]);
  });

  it("命令各带各的 sessionId；事件按 sessionId 各回各家", async () => {
    const rig = makeRig();
    const a = await openOn(rig);
    const b = await openOn(rig);

    const pending = b.session.getState();
    await settle();
    expect(rig.transport.last() as HostCall).toMatchObject({ kind: "call", sessionId: b.session.sessionId });
    rig.transport.replyOk({ type: "response", command: "get_state", success: true });
    await pending;

    rig.transport.emit({ kind: "event", sessionId: a.session.sessionId, event: { type: "text", delta: "A" } });
    rig.transport.emit({ kind: "event", sessionId: b.session.sessionId, event: { type: "text", delta: "B" } });
    expect(a.events).toEqual([{ ev: { type: "text", delta: "A" } }]);
    expect(b.events).toEqual([{ ev: { type: "text", delta: "B" } }]);
  });

  it("UI 请求与回写按会话隔离：A 的回写绝不落到 B", async () => {
    const rig = makeRig();
    const a = await openOn(rig);
    const b = await openOn(rig);
    const request = (id: string): PiUiRequest => ({
      type: "extension_ui_request",
      id,
      method: "confirm",
      title: "t",
      message: "m",
    });

    rig.transport.emit({ kind: "uiRequest", sessionId: a.session.sessionId, requestId: "rq-a", request: request("pi-a") });
    rig.transport.emit({ kind: "uiRequest", sessionId: b.session.sessionId, requestId: "rq-b", request: request("pi-b") });
    expect(a.uiRequests.map((r) => r.id)).toEqual(["pi-a"]);
    expect(b.uiRequests.map((r) => r.id)).toEqual(["pi-b"]);

    // A 用 B 的 pi id 回写：A 自己的映射表里没有它，只会按原 id 兜底、且 sessionId 仍是 A 的——
    // worker 侧按 sessionId 路由，B 的挂起请求不可能被它结算。
    a.session.respondUi("pi-a", { confirmed: true });
    const resp = rig.transport.last() as HostUiResponse;
    expect(resp).toMatchObject({ sessionId: a.session.sessionId, requestId: "rq-a", payload: { confirmed: true } });
  });

  it("closeSession 只清目标会话：另一个照常收发，关掉那个的残余事件被丢弃", async () => {
    const rig = makeRig();
    const a = await openOn(rig);
    const b = await openOn(rig);

    a.session.stop();
    expect(rig.transport.last()).toMatchObject({ kind: "closeSession", sessionId: a.session.sessionId });

    // A 的残余事件不再进 onEvent；B 的事件照常。
    rig.transport.emit({ kind: "event", sessionId: a.session.sessionId, event: { type: "settled" } });
    rig.transport.emit({ kind: "event", sessionId: b.session.sessionId, event: { type: "settled" } });
    expect(a.events).toEqual([]);
    expect(b.events).toEqual([{ ev: { type: "settled" } }]);

    // B 的命令照常成功。
    const pending = b.session.getState();
    await settle();
    rig.transport.replyOk({ type: "response", command: "get_state", success: true });
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it("stop 只了结本会话的在途 RPC，不动别的会话", async () => {
    const rig = makeRig();
    const a = await openOn(rig);
    const b = await openOn(rig);
    const aPending = a.session.getState();
    const bPending = b.session.getSessionStats();
    await settle();

    a.session.stop();
    await expect(aPending).rejects.toThrow("pi 会话已停止退出");
    expect(b.session.pendingCount).toBe(1);
    rig.transport.replyOk({ type: "response", command: "get_session_stats", success: true });
    await expect(bPending).resolves.toMatchObject({ success: true });
  });

  it("崩溃扇出：worker 死 → 两个会话都收到 crashed、pending 全 reject", async () => {
    const rig = makeRig();
    const a = await openOn(rig);
    const b = await openOn(rig);
    const aPending = a.session.getState();
    const bPending = b.session.getState();
    await settle();

    rig.transport.emitExit(1, "segfault");
    await expect(aPending).rejects.toThrow("退出码 1: segfault");
    await expect(bPending).rejects.toThrow("退出码 1: segfault");
    expect(a.events.at(-1)?.ev).toEqual({ type: "crashed", error: "退出码 1: segfault" });
    expect(b.events.at(-1)?.ev).toEqual({ type: "crashed", error: "退出码 1: segfault" });
  });

  it("崩溃前已 stop 的会话不参与扇出（主动停不是崩溃）", async () => {
    const rig = makeRig();
    const a = await openOn(rig);
    const b = await openOn(rig);
    a.session.stop();
    rig.transport.emitExit(1, "boom");
    expect(a.events.some((e) => e.ev.type === "crashed")).toBe(false);
    expect(b.events.some((e) => e.ev.type === "crashed")).toBe(true);
  });

  it("懒重启：崩溃后不自动重拉，下次 open 才重新 fork", async () => {
    const rig = makeRig();
    await openOn(rig);
    rig.transport.emitExit(1, "boom");
    // 崩溃本身不触发新 fork（防崩溃循环）。
    expect(rig.createTransport).toHaveBeenCalledTimes(1);

    const reopened = await openOn(rig);
    expect(rig.createTransport).toHaveBeenCalledTimes(2);
    expect(rig.forks).toHaveLength(2);
    // 新会话跑在新 transport 上，且功能正常。
    const pending = reopened.session.getState();
    await settle();
    rig.transport.replyOk({ type: "response", command: "get_state", success: true });
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it("预热幂等：primePiGatewayRuntime 连调两次只 fork 一次，随后 open 复用同一 runtime", async () => {
    const rig = makeRig();
    primePiGatewayRuntime(rig.deps);
    primePiGatewayRuntime(rig.deps);
    await settle();
    expect(rig.createTransport).toHaveBeenCalledTimes(1);

    const opened = await openOn(rig);
    expect(rig.createTransport).toHaveBeenCalledTimes(1);
    expect(opened.session.sessionId).toBeTruthy();
  });
});

// ── 构造入口 ────────────────────────────────────────────────────────────────────────

describe("openPiGatewaySession", () => {
  it("open 失败时只关本会话（closeSession）、不杀常驻进程，且不上报 crashed", async () => {
    const rig = makeRig();
    const events: PiSessionEvent[] = [];
    const pending = openPiGatewaySession({
      request: makeRequest(),
      onEvent: (ev) => events.push(ev),
      deps: rig.deps,
    });
    await settle();
    rig.transport.replyErr("createAgentSession 失败: provider 未配置");

    await expect(pending).rejects.toThrow("createAgentSession 失败");
    // 多会话形态下不能为一次 open 失败杀进程（会连坐其它会话），只发 closeSession 清理。
    expect(rig.transport.killed).toBe(0);
    expect(rig.transport.last()?.kind).toBe("closeSession");
    rig.transport.emitExit(1, "boom");
    expect(events.some((e) => e.type === "crashed")).toBe(false);
  });

  it("open 失败后 runtime 仍可开新会话（失败不污染单例）", async () => {
    const rig = makeRig();
    const failed = openPiGatewaySession({ request: makeRequest(), onEvent: () => {}, deps: rig.deps });
    await settle();
    rig.transport.replyErr("provider 未配置");
    await expect(failed).rejects.toThrow("provider 未配置");

    const opened = await openOn(rig);
    expect(rig.createTransport).toHaveBeenCalledTimes(1);
    expect(opened.session.sessionId).toBeTruthy();
  });

  it("deps.env 在创建 runtime 时传给承载工厂；fork 不绑定任何会话的 cwd", async () => {
    const rig = makeRig();
    let forkOptions: { cwd?: string; env?: Record<string, string> } | undefined;
    const pending = openPiGatewaySession({
      request: makeRequest({ cwd: "/proj/a" }),
      onEvent: () => {},
      deps: {
        ...rig.deps,
        env: { CORTEX_PI_SECRET_1: "x" },
        createTransport: (opts) => {
          forkOptions = opts;
          return rig.createTransport();
        },
      },
    });
    await settle();
    rig.transport.replyOk();
    await pending;
    expect(forkOptions?.env).toEqual({ CORTEX_PI_SECRET_1: "x" });
    // 常驻进程活得比任何会话都久，绑首个会话的 cwd 会让后续会话踩着别人的目录跑。
    expect(forkOptions?.cwd).toBeUndefined();
  });
});

// ── 默认金库访问器 ──────────────────────────────────────────────────────────────────

describe("accessGatewayCredential 的 key 命名空间与 op", () => {
  beforeEach(() => {
    vaultMocks.readStoredCredential.mockReset();
    vaultMocks.listStoredCredentialMetas.mockReset();
    vaultMocks.modifyStoredCredential.mockReset();
    vaultMocks.deleteStoredCredential.mockReset();
    vaultMocks.readSecrets.mockReset();
  });

  const req = (over: Partial<WorkerCredentialRequest> & { key: string }): WorkerCredentialRequest => ({
    kind: "credentialRequest",
    requestId: "cr",
    ...over,
  });

  it("provider:<id> 与裸 id 同义，值是 JSON.stringify(Credential)", async () => {
    vaultMocks.readStoredCredential.mockResolvedValue({ type: "api_key", key: "sk-1" });
    await expect(accessGatewayCredential(req({ key: "provider:anthropic" }))).resolves.toBe(
      JSON.stringify({ type: "api_key", key: "sk-1" }),
    );
    expect(vaultMocks.readStoredCredential).toHaveBeenCalledWith("anthropic");

    await accessGatewayCredential(req({ key: "anthropic" }));
    expect(vaultMocks.readStoredCredential).toHaveBeenLastCalledWith("anthropic");
  });

  it("未配置的 provider 回 null（不是空串）", async () => {
    vaultMocks.readStoredCredential.mockResolvedValue(undefined);
    await expect(accessGatewayCredential(req({ key: "provider:none" }))).resolves.toBeNull();
  });

  it("secret:<NAME> 取命名 Secret 明文；空串是合法值、缺失才是 null", async () => {
    vaultMocks.readSecrets.mockResolvedValue({ CF_ID: "", OTHER: "v" });
    await expect(accessGatewayCredential(req({ key: "secret:CF_ID" }))).resolves.toBe("");
    await expect(accessGatewayCredential(req({ key: "secret:MISSING" }))).resolves.toBeNull();
  });

  it("credentials:list / op=list 都回元信息清单，且不解密", async () => {
    vaultMocks.listStoredCredentialMetas.mockResolvedValue([
      { providerId: "anthropic", type: "oauth", expiresAt: 123 },
    ]);
    // expiresAt 属于金库内部元数据，不在 pi 的 CredentialInfo 契约里，必须剔掉。
    await expect(accessGatewayCredential(req({ key: "credentials:list" }))).resolves.toBe(
      JSON.stringify([{ providerId: "anthropic", type: "oauth" }]),
    );
    await expect(accessGatewayCredential(req({ key: "whatever", op: "list" }))).resolves.toContain("anthropic");
    expect(vaultMocks.readStoredCredential).not.toHaveBeenCalled();
  });

  it("op=write 走 modifyStoredCredential（共用金库串行锁，防并发刷新互相覆盖）", async () => {
    const cred = { type: "oauth", access: "a", refresh: "r", expires: 1 };
    vaultMocks.modifyStoredCredential.mockImplementation(async (_id: string, fn: (c: unknown) => Promise<unknown>) =>
      fn(undefined),
    );
    await expect(
      accessGatewayCredential(req({ key: "provider:anthropic", op: "write", value: JSON.stringify(cred) })),
    ).resolves.toBe(JSON.stringify(cred));
    expect(vaultMocks.modifyStoredCredential.mock.calls[0]?.[0]).toBe("anthropic");
  });

  it("op=write 的坏 JSON 在碰金库之前失败（绝不把半个对象落盘）", async () => {
    await expect(
      accessGatewayCredential(req({ key: "provider:x", op: "write", value: "{ broken" })),
    ).rejects.toThrow();
    await expect(accessGatewayCredential(req({ key: "provider:x", op: "write" }))).rejects.toThrow(/缺少 value/);
    expect(vaultMocks.modifyStoredCredential).not.toHaveBeenCalled();
  });

  it("op=delete 删 provider 凭据并回 null", async () => {
    vaultMocks.deleteStoredCredential.mockResolvedValue(undefined);
    await expect(accessGatewayCredential(req({ key: "provider:x", op: "delete" }))).resolves.toBeNull();
    expect(vaultMocks.deleteStoredCredential).toHaveBeenCalledWith("x");
  });

  it("安全边界：拒绝改写/删除命名 Secret（那是用户手工维护、无撤销路径的资产）", async () => {
    await expect(
      accessGatewayCredential(req({ key: "secret:CF_ID", op: "write", value: "{}" })),
    ).rejects.toThrow(/拒绝写入命名 Secret/);
    await expect(accessGatewayCredential(req({ key: "secret:CF_ID", op: "delete" }))).rejects.toThrow(
      /拒绝写入命名 Secret/,
    );
    expect(vaultMocks.modifyStoredCredential).not.toHaveBeenCalled();
    expect(vaultMocks.deleteStoredCredential).not.toHaveBeenCalled();
  });
});

// ── open 请求脱敏（KTD1）────────────────────────────────────────────────────────────

describe("open 请求脱敏", () => {
  it("摘掉 provider.apiKey 再跨进程，其余字段原样保留", async () => {
    const rig = makeRig();
    const request = makeRequest({
      provider: { id: "custom", baseUrl: "https://x", apiKey: "sk-secret", models: [{ id: "m" }] },
    });
    const pending = openPiGatewaySession({
      request,
      onEvent: () => {},
      deps: rig.deps,
    });
    await settle();

    const sent = rig.transport.firstOf("open")?.request as PiOpenRequest;
    expect(sent.provider).toEqual({ id: "custom", baseUrl: "https://x", models: [{ id: "m" }] });
    expect(rig.transport.writes.join("")).not.toContain("sk-secret");
    // 不得就地改调用方还在用的 prepared 对象（binary/in-process 分支与 trace 都还要读它）。
    expect(request.provider?.apiKey).toBe("sk-secret");

    rig.transport.replyOk();
    await pending;
  });
});
