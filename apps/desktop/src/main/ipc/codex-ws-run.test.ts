import { afterEach, describe, expect, it, vi } from "vitest";
import { startCodexWsRun, closeAllCodexChannels, type CodexWsRunOpts } from "./codex-ws-run";
import type { CliStreamEvent, CliExitEvent, CliStartRequest } from "./types";
import type { AgentDef } from "../agents";
import type { CodexServerManager } from "../agents/codex-app-server";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// 持久连接是模块级注册表:每个用例后清掉,防跨用例复用(sessionId 复用会命中上一用例的连接)。
afterEach(() => closeAllCodexChannels());

// fake 通道:channel 不再自发 init(由 run 每轮发);emit 经委托 sink 投递到当前活跃 run。
class FakeChannel {
  opts: { onEvent: (ev: CliStreamEvent) => void; onActivity?: () => void; onClose?: (i: { expected: boolean }) => void };
  resumeShouldThrow = false;
  connect = vi.fn(async () => {});
  startThread = vi.fn(async () => "thr_new");
  resumeThread = vi.fn(async (_id: string) => {
    if (this.resumeShouldThrow) throw new Error("no rollout found for thread id");
  });
  startTurn = vi.fn(async () => "turn_1");
  interrupt = vi.fn(async () => {});
  close = vi.fn();
  constructor(opts: FakeChannel["opts"]) {
    this.opts = opts;
  }
  emit(ev: CliStreamEvent) {
    this.opts.onActivity?.();
    this.opts.onEvent(ev);
  }
}

function harness(reqOver: Partial<CliStartRequest> = {}, optsOver: Partial<CodexWsRunOpts> = {}) {
  const events: CliStreamEvent[] = [];
  const exits: CliExitEvent[] = [];
  const keepalives: number[] = [];
  let channel: FakeChannel | undefined;
  const ensureServer = vi.fn(async () => ({ wsUrl: "ws://127.0.0.1:1", port: 1, restarted: false }));
  const manager = {
    ensureServer,
    setBusy: vi.fn(),
    killServer: vi.fn(),
  } as unknown as CodexServerManager;
  const req = {
    runId: "r1",
    sessionId: "s1",
    agent: "codex",
    cwd: "/proj",
    prompt: "hi",
    permissionMode: "plan",
    ...reqOver,
  } as CliStartRequest;
  const def = { id: "codex", transport: "ws" } as AgentDef;
  const handle = startCodexWsRun({
    req,
    def,
    manager,
    mcpArgs: ["-c", "mcp_servers.x.command=echo"],
    sendEvent: (e) => events.push(e),
    sendExit: (e) => exits.push(e),
    sendKeepalive: () => keepalives.push(Date.now()),
    inactivityMs: 1_000_000,
    retryMax: 0,
    createChannel: (o) => {
      channel = new FakeChannel(o);
      return channel as unknown as ReturnType<NonNullable<CodexWsRunOpts["createChannel"]>>;
    },
    ...optsOver,
  });
  return { handle, events, exits, keepalives, ensureServer, manager, getChannel: () => channel! };
}

