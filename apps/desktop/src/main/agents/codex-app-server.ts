// codex app-server 长驻进程生命周期管理(U2)。
//
// 与 `codex exec` 每轮 spawn 不同:codex 主交互会话用一个长驻 `codex app-server --listen ws://127.0.0.1:<port>`
// 进程,经 WebSocket 持久驱动(见 ipc/codex-ws-channel.ts)。本模块负责进程侧:端口分配、就绪探测、
// 按 sessionId 注册、资源回收(空闲驱逐/并发上限/LRU)、崩溃清理、应用退出整体回收。
//
// 设计:依赖注入(spawn/env/port/readyz/now 全部可注入)——单测注入 fake,生产由 cli.ts 注入
// `startAgentProcess`/`buildEnv`(故本模块对 cli.ts 仅 `import type`,运行时无循环依赖)。
//
// 实测(codex-cli 0.142.2,见计划 Open Questions):
//   - `--listen ws://127.0.0.1:<port>` 接受预绑定端口;stderr 打印监听地址;仅绑 localhost。
//   - `GET /readyz` 就绪后返回 200(~100ms)。
//   - `-c mcp_servers.*` 在 app-server 级被接受(MCP 经启动参数注入,OQ2=是)。
//   - loopback 只接受无 Origin 头连接(浏览器必被拒,DNS rebinding 由 codex 自身挡住,OQ4)。

import net from "node:net";
import http from "node:http";
import type { AgentProcess } from "../ipc/cli"; // 仅类型,运行时不引入 → 无循环依赖
import { createLogger } from "../log";

// codex app-server 进程侧盲区观测(U4):就绪超时 / 旧版不支持 / LRU·空闲驱逐 等
// 会静默吞掉会话的节点在此落盘。埋点失败 try/catch 吞掉,不阻断进程管理主流程(R14)。
const log = createLogger("codex-server");

// ── 可注入依赖 ────────────────────────────────────────────────────────────
export interface CodexServerDeps {
  /** spawn 一个子进程(生产 = cli.ts 的 startAgentProcess,detached 进程组 + 组级 kill)。 */
  spawnProcess(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }): AgentProcess;
  /** 构造补齐 PATH 的子进程 env(生产 = cli.ts 的 buildEnv)。 */
  buildEnv(): NodeJS.ProcessEnv;
  /** 分配一个空闲端口(默认真实 net 实现)。 */
  allocatePort?(): Promise<number>;
  /** /readyz 探针:返回 true 表示该端口已就绪(默认真实 http 实现)。 */
  probeReady?(port: number): Promise<boolean>;
  /** 当前时间 ms(默认 Date.now;注入便于测试驱逐时序)。 */
  now?(): number;
  /** 就绪轮询超时(ms,默认 15000)。 */
  readyTimeoutMs?: number;
  /** 就绪轮询间隔(ms,默认 100)。 */
  readyPollMs?: number;
  /** 最大并发 server 数(默认 8;超出则 LRU 驱逐空闲 server)。 */
  maxServers?: number;
  /** 空闲驱逐阈值(ms,默认 30min;无活跃 turn 且超此时长 → 回收)。 */
  idleEvictMs?: number;
}

export interface EnsureServerOpts {
  /** 默认 cwd(thread/start 仍可逐 thread 覆盖;此处主要影响 server 进程自身)。 */
  cwd?: string;
  /** ws 路径 spawn 的可执行名(派生 agent 的自定义 bin → def.serverCmd;缺省 "codex")。 */
  serverCmd?: string;
  /** MCP 注入参数(`-c mcp_servers.*` 等),拼入 app-server 启动 args(OQ2=是)。 */
  mcpArgs?: string[];
  /** 合并进子进程 env 的额外变量(派生 agent extraEnv)。 */
  extraEnv?: Record<string, string>;
}

export interface CodexAppServer {
  sessionId: string;
  port: number;
  wsUrl: string;
  proc: AgentProcess;
  /** 启动配置指纹:变化(如 MCP 配置改动)→ 下次 ensure 杀旧起新。 */
  configKey: string;
  lastActiveAt: number;
  /** 是否有在途 turn(驱逐时跳过 busy 的 server)。 */
  busy: boolean;
  /** 进程是否已退出(崩溃或被杀)。 */
  dead: boolean;
}

