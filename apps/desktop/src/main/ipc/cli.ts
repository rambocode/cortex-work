// CLI 流式管线：spawn agent CLI → stdout 按行缓冲 → adapter 解析为归一化事件
// → webContents.send 推给 renderer。每个 runId 一个子进程，支持 kill；
// 应用退出前统一清理。

import { ipcMain, utilityProcess, type WebContents, type UtilityProcess } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { delimiter, join } from "path";
import { homedir, platform } from "os";
import { existsSync, readdirSync } from "fs";
import type { AgentKind, AgentSessionRequest, CliExitEvent, CliStartRequest, CliStreamEvent, TrimSessionRequest } from "./types";
import { getAdapter } from "../agents";
import { agentSessionExists, trimAgentSession } from "./session-trim";
import { PI_KEY_ENV, writePiExtension } from "../agents/pi-providers";

const running = new Map<string, AgentProcess>();

// 统一封装两类子进程,屏蔽 child_process 与 Electron utilityProcess 的差异:
// claude/codex 是外部 CLI,走 child_process.spawn；pi 走 utilityProcess.fork
//（用 Electron 内置 Node、无 GUI、不在 macOS Dock 上闪现）。
export interface AgentProcess {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  // 进程结束且 stdout 读完后回调一次（合并 child_process 的 close / utilityProcess 的 exit）。
  onExit(cb: (code: number | null) => void): void;
  // 仅 child_process 的 spawn 错误（ENOENT 等）；utilityProcess 启动失败经 exit code + stderr 体现。
  onError(cb: (err: Error) => void): void;
  // 优雅终止（SIGTERM）+ 3s 兜底强杀。
  kill(): void;
}

// SIGTERM 先礼,3s 未退出再用 pid 强杀（kill() 退出后 pid 变 undefined,需判空）。
function killWithTimeout(soft: () => void, pid: number | undefined): void {
  soft();
  setTimeout(() => {
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
    kill: () => killWithTimeout(() => child.kill("SIGTERM"), child.pid),
  };
}

function wrapUtility(child: UtilityProcess): AgentProcess {
  // utilityProcess 无 close 事件,且 exit 可能早于 stdout flush;以「进程 exit + stdout
  // 流结束」双信号合并为一次 onExit,避免丢末行（pi 的最终结果/错误在末行 message_end 里）。
  let exited = false;
  let stdoutDone = false;
  let exitCode: number | null = null;
  let exitCb: ((code: number | null) => void) | null = null;
  let fired = false;
  const finalize = () => {
    // 必须等回调注册后才触发:否则信号先于 onExit 到达时会提前置 fired,导致补发失效。
    if (fired || !exited || !stdoutDone || !exitCb) return;
    fired = true;
    exitCb(exitCode);
  };
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
    finalize();
  });
  const out = child.stdout;
  if (out) {
    out.on("end", () => {
      stdoutDone = true;
      finalize();
    });
    out.on("close", () => {
      stdoutDone = true;
      finalize();
    });
  } else {
    stdoutDone = true;
  }
  return {
    get pid() {
      return child.pid;
    },
    stdout: child.stdout,
    stderr: child.stderr,
    onExit: (cb) => {
      exitCb = cb;
      finalize(); // 进程若已在设回调前结束,这里补发。
    },
    onError: () => {
      // utilityProcess 无对应的 spawn 错误事件;启动失败 = 非 0 exit code + stderr。
    },
    kill: () => killWithTimeout(() => child.kill(), child.pid),
  };
}

// 按 agent 分流启动子进程。pi 的 buildArgs 仍返回 cmd=process.execPath + args[0]=cli.js
//（兼容 adapter 契约与 pi.test.ts）,这里取 args[0] 作 utilityProcess 的 modulePath。
export function startAgentProcess(
  agent: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv },
): AgentProcess {
  if (agent === "pi") {
    const [modulePath, ...childArgs] = args;
    const child = utilityProcess.fork(modulePath, childArgs, {
      cwd: opts.cwd,
      env: opts.env as Record<string, string>,
      stdio: "pipe", // = ["ignore","pipe","pipe"]；stdin 只能 ignore。
      serviceName: "pi-agent",
    });
    return wrapUtility(child);
  }
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return wrapChild(child);
}

function nvmBinDirs(home: string): string[] {
  const root = `${home}/.nvm/versions/node`;
  try {
    return readdirSync(root)
      .map((name) => `${root}/${name}/bin`)
      .filter((dir) => existsSync(dir));
  } catch {
    return [];
  }
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
  const merged = [...new Set([...current.split(delimiter).filter(Boolean), ...extras])].join(delimiter);
  return { ...process.env, PATH: merged };
}

// 按 agent 定制子进程环境：pi 经 utilityProcess.fork 跑在 Electron 内置 Node 上,把选中
// 通道的 API key 注入 CORTEX_PI_KEY（与生成的 extension 里 apiKey:"$CORTEX_PI_KEY" 占位
// 对应）；其余 agent 用基础 env。
export function spawnEnvFor(req: { agent: string; provider?: { apiKey?: string } }): NodeJS.ProcessEnv {
  const env = buildEnv();
  if (req.agent !== "pi") return env;
  // utilityProcess 本身就是 Node 环境,不需要 ELECTRON_RUN_AS_NODE;防御性清除可能的残留。
  delete env.ELECTRON_RUN_AS_NODE;
  if (req.provider?.apiKey) env[PI_KEY_ENV] = req.provider.apiKey;
  return env;
}

