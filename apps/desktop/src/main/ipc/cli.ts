// CLI 流式管线：spawn agent CLI → stdout 按行缓冲 → adapter 解析为归一化事件
// → webContents.send 推给 renderer。每个 runId 一个子进程，支持 kill；
// 应用退出前统一清理。

import { ipcMain, type WebContents } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { delimiter, dirname, isAbsolute, join } from "path";
import { homedir, platform } from "os";
import { existsSync, readdirSync, realpathSync, statSync } from "fs";
import type { AgentKind, AgentSessionRequest, CliExitEvent, CliStartRequest, CliStreamEvent, McpServerConfig, McpSettings, TrimSessionRequest } from "./types";
import { baseAgentKindOf, getAgentDef, listAgentProfiles, parseLineEvents, refreshLocalAgentProfiles } from "../agents";
import { agentSessionExists, trimAgentSession } from "./session-trim";
import { PI_KEY_ENV, writePiExtension } from "../agents/pi-providers";
import { recordAgentTrace, recordStreamDelta } from "./agent-trace";
import { classifyAgentFailure, decideSafeRunRetry, DEFAULT_SAFE_RUN_RETRY_MAX_ATTEMPTS } from "./run-retry-policy";
import { applyClaudeMcp, buildCodexMcpArgs, CODEX_MCP_CLEAR } from "./mcp-config";
import { buildBrowserMcpServerConfig } from "../capabilities/browser/inject";
import { buildDocExtractMcpServerConfig } from "../capabilities/doc-extract/mcp";
import { buildMediaGenMcpServerConfig, unregisterMediaGenSession } from "../capabilities/media-gen/server";
import { buildLoopWorkflowsMcpServerConfig, unregisterLoopWorkflowsSession } from "../capabilities/loop-workflows/server";
import { loadWorkflows } from "../workflow/store";
import { getPersistedState } from "./store";
import { CodexServerManager } from "../agents/codex-app-server";
import { startCodexWsRun, closeAllCodexChannels } from "./codex-ws-run";

const running = new Map<string, AgentProcess>();

// codex app-server 进程管理器(U2)。ws 传输(codex 主交互会话)经 startCodexWsRun → 此处 ensureServer。
// 注入 spawn/env 原语(本模块的 startAgentProcess/buildEnv),故 codex-app-server.ts 对 cli.ts 仅 import type,
// 运行时无循环依赖。app-server 为 per-session 长驻;ws 连接 per-run(每轮)。
const codexServers = new CodexServerManager({
  spawnProcess: (cmd, args, o) => startAgentProcess(cmd, args, o),
  buildEnv,
});
// 已被显式取消(cli:kill / killAllCli)的 runId。安全重试用它判定「被取消」——不能只靠 code===null:
// CLI 捕获 SIGTERM 后可能以非零码退出,此时仍属取消,绝不能重试(否则取消后复活子进程)。
const cancelledRunIds = new Set<string>();
// 安全重试前的退避:限流/上游瞬断后零延迟重试几乎必然再次撞墙,给上游一个恢复窗口。
const RETRY_BACKOFF_MS = 800;
const VERIFY_TIMEOUT_MS = 3000;
let detectedAgents: Promise<Record<AgentKind, boolean>> | null = null;

// 主进程活跃度看门狗(U5)。基于 stdout/事件活跃度(非 CPU)。默认 10 分钟,可被环境变量覆盖,
// 24 小时上限钳制(防 Node setTimeout 32-bit 溢出被静默降到 1ms)。它是**进程回收兜底**:
// 渲染端 messages.ts 另有更短的 90s/300s per-run 看门狗负责面向用户的超时文案与 UI 清理,二者按
// 阈值排序非冲突 —— 正常情况下渲染端先触发,主进程看门狗只在渲染端失联(刷新/重载)时兜底回收进程,
// 避免子进程残留。两者不会双杀同一活跃 run。
const DEFAULT_CLI_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const MAX_CLI_INACTIVITY_TIMEOUT_MS = 24 * 60 * 60_000;

export function resolveCliInactivityTimeoutMs(): number {
  const raw = Number(process.env.CORTEX_CLI_INACTIVITY_TIMEOUT_MS);
  const v = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLI_INACTIVITY_TIMEOUT_MS;
  return Math.min(v, MAX_CLI_INACTIVITY_TIMEOUT_MS);
}

function promptPreview(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  return prompt.length > 300 ? `${prompt.slice(0, 300)}…` : prompt;
}

// 封装子进程为统一接口。三种 agent 都走 child_process.spawn:claude/codex 是 PATH 上的
// 外部 CLI,pi 是 bun 编译的自包含二进制(见 pi-locate.ts,不依赖 node_modules 解析)。
export interface AgentProcess {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  // 进程结束且 stdout 读完后回调一次（child_process 的 close,已保证 stdout flush）。
  onExit(cb: (code: number | null) => void): void;
  // spawn 错误（ENOENT 等,如二进制缺失）。
  onError(cb: (err: Error) => void): void;
  // 优雅终止（SIGTERM）+ 3s 兜底强杀。
  kill(): void;
}

