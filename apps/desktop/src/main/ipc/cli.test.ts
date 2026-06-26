// cli.ts 子进程单测：三种 agent（claude/codex/pi）统一走 child_process.spawn(cmd, args);
// 以及 spawnEnvFor 的环境定制（pi 注入 CORTEX_PI_KEY、清 ELECTRON_RUN_AS_NODE）。
// electron / child_process 在测试环境整体 mock。

import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const spawnMock = vi.fn();
const traceMock = vi.hoisted(() => vi.fn());
const streamDeltaMock = vi.hoisted(() => vi.fn());
const ipcHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
// U2/U4 接线 mock:MCP 配置读取/注入、会话存在性。
const m = vi.hoisted(() => ({
  getPersistedState: vi.fn(async () => ({ generalSettings: {} as Record<string, unknown> })),
  applyClaudeMcp: vi.fn(async () => "skip"),
  buildCodexMcpArgs: vi.fn(() => [] as string[]),
  agentSessionExists: vi.fn(() => true),
}));

vi.mock("./store", () => ({ getPersistedState: m.getPersistedState }));
vi.mock("./mcp-config", () => ({
  applyClaudeMcp: m.applyClaudeMcp,
  buildCodexMcpArgs: m.buildCodexMcpArgs,
  CODEX_MCP_CLEAR: ["-c", "mcp_servers={}"],
}));
vi.mock("./session-trim", () => ({
  agentSessionExists: m.agentSessionExists,
  trimAgentSession: vi.fn(async () => false),
}));

vi.mock("electron", () => ({
  app: { getAppPath: () => "/fake/app", isPackaged: false },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("./agent-trace", () => ({
  recordAgentTrace: (...args: unknown[]) => traceMock(...args),
  recordStreamDelta: (...args: unknown[]) => streamDeltaMock(...args),
}));

// codex ws 传输:在 cli.ts 单测里把 ws 编排 stub 掉,只验证 cli:start 的分流接线(ws 机制本身由
// codex-ws-run.test.ts / codex-app-server.test.ts / codex-ws-channel.test.ts 覆盖)。否则 codex 主会话
// 会触发真实后台 app-server spawn + /readyz 轮询,污染单测且泄漏定时器。
const startCodexWsRunMock = vi.hoisted(() => vi.fn());
vi.mock("./codex-ws-run", () => ({
  startCodexWsRun: (...args: unknown[]) => {
    startCodexWsRunMock(...args);
    return { pid: undefined, stdout: null, stderr: null, onExit() {}, onError() {}, kill() {} };
  },
}));

import {
  detectAgents,
  envForCommand,
  mergePathWithPreferredDirs,
  nvmBinDirs,
  resetAgentDetectionForTest,
  registerCliHandlers,
  startAgentProcess,
  spawnEnvFor,
  spawnEnvForDef,
} from "./cli";
import { PI_KEY_ENV } from "../agents/pi-providers";

// child_process.spawn 返回值的最小替身。
function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 123,
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    kill: vi.fn(),
  });
}

