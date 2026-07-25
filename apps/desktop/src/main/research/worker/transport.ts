// Worker 承载层抽象（spec §12.1 的偏离点，依据见 U0 spike S3）。
//
// **跨进程契约**：spec 写的是「stdin/stdout 使用 JSONL」，但 Electron 的 utilityProcess
// **不允许把 stdin 配成 pipe**——electron.d.ts:20716 原文：
//   "Configuring `stdin` to any property other than `ignore` is not supported and will
//    result in an error."
// 因此承载改为 `child.postMessage(line)` ←→ `process.parentPort.postMessage(line)`，
// 契约收敛成「**一行 JSONL 进 / 一行 JSONL 出**」。协议消息体、method 名、字段、错误信封
// 与 spec §12 逐字一致（真源见 core/research/protocol）。
//
// 将来换 Rust Worker（真 stdio）时：只需再实现一个 WorkerTransport，把 writeLine 写进 stdin、
// 把 stdout 按行切开喂给 onLine。其上的 rpc-client / process-manager **零改动**。
import { utilityProcess } from "electron";

/// 承载抽象：一行进、一行出，加上退出与错误通知。
export interface WorkerTransport {
  /// 写出一行 JSONL（实现负责成帧，调用方不加换行）。
  writeLine(line: string): void;
  onLine(cb: (line: string) => void): void;
  /// 退出通知。stderrTail 是崩溃诊断用的最后 2KB stderr。
  onExit(cb: (code: number | null, stderrTail?: string) => void): void;
  onError(cb: (err: Error) => void): void;
  /// 终止进程。force 为真时跳过优雅终止直接强杀（两段式 kill 的第二段）。
  kill(force?: boolean): void;
}

/// stderr 尾环大小。崩溃时只有这最后一段能说明问题，全量收集则会在长任务里吃掉内存。
const STDERR_TAIL_BYTES = 2000;

/// 生产实现：用 utilityProcess.fork 起 Worker。
///
/// stdio 固定为 ["ignore", "pipe", "pipe"]：stdin 必须是 ignore（见文件头），stdout 我们
/// 只用来接住 Worker 里第三方库的意外输出（协议不走它），stderr 进 2KB 尾环。
export function forkUtilityWorkerTransport(entry: string): WorkerTransport {
  const child = utilityProcess.fork(entry, [], {
    stdio: ["ignore", "pipe", "pipe"],
    serviceName: "cortex-research-worker",
  });

  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    // 尾环：拼接后只留最后 2KB。这样即使 Worker 疯狂刷日志也不会撑爆 main 的内存。
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });
  // stdout 不参与协议，但必须消费掉，否则管道写满会把 Worker 卡死。
  child.stdout?.resume();

  return {
    writeLine: (line) => child.postMessage(line),
    onLine: (cb) => {
      child.on("message", (message: unknown) => {
        cb(typeof message === "string" ? message : JSON.stringify(message));
      });
    },
    onExit: (cb) => {
      child.on("exit", (code: number) => cb(code, stderrTail));
    },
    onError: (cb) => {
      // utilityProcess 没有 'error' 事件；spawn 失败表现为立刻 exit。保留该回调是为了让
      // WorkerTransport 对真 stdio 实现（child_process.spawn 会 emit 'error'）保持通用。
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
}
