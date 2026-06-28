import { describe, expect, it, vi } from "vitest";

// ../log 桩:断言 U4 盲区补点(就绪超时 / 旧版不支持 / LRU·空闲驱逐)经 scoped logger 落盘;
// 同时避免加载真 electron-log/main。所有 scope 复用同一 logger 桩,便于跨用例断言。
const logMocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() },
}));
vi.mock("../log", () => ({ createLogger: () => logMocks.logger, isDevEnv: () => true }));

import { CodexServerManager, type CodexServerDeps } from "./codex-app-server";
import type { AgentProcess } from "../ipc/cli";

// ── fake AgentProcess ──────────────────────────────────────────────────────
function makeFakeProc() {
  let exitCb: ((code: number | null) => void) | undefined;
  const stderrHandlers: ((c: string) => void)[] = [];
  const proc: AgentProcess = {
    pid: 4242,
    stdout: null,
    stderr: {
      setEncoding: () => {},
      on: (_e: string, cb: (c: string) => void) => stderrHandlers.push(cb),
    } as unknown as NodeJS.ReadableStream,
    onExit: (cb) => {
      exitCb = cb;
    },
    onError: () => {},
    kill: vi.fn(),
  };
  return {
    proc,
    emitStderr: (s: string) => stderrHandlers.forEach((h) => h(s)),
    triggerExit: (code: number | null = 0) => exitCb?.(code),
    killSpy: proc.kill as ReturnType<typeof vi.fn>,
  };
}

// 可控时钟
function makeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

interface Harness {
  manager: CodexServerManager;
  spawned: { cmd: string; args: string[]; fake: ReturnType<typeof makeFakeProc> }[];
  setReady: (v: boolean) => void;
  clock: ReturnType<typeof makeClock>;
}

function makeHarness(over: Partial<CodexServerDeps> = {}): Harness {
  const spawned: Harness["spawned"] = [];
  let ready = true;
  let portSeq = 50000;
  const clock = makeClock();
  const deps: CodexServerDeps = {
    spawnProcess: (cmd, args) => {
      const fake = makeFakeProc();
      spawned.push({ cmd, args, fake });
      return fake.proc;
    },
    buildEnv: () => ({ PATH: "/usr/bin" }),
    allocatePort: async () => portSeq++,
    probeReady: async () => ready,
    now: () => clock.now(),
    readyTimeoutMs: 1000,
    readyPollMs: 1,
    ...over,
  };
  return {
    manager: new CodexServerManager(deps),
    spawned,
    setReady: (v) => (ready = v),
    clock,
  };
}

describe("CodexServerManager.ensureServer", () => {
  it("spawn `codex app-server --listen ws://127.0.0.1:<port>` 并在就绪后返回 wsUrl", async () => {
    const h = makeHarness();
    const r = await h.manager.ensureServer("s1", {});
    expect(r.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(h.spawned[0].cmd).toBe("codex");
    expect(h.spawned[0].args.slice(0, 3)).toEqual(["app-server", "--listen", r.wsUrl]);
    expect(r.restarted).toBe(false);
  });

  it("MCP args 拼入启动参数(OQ2=是)", async () => {
    const h = makeHarness();
    await h.manager.ensureServer("s1", { mcpArgs: ["-c", "mcp_servers.x.command=echo"] });
    expect(h.spawned[0].args).toEqual([
      "app-server",
      "--listen",
      expect.stringContaining("ws://"),
      "-c",
      "mcp_servers.x.command=echo",
    ]);
  });

  it("自定义 serverCmd(派生 agent bin)生效", async () => {
    const h = makeHarness();
    await h.manager.ensureServer("s1", { serverCmd: "/opt/custom-codex" });
    expect(h.spawned[0].cmd).toBe("/opt/custom-codex");
  });

  it("并发两个 session 拿到不同端口与各自进程", async () => {
    const h = makeHarness();
    const a = await h.manager.ensureServer("s1", {});
    const b = await h.manager.ensureServer("s2", {});
    expect(a.port).not.toBe(b.port);
    expect(h.spawned).toHaveLength(2);
    expect(h.manager.size()).toBe(2);
  });

  it("复用同 configKey 的存活 server(不重复 spawn)", async () => {
    const h = makeHarness();
    const a = await h.manager.ensureServer("s1", { mcpArgs: ["-c", "x=1"] });
    const b = await h.manager.ensureServer("s1", { mcpArgs: ["-c", "x=1"] });
    expect(b.wsUrl).toBe(a.wsUrl);
    expect(h.spawned).toHaveLength(1);
    expect(b.restarted).toBe(false);
  });

  it("configKey 变更(MCP 改动)→ 杀旧起新", async () => {
    const h = makeHarness();
    const a = await h.manager.ensureServer("s1", { mcpArgs: ["-c", "x=1"] });
    const b = await h.manager.ensureServer("s1", { mcpArgs: ["-c", "x=2"] });
    expect(h.spawned[0].fake.killSpy).toHaveBeenCalled(); // 旧 server 被杀
    expect(b.wsUrl).not.toBe(a.wsUrl);
    expect(b.restarted).toBe(true);
    expect(h.spawned).toHaveLength(2);
  });

  it("/readyz 始终不就绪 → 就绪超时 reject 且杀进程", async () => {
    const h = makeHarness();
    h.setReady(false);
    // probe 永远 false;readyTimeoutMs=1000,但 now() 不前进 → 手动前进时钟使超时触发
    const p = h.manager.ensureServer("s1", {});
    // 推进时钟越过超时阈值(在轮询循环的 now() 比较里生效)
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      h.clock.advance(500);
    }
    await expect(p).rejects.toThrow(/就绪超时/);
    expect(h.spawned[0].fake.killSpy).toHaveBeenCalled();
    expect(h.manager.size()).toBe(0);
  });

  it("进程就绪前退出 + stderr 含 unrecognized → 升级提示", async () => {
    const h = makeHarness({ probeReady: async () => false });
    const p = h.manager.ensureServer("s1", {});
    await Promise.resolve();
    h.spawned[0].fake.emitStderr("error: unrecognized subcommand 'app-server'");
    h.spawned[0].fake.triggerExit(2);
    await expect(p).rejects.toThrow(/升级 codex/);
  });
});

