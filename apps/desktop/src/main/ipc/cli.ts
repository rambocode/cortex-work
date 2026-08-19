// CLI 流式管线：spawn agent CLI → stdout 按行缓冲 → adapter 解析为归一化事件
// → webContents.send 推给 renderer。每个 runId 一个子进程，支持 kill；
// 应用退出前统一清理。

import { app, ipcMain, type WebContents } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { delimiter, dirname, isAbsolute, join } from "path";
import { homedir, platform } from "os";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "fs";
import type { AgentKind, AgentSessionRequest, CliExitEvent, CliStartRequest, CliStreamEvent, McpServerConfig, McpSettings, ReasoningEffort, RoleConfig, TrimSessionRequest } from "./types";
import { baseAgentKindOf, getAgentDef, listAgentProfiles, parseLineEvents, refreshLocalAgentProfiles } from "../agents";
import { sendRunEvent } from "./run-events";
import { agentSessionExists, trimAgentSession, trimSessionIntoCopy } from "./session-trim";
import { resolvePiProviderInput } from "../providers/pi-provider-input";
// pi 单发的 in-process 引擎(U5;引擎收敛后是 pi 单发的唯一路径,永不 spawn)。它伪装成
// AgentProcess,stdout 逐行吐出与旧 `pi --mode json` 同形的 JSONL,故本文件的流式管线
// (parseLineEvents / 看门狗 / 安全重试 / trace / 委派清理)对 pi 与 claude/codex 完全一致
// —— 差别只是「拿哪个 AgentProcess」。
import { startPiInProcOneShot, type PiOneShotOptions } from "../agents/pi-inproc/oneshot";
import { mcpServerToBridge, type BridgeServer } from "../agents/pi-mcp-bridge";
import { recordAgentTrace, recordStreamDelta } from "./agent-trace";
import { classifyAgentFailure, decideSafeRunRetry, DEFAULT_SAFE_RUN_RETRY_MAX_ATTEMPTS } from "./run-retry-policy";
import { applyClaudeMcp, buildCodexMcpArgs, CODEX_MCP_CLEAR } from "./mcp-config";
import { buildBrowserMcpServerConfig } from "../capabilities/browser/inject";
import { buildAgentBrowserMcpServerConfig, migrateLegacyAgentBrowserMcp } from "../capabilities/agent-browser/inject";
import { resolveAgentBrowserBinary } from "../capabilities/agent-browser/locate";
import { buildDocExtractMcpServerConfig } from "../capabilities/doc-extract/mcp";
import { buildKnowledgeMcpServerConfig } from "../capabilities/knowledge/inject";
import { buildMediaGenMcpServerConfig, unregisterMediaGenSession } from "../capabilities/media-gen/server";
import { buildLoopWorkflowsMcpServerConfig, unregisterLoopWorkflowsSession } from "../capabilities/loop-workflows/server";
import { buildResearchMcpServerConfig } from "../capabilities/research/inject";
import { unregisterResearchSession } from "../capabilities/research/server";
import {
  ensureDelegateMcpServerConfig,
  registerDelegateSession,
  unregisterDelegateSession,
  type DelegateSessionState,
} from "../capabilities/delegate/server";
import {
  ensureDesignDelegateMcpServerConfig,
  registerDesignDelegateSession,
  unregisterDesignDelegateSession,
  type DesignDelegateSessionState,
} from "../capabilities/design-delegate/server";
import { ensureSlidesMcpServerConfig } from "../capabilities/slides/server";
import { ensureVoiceAssistantMcpServerConfig } from "../capabilities/voice-intent/assistant-tools";
import {
  isSlidesRunId,
  parseSlidesRunId,
  registerSlidesSession,
  unregisterSlidesSession,
} from "../capabilities/slides/session";
import { loadWorkflows } from "../workflow/store";
import { getPersistedState } from "./store";
import { assertAllowed } from "./fs";
import {
  assertConversationArtifactRunIdentity,
  assertConversationArtifactRequestShape,
  isKnownConversationArtifactRoot,
  validateConversationArtifact,
} from "./artifact-workspace";
import { documentsCortexDir, noProjectSessionDir } from "../paths";
import { CodexServerManager } from "../agents/codex-app-server";
import { startCodexWsRun, closeAllCodexChannels } from "./codex-ws-run";
import { renderCodexSkillFallback } from "./codex-ws-channel";
import { buildClaudeSkillBridge } from "../skills/claude-bridge";
import { createLogger } from "../log";

const log = createLogger("cli");

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
// 探针超时:codex 的 npm 包只是 shim,真正执行的是约 260MB 的原生 rust 二进制;app 冷启动
// (磁盘忙、二进制不在 page cache)时 `codex --version` 可能远超几秒。给足冷启动窗口,避免把
// 已安装的 agent 误判为不可用。ENOENT(未安装)走 onError 立即返回,不受此值影响。
const VERIFY_TIMEOUT_MS = 15000;
let detectedAgents: Promise<Record<AgentKind, boolean>> | null = null;

// 主进程活跃度看门狗(U5)。基于 stdout/事件活跃度(非 CPU)。默认 40 分钟,可被环境变量覆盖,
// 24 小时上限钳制(防 Node setTimeout 32-bit 溢出被静默降到 1ms)。它是**进程回收兜底**:
// 渲染端 messages.ts 另有更短的 5min/30min per-run 看门狗负责面向用户的超时文案与 UI 清理,二者按
// 阈值排序非冲突 —— 正常情况下渲染端先触发,主进程看门狗只在渲染端失联(刷新/重载)时兜底回收进程,
// 避免子进程残留。两者不会双杀同一活跃 run。默认值须 > 渲染端 RUN_STALL_TIMEOUT_MS(30 分钟),
// 否则主进程会抢在渲染端前把长任务杀掉、破坏「渲染端先触发」不变量;放宽长任务阈值时须同步抬高本值。
// codex 长驻进程守则(英文,注入 codex 会话的 appendSystemPrompt):codex 会在回合边界清理
// 会话工具拉起的子进程,前台起服务必被下一轮连坐;要求后台化 + 立即返回。
const CODEX_LONG_RUNNING_PROCESS_GUIDANCE = [
  "<long_running_processes>",
  "Your shell tool CANNOT keep foreground processes alive across turns: any command still running",
  "when the turn ends is interrupted, and its child processes (including servers it spawned) are",
  "cleaned up together with the process group when the next turn starts.",
  "To start a dev server or any long-running service, detach it and return immediately, e.g.:",
  "  nohup <cmd> > /tmp/<name>.log 2>&1 & disown",
  "(or `setsid <cmd> ...`). Then verify readiness with a bounded probe such as",
  "`curl --silent --max-time 2 <url>` and report the log path and PID.",
  "Never leave a server running in the foreground of a tool call.",
  "</long_running_processes>",
].join("\n");

