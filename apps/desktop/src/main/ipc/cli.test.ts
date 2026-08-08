// cli.ts 单测：claude/codex 走 child_process.spawn(cmd, args)；pi 无外部二进制,
// 无条件走 in-process 单发(startPiInProcOneShot,此处 mock 成可驱动的假 AgentProcess)。
// electron / child_process 在测试环境整体 mock。

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  resolveAgentBrowserBinary: vi.fn(() => "/app/agent-browser" as string | null),
  buildAgentBrowserMcpServerConfig: vi.fn(() => ({
    id: "agent-browser",
    transport: "stdio",
    command: "/app/agent-browser",
    args: ["mcp", "--tools", "all"],
  }) as unknown),
  migrateLegacyAgentBrowserMcp: vi.fn((settings: unknown) => settings),
  agentSessionExists: vi.fn(() => true),
  buildResearchMcpServerConfig: vi.fn(
    (_settings: unknown, _sessionId?: unknown, _consumer?: unknown, _optIn?: unknown) =>
      null as unknown,
  ),
}));

// mock ../log:避免加载真 electron-log,并断言 scoped logger 承接了原 console 调用。
const logMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  verbose: vi.fn(),
  debug: vi.fn(),
  silly: vi.fn(),
}));
vi.mock("../log", () => ({
  createLogger: () => logMock,
  isDevEnv: () => true,
}));

vi.mock("./store", () => ({ getPersistedState: m.getPersistedState }));
vi.mock("./mcp-config", () => ({
  applyClaudeMcp: m.applyClaudeMcp,
  buildCodexMcpArgs: m.buildCodexMcpArgs,
  CODEX_MCP_CLEAR: ["-c", "mcp_servers={}"],
  effectiveEnv: () => undefined,
  isValidServerId: () => true,
}));
vi.mock("./session-trim", () => ({
  agentSessionExists: m.agentSessionExists,
  trimAgentSession: vi.fn(async () => false),
}));
vi.mock("../capabilities/agent-browser/locate", () => ({ resolveAgentBrowserBinary: m.resolveAgentBrowserBinary }));
vi.mock("../capabilities/agent-browser/inject", () => ({
  buildAgentBrowserMcpServerConfig: m.buildAgentBrowserMcpServerConfig,
  migrateLegacyAgentBrowserMcp: m.migrateLegacyAgentBrowserMcp,
}));
vi.mock("../capabilities/research/inject", () => ({
  buildResearchMcpServerConfig: (
    settings: unknown,
    sessionId?: unknown,
    consumer?: unknown,
    optIn?: unknown,
  ) => m.buildResearchMcpServerConfig(settings, sessionId, consumer, optIn),
}));

// U2 claude 桥接接线单测:mock 掉 buildClaudeSkillBridge 本体(其自身行为已由 claude-bridge.test.ts
// 覆盖),这里只验证 cli.ts 的守卫条件/降级路径是否正确调用它、正确写回 req.skillsBridgeDir。
const buildClaudeSkillBridgeMock = vi.hoisted(() => vi.fn());
vi.mock("../skills/claude-bridge", () => ({
  buildClaudeSkillBridge: (...args: unknown[]) => buildClaudeSkillBridgeMock(...args),
}));

const designDelegateState = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}));
vi.mock("../capabilities/design-delegate/server", () => ({
  ensureDesignDelegateMcpServerConfig: vi.fn(async () => null),
  registerDesignDelegateSession: vi.fn((state: unknown) => {
    designDelegateState.current = state as Record<string, unknown>;
  }),
  unregisterDesignDelegateSession: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getAppPath: () => "/fake/app", getPath: () => "/tmp/cortex-test-userData", isPackaged: false },
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

// pi 单发引擎 mock：cli.ts 对 pi 恒调 startPiInProcOneShot（不 spawn）。测试里换成
// 可驱动的假 AgentProcess（stdout/stderr 事件 + close/error），并记录 (req, opts) 供断言。
const oneshotMock = vi.hoisted(() => vi.fn());
vi.mock("../agents/pi-inproc/oneshot", () => ({
  startPiInProcOneShot: (...args: unknown[]) => oneshotMock(...args),
}));

import {
  __runDelegateSubAgentForTest,
  detectAgents,
  ensureProcessPath,
  envForCommand,
  mergePathWithPreferredDirs,
  nvmBinDirs,
  resetAgentDetectionForTest,
  registerCliHandlers,
  resolveSpawnCwd,
  startAgentProcess,
  spawnEnvFor,
  spawnEnvForDef,
} from "./cli";
import { setLocalAgentProfilesLoader } from "../agents";
import { killAllDelegates, stopDelegateHost } from "../capabilities/delegate/server";

// child_process.spawn 返回值的最小替身。
function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 123,
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    kill: vi.fn(),
  });
}