// 进程组级信号(U6)。非 Windows 下子进程以 detached 建为进程组组长(pgid = child.pid),
// process.kill(-pgid) 杀**整组** —— 连带 CLI 派生的 shell / MCP / 模型子进程,杜绝子孙残留。
// 子进程未成组(ESRCH 等)或已退出则回退直接杀 child;Windows 无进程组语义,始终 child.kill。
// 实测见 spike(RISK-1):整组与单进程场景均正常回收,后者不退化于原 pid 路径。
function signalChildGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined && platform() !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // 未成组/已退出 → 回退到直接杀 child
    }
  }
  try {
    child.kill(signal);
  } catch {
    // 已退出
  }
}

// SIGTERM 先礼,3s 未退出再 SIGKILL（两次都针对**整组**,否则只杀组长会残留子孙）。
// 取消第一步先关 stdin,让乖巧子进程读到 EOF 后优雅退出(stdin 为 ignore 时 child.stdin 为 null,no-op)。
// 返回兜底强杀 timer 供进程正常退出后 clearTimeout,避免每次 kill 都空等 3s 占用（防泄漏）。
function killWithTimeout(child: ChildProcess): ReturnType<typeof setTimeout> {
  try {
    child.stdin?.end();
  } catch {
    // stdin 已关/不可写
  }
  signalChildGroup(child, "SIGTERM");
  return setTimeout(() => signalChildGroup(child, "SIGKILL"), 3000);
}

function wrapChild(child: ChildProcess): AgentProcess {
  // 兜底强杀 timer:进程正常 close 后清掉,避免空等 3s 占用（防泄漏）。
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  child.on("close", () => {
    if (killTimer) clearTimeout(killTimer);
  });
  return {
    get pid() {
      return child.pid;
    },
    stdout: child.stdout,
    stderr: child.stderr,
    // close 在进程退出且 stdio 流关闭后触发,已保证 stdout 读完。
    onExit: (cb) => {
      child.on("close", (code) => cb(code));
    },
    onError: (cb) => {
      child.on("error", cb);
    },
    kill: () => {
      killTimer = killWithTimeout(child);
    },
  };
}

// stdout 按行缓冲 + 冲刷的可复用循环。cli:start 与 ask.ts(临时追问通道)共用,
// 避免「1MB 溢出保护 + 无换行末行冲刷」两处维护漂移。
// · onLine 收到的是已 trim 的非空行;空行被跳过。
// · 返回 flush():进程退出时调用一次,冲刷残留的最后一行(无换行结尾时)。
export function pipeStdoutLines(
  stdout: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): () => void {
  let buffer = "";
  stdout?.setEncoding("utf8");
  stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
    // 单行长度上限保护:异常超长单行（无换行）会无限撑大 buffer,超阈值丢弃溢出部分（防泄漏）。
    if (buffer.length > 1_000_000) buffer = buffer.slice(-1_000_000);
  });
  return () => {
    const line = buffer.trim();
    if (line) onLine(line);
    buffer = "";
  };
}

// 启动 agent 子进程。三种 agent 统一走 child_process.spawn(cmd=可执行文件路径, args)。
// pi 的 cmd 是 bun 编译的二进制(pi-locate.resolvePiBinary),claude/codex 是 PATH 上的命令。
export function startAgentProcess(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; stdin?: string },
): AgentProcess {
  const env = envForCommand(cmd, opts.env);
  const invocation = resolveInvocationForSpawn(cmd, args, env);
  const child = spawn(invocation.cmd, invocation.args, {
    cwd: opts.cwd,
    env,
    // prompt 走 stdin 时开 pipe(claude/codex,U4);否则 ignore(pi,prompt 在 argv)。
    stdio: [opts.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    // detached(非 Windows):子进程成为进程组组长,使取消时 process.kill(-pgid) 能回收整组子孙(U6)。
    detached: platform() !== "win32",
    // 显式不经 shell:避免参数注入/转义问题(args 已是结构化数组)。
    shell: false,
  });
  // prompt 经 stdin 投递:写入后立即 end() 发 EOF(cortex 每轮一次 spawn,单发即可,子进程读到 EOF 即处理)。
  // 吞掉 stdin 的 EPIPE/EOF(U8):子进程提前退出会让写 stdin 报 EPIPE,真因已由 stderr/exit 路由,
  // 这里静默避免拖崩主进程。
  if (opts.stdin !== undefined && child.stdin) {
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE" && err.code !== "EOF") {
        console.warn(`[cli] stdin write error: ${err.message}`);
      }
    });
    child.stdin.end(opts.stdin, "utf8");
  }
  return wrapChild(child);
}