describe("startCodexWsRun(U5)", () => {
  it("首轮:ensureServer→connect→startThread→startTurn,流式 init/text/result + cli:exit", async () => {
    const h = harness();
    await flush();
    expect(h.ensureServer).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ cwd: "/proj", serverCmd: "codex", mcpArgs: ["-c", "mcp_servers.x.command=echo"] }),
    );
    const ch = h.getChannel();
    expect(ch.connect).toHaveBeenCalled();
    expect(ch.startThread).toHaveBeenCalled();
    expect(ch.startTurn).toHaveBeenCalled();
    // 流式产出
    ch.emit({ type: "text", delta: "PONG" });
    ch.emit({ type: "result", ok: true });
    expect(h.events).toEqual([
      { type: "init", sessionId: "thr_new" },
      { type: "text", delta: "PONG" },
      { type: "result", ok: true },
    ]);
    expect(h.exits).toEqual([{ runId: "r1", sessionId: "s1", code: 0, error: undefined }]);
    // busy:true 后 false
    expect(h.manager.setBusy).toHaveBeenCalledWith("s1", true);
    expect(h.manager.setBusy).toHaveBeenCalledWith("s1", false);
  });

  it("带 resumeSessionId → resumeThread(非 startThread)", async () => {
    const h = harness({ resumeSessionId: "thr_old" });
    await flush();
    const ch = h.getChannel();
    expect(ch.resumeThread).toHaveBeenCalledWith("thr_old", expect.objectContaining({ cwd: "/proj" }));
    expect(ch.startThread).not.toHaveBeenCalled();
    expect(h.events[0]).toEqual({ type: "init", sessionId: "thr_old" });
  });

  it("续接失败(预置 throw)→ result ok:false 含 thread/resume failed", async () => {
    const events: CliStreamEvent[] = [];
    const exits: CliExitEvent[] = [];
    let channel: FakeChannel | undefined;
    const manager = { ensureServer: vi.fn(async () => ({ wsUrl: "ws://x", port: 1, restarted: false })), setBusy: vi.fn(), killServer: vi.fn() } as unknown as CodexServerManager;
    startCodexWsRun({
      req: { runId: "r", sessionId: "s", agent: "codex", cwd: "/p", prompt: "hi", resumeSessionId: "thr_gone" } as CliStartRequest,
      def: { id: "codex", transport: "ws" } as AgentDef,
      manager,
      sendEvent: (e) => events.push(e),
      sendExit: (e) => exits.push(e),
      inactivityMs: 1_000_000,
      retryMax: 0,
      createChannel: (o) => {
        channel = new FakeChannel(o);
        channel.resumeShouldThrow = true;
        return channel as unknown as ReturnType<NonNullable<CodexWsRunOpts["createChannel"]>>;
      },
    });
    await flush();
    const result = events.find((e) => e.type === "result");
    expect(result).toMatchObject({ type: "result", ok: false });
    expect((result as { error: string }).error).toMatch(/thread\/resume failed/);
    expect(exits).toHaveLength(1);
  });

  it("kill() → turn/interrupt + cli:exit(code null),保留连接(不 close)", async () => {
    const h = harness();
    await flush();
    const ch = h.getChannel();
    h.handle.kill();
    expect(ch.interrupt).toHaveBeenCalled();
    expect(ch.close).not.toHaveBeenCalled(); // 持久连接:取消只中断 turn,连接留给下轮
    expect(h.exits.some((e) => e.code === null)).toBe(true);
  });

  it("跨轮复用连接:第二轮不再 connect/startThread,仅 startTurn", async () => {
    const h = harness();
    await flush();
    const ch = h.getChannel();
    ch.emit({ type: "result", ok: true }); // 第一轮收尾
    expect(ch.connect).toHaveBeenCalledTimes(1);
    expect(ch.startThread).toHaveBeenCalledTimes(1);
    // 第二轮:同 sessionId 再起一个 run(复用模块级持久连接)
    startCodexWsRun({
      req: { runId: "r2", sessionId: "s1", agent: "codex", cwd: "/proj", prompt: "again" } as CliStartRequest,
      def: { id: "codex", transport: "ws" } as AgentDef,
      manager: h.manager,
      sendEvent: () => {},
      sendExit: () => {},
      inactivityMs: 1_000_000,
      retryMax: 0,
      createChannel: () => ch as unknown as ReturnType<NonNullable<CodexWsRunOpts["createChannel"]>>,
    });
    await flush();
    expect(ch.connect).toHaveBeenCalledTimes(1); // 未重连
    expect(ch.startThread).toHaveBeenCalledTimes(1); // 未重建 thread
    expect(ch.startTurn).toHaveBeenCalledTimes(2); // 第二轮只发 turn
  });

  it("首轮建 thread 失败后,复用同连接的下一轮补建 thread(回归:startTurn 前必有 thread)", async () => {
    // getOrCreateConn 在 startThread 之前就把 conn 存进注册表:首轮 startThread 失败后 conn 仍留存,
    // 下一轮复用(fresh=false)却没有 thread。修复前按 fresh 跳过建 thread → startTurn 报「startTurn 前
    // 需先 startThread」;修复后按 c.threadId 判定,会补建 thread。
    const exits: CliExitEvent[] = [];
    let channel: FakeChannel | undefined;
    let startThreadCalls = 0;
    const manager = {
      ensureServer: vi.fn(async () => ({ wsUrl: "ws://x", port: 1, restarted: false })),
      setBusy: vi.fn(),
      killServer: vi.fn(),
    } as unknown as CodexServerManager;
    const mk = (runId: string, sink: CliStreamEvent[]) =>
      startCodexWsRun({
        req: { runId, sessionId: "sx", agent: "codex", cwd: "/p", prompt: "hi" } as CliStartRequest,
        def: { id: "codex", transport: "ws" } as AgentDef,
        manager,
        sendEvent: (e) => sink.push(e),
        sendExit: (e) => exits.push(e),
        inactivityMs: 1_000_000,
        retryMax: 0,
        createChannel: (o) => {
          // 仅首轮新建(下一轮复用持久 conn,不再调本工厂)。startThread 首次失败、之后成功。
          channel = new FakeChannel(o);
          channel.startThread = vi.fn(async () => {
            startThreadCalls++;
            if (startThreadCalls === 1) throw new Error("thread/start 失败");
            return "thr_ok";
          }) as unknown as FakeChannel["startThread"];
          return channel as unknown as ReturnType<NonNullable<CodexWsRunOpts["createChannel"]>>;
        },
      });

    // 首轮:startThread 抛 → result false,但 conn 留在注册表(未 drop)。
    const e1: CliStreamEvent[] = [];
    mk("r1", e1);
    await flush();
    expect(e1.find((e) => e.type === "result")).toMatchObject({ ok: false });
    expect(startThreadCalls).toBe(1);

    // 下一轮:同 sessionId 复用 conn(channel 无 thread)→ 必须补建 thread,startTurn 正常发出。
    const e2: CliStreamEvent[] = [];
    mk("r2", e2);
    await flush();
    expect(startThreadCalls).toBe(2); // 补建(修复前会跳过)
    channel!.emit({ type: "result", ok: true });
    expect(channel!.startTurn).toHaveBeenCalled();
    expect(e2.find((e) => e.type === "result")).toMatchObject({ ok: true });
  });

  it("ensureServer 失败 + retryMax 0 → result ok:false + exit", async () => {
    const h = harness({}, { createChannel: undefined });
    // 用一个会抛错的 manager 覆盖
    const events: CliStreamEvent[] = [];
    const exits: CliExitEvent[] = [];
    const manager = { ensureServer: vi.fn(async () => { throw new Error("就绪超时"); }), setBusy: vi.fn(), killServer: vi.fn() } as unknown as CodexServerManager;
    startCodexWsRun({
      req: { runId: "r", sessionId: "s", agent: "codex", cwd: "/p", prompt: "hi" } as CliStartRequest,
      def: { id: "codex", transport: "ws" } as AgentDef,
      manager,
      sendEvent: (e) => events.push(e),
      sendExit: (e) => exits.push(e),
      inactivityMs: 1_000_000,
      retryMax: 0,
    });
    await flush();
    expect(events.find((e) => e.type === "result")).toMatchObject({ type: "result", ok: false });
    expect(exits).toHaveLength(1);
    void h;
  });

  it("活跃信号触发 keepalive(首次活跃即发,< 300s 阈值)", async () => {
    const h = harness();
    await flush();
    h.getChannel().emit({ type: "text", delta: "x" });
    expect(h.keepalives.length).toBeGreaterThanOrEqual(1);
  });
});
