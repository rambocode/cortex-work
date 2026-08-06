// pi gateway 的进程承载层（U1 / KTD2）。
//
// 抄 `research/worker/transport.ts` 的生产验证结论，不自己摸索。三条实测约束逐条写在下面，
// 它们各自对应一个「同症状不同因」的坑，缺任何一条都表现为「worker 起不来但没有任何报错」。
//
// ── 契约 ────────────────────────────────────────────────────────────────────────────
// 协议走 `child.postMessage(line)` ⇄ `process.parentPort.postMessage(line)`，
// **一行 JSONL 进、一行 JSONL 出**（成帧见 protocol.ts 的 encodeLine/decodeLine）。
// stdout / stderr **不参与协议**，只做崩溃诊断。
//
// ── 为什么不能用 stdio 承载（KTD2）─────────────────────────────────────────────────
// `utilityProcess` 的 stdin **必须**是 `ignore`（electron.d.ts 原文：
// "Configuring `stdin` to any property other than `ignore` is not supported and will result in
// an error."）。配成 `"inherit"` / `"pipe"` 时子进程直接起不来，且表现为「code=0、无任何输出」
// ——最难查的一种失败。
//
// ── stdout 必须消费掉 ───────────────────────────────────────────────────────────────
// 协议不走 stdout，但 pi 的依赖闭包里随时可能有人 `console.log`。不 resume 的话管道写满后
// worker 会**卡死在一次 write 上**（没有超时、没有报错），表现为会话「开着但永远不回消息」。
//
// ── stderr 尾环 ─────────────────────────────────────────────────────────────────────
// worker 的 ESM 加载失败（`ERR_MODULE_NOT_FOUND` 那一族）只会打到 stderr，且此时协议通道
// 根本没建立起来——尾环是**唯一**的线索来源。全量收集则会在长会话里吃掉主进程内存，故留最后 2KB。
import { app, utilityProcess } from "electron";

import { piHostEntryCandidates, resolvePiHostEntry } from "./entry";
import { createLogger } from "../../log";

const log = createLogger("pi-gateway");

/** stderr 尾环大小。见文件头。 */
const STDERR_TAIL_BYTES = 2000;

/** 承载抽象：一行进、一行出，加上退出与错误通知。客户端只依赖它，单测传替身即可全覆盖。 */
export interface PiGatewayTransport {
  /** 写出一行 JSONL（实现负责成帧，调用方不加换行）。 */
  writeLine(line: string): void;
  onLine(cb: (line: string) => void): void;
  /** 退出通知。stderrTail 是崩溃诊断用的最后 2KB stderr。 */
  onExit(cb: (code: number | null, stderrTail?: string) => void): void;
  onError(cb: (err: Error) => void): void;
  /** 终止进程。force 为真时跳过优雅终止直接强杀（两段式 kill 的第二段）。 */
  kill(force?: boolean): void;
}

/** fork 参数。全部可选：缺省即「入口自动解析 + 继承主进程 env / cwd」。 */
export interface PiGatewayForkOptions {
  /** 会话工作目录。pi 的工具（bash/read/grep）与会话文件推导都依赖它。 */
  cwd?: string;
  /**
   * 追加/覆盖的环境变量（如自定义 Provider 的 `${CORTEX_PI_SECRET_N}` 占位、Computer Use 的
   * grounding 模型配置）。与 `process.env` 合并后传入——`utilityProcess.fork` 的 `env` 是
   * **整体替换**语义，只传增量会把 PATH/HOME 一起丢掉，pi 的 stdio MCP server 立刻 spawn 失败。
   */
  env?: Record<string, string>;
  /** 显式入口路径（测试/诊断脚本用）。缺省走 `resolvePiHostEntry`。 */
  entry?: string;
}

/** 承载工厂。客户端只认这个签名，生产用 `forkPiHostTransport`，单测传替身。 */
export type PiGatewayTransportFactory = (options: PiGatewayForkOptions) => PiGatewayTransport;

// ── 全局注册表 ───────────────────────────────────────────────────────────────────────
//
// `utilityProcess` 的子进程**不会**随 Electron 主进程退出自动消失（`before-quit` 没走完的路径、
// 主进程崩溃退出、开发态热重启都会留下孤儿）。留下的 pi-host 会继续持有模型连接与 MCP 子进程。
// 本模块**只导出不接线**：把 `killAllPiHostWorkers()` 挂进 app 的退出钩子是接线单元（U4/U5）的事。
const activeWorkers = new Set<Pick<PiGatewayTransport, "kill">>();