beforeEach(() => {
  resetAgentDetectionForTest();
  ipcHandlers.clear();
  traceMock.mockReset();
  streamDeltaMock.mockReset();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild());
  m.getPersistedState.mockReset().mockResolvedValue({ generalSettings: {} });
  m.applyClaudeMcp.mockReset().mockResolvedValue("skip");
  m.buildCodexMcpArgs.mockReset().mockReturnValue([]);
  m.agentSessionExists.mockReset().mockReturnValue(true);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

// claude/codex 经 detect 探针(claude+codex --version)后才 spawn run;辅助:发起 cli:start,
// 关闭两个探针使 detect 通过,返回 run 子进程已 spawn 后的状态。
async function startWithDetect(
  agent: "claude" | "codex",
  req: Record<string, unknown>,
  send: (...a: unknown[]) => void,
) {
  const claudeProbe = fakeChild();
  const codexProbe = fakeChild();
  const run = fakeChild();
  spawnMock.mockReturnValueOnce(claudeProbe).mockReturnValueOnce(codexProbe).mockReturnValueOnce(run);
  registerCliHandlers();
  const p = ipcHandlers.get("cli:start")?.({ sender: { isDestroyed: () => false, send } }, { agent, ...req });
  claudeProbe.emit("close", 0);
  codexProbe.emit("close", 0);
  await p;
  return run;
}

describe("cli:start MCP 接线 + 续接回退(M2 U2/U4)", () => {
  it("claude 启用 MCP → 调用 applyClaudeMcp(cwd, 配置)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-mcpwire-"));
    const mcp = { enabled: true, servers: [{ id: "fs", transport: "stdio", command: "/bin/fs" }] };
    m.getPersistedState.mockResolvedValue({ generalSettings: { mcp } });
    try {
      await startWithDetect("claude", { runId: "m1", sessionId: "s", cwd, prompt: "hi" }, vi.fn());
      expect(m.applyClaudeMcp).toHaveBeenCalledWith(cwd, mcp);
      expect(m.buildCodexMcpArgs).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("codex 启用 MCP → buildCodexMcpArgs 算出 mcpArgs 交 ws 编排(非 applyClaudeMcp)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-mcpwire2-"));
    m.getPersistedState.mockResolvedValue({ generalSettings: { mcp: { enabled: true, servers: [] } } });
    m.buildCodexMcpArgs.mockReturnValue(["-c", 'mcp_servers.fs.command="/bin/fs"']);
    startCodexWsRunMock.mockClear();
    try {
      // codex 主会话走 ws:mcpArgs 经 startCodexWsRun 透传给 app-server(不再 spawn `codex exec`)。
      await startWithDetect("codex", { runId: "m2", sessionId: "s", cwd, prompt: "hi" }, vi.fn());
      expect(m.buildCodexMcpArgs).toHaveBeenCalled();
      expect(m.applyClaudeMcp).not.toHaveBeenCalled();
      expect(startCodexWsRunMock).toHaveBeenCalledWith(
        expect.objectContaining({ mcpArgs: ["-c", 'mcp_servers.fs.command="/bin/fs"'] }),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("续接回退(spawn agent):resumeSessionId 但会话不存在 → 清除、发 trace、spawn 不含该 id", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-fallback-"));
    m.agentSessionExists.mockReturnValue(false);
    try {
      // 用 claude(spawn 传输)验证通用磁盘回退仍生效。
      await startWithDetect("claude", { runId: "f1", sessionId: "s", cwd, prompt: "hi", resumeSessionId: "dead-id" }, vi.fn());
      expect(traceMock).toHaveBeenCalledWith(expect.objectContaining({ phase: "resume-fallback" }));
      const runArgs = spawnMock.mock.calls[2]?.[1] as string[];
      expect(runArgs).not.toContain("dead-id"); // 干净新建,不带失效 id
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("续接回退不触发(spawn agent):会话存在时保留 resume id", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-fallback2-"));
    m.agentSessionExists.mockReturnValue(true);
    try {
      await startWithDetect("claude", { runId: "f2", sessionId: "s", cwd, prompt: "hi", resumeSessionId: "live-id" }, vi.fn());
      expect(traceMock).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "resume-fallback" }));
      const runArgs = spawnMock.mock.calls[2]?.[1] as string[];
      expect(runArgs).toContain("live-id");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("codex ws 跳过磁盘 resume 回退:会话不存在也不清除 id、不发 fallback trace(U6)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-wsresume-"));
    m.agentSessionExists.mockReturnValue(false); // 磁盘无该会话
    startCodexWsRunMock.mockClear();
    try {
      await startWithDetect("codex", { runId: "f3", sessionId: "s", cwd, prompt: "hi", resumeSessionId: "thr_x" }, vi.fn());
      // ws 路径不走磁盘检查:无 resume-fallback trace,且 resumeSessionId 原样交给 ws 编排(由 thread/resume 处理)。
      expect(traceMock).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "resume-fallback" }));
      expect(startCodexWsRunMock).toHaveBeenCalledWith(
        expect.objectContaining({ req: expect.objectContaining({ resumeSessionId: "thr_x" }) }),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("cli:start trace", () => {
  it("记录启动、解析事件、stderr 和退出 trace", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-cli-trace-"));
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    registerCliHandlers();
    const send = vi.fn();

    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send } },
        {
          runId: "run-1",
          sessionId: "session-1",
          agent: "pi",
          cwd,
          prompt: "hello",
        },
      );

      child.stdout.emit("data", JSON.stringify({ type: "session", id: "pi-session" }) + "\n");
      child.stdout.emit(
        "data",
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "hi" },
        }) + "\n",
      );
      child.stderr.emit("data", "warn line\n");
      child.emit("close", 0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }

    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "cli", phase: "start", runId: "run-1", sessionId: "session-1", agent: "pi" }),
    );
    // session → init 仍走普通 trace(phase:event);text 增量改走合并段(recordStreamDelta)。
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "cli", phase: "event", runId: "run-1", sessionId: "session-1", agent: "pi" }),
    );
    expect(streamDeltaMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "cli", segmentType: "text", delta: "hi", runId: "run-1", agent: "pi" }),
    );
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "cli", phase: "stderr", data: expect.objectContaining({ chunk: "warn line\n" }) }),
    );
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "cli", phase: "exit", data: expect.objectContaining({ code: 0 }) }),
    );
  });
});