describe("CodexServerManager 生命周期与回收", () => {
  it("进程意外退出 → 标记 dead 并移出注册表", async () => {
    const h = makeHarness();
    await h.manager.ensureServer("s1", {});
    expect(h.manager.has("s1")).toBe(true);
    h.spawned[0].fake.triggerExit(1);
    expect(h.manager.has("s1")).toBe(false);
    expect(h.manager.size()).toBe(0);
  });

  it("killServer 杀整组并移出注册表", async () => {
    const h = makeHarness();
    await h.manager.ensureServer("s1", {});
    h.manager.killServer("s1");
    expect(h.spawned[0].fake.killSpy).toHaveBeenCalled();
    expect(h.manager.has("s1")).toBe(false);
  });

  it("killAll 回收全部 server", async () => {
    const h = makeHarness();
    await h.manager.ensureServer("s1", {});
    await h.manager.ensureServer("s2", {});
    h.manager.killAll();
    expect(h.spawned[0].fake.killSpy).toHaveBeenCalled();
    expect(h.spawned[1].fake.killSpy).toHaveBeenCalled();
    expect(h.manager.size()).toBe(0);
  });

  it("空闲驱逐:超阈值且非 busy 的 server 被回收;busy 的保留", async () => {
    const h = makeHarness({ idleEvictMs: 1000 });
    await h.manager.ensureServer("idle", {});
    await h.manager.ensureServer("busy", {});
    h.manager.setBusy("busy", true);
    h.clock.advance(2000); // 越过空闲阈值
    h.manager.markActive("busy"); // busy 的刷新活跃(且 busy=true)
    h.manager.sweepIdle();
    expect(h.manager.has("idle")).toBe(false); // 空闲被回收
    expect(h.manager.has("busy")).toBe(true); // busy 保留
  });

  it("并发上限:达上限新建时 LRU 驱逐最久未活跃的空闲 server", async () => {
    const h = makeHarness({ maxServers: 2 });
    await h.manager.ensureServer("a", {});
    h.clock.advance(10);
    await h.manager.ensureServer("b", {});
    h.clock.advance(10);
    // 新建 c → 应驱逐最久未活跃的 a
    await h.manager.ensureServer("c", {});
    expect(h.manager.has("a")).toBe(false);
    expect(h.manager.has("b")).toBe(true);
    expect(h.manager.has("c")).toBe(true);
    expect(h.manager.size()).toBe(2);
  });
});

describe("U4 盲区补点落盘", () => {
  // 取某条 warn/debug 日志的第二参(结构化 data),便于断言落盘内容。
  const warnArg = (msg: string) => logMocks.logger.warn.mock.calls.find((c) => c[0] === msg)?.[1];
  const debugArg = (msg: string) => logMocks.logger.debug.mock.calls.find((c) => c[0] === msg)?.[1];

  it("就绪超时 → 记一条 warn(含 sessionId/port/timeoutMs)", async () => {
    logMocks.logger.warn.mockReset();
    const h = makeHarness();
    h.setReady(false);
    const p = h.manager.ensureServer("s1", {});
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      h.clock.advance(500);
    }
    await expect(p).rejects.toThrow(/就绪超时/);
    expect(warnArg("codex app-server 就绪超时")).toMatchObject({ sessionId: "s1", timeoutMs: 1000 });
  });

  it("旧版不支持(启动即退出)→ 记一条 warn(unsupported=true)", async () => {
    logMocks.logger.warn.mockReset();
    const h = makeHarness({ probeReady: async () => false });
    const p = h.manager.ensureServer("s1", {});
    await Promise.resolve();
    h.spawned[0].fake.emitStderr("error: unrecognized subcommand 'app-server'");
    h.spawned[0].fake.triggerExit(2);
    await expect(p).rejects.toThrow(/升级 codex/);
    expect(warnArg("codex app-server 启动即退出")).toMatchObject({ sessionId: "s1", unsupported: true });
  });

  it("LRU 驱逐 → 记一条 debug(含被驱逐 sessionId)", async () => {
    logMocks.logger.debug.mockReset();
    const h = makeHarness({ maxServers: 2 });
    await h.manager.ensureServer("a", {});
    h.clock.advance(10);
    await h.manager.ensureServer("b", {});
    h.clock.advance(10);
    await h.manager.ensureServer("c", {});
    expect(debugArg("codex app-server LRU 驱逐")).toMatchObject({ sessionId: "a" });
  });

  it("空闲驱逐 → 记一条 debug(含被驱逐 sessionId)", async () => {
    logMocks.logger.debug.mockReset();
    const h = makeHarness({ idleEvictMs: 1000 });
    await h.manager.ensureServer("idle", {});
    h.clock.advance(2000);
    h.manager.sweepIdle();
    expect(debugArg("codex app-server 空闲驱逐")).toMatchObject({ sessionId: "idle" });
  });
});