const DEFAULT_CLI_INACTIVITY_TIMEOUT_MS = 40 * 60_000;
const MAX_CLI_INACTIVITY_TIMEOUT_MS = 24 * 60 * 60_000;

// 委派（delegate）：主 agent run 的看门狗复位器注册表（runId → 本 attempt 的 noteActivity）。
// delegate 工具 spawn 长子任务期间主 agent 自身 stdout 静默，主进程 inactivity 看门狗只看主 agent
// stdout 会误杀（R2）；delegate handler 每个子 agent 事件经 bumpRunWatchdog 喂它。每 attempt 覆盖写、
// run 终态时 delete。
const runWatchdogBumpers = new Map<string, () => void>();
export function bumpRunWatchdog(runId: string): void {
  runWatchdogBumpers.get(runId)?.();
}

export function resolveCliInactivityTimeoutMs(): number {
  const raw = Number(process.env.CORTEX_CLI_INACTIVITY_TIMEOUT_MS);
  const v = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLI_INACTIVITY_TIMEOUT_MS;
  return Math.min(v, MAX_CLI_INACTIVITY_TIMEOUT_MS);
}

function promptPreview(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  return prompt.length > 300 ? `${prompt.slice(0, 300)}…` : prompt;
}

// 封装子进程为统一接口。claude/codex 经 child_process.spawn 跑 PATH 上的外部 CLI;
// pi 无外部二进制、永不 spawn —— pi-inproc/oneshot.ts 以「伪装成 AgentProcess」的形态
// 接入同一条流式管线(这正是本接口存在的意义:管线只认形状,不认底下是不是真进程)。
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

// 启动 agent 子进程(claude/codex;pi 不经此,见 startPiInProcOneShot)。
// cmd=可执行文件路径或 PATH 上的命令,统一走 child_process.spawn。
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
        log.warn(`stdin write error: ${err.message}`);
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