describe("cli:oneshot trace", () => {
  it("记录 oneshot start/event/stderr/exit trace", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-oneshot-trace-"));
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    registerCliHandlers();

    try {
      const promise = ipcHandlers.get("cli:oneshot")?.(
        {},
        {
          agent: "pi",
          cwd,
          prompt: "生成标题",
        },
      ) as Promise<string>;
      await Promise.resolve();

      child.stdout.emit(
        "data",
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "标题" },
        }) + "\n",
      );
      child.stderr.emit("data", "warn\n");
      child.emit("close", 0);

      await expect(promise).resolves.toBe("标题");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }

    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "oneshot", phase: "start", sessionId: "oneshot", agent: "pi" }),
    );
    // text 增量改走合并段(recordStreamDelta),不再每增量一条普通 trace。
    expect(streamDeltaMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "oneshot", segmentType: "text", delta: "标题", sessionId: "oneshot", agent: "pi" }),
    );
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "oneshot", phase: "stderr", data: expect.objectContaining({ chunk: "warn\n" }) }),
    );
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "oneshot", phase: "exit", data: expect.objectContaining({ code: 0 }) }),
    );
  });
});

describe("cli:start 活跃度看门狗(U5)", () => {
  it("无活动超阈值 → 杀进程并补发带超时标识的 cli:exit", async () => {
    vi.useFakeTimers();
    process.env.CORTEX_CLI_INACTIVITY_TIMEOUT_MS = "5000";
    const cwd = mkdtempSync(join(tmpdir(), "cortex-wd-"));
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    registerCliHandlers();
    const send = vi.fn();
    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send } },
        { runId: "wd-1", sessionId: "s", agent: "pi", cwd, prompt: "hi" },
      );
      vi.advanceTimersByTime(5001); // 超阈值,看门狗触发 proc.kill()
      child.emit("close", null); // 子进程被信号杀后 close → onExit 补发 cli:exit
      expect(send).toHaveBeenCalledWith(
        "cli:exit",
        expect.objectContaining({ runId: "wd-1", error: expect.stringContaining("超时") }),
      );
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
      delete process.env.CORTEX_CLI_INACTIVITY_TIMEOUT_MS;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("阈值内有 stdout 活动 → 重置看门狗,不误杀", async () => {
    vi.useFakeTimers();
    process.env.CORTEX_CLI_INACTIVITY_TIMEOUT_MS = "5000";
    const cwd = mkdtempSync(join(tmpdir(), "cortex-wd2-"));
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    registerCliHandlers();
    const send = vi.fn();
    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send } },
        { runId: "wd-2", sessionId: "s", agent: "pi", cwd, prompt: "hi" },
      );
      vi.advanceTimersByTime(4000);
      child.stdout.emit("data", JSON.stringify({ type: "session", id: "x" }) + "\n"); // 活动,重置
      vi.advanceTimersByTime(4000); // 距上次活动仅 4s < 5s,不应触发
      expect(send).not.toHaveBeenCalledWith("cli:exit", expect.anything());
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
      delete process.env.CORTEX_CLI_INACTIVITY_TIMEOUT_MS;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("cli:start 安全重试(U7)", () => {
  it("首事件前瞬态失败(非零退出 + 无输出)→ 退避后重试一次,不提前发终态", async () => {
    vi.useFakeTimers();
    const cwd = mkdtempSync(join(tmpdir(), "cortex-retry-"));
    const child1 = fakeChild();
    const child2 = fakeChild();
    spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    registerCliHandlers();
    const send = vi.fn();
    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send } },
        { runId: "rt-1", sessionId: "s", agent: "pi", cwd, prompt: "hi" },
      );
      child1.stderr.emit("data", "fetch failed: ECONNRESET\n"); // 瞬态上游错误
      child1.emit("close", 1); // 非零退出,无任何输出 → 触发重试
      // 立即广播 retry 事件;但重 spawn 有退避,尚未发生,也未发终态 cli:exit。
      const retryEvent = send.mock.calls.find((c) => c[0] === "cli:event" && c[1]?.event?.type === "retry");
      expect(retryEvent?.[1].event).toMatchObject({ type: "retry", attempt: 1 });
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalledWith("cli:exit", expect.anything());
      vi.advanceTimersByTime(800); // 退避到期 → 第二次 spawn
      expect(spawnMock).toHaveBeenCalledTimes(2);
      child2.emit("close", 0); // 第二次成功收尾 → 终态 cli:exit
      expect(send).toHaveBeenCalledWith("cli:exit", expect.objectContaining({ runId: "rt-1", code: 0 }));
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("取消(cli:kill)后即便子进程非零退出也不重试 —— 直接终态", async () => {
    vi.useFakeTimers();
    const cwd = mkdtempSync(join(tmpdir(), "cortex-retry3-"));
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    registerCliHandlers();
    const send = vi.fn();
    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send } },
        { runId: "rt-3", sessionId: "s", agent: "pi", cwd, prompt: "hi" },
      );
      ipcHandlers.get("cli:kill")?.({}, "rt-3"); // 用户取消
      child.stderr.emit("data", "fetch failed: ECONNRESET\n"); // 瞬态文本(诱导误重试)
      child.emit("close", 1); // 捕获 SIGTERM 后非零退出
      vi.advanceTimersByTime(800);
      expect(spawnMock).toHaveBeenCalledTimes(1); // 未重试
      expect(send).toHaveBeenCalledWith("cli:exit", expect.objectContaining({ runId: "rt-3", code: 1 }));
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("spawn 失败时 error+close 都触发,只发一次终态 cli:exit(settled 守卫)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-retry4-"));
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    registerCliHandlers();
    const send = vi.fn();
    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send } },
        { runId: "rt-4", sessionId: "s", agent: "pi", cwd, prompt: "hi" },
      );
      child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
      child.emit("close", null); // Node 在 error 后还会触发 close
      const exits = send.mock.calls.filter((c) => c[0] === "cli:exit" && c[1]?.runId === "rt-4");
      expect(exits).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("已产生可见文本后失败 → 不重试(直接终态)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-retry2-"));
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    registerCliHandlers();
    const send = vi.fn();
    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send } },
        { runId: "rt-2", sessionId: "s", agent: "pi", cwd, prompt: "hi" },
      );
      // 先产出可见文本(pi text_delta),再非零退出。
      child.stdout.emit("data", JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }) + "\n");
      child.stderr.emit("data", "fetch failed: ECONNRESET\n");
      child.emit("close", 1);
      expect(spawnMock).toHaveBeenCalledTimes(1); // 未重试
      expect(send).toHaveBeenCalledWith("cli:exit", expect.objectContaining({ runId: "rt-2", code: 1 }));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startAgentProcess", () => {
  it("pi → child_process.spawn(二进制, args, stdio=[ignore,pipe,pipe])", () => {
    startAgentProcess("/res/pi/pi", ["--mode", "json", "-p", "hello"], {
      cwd: "/proj",
      env: { FOO: "1" } as NodeJS.ProcessEnv,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe("/res/pi/pi");
    expect(args).toEqual(["--mode", "json", "-p", "hello"]);
    expect(opts).toMatchObject({ cwd: "/proj", stdio: ["ignore", "pipe", "pipe"] });
  });

  it("claude → child_process.spawn(cmd, args)（与 pi 同路径）", () => {
    startAgentProcess("claude", ["-p", "hi"], { cwd: "/proj", env: {} as NodeJS.ProcessEnv });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args).toEqual(["-p", "hi"]);
    expect(opts).toMatchObject({ cwd: "/proj", stdio: ["ignore", "pipe", "pipe"] });
  });

  it("spawn 带 detached(非 win)+ shell:false,用于进程组取消", () => {
    startAgentProcess("/res/pi/pi", ["hi"], { cwd: "/p", env: {} as NodeJS.ProcessEnv });
    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts).toMatchObject({ shell: false, detached: process.platform !== "win32" });
  });

  it("有 stdin 负载:stdio[0]=pipe,写入 prompt 并 end()(U4)", () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 1,
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      kill: vi.fn(),
    });
    spawnMock.mockReturnValueOnce(child);
    startAgentProcess("claude", ["-p"], { cwd: "/p", env: {} as NodeJS.ProcessEnv, stdin: "PAYLOAD" });
    const [, , opts] = spawnMock.mock.calls[0] as [unknown, unknown, { stdio: unknown[] }];
    expect(opts.stdio[0]).toBe("pipe");
    expect(child.stdin.end).toHaveBeenCalledWith("PAYLOAD", "utf8");
    // U8:stdin EPIPE/EOF 静默吞掉(子进程提前退出),其余错误才告警。
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(warnSpy).not.toHaveBeenCalled();
    child.stdin.emit("error", Object.assign(new Error("boom"), { code: "EACCES" }));
    expect(warnSpy).toHaveBeenCalled();
  });

  it("无 stdin 负载:stdio[0]=ignore(pi,prompt 在 argv)", () => {
    startAgentProcess("/res/pi/pi", ["hi"], { cwd: "/p", env: {} as NodeJS.ProcessEnv });
    const [, , opts] = spawnMock.mock.calls[0] as [unknown, unknown, { stdio: unknown[] }];
    expect(opts.stdio[0]).toBe("ignore");
  });

  it("kill() 非 win 走进程组信号 process.kill(-pgid, SIGTERM);win 直接 child.kill", () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    // mock process.kill 避免向真实进程/进程组发信号(fakeChild.pid=123)。
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    const proc = startAgentProcess("/res/pi/pi", ["hi"], { cwd: "/p", env: {} as NodeJS.ProcessEnv });
    proc.kill();
    if (process.platform === "win32") {
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } else {
      expect(killSpy).toHaveBeenCalledWith(-123, "SIGTERM"); // -pgid 杀整组
      expect(child.kill).not.toHaveBeenCalled();
    }
    child.emit("close", 0); // 清理 3s 兜底 SIGKILL timer
    killSpy.mockRestore();
  });

  it("kill() 进程组信号抛错(未成组/已退出)时回退到 child.kill", () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    const proc = startAgentProcess("/res/pi/pi", ["hi"], { cwd: "/p", env: {} as NodeJS.ProcessEnv });
    proc.kill();
    // 非 win:process.kill(-pgid) 抛错 → 回退 child.kill;win:本就直接 child.kill。
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", 0);
    killSpy.mockRestore();
  });

  it("把命中的 CLI 目录提到 PATH 最前，确保 shebang 使用同目录 node", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cli-path-"));
    try {
      const oldBin = join(root, "old-bin");
      const codexBin = join(root, "node20-bin");
      mkdirSync(oldBin);
      mkdirSync(codexBin);
      writeFileSync(join(oldBin, "node"), "");
      writeFileSync(join(codexBin, "node"), "");
      writeFileSync(join(codexBin, "codex"), "");

      const env = envForCommand("codex", {
        PATH: [oldBin, codexBin].join(delimiter),
      } as NodeJS.ProcessEnv);

      expect(env.PATH?.split(delimiter).slice(0, 2)).toEqual([codexBin, oldBin]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("绝对路径 CLI 也会把自身目录提到 PATH 最前", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cli-abs-"));
    try {
      const oldBin = join(root, "old-bin");
      const codexBin = join(root, "node20-bin");
      mkdirSync(oldBin);
      mkdirSync(codexBin);
      const codex = join(codexBin, "codex");
      writeFileSync(join(oldBin, "node"), "");
      writeFileSync(join(codexBin, "node"), "");
      writeFileSync(codex, "");

      const env = envForCommand(codex, {
        PATH: oldBin,
      } as NodeJS.ProcessEnv);

      expect(env.PATH?.split(delimiter).slice(0, 2)).toEqual([codexBin, oldBin]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("PATH 上命中的 CLI 用绝对路径 spawn,避免 GUI 环境再次搜索失败", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cli-resolve-"));
    try {
      const codexBin = join(root, "node-bin");
      mkdirSync(codexBin);
      const codex = join(codexBin, "codex");
      writeFileSync(codex, "");

      startAgentProcess("codex", ["--version"], {
        cwd: "/proj",
        env: { PATH: codexBin } as NodeJS.ProcessEnv,
      });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]?.[0]).toBe(realpathSync(codex));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("nvm 安装的 Node 脚本 CLI 用同目录 node 执行,避开 shebang ENOENT", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cli-node-script-"));
    try {
      const bin = join(root, "bin");
      const lib = join(root, "lib");
      mkdirSync(bin);
      mkdirSync(lib);
      const node = join(bin, "node");
      const script = join(lib, "codex.js");
      writeFileSync(node, "");
      writeFileSync(script, "#!/usr/bin/env node\nconsole.log('codex')\n");
      symlinkSync("../lib/codex.js", join(bin, "codex"));

      startAgentProcess("codex", ["--version"], {
        cwd: "/proj",
        env: { PATH: bin } as NodeJS.ProcessEnv,
      });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]?.[0]).toBe(node);
      expect(spawnMock.mock.calls[0]?.[1]).toEqual([realpathSync(script), "--version"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("symlink 到原生二进制的 CLI 用 realpath spawn", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cli-realpath-"));
    try {
      const bin = join(root, "bin");
      const versions = join(root, "versions");
      mkdirSync(bin);
      mkdirSync(versions);
      const realClaude = join(versions, "claude-2.1");
      writeFileSync(realClaude, "");
      symlinkSync("../versions/claude-2.1", join(bin, "claude"));

      startAgentProcess("claude", ["--version"], {
        cwd: "/proj",
        env: { PATH: bin } as NodeJS.ProcessEnv,
      });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]?.[0]).toBe(realpathSync(realClaude));
      expect(spawnMock.mock.calls[0]?.[1]).toEqual(["--version"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("spawnEnvFor", () => {
  it("pi:不注入 ELECTRON_RUN_AS_NODE,注入 PI key", () => {
    const env = spawnEnvFor({ agent: "pi", provider: { apiKey: "sk-test" } });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env[PI_KEY_ENV]).toBe("sk-test");
  });

  it("pi 无供应商:无 PI key,也无 ELECTRON_RUN_AS_NODE", () => {
    const env = spawnEnvFor({ agent: "pi" });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env[PI_KEY_ENV]).toBeUndefined();
  });

  it("claude:基础 env,不含 PI key", () => {
    const env = spawnEnvFor({ agent: "claude" });
    expect(env[PI_KEY_ENV]).toBeUndefined();
  });
});

describe("spawnEnvForDef(M3-A 派生 env 注入)", () => {
  it("def.extraEnv 合并进 env,覆盖同名键", () => {
    const env = spawnEnvForDef({ agent: "my-claude" }, { extraEnv: { ANTHROPIC_BASE_URL: "https://x", PATH: "/only" } });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://x");
    expect(env.PATH).toBe("/only"); // profile 显式覆盖基础 PATH
  });

  it("无 extraEnv 等价于 spawnEnvFor", () => {
    const env = spawnEnvForDef({ agent: "claude" }, {});
    expect(env[PI_KEY_ENV]).toBeUndefined();
    expect(env.PATH).toBeDefined();
  });
});

describe("buildEnv helpers", () => {
  it("nvm bin 目录按版本从新到旧排序,避免旧 CLI wrapper 抢先", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-nvm-sort-"));
    try {
      mkdirSync(join(root, ".nvm", "versions", "node", "v20.19.4", "bin"), { recursive: true });
      mkdirSync(join(root, ".nvm", "versions", "node", "v20.19.5", "bin"), { recursive: true });
      mkdirSync(join(root, ".nvm", "versions", "node", "v24.15.0", "bin"), { recursive: true });

      expect(nvmBinDirs(root).map((dir) => dir.replace(`${root}/.nvm/versions/node/`, ""))).toEqual([
        "v24.15.0/bin",
        "v20.19.5/bin",
        "v20.19.4/bin",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("PATH 合并时优先使用补齐的用户安装目录", () => {
    const merged = mergePathWithPreferredDirs("/stale-node/bin:/usr/bin", [
      "/Users/me/.local/bin",
      "/fresh-node/bin",
      "/usr/bin",
    ]);

    expect(merged.split(delimiter)).toEqual(["/Users/me/.local/bin", "/fresh-node/bin", "/usr/bin", "/stale-node/bin"]);
  });
});

describe("detectAgents", () => {
  it("claude/codex 都能 --version 退出 0 时标记可用,pi 恒可用", async () => {
    const claude = fakeChild();
    const codex = fakeChild();
    spawnMock.mockImplementationOnce(() => claude).mockImplementationOnce(() => codex);

    const resultPromise = detectAgents();
    claude.emit("close", 0);
    codex.emit("close", 0);

    await expect(resultPromise).resolves.toEqual({ claude: true, codex: true, pi: true });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(["--version"]);
    expect(String(spawnMock.mock.calls[1]?.[0])).toMatch(/(^|[/\\])(codex|node)(\.cmd|\.exe|\.bat)?$/);
    expect(spawnMock.mock.calls[1]?.[1]).toContain("--version");
  });

  it("非 0 退出或 spawn error 时标记不可用", async () => {
    const claude = fakeChild();
    const codex = fakeChild();
    spawnMock.mockImplementationOnce(() => claude).mockImplementationOnce(() => codex);

    const resultPromise = detectAgents();
    claude.stderr.emit("data", "bad credentials\n");
    claude.emit("close", 1);
    codex.emit("error", new Error("ENOENT"));

    await expect(resultPromise).resolves.toEqual({ claude: false, codex: false, pi: true });
  });

  it("同一进程生命周期内缓存验证结果,后续 detect 不重复 spawn", async () => {
    const claude = fakeChild();
    const codex = fakeChild();
    spawnMock.mockImplementationOnce(() => claude).mockImplementationOnce(() => codex);

    const first = detectAgents();
    claude.emit("close", 0);
    codex.emit("close", 0);
    await expect(first).resolves.toEqual({ claude: true, codex: true, pi: true });

    await expect(detectAgents()).resolves.toEqual({ claude: true, codex: true, pi: true });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