// pi 单发 mock 的驱动记录：每次 startPiInProcOneShot 调用产生一个可驱动的 fakeChild。
const piProcs: Array<{ child: ReturnType<typeof fakeChild>; req: unknown; opts: unknown }> = [];

// 把 fakeChild 包成 AgentProcess 形状（对应真实 oneshot 返回的垫层接口）。
function wrapFakeAgentProc(child: ReturnType<typeof fakeChild>) {
  return {
    pid: undefined,
    stdout: child.stdout,
    stderr: child.stderr,
    onExit: (cb: (code: number | null) => void) => child.on("close", cb),
    onError: (cb: (err: Error) => void) => child.on("error", cb),
    kill: child.kill,
  };
}

// 等待第 i 个 pi 单发被拉起（handler 内部有若干 await,给足微任务轮次）。
async function nextPiProc(i = 0) {
  for (let k = 0; k < 50 && piProcs.length <= i; k++) await Promise.resolve();
  const entry = piProcs[i];
  if (!entry) throw new Error(`pi 单发 #${i} 未被拉起`);
  return entry;
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
  m.resolveAgentBrowserBinary.mockReset().mockReturnValue("/app/agent-browser");
  m.buildAgentBrowserMcpServerConfig.mockReset().mockReturnValue({
    id: "agent-browser",
    transport: "stdio",
    command: "/app/agent-browser",
    args: ["mcp", "--tools", "all"],
  });
  m.migrateLegacyAgentBrowserMcp.mockReset().mockImplementation((settings) => settings);
  m.agentSessionExists.mockReset().mockReturnValue(true);
  m.buildResearchMcpServerConfig.mockReset().mockReturnValue(null);
  buildClaudeSkillBridgeMock.mockReset().mockReturnValue(undefined);
  piProcs.length = 0;
  oneshotMock.mockReset().mockImplementation((req: unknown, opts: unknown) => {
    const child = fakeChild();
    piProcs.push({ child, req, opts });
    return wrapFakeAgentProc(child);
  });
  designDelegateState.current = null;
  killAllDelegates();
  stopDelegateHost();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  killAllDelegates();
  stopDelegateHost();
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
      expect(m.applyClaudeMcp).toHaveBeenCalledWith(cwd, {
        enabled: true,
        // 内置注入面:agent-browser + 语音助手控制工具(常驻聊天路径,执行面按语音激活态门控)。
        servers: [
          ...mcp.servers,
          expect.objectContaining({ id: "agent-browser" }),
          expect.objectContaining({ id: "cortex-voice-assistant" }),
        ],
      });
      expect(m.buildCodexMcpArgs).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("默认给 Claude 注入内置 agent-browser，并标记为预授权 MCP", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-agent-browser-"));
    try {
      await startWithDetect(
        "claude",
        { runId: "ab1", sessionId: "session-1", cwd, prompt: "hi", permissionMode: "accept-edits" },
        vi.fn(),
      );
      expect(m.buildAgentBrowserMcpServerConfig).toHaveBeenCalledWith(
        undefined,
        "session-1",
        "/app/agent-browser",
      );
      expect(m.applyClaudeMcp).toHaveBeenCalledWith(
        cwd,
        expect.objectContaining({
          enabled: true,
          servers: [
            expect.objectContaining({ id: "agent-browser" }),
            expect.objectContaining({ id: "cortex-voice-assistant" }),
          ],
        }),
      );
      const runArgs = spawnMock.mock.calls[2]?.[1] as string[];
      // --allowed-tools 是逗号拼接的单参数,内置 server 全部在列。
      expect(runArgs).toContain("mcp__agent-browser,mcp__cortex-voice-assistant");
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
      expect(traceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "cli",
          phase: "start",
          sessionId: "s",
          data: expect.objectContaining({
            contextMode: "native-resume",
            resumeSessionId: "live-id",
          }),
        }),
      );
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

describe("delegate 派生 agent 基础类型", () => {
  it("派生 Pi 子 agent 继承 Pi 主会话 model/provider 并走 in-process 单发（不 spawn）", async () => {
    setLocalAgentProfilesLoader(() => [{ id: "my-pi", base: "pi" }]);
    const controller = new AbortController();
    try {
      const done = __runDelegateSubAgentForTest(
        {
          runId: "parent-run",
          sessionId: "parent-session",
          agent: "pi",
          cwd: "/tmp",
          prompt: "parent",
          model: "deepseek-v3",
          thinkingLevel: "xhigh",
          provider: {
            id: "deepseek",
            baseUrl: "https://api.example.test",
            apiKey: "secret",
            models: [{ id: "deepseek-v3" }],
          },
        },
        {
          id: "helper",
          label: "Helper",
          agent: "my-pi",
          systemPrompt: "",
          createdAt: "",
          updatedAt: "",
        },
        "分析任务",
        vi.fn(),
        controller.signal,
      );

      const { child, req } = await nextPiProc(0);
      // pi 子 agent 不经 spawn：模型/供应商随请求进 in-process 单发原生解析。
      expect(spawnMock).not.toHaveBeenCalled();
      expect(req).toMatchObject({
        agent: "my-pi",
        model: "deepseek-v3",
        provider: expect.objectContaining({ id: "deepseek" }),
        // pi 主 → pi 子:思考档同体系直传(pi 专属档 xhigh 也保留);effort 对 pi 无意义,恒空。
        thinkingLevel: "xhigh",
        effort: undefined,
      });
      child.emit("close", 0);
      await expect(done).resolves.toMatchObject({ ok: true });
    } finally {
      setLocalAgentProfilesLoader(null);
    }
  });

  it("claude 主 effort 透传为 pi 子 agent 的 thinkingLevel（公共三档同刻度）", async () => {
    const controller = new AbortController();
    const done = __runDelegateSubAgentForTest(
      { runId: "r", sessionId: "s", agent: "claude", cwd: "/tmp", prompt: "parent", effort: "high" },
      { id: "helper", label: "Helper", agent: "pi", systemPrompt: "", createdAt: "", updatedAt: "" },
      "分析任务",
      vi.fn(),
      controller.signal,
    );
    const { child, req } = await nextPiProc(0);
    expect(req).toMatchObject({ thinkingLevel: "high", effort: undefined });
    child.emit("close", 0);
    await expect(done).resolves.toMatchObject({ ok: true });
  });

  it("pi 主 thinkingLevel 只在公共三档映射为 claude/codex 子 agent 的 effort", async () => {
    // 公共档 medium → 映射;pi 专属档 xhigh → 不硬映射(子 agent 用自身默认强度)。
    for (const [level, expected] of [["medium", "medium"], ["xhigh", undefined]] as const) {
      spawnMock.mockClear();
      const child = Object.assign(fakeChild(), {
        stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      });
      spawnMock.mockReturnValueOnce(child);
      const controller = new AbortController();
      const done = __runDelegateSubAgentForTest(
        { runId: "r", sessionId: "s", agent: "pi", cwd: "/tmp", prompt: "parent", thinkingLevel: level },
        { id: "helper", label: "Helper", agent: "codex", systemPrompt: "", createdAt: "", updatedAt: "" },
        "分析任务",
        vi.fn(),
        controller.signal,
      );
      const args = spawnMock.mock.calls[0]?.[1] as string[];
      if (expected) expect(args).toEqual(expect.arrayContaining(["-c", `model_reasoning_effort=${expected}`]));
      else expect(args.join(" ")).not.toContain("model_reasoning_effort");
      child.emit("close", 0);
      await expect(done).resolves.toMatchObject({ ok: true });
    }
  });

  it("派生 Codex 子 agent 仍清空 MCP 并开启诊断日志", async () => {
    setLocalAgentProfilesLoader(() => [{ id: "my-codex", base: "codex" }]);
    const child = Object.assign(fakeChild(), {
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    });
    spawnMock.mockReturnValueOnce(child);
    const controller = new AbortController();
    try {
      const done = __runDelegateSubAgentForTest(
        {
          runId: "parent-run",
          sessionId: "parent-session",
          agent: "claude",
          cwd: "/tmp",
          prompt: "parent",
        },
        {
          id: "helper",
          label: "Helper",
          agent: "my-codex",
          systemPrompt: "",
          createdAt: "",
          updatedAt: "",
        },
        "分析任务",
        vi.fn(),
        controller.signal,
      );

      const args = spawnMock.mock.calls[0]?.[1] as string[];
      const opts = spawnMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
      expect(args).toEqual(expect.arrayContaining(["-c", "mcp_servers={}"]));
      expect(opts.env.RUST_LOG).toBe("info");
      child.emit("close", 0);
      await expect(done).resolves.toMatchObject({ ok: true });
    } finally {
      setLocalAgentProfilesLoader(null);
    }
  });
});

describe("cli:start codex 原生 skill 分流(U4)", () => {
  it("codex ws + invokedSkill → 透传给 startCodexWsRun,不改写 prompt(原生触发)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-skill-ws-"));
    startCodexWsRunMock.mockClear();
    try {
      await startWithDetect(
        "codex",
        { runId: "sk-ws", sessionId: "s", cwd, prompt: "打开 x.com", invokedSkill: { name: "agent-browser", path: "/g/ab" } },
        vi.fn(),
      );
      // ws 路径:invokedSkill 原样交给 ws 编排(buildTurnInput 转原生 skill input item),prompt 未被 prose 改写。
      expect(startCodexWsRunMock).toHaveBeenCalledWith(
        expect.objectContaining({
          req: expect.objectContaining({
            invokedSkill: { name: "agent-browser", path: "/g/ab" },
            prompt: "打开 x.com",
          }),
        }),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("codex 委派(exec)+ invokedSkill → 不走 ws,prompt 改写为 prose 回退(R3 不倒退)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-skill-exec-"));
    const claudeProbe = fakeChild();
    const codexProbe = fakeChild();
    // exec 路径经 stdin 投递 prompt(codex.ts:promptDelivery=stdin-eof),用带 stdin 的替身捕获。
    const run = Object.assign(new EventEmitter(), {
      pid: 42,
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      kill: vi.fn(),
    });
    spawnMock.mockReturnValueOnce(claudeProbe).mockReturnValueOnce(codexProbe).mockReturnValueOnce(run);
    startCodexWsRunMock.mockClear();
    registerCliHandlers();
    const send = vi.fn();
    try {
      const p = ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send } },
        {
          agent: "codex",
          runId: "sk-exec",
          sessionId: "s",
          cwd,
          prompt: "打开 x.com",
          invokedSkill: { name: "agent-browser", path: "/g/ab" },
          delegateRoles: [{ id: "codex", label: "Codex", agent: "codex", systemPrompt: "", createdAt: "", updatedAt: "" }],
        },
      );
      claudeProbe.emit("close", 0);
      codexProbe.emit("close", 0);
      await p;
      // 委派 → 非 ws,不进 startCodexWsRun。
      expect(startCodexWsRunMock).not.toHaveBeenCalled();
      // prose 回退经 stdin 投递:含定向文案 + SKILL.md 路径 + 用户参数(与现状等价)。
      const stdinPayload = (run.stdin.end as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(stdinPayload).toContain("请使用 skill「agent-browser」");
      expect(stdinPayload).toContain("/g/ab/SKILL.md");
      expect(stdinPayload).toContain("打开 x.com");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("codex ws 无 invokedSkill → 行为与改动前一致(prompt 不改写,invokedSkill 不出现)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-skill-none-"));
    startCodexWsRunMock.mockClear();
    try {
      await startWithDetect("codex", { runId: "sk-none", sessionId: "s", cwd, prompt: "hi" }, vi.fn());
      const passed = startCodexWsRunMock.mock.calls[0]?.[0] as { req: Record<string, unknown> };
      expect(passed.req.prompt).toBe("hi");
      expect(passed.req.invokedSkill).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// U2:claude 桥接目录构建的守卫条件 + 降级路径(buildClaudeSkillBridge 本体已由 claude-bridge.test.ts
// 覆盖,这里只测 cli.ts 的接线是否在正确条件下调用它、正确写回 skillsBridgeDir、失败是否降级不阻断)。
describe("cli:start claude 原生 skill 桥接接线(U2)", () => {
  const skillRecords = [{ name: "agent-browser", dir: "/g/ab" }];

  it("useOwnSkills===true 且 skillRecords 非空 → 调用 buildClaudeSkillBridge,--add-dir 追加桥接目录", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-claude-bridge-"));
    buildClaudeSkillBridgeMock.mockReturnValue("/fake/bridge/dir");
    try {
      await startWithDetect(
        "claude",
        { runId: "cb1", sessionId: "s", cwd, prompt: "hi", useOwnSkills: true, skillRecords },
        vi.fn(),
      );
      expect(buildClaudeSkillBridgeMock).toHaveBeenCalledWith(
        skillRecords,
        expect.stringContaining("skill-bridge"),
      );
      const runArgs = spawnMock.mock.calls[2]?.[1] as string[];
      expect(runArgs).toEqual(expect.arrayContaining(["--add-dir", "/fake/bridge/dir"]));
      expect(runArgs).not.toContain("--disable-slash-commands");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("useOwnSkills!==true → 不构建桥接目录,不追加 --add-dir(回归现状)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-claude-bridge2-"));
    try {
      await startWithDetect("claude", { runId: "cb2", sessionId: "s", cwd, prompt: "hi", skillRecords }, vi.fn());
      expect(buildClaudeSkillBridgeMock).not.toHaveBeenCalled();
      const runArgs = spawnMock.mock.calls[2]?.[1] as string[];
      expect(runArgs).toContain("--disable-slash-commands");
      expect(runArgs).not.toContain("--add-dir");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("agent !== claude(codex)→ 即使带 useOwnSkills/skillRecords 也不触发桥接构建", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-claude-bridge3-"));
    startCodexWsRunMock.mockClear();
    try {
      await startWithDetect(
        "codex",
        { runId: "cb3", sessionId: "s", cwd, prompt: "hi", useOwnSkills: true, skillRecords },
        vi.fn(),
      );
      expect(buildClaudeSkillBridgeMock).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("skillRecords 为空数组 → 不构建桥接目录(无需 --add-dir)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-claude-bridge4-"));
    try {
      await startWithDetect(
        "claude",
        { runId: "cb4", sessionId: "s", cwd, prompt: "hi", useOwnSkills: true, skillRecords: [] },
        vi.fn(),
      );
      expect(buildClaudeSkillBridgeMock).not.toHaveBeenCalled();
      const runArgs = spawnMock.mock.calls[2]?.[1] as string[];
      expect(runArgs).not.toContain("--add-dir");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("buildClaudeSkillBridge 抛错 → 仅 warn,继续正常发送、不追加 --add-dir(降级对齐 applyClaudeMcp)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-claude-bridge5-"));
    buildClaudeSkillBridgeMock.mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      await startWithDetect(
        "claude",
        { runId: "cb5", sessionId: "s", cwd, prompt: "hi", useOwnSkills: true, skillRecords },
        vi.fn(),
      );
      expect(logMock.warn).toHaveBeenCalledWith(expect.stringContaining("buildClaudeSkillBridge failed"));
      const runArgs = spawnMock.mock.calls[2]?.[1] as string[];
      expect(runArgs).not.toContain("--add-dir");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("sessionId 含路径穿越字符 → 拼进桥接目录路径前被清洗(安全修复)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-claude-bridge6-"));
    buildClaudeSkillBridgeMock.mockReturnValue("/fake/bridge/dir");
    try {
      await startWithDetect(
        "claude",
        {
          runId: "cb6",
          sessionId: "../../../etc",
          cwd,
          prompt: "hi",
          useOwnSkills: true,
          skillRecords,
        },
        vi.fn(),
      );
      const bridgeRootDir = buildClaudeSkillBridgeMock.mock.calls[0]?.[1] as string;
      expect(bridgeRootDir).not.toContain("..");
      expect(bridgeRootDir.startsWith("/tmp/cortex-test-userData")).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("cli:start trace", () => {
  it("pi slides 联网轮次把 research 合进同一份 bridgeServers", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-pi-slides-research-"));
    const researchSettings = { enabled: true };
    m.getPersistedState.mockResolvedValue({ generalSettings: { researchEngine: researchSettings } });
    m.buildResearchMcpServerConfig.mockReturnValue({
      id: "cortex-research",
      label: "研究引擎（内置）",
      transport: "http",
      url: "http://127.0.0.1:51234/mcp",
    });
    registerCliHandlers();

    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send: vi.fn() } },
        {
          runId: "slides:deck-1:run-1",
          sessionId: "session-slides",
          agent: "pi",
          cwd,
          prompt: "联网查资料",
          webSearch: true,
        },
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }

    expect(m.buildResearchMcpServerConfig).toHaveBeenCalledWith(
      researchSettings,
      "session-slides",
      "slides",
      true,
    );
    // 引擎收敛后不再落盘桥接 .js：research server 以结构化 bridgeServers 交给 in-process 单发。
    expect(oneshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "slides:deck-1:run-1" }),
      expect.objectContaining({
        bridgeServers: expect.arrayContaining([expect.objectContaining({ id: "cortex-research" })]),
      }),
    );
  });

  it("pi slides 缺省联网状态按 false 传给 research gate", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-pi-slides-off-"));
    const researchSettings = { enabled: true };
    m.getPersistedState.mockResolvedValue({ generalSettings: { researchEngine: researchSettings } });
    registerCliHandlers();

    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send: vi.fn() } },
        {
          runId: "slides:deck-2:run-1",
          sessionId: "session-slides-off",
          agent: "pi",
          cwd,
          prompt: "不联网",
        },
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }

    expect(m.buildResearchMcpServerConfig).toHaveBeenCalledWith(
      researchSettings,
      "session-slides-off",
      "slides",
      false,
    );
  });

  it("pi 委派轮次按需启动 delegate host 并注入 ask 工具桥接（bridgeServers）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-pi-delegate-"));
    registerCliHandlers();
    const send = vi.fn();

    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send } },
        {
          runId: "run-delegate",
          sessionId: "session-delegate",
          agent: "pi",
          cwd,
          prompt: "请 @Codex 总结",
          delegateRoles: [
            { id: "codex", label: "Codex", agent: "codex", systemPrompt: "", createdAt: "", updatedAt: "" },
          ],
        },
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }

    expect(oneshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-delegate" }),
      expect.objectContaining({
        bridgeServers: expect.arrayContaining([expect.objectContaining({ id: "cortex-delegate" })]),
      }),
    );
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "delegate",
        phase: "pi-bridge",
        summary: "pi delegate bridge injected",
      }),
    );
  });

  it("pi 委派与 research 合并进同一份 bridgeServers（原生注册统一去重,避免工具重名）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-pi-delegate-research-"));
    m.getPersistedState.mockResolvedValue({ generalSettings: { researchEngine: { enabled: true } } });
    m.buildResearchMcpServerConfig.mockReturnValue({
      id: "cortex-research",
      label: "研究引擎（内置）",
      transport: "http",
      url: "http://127.0.0.1:51234/mcp",
    });
    registerCliHandlers();

    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send: vi.fn() } },
        {
          runId: "run-delegate-research",
          sessionId: "session-delegate-research",
          agent: "pi",
          cwd,
          prompt: "委派并联网研究",
          webSearch: true,
          delegateRoles: [
            { id: "codex", label: "Codex", agent: "codex", systemPrompt: "", createdAt: "", updatedAt: "" },
          ],
        },
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }

    expect(oneshotMock).toHaveBeenCalledTimes(1);
    const opts = oneshotMock.mock.calls[0]?.[1] as { bridgeServers: Array<{ id: string }> };
    expect(opts.bridgeServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cortex-delegate" }),
        expect.objectContaining({ id: "cortex-research" }),
      ]),
    );
  });

  it("记录启动、解析事件、stderr 和退出 trace", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-cli-trace-"));
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

      const { child } = await nextPiProc(0);
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
      const { child } = await nextPiProc(0);

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
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    registerCliHandlers();
    const send = vi.fn();
    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send } },
        { runId: "wd-1", sessionId: "s", agent: "pi", cwd, prompt: "hi" },
      );
      const { child } = await nextPiProc(0);
      vi.advanceTimersByTime(5001); // 超阈值,看门狗触发 proc.kill()
      expect(child.kill).toHaveBeenCalled();
      child.emit("close", null); // 单发被取消后以 code=null 收尾 → onExit 补发 cli:exit
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
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    registerCliHandlers();
    const send = vi.fn();
    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send } },
        { runId: "wd-2", sessionId: "s", agent: "pi", cwd, prompt: "hi" },
      );
      const { child } = await nextPiProc(0);
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
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    registerCliHandlers();
    const send = vi.fn();
    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send } },
        { runId: "rt-1", sessionId: "s", agent: "pi", cwd, prompt: "hi" },
      );
      const { child: child1 } = await nextPiProc(0);
      child1.stderr.emit("data", "fetch failed: ECONNRESET\n"); // 瞬态上游错误
      child1.emit("close", 1); // 非零退出,无任何输出 → 触发重试
      // 立即广播 retry 事件;但重启有退避,尚未发生,也未发终态 cli:exit。
      const retryEvent = send.mock.calls.find((c) => c[0] === "cli:event" && c[1]?.event?.type === "retry");
      expect(retryEvent?.[1].event).toMatchObject({ type: "retry", attempt: 1 });
      expect(oneshotMock).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalledWith("cli:exit", expect.anything());
      vi.advanceTimersByTime(800); // 退避到期 → 第二次拉起
      expect(oneshotMock).toHaveBeenCalledTimes(2);
      const { child: child2 } = await nextPiProc(1);
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
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    registerCliHandlers();
    const send = vi.fn();
    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send } },
        { runId: "rt-3", sessionId: "s", agent: "pi", cwd, prompt: "hi" },
      );
      const { child } = await nextPiProc(0);
      ipcHandlers.get("cli:kill")?.({}, "rt-3"); // 用户取消
      child.stderr.emit("data", "fetch failed: ECONNRESET\n"); // 瞬态文本(诱导误重试)
      child.emit("close", 1); // 中断后仍以非零码收尾
      vi.advanceTimersByTime(800);
      expect(oneshotMock).toHaveBeenCalledTimes(1); // 未重试
      expect(send).toHaveBeenCalledWith("cli:exit", expect.objectContaining({ runId: "rt-3", code: 1 }));
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("spawn 失败时 error+close 都触发,只发一次终态 cli:exit(settled 守卫)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-retry4-"));
    registerCliHandlers();
    const send = vi.fn();
    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send } },
        { runId: "rt-4", sessionId: "s", agent: "pi", cwd, prompt: "hi" },
      );
      const { child } = await nextPiProc(0);
      child.emit("error", Object.assign(new Error("pi 运行时不可用"), { code: "ENOENT" }));
      child.emit("close", null); // 启动失败后 error+close 都可能触发
      const exits = send.mock.calls.filter((c) => c[0] === "cli:exit" && c[1]?.runId === "rt-4");
      expect(exits).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("已产生可见文本后失败 → 不重试(直接终态)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-retry2-"));
    registerCliHandlers();
    const send = vi.fn();
    try {
      await ipcHandlers.get("cli:start")?.(
        { sender: { isDestroyed: () => false, send } },
        { runId: "rt-2", sessionId: "s", agent: "pi", cwd, prompt: "hi" },
      );
      const { child } = await nextPiProc(0);
      // 先产出可见文本(pi text_delta),再非零退出。
      child.stdout.emit("data", JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }) + "\n");
      child.stderr.emit("data", "fetch failed: ECONNRESET\n");
      child.emit("close", 1);
      expect(oneshotMock).toHaveBeenCalledTimes(1); // 未重试
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
    // U8:stdin EPIPE/EOF 静默吞掉(子进程提前退出),其余错误才告警(经 scoped logger)。
    logMock.warn.mockClear();
    child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(logMock.warn).not.toHaveBeenCalled();
    child.stdin.emit("error", Object.assign(new Error("boom"), { code: "EACCES" }));
    expect(logMock.warn).toHaveBeenCalled();
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

