// gateway 客户端单测。用假承载（不真起进程）覆盖五类：
//   1. `PiSessionEngine` 19 个方法的转发（含协议 `ENGINE_METHODS` 的逐项对账）；
//   2. 应答归一化与失败语义（命令级 success:false vs 传输级 reject）；
//   3. 反向调用——UI 请求（含 id 映射、无出口自动 cancel）与凭据（含解密失败）；
//   4. worker 退出 → `crashed`（R5），以及主动 stop 之后**不得**上报 crashed；
//   5. 两段式 kill 与资源释放。

import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { accessGatewayCredential, openPiGatewaySession, PiGatewaySession } from "./client";
import { FakePiGatewayTransport } from "./fake-transport";
import { ENGINE_METHODS, type HostCall, type HostUiResponse, type WorkerCredentialRequest } from "./protocol";
import type { PiOpenRequest, PiSessionEvent, PiUiRequest } from "../../ipc/types";

// ── 夹具 ────────────────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<PiOpenRequest> = {}): PiOpenRequest {
  return { uiSessionId: "ui-1", cwd: "/work", ...overrides } as PiOpenRequest;
}

/** 排空微任务队列。凭据反向调用要过「读金库 → 写应答」两跳异步，单个 tick 不够。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  transport: FakePiGatewayTransport;
  session: PiGatewaySession;
  events: Array<{ ev: PiSessionEvent; runId?: string }>;
  uiRequests: PiUiRequest[];
  credentialCalls: string[];
}

/** 建一个已 open 成功的会话。`open` 的应答由本函数即时回掉，用例只需关心之后的交互。 */
async function open(
  options: {
    onUiRequest?: boolean;
    readCredential?: (key: string) => Promise<string | null>;
    onDispose?: () => void;
    killDelayMs?: number;
  } = {},
): Promise<Harness> {
  const transport = new FakePiGatewayTransport();
  const events: Array<{ ev: PiSessionEvent; runId?: string }> = [];
  const uiRequests: PiUiRequest[] = [];
  const credentialCalls: string[] = [];

  const pending = openPiGatewaySession({
    request: makeRequest(),
    onEvent: (ev, runId) => events.push({ ev, ...(runId === undefined ? {} : { runId }) }),
    ...(options.onUiRequest === false ? {} : { onUiRequest: (req: PiUiRequest) => uiRequests.push(req) }),
    deps: {
      createTransport: () => transport,
      readCredential: async (req) => {
        credentialCalls.push(req.key);
        return options.readCredential ? options.readCredential(req.key) : `secret-of-${req.key}`;
      },
      ...(options.onDispose ? { onDispose: options.onDispose } : {}),
      ...(options.killDelayMs === undefined ? {} : { killDelayMs: options.killDelayMs }),
    },
  });

  // open 是异步的：让 openPiGatewaySession 先把 HostOpen 写出去，再回应答。
  await Promise.resolve();
  transport.replyOk();
  const session = await pending;
  return { transport, session, events, uiRequests, credentialCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ── 1. 方法转发 ─────────────────────────────────────────────────────────────────────

describe("PiSessionEngine 方法转发", () => {
  it("open 写出 HostOpen，带上已 prepare 的 request 与 hasUiOutlet", async () => {
    const { transport } = await open();
    const msg = transport.firstOf("open");
    expect(msg?.kind).toBe("open");
    expect((msg?.request as PiOpenRequest).uiSessionId).toBe("ui-1");
    expect(msg?.hasUiOutlet).toBe(true);
  });

  it("无 onUiRequest 时 hasUiOutlet=false（决定 worker 侧审批 hook 的无 UI 语义）", async () => {
    const { transport } = await open({ onUiRequest: false });
    expect(transport.firstOf("open")?.hasUiOutlet).toBe(false);
  });

  // 逐条对账：协议侧 ENGINE_METHODS 的每个方法名都得能在客户端上调起来，
  // 并且真的写出一条 method 相符的 HostCall。漏一个的表现是「某命令静默失效」。
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
    await Promise.resolve();

    const call = transport.last() as HostCall;
    expect(call.kind).toBe("call");
    expect(call.method).toBe(method);
    expect(call.args).toEqual(expectedArgs);

    // ready 需要一个合法结果，其余任意；回掉以免用例留下未处理 Promise。
    transport.replyOk(method === "ready" ? { sessionId: "s-1" } : { type: "response", command: method, success: true });
    await pending;
  });

  it("ENGINE_METHODS 与本用例表逐项对齐（协议增删方法时这里必须同步）", () => {
    expect(Object.keys(invocations).sort()).toEqual([...ENGINE_METHODS].sort());
  });

  it("stop 与 respondUi 不走 call 通道（它们是连接级/反向应答动作）", async () => {
    const { transport, session } = await open();
    session.respondUi("pi-id", { confirmed: true });
    session.stop();
    expect(transport.sent().some((m) => m.kind === "call")).toBe(false);
    expect(transport.sent().map((m) => m.kind)).toEqual(["open", "uiResponse", "shutdown"]);
  });

  it("裁掉尾部 undefined 参数（否则 JSON 往返会把它变成 null，worker 侧判定走错分支）", async () => {
    const { transport, session } = await open();
    void session.prompt("only message");
    await Promise.resolve();
    expect((transport.last() as HostCall).args).toEqual(["only message"]);
  });
});