/// 解析 agent 进程真正要用的 cwd。**空值兜底,绝不能把空 cwd 交给 spawn**。
///
/// 渲染端算 cwd 的口径是 `项目 path ?? session.noProjectDir ?? ""`。无项目会话若没有
/// noProjectDir(旧会话,或曾漏传的创建路径),这里拿到的就是空串;空串等于不设 cwd,
/// 子进程直接继承 Electron 自己的工作目录 —— dev 下是 apps/desktop/,agent 产物就写进了
/// 程序目录(用户实测:合同审查报告落到 apps/desktop/outputs/)。
///
/// 回落目标选「当天的无项目工作目录」而非 homedir:那正是无项目会话本来就该用的地方
///(见 NewSessionLanding 的「不使用项目」分支 / fs:ensureNoProjectDir),产物落在那里
/// 用户找得到、也和正常创建的无项目会话一致。日期按当天算,老会话因此可能换目录,
/// 但总好过写进程序目录。
export function resolveSpawnCwd(cwd: string | undefined): string {
  const trimmed = cwd?.trim();
  if (trimmed) return trimmed;
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  // 与渲染端 core/personal/date.ts 的 dayKey 同口径（本地时区 YYYY-MM-DD）。
  const dir = noProjectSessionDir(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  mkdirSync(dir, { recursive: true });
  return dir;
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

/**
 * 把补齐后的 PATH 写回 `process.env.PATH`，启动时调一次即可（幂等）。
 *
 * 为什么需要：GUI 启动的 Electron 主进程 PATH 里通常没有 nvm / homebrew 的 node 与 npm
 * （从 Finder/Dock 拉起时不经登录 shell）。`spawnEnvFor` 这条路径靠 `buildEnv()` 逐次补齐，
 * 但**不经过它**的第三方 spawn 就没人补——典型如 pi SDK 的 `DefaultPackageManager`，
 * 它内部直接用 `process.env` 起 npm，装包会以「找不到 npm」失败。
 *
 * 早年那种「用到时临时改写 process.env.PATH、finally 还原」的写法能跑但脆：还原窗口期内
 * 任何并发 spawn 都会读到被改的值，而主进程里 agent CLI / pty / helper / whisper 全在并发 spawn。
 * 索性在启动期一次性补齐——PATH 只增不减（`mergePathWithPreferredDirs` 去重后拼接，
 * extras 全部经过 `existsSync` 过滤），补齐后 `buildEnv()` 再算一次结果相同，故对既有路径无行为影响。
 */
export function ensureProcessPath(): void {
  process.env.PATH = buildEnv().PATH;
}

// spawn 用的子进程环境。历史上这里还有 pi 专属段（CORTEX_PI_KEY 注入 + 自定义 Provider 的
// `${secret:N}` 真值合并）——pi 收敛为 in-process/gateway 引擎、永不 spawn 后,那些注入随
// binary 路径一起删除;claude/codex 只需要补齐 PATH 的基础 env。
export function spawnEnvFor(_req: { agent: string }): NodeJS.ProcessEnv {
  return buildEnv();
}

// 在 spawnEnvFor 基础上合并 def.extraEnv(M3-A:用户 JSON 派生 agent 注入的自定义 env)。
// 内置 def 无 extraEnv,等价于 spawnEnvFor。profile 的 env 覆盖基础 env 同名键。
export function spawnEnvForDef(
  req: { agent: string },
  def: { extraEnv?: Record<string, string> },
): NodeJS.ProcessEnv {
  const env = spawnEnvFor(req);
  if (def.extraEnv) Object.assign(env, def.extraEnv);
  return env;
}

// ── 委派子 agent 执行（delegate handler 经 DelegateSessionState.runSubAgent 调用） ──
//
// 给定协作者 role 与主 agent 委派的 task,fresh spawn 子 agent;流式事件经 onEvent 推送(带 roleId),
// 返回最终文本。子 agent 用 fresh sessionId(randomUUID)且**不注入** delegate server → tools/list
// 取不到 state → 无 ask_<id> 工具 → 无法再委派(防递归核心不变量)。codex 子 agent 清空 MCP,
// claude/pi 不注入 delegate(裸 spawn)。取消经 signal(主 agent run 的 AbortController)级联到子进程。
const SUB_AGENT_TIMEOUT_MS = 30 * 60_000;
const MAX_SUB_AGENT_OUTPUT = 200_000;

// 思考档跨体系映射:pi 的 thinkingLevel 与 claude/codex 的 effort 只在 low/medium/high 三档同义,
// pi 专属档(off/minimal/xhigh/max)对 claude/codex 无对应物——硬映射只会得到看似合理实则随意的值,
// 故非公共档一律不透传(子 agent 用各自默认强度)。
const COMMON_THINKING_EFFORTS: readonly string[] = ["low", "medium", "high"];
function commonEffortOf(level: string | undefined): ReasoningEffort | undefined {
  return level && COMMON_THINKING_EFFORTS.includes(level) ? (level as ReasoningEffort) : undefined;
}

function runDelegateSubAgent(
  parent: CliStartRequest,
  role: RoleConfig,
  task: string,
  onEvent: (ev: CliStreamEvent) => void,
  signal: AbortSignal,
  childSessionId: string,
): Promise<{ text: string; ok: boolean; error?: string }> {
  if (signal.aborted) return Promise.resolve({ text: "", ok: false, error: "已取消" });

  const adapter = getAgentDef(role.agent);
  const spawnKey = randomUUID();
  const roleBaseAgent = baseAgentKindOf(role.agent);
  const parentBaseAgent = baseAgentKindOf(parent.agent);
  // 同一底层 Agent 的默认角色继承父会话实际模型，确保相同问题不会因为委派而静默切模型；
  // 跨体系仍禁止继承，避免把 DeepSeek 模型名传给 Codex/Claude 等不兼容 provider。
  const sameBaseAgent = roleBaseAgent === parentBaseAgent;
  const parentIsPi = parentBaseAgent === "pi";
  const req: CliStartRequest = {
    runId: spawnKey,
    // 应用侧 child session id 也作为本次 fresh 运行的 UI session id。它不会注册 delegate state，
    // 因此子 Agent 依旧拿不到 ask_*；原生 resume id 则由稍后的 init 单独回传给 renderer。
    sessionId: childSessionId,
    agent: role.agent,
    cwd: parent.cwd,
    prompt: task,
    // 角色显式覆盖优先；未覆盖且同一 base agent 时继承父会话模型。跨体系改用子 Agent 默认模型。
    model: role.model || (sameBaseAgent ? parent.model : undefined),
    // 思考档透传:同体系直传;跨体系只透传公共三档(见 commonEffortOf)。effort(low/medium/high)
    // 本身是 pi thinkingLevel 刻度的子集,可直接作 pi 子 agent 的思考档。
    effort:
      roleBaseAgent === "pi"
        ? undefined
        : (commonEffortOf(role.effort) ?? parent.effort ?? commonEffortOf(parent.thinkingLevel)),
    thinkingLevel:
      roleBaseAgent === "pi"
        ? (role.effort ?? parent.thinkingLevel ?? parent.effort)
        : undefined,
    // Kun 的 readOnly 是执行策略，不是展示标签：无论主会话权限多高，都把该角色降为原生
    // plan/read-only 模式。inherit 才沿用主会话权限，防止审查类角色意外改写工作区。
    permissionMode: role.toolPolicy === "readOnly" ? "plan" : parent.permissionMode,
    approvalPolicy: parent.approvalPolicy,
    // 协作者 persona 作为子 agent 系统提示(三端 adapter 原生支持 appendSystemPrompt)。
    appendSystemPrompt: role.systemPrompt || undefined,
    // 子 agent 若为 pi 且主会话也是 pi，复用主会话 provider；主会话非 pi 时 parent 无 pi provider，
    // pi 协作者走内置默认（可能 deactivated，R6 已知限制——v1 协作者建议用 claude/codex）。
    provider: roleBaseAgent === "pi" && parentIsPi ? parent.provider : undefined,
  };
  // codex 子 agent 清空 MCP(裸 spawn);claude 不接 mcpArgs。
  // pi 子 agent 不走 buildArgs/spawn(引擎收敛后 pi.buildArgs 是抛错 stub):
  // 无条件走 in-process 单发,模型/凭据由 resolveOneShotModel 按 provider.id 原生解析,
  // 不再需要 provider extension 文件。
  const isPiSub = roleBaseAgent === "pi";
  const mcpArgs = roleBaseAgent === "codex" ? CODEX_MCP_CLEAR : undefined;
  const built = isPiSub ? undefined : adapter.buildArgs(req, mcpArgs);
  const { cmd, args, stdin } = built ?? { cmd: "(pi in-process)", args: [] as string[], stdin: undefined };

  recordAgentTrace({
    scope: "delegate", phase: "start", summary: `${role.agent}[${role.label}] sub start`,
    runId: spawnKey, sessionId: parent.sessionId, agent: role.agent,
    data: {
      cwd: parent.cwd, roleId: role.id, taskPreview: promptPreview(task),
      parentRunId: parent.runId,
      parentSessionId: parent.sessionId,
      parentResumeSessionId: parent.resumeSessionId,
      contextMode: "self-contained-task",
      // 诊断：确认 stdin 是否真带 task + 子 agent 实际 permissionMode（继承自主会话）。
      stdinLen: stdin?.length ?? 0, permissionMode: req.permissionMode ?? "(full-auto)",
      // model/effort/thinkingLevel:子 agent 实际模型(未继承时用 agent 自身默认)与思考档(继承/映射自主会话)。
      model: req.model ?? "(默认)", effort: req.effort ?? "(默认)", thinkingLevel: req.thinkingLevel ?? "(默认)",
    },
  });

  // 临时诊断：给 codex 子 agent 开 RUST_LOG，让它把内部失败原因（WebSocket 连接 / 认证 / plugin
  // 加载）写到 stderr——所有终端复现均成功，唯 Electron 主进程失败，需 codex 自身日志定位。
  const subEnv = spawnEnvForDef(req, adapter);
  // 委派诊断要求 info；继承到的全局 RUST_LOG=warn 会吞掉 WebSocket/认证失败上下文，导致只看到
  // 子进程退出码而无法定位。该覆盖只作用于一次性 Codex 子进程，不改主进程环境。
  if (roleBaseAgent === "codex") subEnv.RUST_LOG = "info";
  // pi 协作者无条件走 in-process 单发(图片校验在 oneshot 内部,错误码/文案与 buildArgs 时代一致);
  // 刻意不注入 MCP 桥 / todo:子 agent 拿不到 delegate 工具是防递归的核心不变量,todo 事件在
  // 委派流里也不渲染。claude/codex 原样 spawn。
  const proc = isPiSub
    ? startPiInProcOneShot(req, { cwd: parent.cwd })
    : startAgentProcess(cmd, args, { cwd: parent.cwd, env: subEnv, stdin });

  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let timedOut = false;
    let resultFailed = false;
    let errorText = "";
    let stderrBuf = "";
    let rawOut = ""; // 诊断：原始 stdout（含非 text 事件，如 codex turn.failed / 认证错误，不计入 out）

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        proc.kill();
      }
    }, SUB_AGENT_TIMEOUT_MS);

    const onAbort = () => {
      if (!settled) proc.kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };

    const flushStdout = pipeStdoutLines(proc.stdout, (line) => {
      if (rawOut.length < 4000) rawOut += line + "\n"; // 诊断：保留原始 stdout
      for (const ev of parseLineEvents(adapter, line)) {
        if (ev.type === "text") {
          if (out.length < MAX_SUB_AGENT_OUTPUT) out += ev.delta;
          onEvent({ ...ev, roleId: role.id });
        } else if (ev.type === "result") {
          // 子 agent 的 result 不外发(由本函数 resolve 收口);失败信息内部留存。
          if (!ev.ok) {
            resultFailed = true;
            errorText = ev.error ?? "执行失败";
          }
        } else if (ev.type === "init") {
          // 不再丢弃原生 init：它是独立子会话后续可续接的唯一 resume id。用 childAgentSessionId
          // 明确标注后，renderer 只更新 side SessionMeta，不会再插入第二张卡或污染父 resume id。
          onEvent({
            ...ev,
            roleId: role.id,
            stage: "subagent",
            stageLabel: role.label,
            childSessionId,
            childAgentSessionId: ev.sessionId,
            subagentAgentId: role.agent,
            subagentBaseAgent: roleBaseAgent,
            subagentModel: req.model,
            subagentProviderId: req.provider?.id,
            subagentReadOnly: role.toolPolicy === "readOnly",
          });
        } else {
          // thinking/tool/turn/usage/retry：带 roleId 转发，实时展示子 agent 过程。
          onEvent({ ...ev, roleId: role.id });
        }
      }
    });

    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      stderrBuf += chunk;
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });

    proc.onError((err) => {
      recordAgentTrace({
        scope: "delegate", phase: "error", summary: `${role.agent}[${role.label}] sub error`,
        runId: spawnKey, agent: role.agent, data: { error: err.message, stderr: stderrBuf.slice(-500) },
      });
      settle(() => resolve({ text: out.trim(), ok: false, error: err.message }));
    });

    proc.onExit((code) => {
      flushStdout();
      settle(() => {
        recordAgentTrace({
          scope: "delegate", phase: "exit", summary: `${role.agent}[${role.label}] sub exit(${code})`,
          runId: spawnKey, sessionId: parent.sessionId, agent: role.agent,
          data: {
            code, outLen: out.length,
            parentRunId: parent.runId,
            parentSessionId: parent.sessionId,
            resultPreview: promptPreview(out.trim()),
            stderr: stderrBuf.slice(-2000),
            rawStdout: rawOut.slice(0, 1500), // 诊断：codex 真实输出（turn.failed/认证错误在此）
            permissionMode: req.permissionMode ?? "(full-auto)",
            args,
          },
        });
        if (signal.aborted) return resolve({ text: out.trim(), ok: false, error: "已取消" });
        if (timedOut) {
          return resolve({ text: out.trim(), ok: false, error: `协作者「${role.label}」超时（${Math.round(SUB_AGENT_TIMEOUT_MS / 1000)}s），已终止` });
        }
        if (resultFailed) {
          const detail = stderrBuf.trim() ? `${errorText}\n${stderrBuf.trim().slice(-300)}` : errorText;
          return resolve({ text: out.trim(), ok: false, error: detail });
        }
        if (code !== 0 && code !== null) {
          const detail = stderrBuf.trim() ? `${role.agent} 退出码 ${code}\n${stderrBuf.trim().slice(-300)}` : `${role.agent} 退出码 ${code}`;
          return resolve({ text: out.trim(), ok: false, error: detail });
        }
        resolve({ text: out.trim(), ok: true });
      });
    });
  });
}

