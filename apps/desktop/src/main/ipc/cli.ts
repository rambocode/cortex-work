// CLI 流式管线：spawn agent CLI → stdout 按行缓冲 → adapter 解析为归一化事件
// → webContents.send 推给 renderer。每个 runId 一个子进程，支持 kill；
// 应用退出前统一清理。

import { ipcMain, type WebContents } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { delimiter, dirname, isAbsolute, join } from "path";
import { homedir, platform } from "os";
import { existsSync, readdirSync, realpathSync, statSync } from "fs";
import type { AgentKind, AgentSessionRequest, CliExitEvent, CliStartRequest, CliStreamEvent, TrimSessionRequest } from "./types";
import { getAdapter } from "../agents";
import { agentSessionExists, trimAgentSession } from "./session-trim";
import { PI_KEY_ENV, writePiExtension } from "../agents/pi-providers";
import { recordAgentTrace, recordStreamDelta } from "./agent-trace";

const running = new Map<string, AgentProcess>();
const VERIFY_TIMEOUT_MS = 3000;
let detectedAgents: Promise<Record<AgentKind, boolean>> | null = null;

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

// SIGTERM 先礼,3s 未退出再用 pid 强杀（kill() 退出后 pid 变 undefined,需判空）。
// 返回强杀 timer 供进程正常退出后 clearTimeout,避免每次 kill 都空等 3s 占用（防泄漏）。
function killWithTimeout(soft: () => void, pid: number | undefined): ReturnType<typeof setTimeout> {
  soft();
  return setTimeout(() => {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已退出
      }
    }
  }, 3000);
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
      killTimer = killWithTimeout(() => child.kill("SIGTERM"), child.pid);
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
  opts: { cwd?: string; env: NodeJS.ProcessEnv },
): AgentProcess {
  const env = envForCommand(cmd, opts.env);
  const invocation = resolveInvocationForSpawn(cmd, args, env);
  const child = spawn(invocation.cmd, invocation.args, {
    cwd: opts.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
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

async function assertAgentAvailable(agent: AgentKind): Promise<void> {
  if (agent === "pi") return;
  const available = await detectAgents();
  if (available[agent] === false) throw new Error(agentUnavailableMessage(agent));
}

export function registerCliHandlers(): void {
  ipcMain.handle("cli:start", async (event, req: CliStartRequest) => {
    await assertAgentAvailable(req.agent);
    const sender = event.sender;
    const adapter = getAdapter(req.agent);
    // pi 选中了自定义供应商:先生成 extension 文件,把路径塞回 req 供 buildArgs 加 -e。
    if (req.agent === "pi" && req.provider) {
      req.piExtensionPath = writePiExtension(req.provider);
    }
    const { cmd, args } = adapter.buildArgs(req); // 未接入的 agent 在此抛错 → renderer 收到 rejection

    assertSpawnCwd(req.cwd);
    recordAgentTrace({
      scope: "cli",
      phase: "start",
      summary: `${req.agent} start`,
      runId: req.runId,
      sessionId: req.sessionId,
      agent: req.agent,
      data: { cmd, cwd: req.cwd, argCount: args.length, promptPreview: promptPreview(req.prompt) },
    });
    const proc = startAgentProcess(cmd, args, { cwd: req.cwd, env: spawnEnvFor(req) });
    running.set(req.runId, proc);

    // 事件回显 sessionId:renderer 被 HMR/刷新重载丢失内存注册表后,
    // 仍能把事件归属到正确的 session 继续渲染/清理。
    const sendEvent = (ev: CliStreamEvent) => {
      if (!sender.isDestroyed()) sender.send("cli:event", { runId: req.runId, sessionId: req.sessionId, event: ev });
    };
    const sendExit = (exit: CliExitEvent) => {
      if (!sender.isDestroyed()) sender.send("cli:exit", exit);
    };

    const flushStdout = pipeStdoutLines(proc.stdout, (line) => {
      const ev = adapter.parseLine(line);
      if (ev) {
        // text 增量交记录端合并为一条生长段;其它事件(init/tool/result)走普通 trace(并触发段收尾)。
        if (ev.type === "text") {
          recordStreamDelta({
            scope: "cli",
            segmentType: "text",
            delta: ev.delta,
            runId: req.runId,
            sessionId: req.sessionId,
            agent: req.agent,
          });
        } else {
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

    let stderrTail = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
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
      // 显式摘除 data 监听:闭包捕获 sender/buffer/adapter,避免进程对象延迟回收时驻留（防泄漏）。
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      running.delete(req.runId);
      sendExit({ runId: req.runId, code: null, error: err.message });
    });

    proc.onExit((code) => {
      // 冲刷残留的最后一行（无换行结尾时）。
      flushStdout();
      // 显式摘除 data 监听:闭包捕获 sender/buffer/adapter,避免进程对象延迟回收时驻留（防泄漏）。
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      running.delete(req.runId);
      const error = code !== 0 && code !== null ? stderrTail.trim() || undefined : undefined;
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
      sendExit({
        runId: req.runId,
        sessionId: req.sessionId,
        code,
        error,
      });
    });
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
      const adapter = getAdapter(agent);
      const provider = agent === "pi" ? req.provider : undefined;
      const piExtensionPath = provider ? writePiExtension(provider) : undefined;
      const { cmd, args } = adapter.buildArgs({
        runId: "oneshot",
        sessionId: "oneshot",
        agent,
        cwd,
        prompt: req.prompt,
        model: req.model,
        provider,
        piExtensionPath,
      });
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
          env: spawnEnvFor({ agent, provider }),
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
          const ev = adapter.parseLine(line);
          if (!ev) return;
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

  ipcMain.handle("cli:kill", (_e, runId: string) => {
    // kill() 内置 SIGTERM + 3s 兜底强杀（claude 偶尔会拖延收尾）。
    running.get(runId)?.kill();
  });
}

export function killAllCli(): void {
  for (const proc of running.values()) proc.kill();
  running.clear();
}

// 供测试或诊断使用。
export function hasRunning(_sender?: WebContents): boolean {
  return running.size > 0;
}