// 无项目会话的 cwd 兜底。渲染端算 cwd 是 `项目 path ?? session.noProjectDir ?? ""`,
// 旧会话(以及曾经漏传 noProjectDir 的侧栏「新建会话」)拿到的是空串;空串交给 spawn 等于
// 继承 Electron 自己的工作目录 —— dev 下就是 apps/desktop/，agent 产物会写进程序目录
//(用户实测:合同审查报告落到了 apps/desktop/outputs/)。
describe("resolveSpawnCwd 无项目会话兜底", () => {
  it("空串 / 纯空白 / undefined → 回落到当天的无项目工作目录并确保存在", () => {
    for (const input of ["", "   ", undefined]) {
      const dir = resolveSpawnCwd(input);
      expect(dir).toMatch(/[/\\]cortex[/\\]\d{4}-\d{2}-\d{2}$/);
      expect(existsSync(dir)).toBe(true);
    }
  });

  it("给了真实 cwd → 原样返回,不改写", () => {
    const real = mkdtempSync(join(tmpdir(), "spawn-cwd-"));
    expect(resolveSpawnCwd(real)).toBe(real);
    rmSync(real, { recursive: true, force: true });
  });

  // 绝不能把有效路径当空处理:项目会话的 cwd 被改写会让 agent 在错误的仓库里干活。
  it("带前后空白的真实路径 → 去空白后原样返回", () => {
    const real = mkdtempSync(join(tmpdir(), "spawn-cwd-"));
    expect(resolveSpawnCwd(`  ${real}  `)).toBe(real);
    rmSync(real, { recursive: true, force: true });
  });
});