export const __runDelegateSubAgentForTest = runDelegateSubAgent;

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
      if (!ok) log.warn(`[agents:detect] ${agent} unavailable: ${reason ?? "verification failed"}`);
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
  const result = await detectedAgents;
  // 负结果不永久缓存:claude/codex 首探可能因原生 CLI 冷启动超时、或安装/PATH 就绪竞态而误判
  // 不可用。此时清掉缓存,让下次调用(工作区重挂载、cli:start 门控、用户手动重试)重新探测,
  // 实现自愈,而非把误判卡死到重启 app。全部可用才长期缓存,避免每次都重复 spawn 探针。
  if (!result.claude || !result.codex) detectedAgents = null;
  return result;
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
  log.info(`[agents:detect] claude=${result.claude} codex=${result.codex} pi=true`);
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
    // cwd 归一必须在最前:后面产物身份校验、MCP 配置落盘、媒体/幻灯片能力都要用 req.cwd,
    // 只在 spawn 那一步兜底会让这些环节仍拿到空串(见 resolveSpawnCwd 的注释)。
    req.cwd = resolveSpawnCwd(req.cwd);
    // 供应商解析:renderer 只给 providerId。pi 单发的模型/凭据由 in-process 引擎的
    // resolveOneShotModel 按 providerId 原生解析（Catalog + 自定义 + 凭据金库,解析不出时
    // 响亮抛错,绝不让 pi 兜底换 provider）;这里合成的 provider 对象只供 delegate 子 agent
    // 继承 provider.id（resolvePiProviderInput 只认 Catalog,自定义 id 得 undefined,无害）。
    if (!req.provider && req.providerId) {
      req.provider = await resolvePiProviderInput(req.providerId);
    }
    assertConversationArtifactRequestShape(req.runId, req.artifactContext);
    if (req.artifactContext) {
      const fallbackRoot = join(documentsCortexDir(), "design");
      const persistedState = await getPersistedState();
      if (
        !isKnownConversationArtifactRoot(
          req.artifactContext.workspaceRoot,
          persistedState,
          fallbackRoot,
        )
      ) {
        throw new Error("产物工作区未注册");
      }
      assertConversationArtifactRunIdentity(req.artifactContext, req.cwd, req.runId);
      await assertAllowed(req.artifactContext.workspaceRoot);
      await validateConversationArtifact(req.artifactContext);
    }
    // 设计工作台回合的诊断日志(runId 前缀 design:):便于排查 agent 是否真被拉起、传了什么。
    if (req.runId.startsWith("design:")) {
      log.info(`[design] cli:start agent=${req.agent} model=${req.model ?? "(default)"} cwd=${req.cwd} runId=${req.runId}`);
    }
    await assertAgentAvailable(req.agent);
    const sender = event.sender;
    const adapter = getAgentDef(req.agent);
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
        mcp = migrateLegacyAgentBrowserMcp(gs?.mcp ?? mcp);
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
          buildAgentBrowserMcpServerConfig(
            gs?.agentBrowser,
            req.sessionId,
            resolveAgentBrowserBinary({
              isPackaged: app.isPackaged,
              resourcesPath: process.resourcesPath,
              appPath: app.getAppPath(),
              platform: process.platform,
              arch: process.arch,
            }),
          ),
          buildBrowserMcpServerConfig(gs?.browserControl, req.sessionId),
          // 研究引擎:给 agent 补上「搜索」这一块能力(浏览器工具只能打开给定 URL,不能自己搜)。
          // 三门控在 buildResearchMcpServerConfig 内部(总开关 + Consumer 准入 + 搜索后端已配)。
          // Consumer 决定受哪个开关约束与默认预算:slides 回合归 slides,其余归 chat。
          //
          // chat 的准入是**会话级**的:req.webSearch 即用户在该会话输入框上按下的「联网」
          // (SessionMeta.webSearch),全局已无 chatEnabled。claude/codex 逐轮 fresh spawn,
          // 故改开关下一轮即生效。slides 与 chat 同款，均看 req.webSearch。
          buildResearchMcpServerConfig(
            gs?.researchEngine,
            req.sessionId,
            isSlidesRunId(req.runId) ? "slides" : "chat",
            req.webSearch === true,
          ),
          buildDocExtractMcpServerConfig(req.sessionId),
          // 公司知识库:远端 MCP server(kbserver 的 /api/mcp),给 agent 补上「查公司内部资料」
          // 这块能力。三门控在 buildKnowledgeMcpServerConfig 内部(总开关 + 地址 + 令牌可解密)。
          // 无会话级开关——知识库是常备资料源,与联网(会话级 webSearch)的性质不同。
          buildKnowledgeMcpServerConfig(gs?.knowledgeBase),
          buildMediaGenMcpServerConfig(persistedState.mediaGenSettings, req.sessionId, req.cwd),
          // loop 工作流 MCP 注入（U14）：无 enabled+callable 工作流时返回 null，不注入。
          buildLoopWorkflowsMcpServerConfig(workflowsForMcp, req.sessionId, req.cwd),
          // 语音助手控制工具（voice_exit_assistant 等）：claude/codex 语音轮走本单发路径,
          // 常驻注入 + 执行面按语音激活态门控（见 assistant-tools.ts 文件头,与 pi RPC 同源）。
          await ensureVoiceAssistantMcpServerConfig(req.sessionId).catch(() => null),
          // 委派（delegate）：本轮有被 @ 的协作者时注入 cortex-delegate server（仅 claude/codex 经此块；
          // pi 走 mcpInjection==="none" 不进本块，阶段2 另生成桥接）。工具集由下方 registerDelegateSession 注册。
          req.delegateRoles?.length ? await ensureDelegateMcpServerConfig(req.sessionId) : null,
          // 设计委派（design-delegate）：设计工作台回合(runId 前缀 design:)注入通用 delegate_task 工具,
          // 让父设计 agent 并行 fanout 逐页生成。工具集由下方 registerDesignDelegateSession 注册。
          // Slides 回合(slides: 前缀)同样注入:多 Agent 分工(research/design/review/notes)
          // 复用同一 delegate_task —— 子 agent 用 fresh sessionId,故拿不到 cortex-slides 工具,
          // 只能把产出交回父 agent 由其经 MCP 落盘(reviewer 天然只产 findings、改不了页面)。
          req.runId.startsWith("design:") || isSlidesRunId(req.runId)
            ? await ensureDesignDelegateMcpServerConfig(req.sessionId)
            : null,
          // AI Slides：仅 Slides Workspace 回合(runId 前缀 slides:<docId>:)注入 cortex-slides
          // 工具集(deck 状态/提纲/逐页写入)。工具集由下方 registerSlidesSession 注册的会话状态 gate。
          isSlidesRunId(req.runId) ? await ensureSlidesMcpServerConfig(req.sessionId) : null,
        ].filter((s): s is McpServerConfig => s !== null);
        if (builtinServers.length) {
          const userServers = mcp.enabled ? mcp.servers : [];
          mcp = { enabled: true, servers: [...userServers, ...builtinServers] };
          // 内置 server 是产品自身能力面,回填 id 清单供 claude buildArgs 预授权
          // (--allowed-tools mcp__<id>);用户自配 MCP 不在此列,仍走 claude 自身权限配置。
          req.builtinMcpServers = builtinServers.map((server) => server.id);
        }
      } catch {
        /* 配置不可读 → 不注入 */
      }
      if (adapter.mcpInjection === "claude-mcp-json") {
        try {
          await applyClaudeMcp(req.cwd, mcp);
        } catch (e) {
          log.warn(`applyClaudeMcp failed: ${String(e)}`); // 注入失败不阻断启动
        }
      } else if (adapter.mcpInjection === "codex-c") {
        // 内置 server 需显式预授权,否则 codex 的 MCP 审批闸在非交互 exec 下把每次调用判为
        // 「user cancelled」(与上面 claude 的 --allowed-tools mcp__<id> 同一意图)。
        mcpArgs = buildCodexMcpArgs(mcp, req.builtinMcpServers ?? []);
      }
    }

    // claude 原生 skill 目录桥接(U2/KTD5):仅 claude 且会话开启 useOwnSkills 且渲染端传来非空 skillRecords
    // 时,把这些 skill 物化成 claude 能自动发现的 `.claude/skills/` 目录(symlink),写回 req.skillsBridgeDir
    // 供 claude.ts buildArgs 追加 --add-dir。开关语义与 --disable-slash-commands 一致(KTD4),不影响
    // codex/pi 及 oneshot/ask/automation 等不设 skillRecords 的调用点。降级对齐 applyClaudeMcp:构建失败
    // 只 warn、不阻断发送(skillsBridgeDir 保持 undefined → 不追加 --add-dir,退回现状)。
    if (req.agent === "claude" && req.useOwnSkills === true && req.skillRecords?.length) {
      try {
        // 桥接根目录按 sessionId 命名、每轮覆盖重建,避免跨会话堆积(生命周期/GC 策略见 plan Deferred)。
        // 安全(code review 修复):sessionId 是渲染端经 cli:start 传入的可控字段,拼路径前必须清洗
        // (对齐下方 delegate 桥接扩展名 safeSid 的既有惯例)——否则含 `../` 的 sessionId 经 join
        // 规范化可逃出 userData/skill-bridge,而 buildClaudeSkillBridge 对目标目录做的是
        // rmSync({recursive:true, force:true}),逃逸后即是递归强删任意可写目录。
        const safeSessionId = req.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const bridgeRootDir = join(app.getPath("userData"), "skill-bridge", safeSessionId);
        req.skillsBridgeDir = buildClaudeSkillBridge(req.skillRecords, bridgeRootDir);
      } catch (e) {
        log.warn(`buildClaudeSkillBridge failed: ${String(e)}`); // 桥接失败不阻断启动
      }
    }

    assertSpawnCwd(req.cwd);

    // 事件回显 sessionId:renderer 被 HMR/刷新重载丢失内存注册表后,仍能把事件归属到正确 session。
    const sendEvent = (ev: CliStreamEvent) => {
      sendRunEvent(sender, { v: 1, domain: "chat", runId: req.runId, sessionId: req.sessionId, event: ev });
    };
    const sendExit = (exit: CliExitEvent) => {
      if (!sender.isDestroyed()) sender.send("cli:exit", exit);
    };

    // ── 委派（delegate）：本轮被 @ 的协作者注册为主 agent 可调用的 ask_<id> 工具 ──
    // 主 agent 经 cortex-delegate MCP server 自主调用 ask_<id> 委派子任务；handler 在主进程内
    // spawn 子 agent(runDelegateSubAgent)、过程实时推渲染端(roleId)、结果作 tool_result 返回。
    // AbortController 收口取消：主 agent 退出 / cli:kill → abort → 在途子 agent 被杀（见 onExit/onError）。
    let delegateAbort: AbortController | undefined;
    let delegateState: DelegateSessionState | undefined;
    let piDelegateBridge: BridgeServer | null = null;
    if (req.delegateRoles?.length) {
      const controller = new AbortController();
      delegateAbort = controller;
      const state: DelegateSessionState = {
        sessionId: req.sessionId,
        runId: req.runId,
        roles: req.delegateRoles,
        signal: controller.signal,
        abort: () => controller.abort(),
        pushEvent: (ev) => sendEvent(ev),
        // 信封归一 P2:子会话完整过程走独立信封(见 delegate/server.ts 的双发说明)。
        pushChildEvent: (childSessionId, callId, ev) =>
          sendRunEvent(sender, { v: 1, domain: "chat", runId: callId, sessionId: childSessionId, event: ev }),
        bumpWatchdog: () => bumpRunWatchdog(req.runId),
        maxParallel: req.delegatePolicy?.maxParallel ?? 256,
        maxChildRuns: req.delegatePolicy?.maxChildRuns ?? 25,
        childRunCount: 0,
        activeRuns: 0,
        waiters: [],
        runSubAgent: (role, task, onEvent, childSessionId, signal) =>
          runDelegateSubAgent(req, role, task, onEvent, signal ?? controller.signal, childSessionId),
      };
      delegateState = state;
      registerDelegateSession(state);
      // pi 主 agent 走单发,mcpInjection==="none" 不进上面 builtinServers 注入块。这里只收集 bridge，
      // 稍后与 design/slides/research 合成一个扩展，避免 Pi 0.82+ 拒绝跨扩展的同名 ping 工具。
      // claude/codex 不进此分支(它们经 builtinServers + applyClaudeMcp/buildCodexMcpArgs 注入)。
      if (baseAgentKindOf(req.agent) === "pi") {
        const delegateCfg = await ensureDelegateMcpServerConfig(req.sessionId);
        // 诊断：pi delegate 桥接是否注入（host 不可用 → null → pi 缺 ask_<id> 工具，只剩内置工具）。
        recordAgentTrace({
          scope: "delegate", phase: "pi-bridge",
          summary: `pi delegate bridge ${delegateCfg ? "injected" : "SKIPPED:host-unavailable"}`,
          runId: req.runId, sessionId: req.sessionId, agent: req.agent,
          data: { hostAvailable: !!delegateCfg, url: delegateCfg?.url, roles: req.delegateRoles?.map((r) => r.id) },
        });
        piDelegateBridge = delegateCfg ? mcpServerToBridge(delegateCfg) : null;
      }
    }

    // ── 设计委派（design-delegate）：设计回合(runId 前缀 design:)注册 delegate_task 会话 ──
    // 父设计 agent 经该工具并行 fanout 逐页生成;每次调用在主进程内 spawn 一个子 agent
    // (父 agent 同款底层 agent、fresh sessionId、跑该页 prompt),事件带 label(page:<artifactId>)
    // 实时推渲染端。子 agent 用 fresh sessionId 不注册本 session → 无 delegate_task 工具 → 防递归。
    let designDelegateAbort: AbortController | undefined;
    if (req.runId.startsWith("design:") || isSlidesRunId(req.runId)) {
      const controller = new AbortController();
      designDelegateAbort = controller;
      const state: DesignDelegateSessionState = {
        sessionId: req.sessionId,
        runId: req.runId,
        signal: controller.signal,
        abort: () => controller.abort(),
        pushEvent: (ev) => sendEvent(ev),
        bumpWatchdog: () => bumpRunWatchdog(req.runId),
        callCount: { n: 0 },
        // 合成一个无 persona 的 role(agent=父 agent),复用 runDelegateSubAgent 的子 agent spawn 全套逻辑。
        runSubAgent: (label, prompt, onEvent, signal) =>
          runDelegateSubAgent(
            req,
            {
              id: label,
              label,
              agent: req.agent,
              systemPrompt: "",
              createdAt: "",
              updatedAt: "",
            },
            prompt,
            onEvent,
            signal ?? controller.signal,
            randomUUID(),
          ),
      };
      registerDesignDelegateSession(state);
    }

    // ── AI Slides：Slides Workspace 回合(runId 前缀 slides:<docId>:)注册 cortex-slides 会话 ──
    // 会话状态只存 documentId + workspaceRoot(= cwd);deck 文件读写全部经 capabilities/slides/
    // workspace.ts 的路径校验与乐观锁。回合结束(onExit/onError)unregister,防跨 deck 泄漏。
    let slidesSessionActive = false;
    {
      const slidesDocId = parseSlidesRunId(req.runId);
      if (slidesDocId) {
        registerSlidesSession({
          sessionId: req.sessionId,
          runId: req.runId,
          documentId: slidesDocId,
          workspaceRoot: req.cwd,
        });
        slidesSessionActive = true;
        log.info(`[slides] cli:start agent=${req.agent} doc=${slidesDocId} runId=${req.runId}`);
      }
    }

    // ── pi 的 MCP 桥接:delegate、design-delegate、cortex-slides 与 research 合成一份结构化配置 ──
    // pi 不进 builtinServers 注入块(mcpInjection==="none")。引擎收敛后不再落盘桥接 .js:
    // 本轮全部 server 收进一个 bridgeServers 数组,经 PiOneShotOptions 交给 in-process 单发
    // 原生注册(createMcpInProcTools 内部按工具名去重,与旧「单扩展内去重」同义,避免重名冲突)。
    let piOneShot: Pick<PiOneShotOptions, "bridgeServers" | "todoTool"> | undefined;
    if (baseAgentKindOf(req.agent) === "pi") {
      // pi 的 adapter.mcpInjection==="none"，不会经过上面的 builtinServers 块。这里按轮重新读取
      // 设置并复用同一套 research gate；slides 走 cli:start 单发，每轮都会得到 fresh 工具集。
      // 文档抽取不依赖用户设置，必须和 gateway 长驻会话一样常驻注入。漏掉它时自动子 Agent
      // 会把 Pi 切到本分支，模型仍能运行却看不到 extract_document，只能静默回退到 bash。
      const docCfg = buildDocExtractMcpServerConfig(req.sessionId);
      let researchCfg: McpServerConfig | null = null;
      let mediaGenCfg: McpServerConfig | null = null;
      let loopCfg: McpServerConfig | null = null;
      try {
        const persistedState = await getPersistedState();
        researchCfg = buildResearchMcpServerConfig(
          persistedState.generalSettings?.researchEngine,
          req.sessionId,
          isSlidesRunId(req.runId) ? "slides" : "chat",
          req.webSearch === true,
        );
        // 媒体生成:与 claude/codex 的 builtinServers 块同款 gate(四模态全关/host 不可用 → null)。
        // pi 走 mcpInjection==="none" 不进那个块,漏掉这里就会出现「同一开关 claude 能生图、pi 不能」。
        mediaGenCfg = buildMediaGenMcpServerConfig(persistedState.mediaGenSettings, req.sessionId, req.cwd);
        // loop 工作流:无 enabled+callable 工作流 → null;loadWorkflows 失败降级不注入(不阻断 pi 启动)。
        const piWorkflows = await loadWorkflows().catch(() => []);
        loopCfg = buildLoopWorkflowsMcpServerConfig(piWorkflows, req.sessionId, req.cwd);
      } catch {
        /* 配置不可读 → research/media-gen/loop 均不注入，不阻断 pi 启动 */
      }
      // TODO(知识库): knowledge server 在 pi 单发路径同样缺席(claude/codex builtinServers 有、这里没有)。
      // 非有意省略,后续补齐时照 researchCfg 先例并入 piBridgeCfgs 即可。
      const piBridgeCfgs = [
        req.runId.startsWith("design:") || isSlidesRunId(req.runId)
          ? await ensureDesignDelegateMcpServerConfig(req.sessionId)
          : null,
        slidesSessionActive ? await ensureSlidesMcpServerConfig(req.sessionId) : null,
        docCfg,
        researchCfg,
        mediaGenCfg,
        loopCfg,
      ].filter((c): c is McpServerConfig => c !== null);
      const bridges = [piDelegateBridge, ...piBridgeCfgs.map(mcpServerToBridge)]
        .filter((b): b is BridgeServer => b !== null);
      // 任务清单工具 todo_write:pi 无原生 TodoWrite,单发聊天路径常驻注入(与 RPC 路径的
      // native-hooks 对齐)。编排流(design:/slides:/writing:)跳过——其事件在渲染端
      // 被前缀守卫拦截,不渲染 todo 卡,注入只会让 agent 白调工具。
      const isOrchestrationRun =
        req.runId.startsWith("design:") || req.runId.startsWith("slides:") || req.runId.startsWith("writing:");
      piOneShot = { bridgeServers: bridges, todoTool: !isOrchestrationRun };
    }

    const inactivityMs = resolveCliInactivityTimeoutMs();

    // codex 的 exec 工具没有后台任务语义:回合结束/下一轮 turn 启动时,上一轮仍在跑的命令
    // 会连同其进程组一起被清理(codex 自身行为,用户实测:turn1 起的 dev server 在 turn2 被杀,
    // codex 也自述「由会话工具拉起的子进程会在回合结束时清理」)。注入英文运行时守则,要求
    // 长驻服务必须脱离进程组后台化、命令本身立即返回——同时治好「命令 in_progress 吊死回合」。
    // 静态文本恒定追加,不破坏供应商 prompt 缓存前缀。
    if (baseAgentKindOf(req.agent) === "codex") {
      req.appendSystemPrompt = [req.appendSystemPrompt, CODEX_LONG_RUNNING_PROCESS_GUIDANCE]
        .filter(Boolean)
        .join("\n\n");
    }

    // ── ws 传输分流(U5):codex 主交互会话走 app-server WebSocket,在 buildArgs/spawn 之前前置返回 ──
    // ws 路径不调 buildArgs(那是 `codex exec` 的命令构造),直接把已算好的 mcpArgs 交给 server 管理器。
    // 仅 cli:start 读 transport;oneshot/ask/automation/workflow-headless 不经此、恒走 spawn+`codex exec`。
    // 委派场景强制 codex 走单发 codex exec（非 ws）：ws app-server 长驻会缓存 tools/list，
    // 破坏 per-turn 工具集（每轮 @mention 不同）。单发每轮 fresh exec 重新发现 delegate 工具。
    // 委派场景强制走单发(非 ws):ws app-server 长驻缓存 tools/list,破坏 per-turn delegate 工具集。
    // 设计回合的 design-delegate 同理需 per-turn 工具,故设计回合也不走 ws。
    // Slides 回合同理:cortex-slides 工具按会话 gate,ws 长驻会缓存 tools/list。
    const goesWs =
      (adapter.transport ?? "spawn") === "ws" &&
      !req.delegateRoles?.length &&
      !req.runId.startsWith("design:") &&
      !slidesSessionActive;

    // codex 原生 skill(U4):ws 主交互路径把 invokedSkill 作为 turn/start 的原生 skill input item
    // 显式注入(见 buildTurnInput);但因委派等原因退回 `codex exec`(非 ws)时,exec 没有输入层做
    // slash→内容 替换,退回现状 prose 回退(R3):把 invokedSkill 渲染成「读 SKILL.md 再执行」的
    // 定向 prompt 写回 req.prompt(与改动前 codex 单发 skill 行为等价),并清空 invokedSkill(已消费,
    // 避免 exec 下游误读)。ws 分支不在此处理,留给 buildTurnInput。
    if (req.agent === "codex" && req.invokedSkill && !goesWs) {
      req.prompt = renderCodexSkillFallback(req.invokedSkill, req.prompt);
      req.invokedSkill = undefined;
    }

    if (goesWs) {
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
            unregisterResearchSession(req.sessionId);
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
    // pi 不构造命令行(buildArgs 是抛错 stub):无条件走 in-process 单发。图片校验从 buildArgs
    // 挪进了 oneshot 内部(startPiInProcOneShot → validatePiImages),错误码/文案不变。
    const isPiRun = baseAgentKindOf(req.agent) === "pi";
    const built = isPiRun ? undefined : adapter.buildArgs(req, mcpArgs); // 未接入的 agent 在此抛错 → renderer 收到 rejection
    const { cmd, args, stdin } = built ?? { cmd: "(pi in-process)", args: [] as string[], stdin: undefined };

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
        // model/effort:调试跟踪需能直读本轮用的模型与推理强度(缺省 = 未显式传,用 agent 自身默认)。
        data: {
          cmd,
          cwd: req.cwd,
          model: req.model ?? "(默认)",
          effort: req.effort ?? "(默认)",
          argCount: args.length,
          // MCP 预授权现场取证:权限类问题(如 slides 回合 claude 被 MCP 弹窗卡死)可直读
          // 本轮是否带了 --allowed-tools 及其值,不必猜测运行中的构建新旧。值仅含 server 名,无敏感信息。
          allowedTools: (() => {
            const i = args.indexOf("--allowed-tools");
            return i >= 0 ? args[i + 1] : "(无)";
          })(),
          attempt,
          // 上下文不做 UI 历史重放：记录主 agent 原生 session 的续接身份，便于在 traces 中
          // 区分“同一主会话续接”与“fresh 主会话”。delegate 子任务的实际上下文另见 delegate trace。
          contextMode: req.resumeSessionId ? "native-resume" : "fresh",
          resumeSessionId: req.resumeSessionId,
          delegateRoles: req.delegateRoles?.map((role) => role.id),
          promptPreview: promptPreview(req.prompt),
        },
      });
      // pi 无条件走 in-process 单发(带本轮 MCP 桥与 todo 注入);claude/codex 原样 spawn。
      const proc = isPiRun
        ? startPiInProcOneShot(req, { cwd: req.cwd, ...piOneShot })
        : startAgentProcess(cmd, args, { cwd: req.cwd, env: spawnEnvForDef(req, adapter), stdin });
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
      // 委派:把本 attempt 的 noteActivity 暴露给 delegate handler 喂主进程看门狗(R2)。每 attempt 覆盖。
      if (req.delegateRoles?.length) runWatchdogBumpers.set(req.runId, noteActivity);

      const flushStdout = pipeStdoutLines(proc.stdout, (line) => {
        noteActivity(); // 任意 stdout 行(含未解析行)都算活跃,重置看门狗
        for (const ev of parseLineEvents(adapter, line)) {
          sawAny = true;
          // text/thinking 增量交 trace 记录端合并为生长段(与 pi-session 同策略,避免逐 delta 刷屏);
          // 仅影响 dev 调试跟踪,sendEvent 真实事件管线不变。
          if (ev.type === "text" || ev.type === "thinking") {
            if (ev.type === "text") sawText = true;
            recordStreamDelta({
              scope: "cli",
              segmentType: ev.type === "text" ? "text" : "reasoning",
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
        log.error(`${req.agent} spawn failed: ${err.message}`);
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
        // 委派清理:取消所有在途子 agent + 注销 delegate session + 移除看门狗复位器。
        if (delegateAbort) {
          delegateAbort.abort();
          unregisterDelegateSession(req.sessionId, delegateState);
        }
        if (designDelegateAbort) {
          designDelegateAbort.abort();
          unregisterDesignDelegateSession(req.sessionId);
        }
        if (slidesSessionActive) unregisterSlidesSession(req.sessionId);
        runWatchdogBumpers.delete(req.runId);
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
          // 清理研究 MCP 的 session→Consumer 映射（下一轮 cli:start 会重新 register）。
          unregisterResearchSession(req.sessionId);
        }
        // 委派清理:取消所有在途子 agent + 注销 delegate session + 移除看门狗复位器。
        if (delegateAbort) {
          delegateAbort.abort();
          unregisterDelegateSession(req.sessionId, delegateState);
        }
        if (designDelegateAbort) {
          designDelegateAbort.abort();
          unregisterDesignDelegateSession(req.sessionId);
        }
        // Slides 会话状态注销:回合终态即失效(下一轮 cli:start 会重新注册),防跨 deck 泄漏。
        if (slidesSessionActive) unregisterSlidesSession(req.sessionId);
        runWatchdogBumpers.delete(req.runId);
        cancelledRunIds.delete(req.runId);
        running.delete(req.runId);
        const timeoutError = watchdogTripped
          ? `活跃超时:${Math.round(inactivityMs / 1000)} 秒无输出,已终止`
          : undefined;
        const error = timeoutError ?? (code !== 0 && code !== null ? stderrTail.trim() || undefined : undefined);
        if (error) log.error(`${req.agent} exited with code ${code}: ${error}`);
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
        providerId?: string;
        effort?: ReasoningEffort;
      },
    ) => {
      // oneshot（标题/日报）默认 claude。pi 选中了供应商（日报选 Pi）时:providerId 直接进请求,
      // 模型/凭据由 in-process 引擎的 resolveOneShotModel 原生解析（Catalog + 自定义 + 凭据金库,
      // 解析不出响亮抛错）;未传 providerId 则裸 pi 跑（用 pi 自身默认 provider,如标题生成兜底）。
      // claude/codex 不挂供应商。明文 apiKey 不经 IPC 过桥。
      const agent = req.agent ?? "claude";
      // 不传 cwd 时在用户主目录运行 —— 不加载项目上下文,更快更省（不叠加 workspaceRoot,
      // 那是交互会话/自动化的默认目录语义,oneshot 是轻量任务）。
      const cwd = req.cwd ?? homedir();
      await assertAgentAvailable(agent);
      const adapter = getAgentDef(agent);
      const isPiOneshot = baseAgentKindOf(agent) === "pi";
      const oneshotReq: CliStartRequest = {
        runId: "oneshot",
        sessionId: "oneshot",
        agent,
        cwd,
        prompt: req.prompt,
        model: req.model,
        providerId: req.providerId,
        effort: req.effort,
      };
      // pi 不构造命令行(buildArgs 是抛错 stub),走 in-process 单发。
      const built = isPiOneshot
        ? undefined
        : adapter.buildArgs(
            oneshotReq,
            CODEX_MCP_CLEAR, // 轻量任务:codex 清空 MCP(沿用 M1,避免加载用户重 MCP);claude 忽略
          );
      const { cmd, args, stdin } = built ?? { cmd: "(pi in-process)", args: [] as string[], stdin: undefined };
      assertSpawnCwd(cwd);
      recordAgentTrace({
        scope: "oneshot",
        phase: "start",
        summary: `${agent} oneshot start`,
        sessionId: "oneshot",
        agent,
        data: { cmd, cwd, model: req.model ?? "(默认)", effort: req.effort ?? "(默认)", argCount: args.length, promptPreview: promptPreview(req.prompt) },
      });
      return new Promise<string>((resolve, reject) => {
        // pi 无条件走 in-process 单发(轻量任务不注入 MCP/todo);claude/codex 原样 spawn。
        const proc = isPiOneshot
          ? startPiInProcOneShot(oneshotReq, { cwd })
          : startAgentProcess(cmd, args, { cwd, env: spawnEnvForDef({ agent }, adapter), stdin });
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
            // text/thinking 增量合并为段(thinking 逐 delta 落普通事件会刷屏,完整输出后定格一条);其它事件走普通 trace。
            if (ev.type === "text" || ev.type === "thinking") {
              recordStreamDelta({
                scope: "oneshot",
                segmentType: ev.type === "text" ? "text" : "reasoning",
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
          log.error(`[oneshot] ${agent} spawn failed: ${err.message}`);
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
            log.error(`[oneshot] ${agent} exited with code ${code}: ${error}`);
            reject(new Error(error));
          }
        });
      });
    },
  );

  // 编辑重发:截断 agent CLI 会话记忆文件(纯逻辑在 session-trim.ts)。
  ipcMain.handle("cli:agentSessionExists", (_e, req: AgentSessionRequest) => agentSessionExists(req));
  ipcMain.handle("cli:trimSession", (_e, req: TrimSessionRequest) => trimAgentSession(req));
  // 分支重新生成:复制会话记忆为新 id 并截断副本(源文件保留,旧分支可续聊)。失败返回 null。
  ipcMain.handle("cli:trimSessionIntoCopy", (_e, req: TrimSessionRequest) => trimSessionIntoCopy(req));

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