// ── 2. 应答语义 ─────────────────────────────────────────────────────────────────────

describe("应答归一化与失败语义", () => {
  it("worker 回 RpcResponse 时原样透出（含命令级 success:false）", async () => {
    const { transport, session } = await open();
    const pending = session.getState();
    await Promise.resolve();
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
    await Promise.resolve();
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
    await Promise.resolve();
    transport.replyErr("会话未建立");
    await expect(pending).rejects.toThrow("会话未建立");
  });

  it("命令超时 reject 且不留下 pending（否则渲染端 invoke 永久挂起）", async () => {
    vi.useFakeTimers();
    const { session } = await open();
    const pending = session.getState();
    await Promise.resolve();
    vi.advanceTimersByTime(30_000);
    await expect(pending).rejects.toThrow("pi 命令超时: getState");
    expect(session.pendingCount).toBe(0);
    vi.useRealTimers();
  });

  it("迟到的 reply（id 已被超时清掉）不会串到别的命令", async () => {
    vi.useFakeTimers();
    const { transport, session } = await open();
    const first = session.getState();
    await Promise.resolve();
    vi.advanceTimersByTime(30_000);
    await expect(first).rejects.toThrow();
    vi.useRealTimers();

    const second = session.getSessionStats();
    await Promise.resolve();
    // 回一条 id 属于第一次调用的应答：必须被忽略，第二次调用仍在途。
    transport.emit({ id: "pg_2", kind: "reply", ok: true, result: { stale: true } });
    expect(session.pendingCount).toBe(1);
    transport.replyOk({ fresh: true });
    await expect(second).resolves.toMatchObject({ data: { fresh: true } });
  });

  it("ready 缺 sessionId 时响亮失败（会话不可用必须让 pi:open 抛出去）", async () => {
    const { transport, session } = await open();
    const pending = session.ready();
    await Promise.resolve();
    transport.replyOk({});
    await expect(pending).rejects.toThrow("缺少 sessionId");
  });

  it("ready 成功时透出 sessionId 与 sessionFile", async () => {
    const { transport, session } = await open();
    const pending = session.ready();
    await Promise.resolve();
    transport.replyOk({ sessionId: "s-7", sessionFile: "/p/s.jsonl" });
    await expect(pending).resolves.toEqual({ sessionId: "s-7", sessionFile: "/p/s.jsonl" });
  });

  it("loadSlashCommands 失败静默降级（只影响补发判定精度，不得阻断会话）", async () => {
    const { transport, session } = await open();
    const pending = session.loadSlashCommands();
    await Promise.resolve();
    transport.replyErr("no commands");
    await expect(pending).resolves.toBeUndefined();
  });

  it("坏 JSON 行只丢弃、不中断通道", async () => {
    const { transport, session } = await open();
    transport.emit("{ not json");
    const pending = session.abort();
    await Promise.resolve();
    transport.replyOk({ type: "response", command: "abort", success: true });
    await expect(pending).resolves.toMatchObject({ success: true });
  });
});