// ── 默认真实依赖实现 ──────────────────────────────────────────────────────
/** 分配一个空闲端口:listen(0) 取系统分配端口后立即关闭。 */
export function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("无法分配端口"))));
    });
  });
}

/** GET http://127.0.0.1:<port>/readyz,200 视为就绪。 */
export function probeReadyz(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/readyz", timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 旧版 codex 无 app-server 子命令时的 stderr 特征 → 给出升级提示(R9)。
function looksLikeUnsupported(stderrTail: string): boolean {
  return /unrecognized|unexpected argument|USAGE|unknown subcommand|no such subcommand/i.test(stderrTail);
}

export class CodexServerManager {
  private readonly deps: Required<
    Pick<CodexServerDeps, "spawnProcess" | "buildEnv">
  > &
    CodexServerDeps;
  private readonly servers = new Map<string, CodexAppServer>();

  constructor(deps: CodexServerDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
  private get maxServers(): number {
    return this.deps.maxServers ?? 8;
  }
  private get idleEvictMs(): number {
    return this.deps.idleEvictMs ?? 30 * 60_000;
  }

  /** 当前会话是否已有存活 server(供 cli.ts 判断是否需要 thread/start vs resume)。 */
  has(sessionId: string): boolean {
    const s = this.servers.get(sessionId);
    return !!s && !s.dead;
  }

  /** 标记会话活跃(收到 ws 消息时调用),重置空闲计时基准。 */
  markActive(sessionId: string): void {
    const s = this.servers.get(sessionId);
    if (s) s.lastActiveAt = this.now();
  }

  /** 设置在途 turn 标志(驱逐时跳过 busy)。 */
  setBusy(sessionId: string, busy: boolean): void {
    const s = this.servers.get(sessionId);
    if (s) {
      s.busy = busy;
      s.lastActiveAt = this.now();
    }
  }

  /**
   * 确保会话有一个就绪的 app-server。复用同 configKey 的存活 server;configKey 变化(MCP 改动)
   * 或已死 → 杀旧起新。返回 { wsUrl, port, restarted }。失败(就绪超时/旧版不支持)抛错,
   * 由 cli.ts 转成 result{ok:false} 降级。
   */
  async ensureServer(
    sessionId: string,
    opts: EnsureServerOpts,
  ): Promise<{ wsUrl: string; port: number; restarted: boolean }> {
    const configKey = JSON.stringify({
      serverCmd: opts.serverCmd ?? "codex",
      mcpArgs: opts.mcpArgs ?? [],
    });
    const existing = this.servers.get(sessionId);
    if (existing && !existing.dead && existing.configKey === configKey) {
      existing.lastActiveAt = this.now();
      return { wsUrl: existing.wsUrl, port: existing.port, restarted: false };
    }
    // 配置变化或已死 → 回收旧的
    if (existing) this.killServer(sessionId);

    // 并发上限:超出则 LRU 驱逐空闲(非 busy)server
    this.evictIfNeeded();

    const server = await this.spawnReady(sessionId, opts, configKey);
    this.servers.set(sessionId, server);
    return { wsUrl: server.wsUrl, port: server.port, restarted: !!existing };
  }

  private async spawnReady(
    sessionId: string,
    opts: EnsureServerOpts,
    configKey: string,
  ): Promise<CodexAppServer> {
    const allocate = this.deps.allocatePort ?? allocateFreePort;
    const probe = this.deps.probeReady ?? probeReadyz;
    const port = await allocate();
    const wsUrl = `ws://127.0.0.1:${port}`;
    const cmd = opts.serverCmd ?? "codex";
    const args = ["app-server", "--listen", wsUrl, ...(opts.mcpArgs ?? [])];
    const env = { ...this.deps.buildEnv(), ...(opts.extraEnv ?? {}) };

    const proc = this.deps.spawnProcess(cmd, args, { env });

    const server: CodexAppServer = {
      sessionId,
      port,
      wsUrl,
      proc,
      configKey,
      lastActiveAt: this.now(),
      busy: false,
      dead: false,
    };

    // 收集 stderr 尾用于错误诊断(旧版无 app-server 子命令时给升级提示)。
    let stderrTail = "";
    proc.stderr?.setEncoding?.("utf8");
    proc.stderr?.on?.("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-3000);
    });

    // 进程退出:标记 dead + 从注册表移除(若仍是当前条目)。崩溃的可见后果由 ws close 驱动 cli.ts 收尾。
    let exited = false;
    proc.onExit(() => {
      exited = true;
      server.dead = true;
      if (this.servers.get(sessionId) === server) this.servers.delete(sessionId);
    });

    // 就绪轮询:/readyz=200 或超时;期间若进程退出则立即判失败(给升级提示)。
    const timeoutMs = this.deps.readyTimeoutMs ?? 15_000;
    const pollMs = this.deps.readyPollMs ?? 100;
    const t0 = this.now();
    for (;;) {
      if (exited) {
        const unsupported = looksLikeUnsupported(stderrTail);
        const hint = unsupported
          ? "codex 版本过旧或不支持 app-server,请升级 codex 后重试"
          : stderrTail.trim() || "codex app-server 启动即退出";
        // 盲区补点(R10):启动即退出会被 cli.ts 降级为 result{ok:false},原因(尤其旧版不支持)
        // 仅在弹窗一闪而过,落盘留证便于复盘。
        try {
          log.warn("codex app-server 启动即退出", { sessionId, unsupported, stderrTail: stderrTail.trim() || undefined });
        } catch {
          /* 日志失败不影响抛错降级 */
        }
        throw new Error(hint);
      }
      if (await probe(port)) return server;
      if (this.now() - t0 > timeoutMs) {
        try {
          proc.kill();
        } catch {
          /* 已退出 */
        }
        server.dead = true;
        if (this.servers.get(sessionId) === server) this.servers.delete(sessionId);
        // 盲区补点(R10):就绪轮询超时,记录端口 + 阈值便于定位是端口冲突还是启动慢。
        try {
          log.warn("codex app-server 就绪超时", { sessionId, port, timeoutMs });
        } catch {
          /* 日志失败不影响抛错降级 */
        }
        throw new Error(`codex app-server 就绪超时(${Math.round(timeoutMs / 1000)}s)`);
      }
      await sleep(pollMs);
    }
  }

  /** 并发上限驱逐:数量达上限时,LRU 回收最久未活跃且非 busy 的 server。 */
  private evictIfNeeded(): void {
    if (this.servers.size < this.maxServers) return;
    const candidates = [...this.servers.values()]
      .filter((s) => !s.busy && !s.dead)
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    // 腾到上限以下(此次新建会 +1)
    while (this.servers.size >= this.maxServers && candidates.length) {
      const victim = candidates.shift()!;
      // 盲区补点(R10):LRU 驱逐会静默杀掉一个会话的 server(下次该会话需重启),记录便于
      // 排查「会话莫名重启」是否因并发上限触发。
      try {
        log.debug("codex app-server LRU 驱逐", { sessionId: victim.sessionId, size: this.servers.size, maxServers: this.maxServers });
      } catch {
        /* 日志失败不影响驱逐 */
      }
      this.killServer(victim.sessionId);
    }
  }

  /** 空闲驱逐扫描:回收所有空闲超阈值且非 busy 的 server。由外部定时调用(或测试直接调)。 */
  sweepIdle(): void {
    const cutoff = this.now() - this.idleEvictMs;
    for (const s of [...this.servers.values()]) {
      if (!s.busy && !s.dead && s.lastActiveAt < cutoff) {
        // 盲区补点(R10):空闲超阈值驱逐,记录便于排查「会话莫名重启」是否因长时间空闲触发。
        try {
          log.debug("codex app-server 空闲驱逐", { sessionId: s.sessionId, idleMs: this.now() - s.lastActiveAt });
        } catch {
          /* 日志失败不影响驱逐 */
        }
        this.killServer(s.sessionId);
      }
    }
  }

  /** 杀掉某会话的 server(SIGTERM 整组,由 AgentProcess.kill 实现)+ 移出注册表。 */
  killServer(sessionId: string): void {
    const s = this.servers.get(sessionId);
    if (!s) return;
    s.dead = true;
    this.servers.delete(sessionId);
    try {
      s.proc.kill();
    } catch {
      /* 已退出 */
    }
  }

  /** 应用退出:回收全部 server。 */
  killAll(): void {
    for (const id of [...this.servers.keys()]) this.killServer(id);
  }

  /** 测试/诊断:当前存活 server 数。 */
  size(): number {
    return this.servers.size;
  }
}