// GUI 启动（Finder/Dock,不经登录 shell）的主进程 PATH 里通常没有 nvm / homebrew 的 node 与 npm。
// 走 spawnEnvFor 的路径本来就逐次补齐,但第三方库自己 spawn 时只认 process.env
//（如 pi SDK 的 DefaultPackageManager 起 npm 装包）,故启动期一次性补齐。
describe("ensureProcessPath", () => {
  const original = process.env.PATH;
  afterEach(() => {
    process.env.PATH = original;
  });

  it("只增不减:原有目录一个不丢", () => {
    process.env.PATH = "/original/bin:/another/bin";
    ensureProcessPath();
    const dirs = (process.env.PATH ?? "").split(":");
    expect(dirs).toContain("/original/bin");
    expect(dirs).toContain("/another/bin");
  });

  it("幂等:连调两次结果不变,也不会把补齐目录堆两遍", () => {
    process.env.PATH = "/original/bin";
    ensureProcessPath();
    const once = process.env.PATH;
    ensureProcessPath();
    expect(process.env.PATH).toBe(once);
    // 去重由 mergePathWithPreferredDirs 保证;这里额外守住「没有重复条目」这条性质。
    const dirs = (process.env.PATH ?? "").split(":");
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});

describe("spawnEnvFor", () => {
  // 引擎收敛后 pi 永不 spawn:曾经的 pi 专属注入(CORTEX_PI_KEY / customProviderEnv 白名单 /
  // 清 ELECTRON_RUN_AS_NODE)随 binary 路径删除,claude/codex 只拿补齐 PATH 的基础 env。
  it("claude/codex:基础 env,带补齐后的 PATH,无任何 pi 专属注入", () => {
    const env = spawnEnvFor({ agent: "claude" });
    expect(env.PATH).toBeDefined();
    expect(env.CORTEX_PI_KEY).toBeUndefined();
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
    expect(env.CORTEX_PI_KEY).toBeUndefined();
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

  // 根因:codex 原生二进制约 260MB,app 冷启动首探可能超时/竞态误判为不可用;若把该负结果
  // 永久缓存,用户随后在终端把 codex 跑热也无法自愈,只能重启 app。故负结果必须不缓存、可重探。
  it("负结果不永久缓存:codex 首轮失败后再次 detect 会重探并自愈为可用", async () => {
    const claude1 = fakeChild();
    const codex1 = fakeChild();
    spawnMock.mockImplementationOnce(() => claude1).mockImplementationOnce(() => codex1);

    const first = detectAgents();
    claude1.emit("close", 0);
    codex1.emit("close", 1); // 冷启动超时/失败 → 本轮不可用
    await expect(first).resolves.toEqual({ claude: true, codex: false, pi: true });

    // 第二轮:codex 已就绪,应重新探测而非返回上一轮缓存的 false。
    const claude2 = fakeChild();
    const codex2 = fakeChild();
    spawnMock.mockImplementationOnce(() => claude2).mockImplementationOnce(() => codex2);
    const second = detectAgents();
    claude2.emit("close", 0);
    codex2.emit("close", 0);
    await expect(second).resolves.toEqual({ claude: true, codex: true, pi: true });
    expect(spawnMock).toHaveBeenCalledTimes(4); // 两轮各 2 次 → 证明确实重探
  });

  it("容忍大体积原生 CLI 冷启动:超过旧 3s 阈值后才退出仍判为可用", async () => {
    vi.useFakeTimers();
    try {
      const claude = fakeChild();
      const codex = fakeChild();
      spawnMock.mockImplementationOnce(() => claude).mockImplementationOnce(() => codex);

      const resultPromise = detectAgents();
      // 推进超过旧的 3000ms 阈值:放宽后不应提前判失败。
      vi.advanceTimersByTime(6000);
      claude.emit("close", 0);
      codex.emit("close", 0);
      await expect(resultPromise).resolves.toEqual({ claude: true, codex: true, pi: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
