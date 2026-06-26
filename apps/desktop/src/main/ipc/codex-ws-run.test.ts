import { describe, expect, it, vi } from "vitest";
import { startCodexWsRun, type CodexWsRunOpts } from "./codex-ws-run";
import type { CliStreamEvent, CliExitEvent, CliStartRequest } from "./types";
import type { AgentDef } from "../agents";
import type { CodexServerManager } from "../agents/codex-app-server";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// fake 通道:记录 opts,提供 emit/emitActivity/emitClose 驱动;startThread/resume 产 init。
class FakeChannel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts: any;
  resumeShouldThrow = false;
  connect = vi.fn(async () => {});
  startThread = vi.fn(async () => {
    this.opts.onEvent({ type: "init", sessionId: "thr_new" });
    return "thr_new";
  });
  resumeThread = vi.fn(async (id: string) => {
    if (this.resumeShouldThrow) throw new Error("no rollout found for thread id");
    this.opts.onEvent({ type: "init", sessionId: id });
  });
  startTurn = vi.fn(async () => "turn_1");
  interrupt = vi.fn(async () => {});
  close = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(opts: any) {
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

  it("kill() → turn/interrupt + close + cli:exit(code null)", async () => {
    const h = harness();
    await flush();
    const ch = h.getChannel();
    h.handle.kill();
    expect(ch.interrupt).toHaveBeenCalled();
    expect(ch.close).toHaveBeenCalled();
    expect(h.exits.some((e) => e.code === null)).toBe(true);
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