// 在 PATH 各目录用 existsSync 找可执行文件（不实际 spawn,够快够稳）。
function hasOnPath(env: NodeJS.ProcessEnv, name: string): boolean {
  const candidates =
    platform() === "win32" ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return dirs.some((dir) => candidates.some((c) => existsSync(join(dir, c))));
}

// 探测本机可用 agent。pi 内置打包,恒为 true；claude/codex 看 PATH 是否找得到。
function detectAgents(): Record<AgentKind, boolean> {
  const env = buildEnv();
  return {
    claude: hasOnPath(env, "claude"),
    codex: hasOnPath(env, "codex"),
    pi: true,
  };
}

export function registerCliHandlers(): void {
  ipcMain.handle("cli:start", (event, req: CliStartRequest) => {
    const sender = event.sender;
    const adapter = getAdapter(req.agent);
    // pi 选中了自定义供应商:先生成 extension 文件,把路径塞回 req 供 buildArgs 加 -e。
    if (req.agent === "pi" && req.provider) {
      req.piExtensionPath = writePiExtension(req.provider);
    }
    const { cmd, args } = adapter.buildArgs(req); // 未接入的 agent 在此抛错 → renderer 收到 rejection

    const proc = startAgentProcess(req.agent, cmd, args, { cwd: req.cwd, env: spawnEnvFor(req) });
    running.set(req.runId, proc);

    // 事件回显 sessionId:renderer 被 HMR/刷新重载丢失内存注册表后,
    // 仍能把事件归属到正确的 session 继续渲染/清理。
    const sendEvent = (ev: CliStreamEvent) => {
      if (!sender.isDestroyed()) sender.send("cli:event", { runId: req.runId, sessionId: req.sessionId, event: ev });
    };
    const sendExit = (exit: CliExitEvent) => {
      if (!sender.isDestroyed()) sender.send("cli:exit", exit);
    };

    let buffer = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const ev = adapter.parseLine(line);
        if (ev) sendEvent(ev);
      }
    });

    let stderrTail = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    proc.onError((err) => {
      running.delete(req.runId);
      sendExit({ runId: req.runId, code: null, error: err.message });
    });

    proc.onExit((code) => {
      // 冲刷残留的最后一行（无换行结尾时）。
      const line = buffer.trim();
      if (line) {
        const ev = adapter.parseLine(line);
        if (ev) sendEvent(ev);
      }
      running.delete(req.runId);
      sendExit({
        runId: req.runId,
        sessionId: req.sessionId,
        code,
        error: code !== 0 && code !== null ? stderrTail.trim() || undefined : undefined,
      });
    });
  });

  // 一次性短任务（生成 session 标题 / 日报等）:复用各 agent 的 adapter
  // （buildArgs 构造命令 + parseLine 解析流式输出）,聚合 text 增量为纯文本返回。
  // 新接入的 agent 自动获得 oneshot 能力。60 秒超时。
  // 不传 cwd 时在用户主目录运行 —— 不加载项目上下文,更快更省。
  ipcMain.handle(
    "cli:oneshot",
    (
      _e,
      req: {
        agent?: AgentKind;
        cwd?: string;
        prompt: string;
        model?: string;
      },
    ) => {
      // oneshot（标题/日报）不挂自定义供应商:默认 claude;若为 pi 则仅当作纯 Node 跑,
      // 无供应商则用 pi 自身默认 provider（标题生成场景已在 renderer 侧对 pi 走兜底）。
      const agent = req.agent ?? "claude";
      // 不传 cwd 时在用户主目录运行 —— 不加载项目上下文,更快更省（不叠加 workspaceRoot,
      // 那是交互会话/自动化的默认目录语义,oneshot 是轻量任务）。
      const cwd = req.cwd ?? homedir();
      const adapter = getAdapter(agent);
      const { cmd, args } = adapter.buildArgs({
        runId: "oneshot",
        sessionId: "oneshot",
        agent,
        cwd,
        prompt: req.prompt,
        model: req.model,
      });
      return new Promise<string>((resolve, reject) => {
        const proc = startAgentProcess(agent, cmd, args, {
          cwd,
          env: spawnEnvFor({ agent }),
        });
        let out = "";
        let resultText = "";
        let failed: string | null = null;
        const timer = setTimeout(() => {
          proc.kill();
          reject(new Error("oneshot 超时"));
        }, 60_000);

        const handleLine = (line: string) => {
          if (!line) return;
          const ev = adapter.parseLine(line);
          if (!ev) return;
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
        proc.onError((err) => {
          clearTimeout(timer);
          reject(err);
        });
        proc.onExit((code) => {
          clearTimeout(timer);
          handleLine(buffer.trim()); // 冲刷无换行结尾的最后一行
          const text = (out || resultText).trim();
          if (failed) reject(new Error(failed));
          else if (code === 0 && text) resolve(text);
          else if (code === 0) reject(new Error("oneshot 无输出"));
          else reject(new Error(`oneshot 退出码 ${code}`));
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