// ── 3. 事件与反向调用 ───────────────────────────────────────────────────────────────

describe("事件流", () => {
  it("WorkerEvent 转成 onEvent（runId 一并带过去）", async () => {
    const { transport, events } = await open();
    transport.emit({ kind: "event", event: { type: "text", delta: "hi" }, runId: "run-3" });
    expect(events).toEqual([{ ev: { type: "text", delta: "hi" }, runId: "run-3" }]);
  });

  it("onEvent 抛错被吞掉，通道继续可用（抛出去会让后续事件与应答一起消失）", async () => {
    const transport = new FakePiGatewayTransport();
    let calls = 0;
    const session = new PiGatewaySession(transport, {
      onEvent: () => {
        calls += 1;
        throw new Error("renderer gone");
      },
      readCredential: async () => null,
      uiSessionId: "ui-1",
    });
    transport.emit({ kind: "event", event: { type: "settled" } });
    transport.emit({ kind: "event", event: { type: "settled" } });
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

  it("uiRequest 转给 onUiRequest；回写按 pi 的 id 找回协议 requestId", async () => {
    const { transport, session, uiRequests } = await open();
    transport.emit({ kind: "uiRequest", requestId: "rq-42", request: uiRequest });
    expect(uiRequests).toEqual([uiRequest]);

    // 渲染端只知道 pi 的 id（pi-uuid-1），主进程必须把它翻回 rq-42。
    session.respondUi("pi-uuid-1", { confirmed: true });
    const resp = transport.last() as HostUiResponse;
    expect(resp.kind).toBe("uiResponse");
    expect(resp.requestId).toBe("rq-42");
    expect(resp.payload).toEqual({ confirmed: true });
  });

  it("无 UI 出口时立即回 cancelled（不回的话 worker 的工具执行栈永久冻住）", async () => {
    const { transport } = await open({ onUiRequest: false });
    transport.emit({ kind: "uiRequest", requestId: "rq-1", request: uiRequest });
    expect(transport.last()).toEqual({
      id: expect.any(String),
      kind: "uiResponse",
      requestId: "rq-1",
      payload: { cancelled: true },
    });
  });

  it("onUiRequest 抛错时同样兜底回 cancelled", async () => {
    const transport = new FakePiGatewayTransport();
    new PiGatewaySession(transport, {
      onEvent: () => {},
      onUiRequest: () => {
        throw new Error("sender destroyed");
      },
      readCredential: async () => null,
      uiSessionId: "ui-1",
    });
    transport.emit({ kind: "uiRequest", requestId: "rq-9", request: uiRequest });
    expect((transport.last() as HostUiResponse).payload).toEqual({ cancelled: true });
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
  it("credentialRequest → 主进程解密 → credentialResponse", async () => {
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

  it("解密失败回 value:null + error，而不是让整条会话崩掉", async () => {
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
    await Promise.resolve();
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

  it("退出后的残余消息一律丢弃（避免串到重开的新会话）", async () => {
    const { transport, events } = await open();
    transport.emitExit(1);
    const crashedCount = events.length;
    transport.emit({ kind: "event", event: { type: "text", delta: "late" } });
    expect(events.length).toBe(crashedCount);
  });
});

// ── 5. 停止与资源释放 ───────────────────────────────────────────────────────────────

describe("stop 的两段式 kill 与释放", () => {
  it("先发 shutdown 再优雅 kill，宽限期后强杀", async () => {
    vi.useFakeTimers();
    const { transport, session } = await open({ killDelayMs: 3_000 });
    session.stop();
    expect(transport.last()?.kind).toBe("shutdown");
    expect(transport.killed).toBe(1);
    expect(transport.forceKilled).toBe(0);
    vi.advanceTimersByTime(3_000);
    expect(transport.forceKilled).toBe(1);
    vi.useRealTimers();
  });

  it("worker 在宽限期内自己退出则不再强杀", async () => {
    vi.useFakeTimers();
    const { transport, session } = await open({ killDelayMs: 3_000 });
    session.stop();
    transport.emitExit(0);
    vi.advanceTimersByTime(10_000);
    expect(transport.forceKilled).toBe(0);
    vi.useRealTimers();
  });

  it("stop 后主动停止的退出不上报 crashed，且在途 RPC 被了结", async () => {
    const { transport, session, events } = await open();
    const pending = session.getState();
    await Promise.resolve();
    session.stop();
    await expect(pending).rejects.toThrow("pi 会话已停止退出");
    transport.emitExit(0);
    expect(events.some((e) => e.ev.type === "crashed")).toBe(false);
  });

  it("stop 幂等：重复调用不重复写 shutdown、不重复 kill", async () => {
    const { transport, session } = await open();
    session.stop();
    session.stop();
    expect(transport.sent().filter((m) => m.kind === "shutdown")).toHaveLength(1);
    expect(transport.killed).toBe(1);
  });

  it("stop 调用注入的 onDispose（外部资源释放的唯一收口）", async () => {
    let disposed = 0;
    const { session } = await open({ onDispose: () => void (disposed += 1) });
    session.stop();
    await Promise.resolve();
    expect(disposed).toBe(1);
  });

  it("管道已断时 stop 不抛（写 shutdown 失败是正常竞态）", async () => {
    const { transport, session } = await open();
    transport.writeThrows = true;
    expect(() => session.stop()).not.toThrow();
    expect(transport.killed).toBe(1);
  });

  it("停止后再发命令直接 reject，不静默挂起", async () => {
    const { session } = await open();
    session.stop();
    await expect(session.getState()).rejects.toThrow("pi 会话已停止退出");
  });
});

// ── 构造入口 ────────────────────────────────────────────────────────────────────────

describe("openPiGatewaySession", () => {
  it("open 失败时 kill 掉 worker 并抛出（不留孤儿进程），且不上报 crashed", async () => {
    const transport = new FakePiGatewayTransport();
    const events: PiSessionEvent[] = [];
    const pending = openPiGatewaySession({
      request: makeRequest(),
      onEvent: (ev) => events.push(ev),
      deps: { createTransport: () => transport, readCredential: async () => null },
    });
    await Promise.resolve();
    transport.replyErr("createAgentSession 失败: provider 未配置");

    await expect(pending).rejects.toThrow("createAgentSession 失败");
    expect(transport.killed).toBeGreaterThanOrEqual(1);
    transport.emitExit(1, "boom");
    expect(events.some((e) => e.type === "crashed")).toBe(false);
  });

  it("cwd 透传给承载工厂（worker 的工具与会话文件推导都依赖它）", async () => {
    const transport = new FakePiGatewayTransport();
    let forkCwd: string | undefined;
    const pending = openPiGatewaySession({
      request: makeRequest({ cwd: "/proj/a" }),
      onEvent: () => {},
      deps: {
        createTransport: (opts) => {
          forkCwd = opts.cwd;
          return transport;
        },
        readCredential: async () => null,
      },
    });
    await Promise.resolve();
    transport.replyOk();
    await pending;
    expect(forkCwd).toBe("/proj/a");
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
    const transport = new FakePiGatewayTransport();
    const request = makeRequest({
      provider: { id: "custom", baseUrl: "https://x", apiKey: "sk-secret", models: [{ id: "m" }] },
    });
    const pending = openPiGatewaySession({
      request,
      onEvent: () => {},
      deps: { createTransport: () => transport, readCredential: async () => null },
    });
    await Promise.resolve();

    const sent = transport.firstOf("open")?.request as PiOpenRequest;
    expect(sent.provider).toEqual({ id: "custom", baseUrl: "https://x", models: [{ id: "m" }] });
    expect(transport.writes.join("")).not.toContain("sk-secret");
    // 不得就地改调用方还在用的 prepared 对象（binary/in-process 分支与 trace 都还要读它）。
    expect(request.provider?.apiKey).toBe("sk-secret");

    transport.replyOk();
    await pending;
  });
});