function compareNodeVersionDesc(a: string, b: string): number {
  const parse = (name: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(name);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  };
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (bv[i] ?? 0) - (av[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
}

export function nvmBinDirs(home: string): string[] {
  const root = `${home}/.nvm/versions/node`;
  try {
    return readdirSync(root)
      .sort(compareNodeVersionDesc)
      .map((name) => `${root}/${name}/bin`)
      .filter((dir) => existsSync(dir));
  } catch {
    return [];
  }
}

export function mergePathWithPreferredDirs(pathValue: string | undefined, preferredDirs: string[]): string {
  const dirs = [...preferredDirs, ...(pathValue ?? "").split(delimiter).filter(Boolean)];
  return [...new Set(dirs)].join(delimiter);
}

function pathWithLeadingDir(pathValue: string | undefined, dir: string): string {
  const dirs = (pathValue ?? "").split(delimiter).filter(Boolean);
  return [dir, ...dirs.filter((d) => d !== dir)].join(delimiter);
}

function resolveOnPath(env: NodeJS.ProcessEnv, name: string): string | null {
  const candidates =
    platform() === "win32" ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

export function resolveCommandForSpawn(cmd: string, env: NodeJS.ProcessEnv): string {
  if (isAbsolute(cmd) || cmd.includes("/") || cmd.includes("\\")) return cmd;
  return resolveOnPath(env, cmd) ?? cmd;
}

export function resolveInvocationForSpawn(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { cmd: string; args: string[] } {
  const resolvedCmd = resolveCommandForSpawn(cmd, env);
  if (platform() === "win32" || !existsSync(resolvedCmd)) return { cmd: resolvedCmd, args };
  let real: string;
  try {
    real = realpathSync(resolvedCmd);
  } catch {
    return { cmd: resolvedCmd, args };
  }
  if (!real.endsWith(".js")) return { cmd: real, args };
  const node = join(dirname(resolvedCmd), platform() === "win32" ? "node.exe" : "node");
  if (!existsSync(node)) return { cmd: real, args };
  return { cmd: node, args: [real, ...args] };
}

export function assertSpawnCwd(cwd: string | undefined): void {
  if (!cwd) return;
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    throw new Error(`工作目录不存在: ${cwd}`);
  }
  if (!stat.isDirectory()) throw new Error(`工作目录不是目录: ${cwd}`);
}

export function envForCommand(cmd: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved =
    isAbsolute(cmd) && existsSync(cmd)
      ? cmd
      : cmd.includes("/") || cmd.includes("\\")
        ? null
        : resolveOnPath(env, cmd);
  if (!resolved) return env;
  return { ...env, PATH: pathWithLeadingDir(env.PATH, dirname(resolved)) };
}

// GUI 进程的 PATH 通常缺少用户 shell 的安装目录（macOS 尤甚），补齐常见位置。
// pty.ts（内嵌终端）也复用此 env。
export function buildEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const extras = [
    `${home}/.local/bin`,
    `${home}/.claude/local`,
    ...nvmBinDirs(home),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${home}/.bun/bin`,
    `${home}/.cargo/bin`,
  ].filter((dir) => existsSync(dir));
  const current = process.env.PATH ?? "";
  // GUI 启动的 PATH 可能带着旧 nvm 版本里的残留 CLI wrapper；优先使用我们补齐的
  // 用户安装目录，并让 nvm 版本按新到旧排序。
  const merged = mergePathWithPreferredDirs(current, extras);
  return { ...process.env, PATH: merged };
}

// 按 agent 定制子进程环境：pi 把选中通道的 API key 注入 CORTEX_PI_KEY（与生成的 extension
// 里 apiKey:"$CORTEX_PI_KEY" 占位对应）；其余 agent 用基础 env。
export function spawnEnvFor(req: { agent: string; provider?: { apiKey?: string } }): NodeJS.ProcessEnv {
  const env = buildEnv();
  if (req.agent !== "pi") return env;
  // 防御性清除可能残留的 ELECTRON_RUN_AS_NODE(pi 是独立二进制,不该带 Electron 标记)。
  delete env.ELECTRON_RUN_AS_NODE;
  if (req.provider?.apiKey) env[PI_KEY_ENV] = req.provider.apiKey;
  return env;
}

// 在 spawnEnvFor 基础上合并 def.extraEnv(M3-A:用户 JSON 派生 agent 注入的自定义 env)。
// 内置 def 无 extraEnv,等价于 spawnEnvFor。profile 的 env 覆盖基础 env 同名键。
export function spawnEnvForDef(
  req: { agent: string; provider?: { apiKey?: string } },
  def: { extraEnv?: Record<string, string> },
): NodeJS.ProcessEnv {
  const env = spawnEnvFor(req);
  if (def.extraEnv) Object.assign(env, def.extraEnv);
  return env;
}

function verifyAgentCli(agent: Exclude<AgentKind, "pi">, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let stderrTail = "";
    const proc = startAgentProcess(agent, ["--version"], { env });
    const done = (ok: boolean, reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      if (!ok) console.warn(`[agents:detect] ${agent} unavailable: ${reason ?? "verification failed"}`);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      proc.kill();
      done(false, `verification timed out after ${VERIFY_TIMEOUT_MS}ms`);
    }, VERIFY_TIMEOUT_MS);

    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });
    proc.onError((err) => done(false, err.message));
    proc.onExit((code) => {
      done(code === 0, code === 0 ? undefined : stderrTail.trim() || `exit code ${code}`);
    });
  });
}

// 启动期验证本机可用 agent。pi 内置打包,恒为 true；claude/codex 需能实际启动。
export async function detectAgents(): Promise<Record<AgentKind, boolean>> {
  detectedAgents ??= detectAgentsOnce();
  return detectedAgents;
}

async function detectAgentsOnce(): Promise<Record<AgentKind, boolean>> {
  const env = buildEnv();
  const [claude, codex] = await Promise.all([
    verifyAgentCli("claude", env),
    verifyAgentCli("codex", env),
  ]);
  const result = {
    claude,
    codex,
    pi: true,
  };
  console.info(`[agents:detect] claude=${result.claude} codex=${result.codex} pi=true`);
  return result;
}

export function resetAgentDetectionForTest(): void {
  detectedAgents = null;
}

function agentUnavailableMessage(agent: Exclude<AgentKind, "pi">): string {
  return `${agent === "claude" ? "Claude Code" : "Codex"} 未安装或不可用。请安装后重启 Cortex Desktop,或切换到 Pi。`;
}

async function assertAgentAvailable(agent: string): Promise<void> {
  if (agent === "pi") return;
  // M3-A:派生/覆盖的 agent(用户 JSON)跳过 PATH 检测 —— 它可能指向不在 PATH 上的自定义 bin,
  // 内置名检测会误判;用户既已显式配置,放行由 spawn 暴露真实错误。覆盖内置同名 id 同理。
  if (listAgentProfiles().some((p) => p.id === agent)) return;
  if (agent !== "claude" && agent !== "codex") return; // 仅内置 claude/codex 走 PATH 门控
  const available = await detectAgents();
  if (available[agent] === false) throw new Error(agentUnavailableMessage(agent));
}

export function registerCliHandlers(): void {
  // 空闲驱逐(U2/KTD8):周期回收长时间无活跃 turn 的 app-server。放在 register 内(仅 app 启动调一次),
  // 避免被测试 import cli.ts 时启动游离定时器。unref 不阻塞进程退出。
  setInterval(() => codexServers.sweepIdle(), 5 * 60_000).unref();

  ipcMain.handle("cli:start", async (event, req: CliStartRequest) => {
    await assertAgentAvailable(req.agent);
    const sender = event.sender;
    const adapter = getAgentDef(req.agent);
    // pi 选中了自定义供应商:先生成 extension 文件,把路径塞回 req 供 buildArgs 加 -e。
    if (req.agent === "pi" && req.provider) {
      req.piExtensionPath = writePiExtension(req.provider);
    }
    // 续接失败回退(U4):带 resumeSessionId 但该会话在本机已不存在(被清理/换机)→ 清除,改为干净新建,
    // 而非带错 id spawn 失败。pi 无外部会话文件,agentSessionExists 恒 true,不触发。新建后的 init 事件
    // 会让渲染端更新存储的 agentSessionId。
    // ⚠️ ws 传输(codex app-server,U6)跳过此磁盘检查:thread 可能仅存在于 server 内存而磁盘 rollout
    // 已不在,磁盘检查会误清仍可 resume 的 threadId。ws 路径的续接失败由 thread/resume 应答 + 归一化
    // session-lost 错误处理(见 codex-ws-run),不靠 pre-flight 磁盘探测。
    if (
      (adapter.transport ?? "spawn") !== "ws" &&
      req.resumeSessionId &&
      !req.continueSession &&
      !agentSessionExists({ agent: baseAgentKindOf(req.agent), agentSessionId: req.resumeSessionId })
    ) {
      recordAgentTrace({
        scope: "cli",
        phase: "resume-fallback",
        summary: `${req.agent} resume session missing → fresh`,
        runId: req.runId,
        sessionId: req.sessionId,
        agent: req.agent,
        data: { missingSessionId: req.resumeSessionId },
      });
      req.resumeSessionId = undefined;
    }
    // MCP 注入(U2):按 def.mcpInjection 能力位 + 全局开关。claude 写 cwd .mcp.json(严格 gate,
    // 不覆盖用户文件);codex 算出 `-c mcp_servers.*` 注入参数交 buildArgs 放进 common。关/无配置时
    // 不注入不覆盖(claude 原生加载用户 .mcp.json、codex 原生继承 ~/.codex)。仅主会话注入;
    // ask/oneshot/automation 走原生继承。
    let mcpArgs: string[] | undefined;
    if (adapter.mcpInjection !== "none") {
      // 配置不可读时降级为不注入(不阻断启动)。
      let mcp: McpSettings = { enabled: false, servers: [] };
      try {
        const persistedState = await getPersistedState();
        const gs = persistedState.generalSettings;
        mcp = gs?.mcp ?? mcp;
        // 内置 server 并入 mcp.servers(token 经 header):
        //  - 浏览器控制:仅总开关开 + server 可用时注入(buildBrowserMcpServerConfig 内部 gate)。
        //  - 文档抽取:v1 无开关,host 可用即注入(extract_document 工具靠会话隔离 + 限根自保)。
        //  - 媒体生成:四模态全关 → null;至少一个 enabled → 注入,cwd 穿透至工具 handler(U5)。
        // 用户 MCP 关闭时不连带启用其 server——仅注入内置 server。此即主会话注入路径(ask/oneshot/automation 不经此)。
        // loop 工作流注入需要当前工作流列表，在此读取（异步加载，失败时降级不注入）。
        let workflowsForMcp: Awaited<ReturnType<typeof loadWorkflows>> = [];
        try {
          workflowsForMcp = await loadWorkflows();
        } catch {
          /* 工作流列表读取失败 → loop MCP 不注入，不阻断主 agent 启动 */
        }
        const builtinServers = [
          buildBrowserMcpServerConfig(gs?.browserControl, req.sessionId),
          buildDocExtractMcpServerConfig(req.sessionId),
          buildMediaGenMcpServerConfig(persistedState.mediaGenSettings, req.sessionId, req.cwd),
          // loop 工作流 MCP 注入（U14）：无 enabled+callable 工作流时返回 null，不注入。
          buildLoopWorkflowsMcpServerConfig(workflowsForMcp, req.sessionId, req.cwd),
        ].filter((s): s is McpServerConfig => s !== null);
        if (builtinServers.length) {
          const userServers = mcp.enabled ? mcp.servers : [];
          mcp = { enabled: true, servers: [...userServers, ...builtinServers] };
        }
      } catch {
        /* 配置不可读 → 不注入 */
      }
      if (adapter.mcpInjection === "claude-mcp-json") {
        try {
          await applyClaudeMcp(req.cwd, mcp);
        } catch (e) {
          console.warn(`[cli] applyClaudeMcp failed: ${String(e)}`); // 注入失败不阻断启动
        }
      } else if (adapter.mcpInjection === "codex-c") {
        mcpArgs = buildCodexMcpArgs(mcp);
      }
    }
    assertSpawnCwd(req.cwd);

    // 事件回显 sessionId:renderer 被 HMR/刷新重载丢失内存注册表后,仍能把事件归属到正确 session。
    const sendEvent = (ev: CliStreamEvent) => {
      if (!sender.isDestroyed()) sender.send("cli:event", { runId: req.runId, sessionId: req.sessionId, event: ev });
    };
    const sendExit = (exit: CliExitEvent) => {
      if (!sender.isDestroyed()) sender.send("cli:exit", exit);
    };

    const inactivityMs = resolveCliInactivityTimeoutMs();

    // ── ws 传输分流(U5):codex 主交互会话走 app-server WebSocket,在 buildArgs/spawn 之前前置返回 ──
    // ws 路径不调 buildArgs(那是 `codex exec` 的命令构造),直接把已算好的 mcpArgs 交给 server 管理器。
    // 仅 cli:start 读 transport;oneshot/ask/automation/workflow-headless 不经此、恒走 spawn+`codex exec`。
    if ((adapter.transport ?? "spawn") === "ws") {
      const handle = startCodexWsRun({
        req,
        def: adapter,
        mcpArgs,
        manager: codexServers,
        sendEvent,
        // 终态:清 running/取消标记 + 清理本 session 的内置 MCP host 状态(镜像 spawn 路径 onExit),再 send cli:exit。
        sendExit: (exit) => {
          cancelledRunIds.delete(req.runId);
          running.delete(req.runId);
          if (req.sessionId) {
            unregisterMediaGenSession(req.sessionId);
            unregisterLoopWorkflowsSession(req.sessionId);
          }
          sendExit(exit);
        },
        // 心跳:长 MCP 工具静默期让渲染端重置 300s 看门狗(防误杀,见 codex-ws-run / messages.ts)。
        sendKeepalive: () => {
          if (!sender.isDestroyed())
            sender.send("cli:keepalive", { runId: req.runId, sessionId: req.sessionId });
        },
        inactivityMs,
      });
      running.set(req.runId, handle);
      return;
    }

    const retryMax = DEFAULT_SAFE_RUN_RETRY_MAX_ATTEMPTS;
    const { cmd, args, stdin } = adapter.buildArgs(req, mcpArgs); // 未接入的 agent 在此抛错 → renderer 收到 rejection

    // 单次 attempt(U7 安全重试):spawn + 流式管线 + 看门狗 + 收尾。attempt = 已重试次数(首跑 0)。
    // 顺序重试:旧 attempt 完全退出(onExit)后才发起下一次,故无并发在途事件、无需代际守卫;
    // 且只在「进程非零退出/空完成 + 未转发过任何可见输出/工具/result 失败」时重试 —— 保证重试前渲染端
    // 未收到任何终态或可见内容,重试干净(无折叠污染、无重复失败提示、无半截会话续接)。
    const launchAttempt = (attempt: number): void => {
      recordAgentTrace({
        scope: "cli",
        phase: "start",
        summary: attempt === 0 ? `${req.agent} start` : `${req.agent} retry#${attempt}`,
        runId: req.runId,
        sessionId: req.sessionId,
        agent: req.agent,
        data: { cmd, cwd: req.cwd, argCount: args.length, attempt, promptPreview: promptPreview(req.prompt) },
      });
      const proc = startAgentProcess(cmd, args, { cwd: req.cwd, env: spawnEnvForDef(req, adapter), stdin });
      running.set(req.runId, proc);

      // 本 attempt 的副作用/失败追踪(重试决策输入)。
      let settled = false; // onError/onExit 互斥:spawn 失败时 Node 会同时触发 error 与 close,只处理一次
      let sawText = false;
      let sawTool = false;
      let sawAny = false; // 是否产出过任意归一化事件(empty_output 判定)
      let lastResultFailed = false; // 是否转发过 result(ok:false)——转发后不再重试,避免渲染端重复失败
      let stderrTail = "";

      // 活跃度看门狗(U5):stdout 行 / stderr 数据重置计时;超阈值杀整组,onExit 补发超时 cli:exit。
      let watchdogTripped = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const clearWatchdog = () => {
        if (watchdog) {
          clearTimeout(watchdog);
          watchdog = undefined;
        }
      };
      const noteActivity = () => {
        clearWatchdog();
        watchdog = setTimeout(() => {
          watchdogTripped = true;
          recordAgentTrace({
            scope: "cli",
            phase: "watchdog",
            summary: `${req.agent} inactivity timeout`,
            runId: req.runId,
            sessionId: req.sessionId,
            agent: req.agent,
            data: { inactivityMs },
          });
          proc.kill();
        }, inactivityMs);
      };
      noteActivity();

      const flushStdout = pipeStdoutLines(proc.stdout, (line) => {
        noteActivity(); // 任意 stdout 行(含未解析行)都算活跃,重置看门狗
        for (const ev of parseLineEvents(adapter, line)) {
          sawAny = true;
          if (ev.type === "text") {
            sawText = true;
            recordStreamDelta({
              scope: "cli",
              segmentType: "text",
              delta: ev.delta,
              runId: req.runId,
              sessionId: req.sessionId,
              agent: req.agent,
            });
          } else {
            if (ev.type === "tool") sawTool = true;
            else if (ev.type === "result" && !ev.ok) lastResultFailed = true;
            recordAgentTrace({
              scope: "cli",
              phase: "event",
              summary: `${req.agent} ${ev.type}`,
              runId: req.runId,
              sessionId: req.sessionId,
              agent: req.agent,
              data: { parsedEvent: ev },
            });
          }
          sendEvent(ev);
        }
      });

      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (chunk: string) => {
        noteActivity(); // stderr 输出也算活跃
        stderrTail = (stderrTail + chunk).slice(-2000);
        recordAgentTrace({
          scope: "cli",
          phase: "stderr",
          summary: `${req.agent} stderr`,
          runId: req.runId,
          sessionId: req.sessionId,
          agent: req.agent,
          data: { chunk },
        });
      });

      proc.onError((err) => {
        if (settled) return; // 已被 onExit 收尾,避免重复终态
        settled = true;
        clearWatchdog();
        cancelledRunIds.delete(req.runId);
        console.error(`[cli] ${req.agent} spawn failed: ${err.message}`);
        recordAgentTrace({
          scope: "cli",
          phase: "error",
          summary: `${req.agent} spawn failed`,
          runId: req.runId,
          sessionId: req.sessionId,
          agent: req.agent,
          data: { error: err.message },
        });
        proc.stdout?.removeAllListeners();
        proc.stderr?.removeAllListeners();
        running.delete(req.runId);
        sendExit({ runId: req.runId, code: null, error: err.message });
      });

      proc.onExit((code) => {
        if (settled) return; // 已被 onError 收尾(spawn 失败时 error+close 都会触发)
        settled = true;
        clearWatchdog();
        flushStdout(); // 冲刷无换行结尾的最后一行
        proc.stdout?.removeAllListeners();
        proc.stderr?.removeAllListeners();

        // 取消判定:被信号杀(code===null)或显式取消(cli:kill/killAllCli)。CLI 捕获 SIGTERM 后可能
        // 以非零码退出,故不能只看 code===null —— 必须并入 cancelledRunIds,否则取消后会被误重试复活。
        const cancelRequested = code === null || cancelledRunIds.has(req.runId);
        // 安全重试判定:仅「进程非零退出 或 0 退出但全程无输出」、未转发过 result 失败、非看门狗、非取消时
        // 才考虑。满足时渲染端尚未收到任何终态/可见内容,重试干净。
        const retryEligible =
          !watchdogTripped &&
          !cancelRequested &&
          !lastResultFailed &&
          ((code !== 0 && code !== null) || (code === 0 && !sawAny));
        if (retryEligible) {
          const failure = classifyAgentFailure({ code, stderrTail, sawAnyOutput: sawAny });
          const decision = decideSafeRunRetry(
            failure,
            { cancelRequested, userVisibleOutputSeen: sawText, toolCallSeen: sawTool },
            attempt,
            retryMax,
          );
          if (decision.shouldRetry) {
            recordAgentTrace({
              scope: "cli",
              phase: "retry",
              summary: `${req.agent} retry (${failure.category})`,
              runId: req.runId,
              sessionId: req.sessionId,
              agent: req.agent,
              data: { attempt: attempt + 1, category: failure.category },
            });
            sendEvent({ type: "retry", attempt: attempt + 1, maxAttempts: retryMax, reason: failure.category });
            // 退避后再起新 attempt;退避窗口内若被取消,直接收尾、不复活子进程。
            setTimeout(() => {
              if (cancelledRunIds.has(req.runId)) {
                cancelledRunIds.delete(req.runId);
                running.delete(req.runId);
                sendExit({ runId: req.runId, sessionId: req.sessionId, code: null });
                return;
              }
              launchAttempt(attempt + 1); // 顺序重试,新 attempt 覆盖 running 中的 proc
            }, RETRY_BACKOFF_MS);
            return;
          }
        }

        // 终态：session 不再复用，清理各 MCP host 的 session 状态。
        // 同 session 下一轮 run 会在各 buildXxxMcpServerConfig 中重新 register，
        // 故此处清理安全，不影响潜在的会话续接。
        if (req.sessionId) {
          unregisterMediaGenSession(req.sessionId);
          // U14：清理 loop 工作流 session cwd 映射。
          unregisterLoopWorkflowsSession(req.sessionId);
        }
        cancelledRunIds.delete(req.runId);
        running.delete(req.runId);
        const timeoutError = watchdogTripped
          ? `活跃超时:${Math.round(inactivityMs / 1000)} 秒无输出,已终止`
          : undefined;
        const error = timeoutError ?? (code !== 0 && code !== null ? stderrTail.trim() || undefined : undefined);
        if (error) console.error(`[cli] ${req.agent} exited with code ${code}: ${error}`);
        recordAgentTrace({
          scope: "cli",
          phase: "exit",
          summary: `${req.agent} exit ${code ?? "null"}`,
          runId: req.runId,
          sessionId: req.sessionId,
          agent: req.agent,
          data: { code, error },
        });
        sendExit({ runId: req.runId, sessionId: req.sessionId, code, error });
      });
    };

    launchAttempt(0);
  });

  // 一次性短任务（生成 session 标题 / 日报等）:复用各 agent 的 adapter
  // （buildArgs 构造命令 + parseLine 解析流式输出）,聚合 text 增量为纯文本返回。
  // 新接入的 agent 自动获得 oneshot 能力。60 秒超时。
  // 不传 cwd 时在用户主目录运行 —— 不加载项目上下文,更快更省。
  ipcMain.handle(
    "cli:oneshot",
    async (
      _e,
      req: {
        agent?: AgentKind;
        cwd?: string;
        prompt: string;
        model?: string;
        provider?: { id: string; baseUrl: string; apiKey?: string; models: { id: string; name?: string }[] };
      },
    ) => {
      // oneshot（标题/日报）默认 claude。pi 选中了自定义供应商（日报选 Pi）时挂载之:
      // 生成 extension + --provider + 注入 key,与会话路径一致;未传 provider 则裸 pi
      // 跑（用 pi 自身默认 provider,如标题生成兜底）。claude/codex 不挂供应商。
      const agent = req.agent ?? "claude";
      // 不传 cwd 时在用户主目录运行 —— 不加载项目上下文,更快更省（不叠加 workspaceRoot,
      // 那是交互会话/自动化的默认目录语义,oneshot 是轻量任务）。
      const cwd = req.cwd ?? homedir();
      await assertAgentAvailable(agent);
      const adapter = getAgentDef(agent);
      const provider = agent === "pi" ? req.provider : undefined;
      const piExtensionPath = provider ? writePiExtension(provider) : undefined;
      const { cmd, args, stdin } = adapter.buildArgs(
        {
          runId: "oneshot",
          sessionId: "oneshot",
          agent,
          cwd,
          prompt: req.prompt,
          model: req.model,
          provider,
          piExtensionPath,
        },
        CODEX_MCP_CLEAR, // 轻量任务:codex 清空 MCP(沿用 M1,避免加载用户重 MCP);claude/pi 忽略
      );
      assertSpawnCwd(cwd);
      recordAgentTrace({
        scope: "oneshot",
        phase: "start",
        summary: `${agent} oneshot start`,
        sessionId: "oneshot",
        agent,
        data: { cmd, cwd, argCount: args.length, promptPreview: promptPreview(req.prompt) },
      });
      return new Promise<string>((resolve, reject) => {
        const proc = startAgentProcess(cmd, args, {
          cwd,
          env: spawnEnvForDef({ agent, provider }, adapter),
          stdin,
        });
        let out = "";
        let resultText = "";
        let failed: string | null = null;
        let stderrTail = "";
        const timer = setTimeout(() => {
          proc.kill();
          reject(new Error("oneshot 超时"));
        }, 60_000);

        const handleLine = (line: string) => {
          if (!line) return;
          // 一行可解析出多个事件(usage + result);逐个处理。oneshot 只关心 text 聚合与 result 收尾,
          // usage 等其它事件走 trace 记录即可。
          for (const ev of parseLineEvents(adapter, line)) {
            // text 增量合并为段;其它事件走普通 trace。
            if (ev.type === "text") {
              recordStreamDelta({
                scope: "oneshot",
                segmentType: "text",
                delta: ev.delta,
                sessionId: "oneshot",
                agent,
              });
            } else {
              recordAgentTrace({
                scope: "oneshot",
                phase: "event",
                summary: `${agent} oneshot ${ev.type}`,
                sessionId: "oneshot",
                agent,
                data: { parsedEvent: ev },
              });
            }
            if (ev.type === "text" && out.length < 20_000) out += ev.delta;
            if (ev.type === "result") {
              if (!ev.ok) failed = ev.error ?? "执行失败";
              else if (ev.text) resultText = ev.text;
            }
          }
        };

        let buffer = "";
        proc.stdout?.setEncoding("utf8");
        proc.stdout?.on("data", (chunk: string) => {
          buffer += chunk;
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            handleLine(buffer.slice(0, nl).trim());
            buffer = buffer.slice(nl + 1);
          }
        });
        proc.stderr?.setEncoding("utf8");
        proc.stderr?.on("data", (chunk: string) => {
          stderrTail = (stderrTail + chunk).slice(-2000);
          recordAgentTrace({
            scope: "oneshot",
            phase: "stderr",
            summary: `${agent} oneshot stderr`,
            sessionId: "oneshot",
            agent,
            data: { chunk },
          });
        });
        proc.onError((err) => {
          clearTimeout(timer);
          console.error(`[cli:oneshot] ${agent} spawn failed: ${err.message}`);
          recordAgentTrace({
            scope: "oneshot",
            phase: "error",
            summary: `${agent} oneshot spawn failed`,
            sessionId: "oneshot",
            agent,
            data: { error: err.message },
          });
          reject(err);
        });
        proc.onExit((code) => {
          clearTimeout(timer);
          handleLine(buffer.trim()); // 冲刷无换行结尾的最后一行
          recordAgentTrace({
            scope: "oneshot",
            phase: "exit",
            summary: `${agent} oneshot exit ${code ?? "null"}`,
            sessionId: "oneshot",
            agent,
            data: { code, error: stderrTail.trim() || undefined },
          });
          const text = (out || resultText).trim();
          if (failed) reject(new Error(failed));
          else if (code === 0 && text) resolve(text);
          else if (code === 0) reject(new Error("oneshot 无输出"));
          else {
            const error = stderrTail.trim() || `oneshot 退出码 ${code}`;
            console.error(`[cli:oneshot] ${agent} exited with code ${code}: ${error}`);
            reject(new Error(error));
          }
        });
      });
    },
  );

  // 编辑重发:截断 agent CLI 会话记忆文件(纯逻辑在 session-trim.ts)。
  ipcMain.handle("cli:agentSessionExists", (_e, req: AgentSessionRequest) => agentSessionExists(req));
  ipcMain.handle("cli:trimSession", (_e, req: TrimSessionRequest) => trimAgentSession(req));

  ipcMain.handle("agents:detect", () => detectAgents());

  // M3-A:列出用户 JSON(agents.local.json)派生/覆盖的 agent,供渲染端在选择器列出新 agent。
  ipcMain.handle("agents:profiles", () => listAgentProfiles());
  // 用户改 agents.local.json 后主动刷新缓存,下次 getAgentDef/profiles 重新读盘。
  ipcMain.handle("agents:reloadProfiles", () => {
    refreshLocalAgentProfiles();
    return listAgentProfiles();
  });

  ipcMain.handle("cli:kill", (_e, runId: string) => {
    // 先标记取消,再 kill()——onExit 据此抑制安全重试(即便 CLI 以非零码退出也不复活)。
    cancelledRunIds.add(runId);
    running.get(runId)?.kill(); // kill() 内置先关 stdin + 进程组 SIGTERM + 3s 兜底 SIGKILL
  });
}

export function killAllCli(): void {
  for (const runId of running.keys()) cancelledRunIds.add(runId);
  for (const proc of running.values()) proc.kill();
  running.clear();
  // ws 传输:先关全部持久 ws 连接,再回收全部长驻 codex app-server 进程(整组 SIGTERM)。
  closeAllCodexChannels();
  codexServers.killAll();
}

// 供测试或诊断使用。
export function hasRunning(_sender?: WebContents): boolean {
  return running.size > 0;
}