/** 杀掉全部存活的 pi-host worker，返回清理数量。 */
export function killAllPiHostWorkers(): number {
  const workers = [...activeWorkers];
  activeWorkers.clear();
  for (const worker of workers) {
    try {
      worker.kill(true);
    } catch {
      // 单个 kill 抛错必须继续杀完剩下的：退出钩子只有一次机会，因一个已死进程的报错就漏掉
      // 其余进程，正是「退出后仍有残留 worker」的典型成因。
    }
  }
  return workers.length;
}

/** 当前存活的 worker 数（诊断/单测用）。 */
export function activePiHostWorkerCount(): number {
  return activeWorkers.size;
}

// ── 生产实现 ─────────────────────────────────────────────────────────────────────────

/**
 * 用 `utilityProcess.fork` 起一个 pi-host worker。
 *
 * ⚠️ **必须在 `app.whenReady()` 之后调用**：早于 ready 时 Electron 直接抛
 * "utilityProcess cannot be created before app is ready"。调用点（`pi:open` IPC handler）天然
 * 满足，这里的断言只为把「有人把它挪到启动早期」变成一条可读的错误而不是一句晦涩的内部异常。
 */
export function forkPiHostTransport(options: PiGatewayForkOptions = {}): PiGatewayTransport {
  if (!app.isReady()) {
    throw new Error("pi gateway worker 必须在 app ready 之后创建（utilityProcess 的硬约束）");
  }

  const entry = options.entry ?? resolvePiHostEntry(entryInput());
  if (!entry) {
    throw new Error(
      `找不到 pi-host worker 入口，已尝试：${piHostEntryCandidates(entryInput()).join("、")}`,
    );
  }

  const child = utilityProcess.fork(entry, [], {
    // stdin 必须 ignore（KTD2）；stdout/stderr 走 pipe 做诊断。
    stdio: ["ignore", "pipe", "pipe"],
    serviceName: "cortex-pi-host",
    ...(options.cwd ? { cwd: options.cwd } : {}),
    // env 是整体替换语义，故必须先铺 process.env（见 PiGatewayForkOptions.env）。
    ...(options.env ? { env: { ...process.env, ...options.env } as Record<string, string> } : {}),
  });

  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });
  // 协议不走 stdout，但必须消费掉，否则管道写满会把 worker 卡死（见文件头）。
  child.stdout?.resume();

  const transport: PiGatewayTransport = {
    writeLine: (line) => child.postMessage(line),
    onLine: (cb) => {
      child.on("message", (message: unknown) => {
        // worker 侧一律 postMessage(string)；非字符串只可能来自误用，序列化后交给上层丢弃并留痕。
        cb(typeof message === "string" ? message : JSON.stringify(message));
      });
    },
    onExit: (cb) => {
      child.on("exit", (code: number) => {
        activeWorkers.delete(transport);
        cb(code, stderrTail);
      });
    },
    onError: (cb) => {
      // utilityProcess 没有 'error' 事件；spawn 失败表现为立刻 exit。保留该回调只为让
      // PiGatewayTransport 对将来可能的 child_process 实现（会 emit 'error'）保持通用。
      void cb;
    },
    kill: (force) => {
      try {
        if (force && child.pid) {
          // utilityProcess.kill() 只做优雅终止（POSIX 上是 SIGTERM），没有信号参数；
          // 强杀只能绕到 process.kill 直接发 SIGKILL。
          process.kill(child.pid, "SIGKILL");
          return;
        }
        child.kill();
      } catch {
        // 进程可能已经没了，kill 抛错属于正常竞态，忽略。
      }
    },
  };

  activeWorkers.add(transport);
  log.debug("pi-host worker 已 fork", { entry, cwd: options.cwd });
  return transport;
}

/** 从 electron `app` 取入口解析所需的三个事实。抽出来只为 fork 与错误信息共用同一份输入。 */
function entryInput(): { isPackaged: boolean; appPath: string; resourcesPath: string } {
  return {
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  };
}
