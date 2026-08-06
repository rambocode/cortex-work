// pi-host worker 的日志出口。
//
// ── 为什么不能直接用 `main/log`（KTD2 的直接后果）──────────────────────────────────────
// `main/log/index.ts` 顶层 `import log from "electron-log/main"` 且 `isDevEnv()` 读 `app.isPackaged`
// —— 那是主进程 API，worker 里 `electron` 模块只有极小的子集（`app` 不在其中）。更要命的是
// `utilityProcess` 的 stdout **不连终端**：即便退回 `console.log`，日志也只会被 main 的
// stderr 尾环截走最后 2KB，长会话里等于没有日志。
//
// 因此本模块把日志收敛成一条协议消息 `WorkerLog`，由主进程侧的 gateway 客户端接到之后
// 再喂给真正的 `createLogger` 落盘。这样 worker 的日志与主进程日志同一份文件、同一套脱敏。
//
// ⚠️ **构建期 alias 目标**：`electron.pi-host.config.ts` 把任何解析到 `src/main/log/index.ts`
// 的 import 重定向到本文件。因此本文件必须保持与 `createLogger()` 返回值**结构兼容**
// （electron-log 的 `LogFunctions`：error/warn/info/verbose/debug/silly/log）。
// 少一个方法 = 被复用的能力模块在 worker 里一调就崩，而且崩在 pi 的 agent loop 栈上。

/** 与协议 `WorkerLog.level` 一致的级别集合。 */
export type WorkerLogLevel = "debug" | "info" | "warn" | "error";

/** 日志出口。未设置时（单测 / 未被 utilityProcess 拉起）退化为写 stderr。 */
export type WorkerLogSink = (level: WorkerLogLevel, message: string) => void;

let sink: WorkerLogSink | null = null;

/**
 * 安装日志出口。由 `index.ts` 在拿到 parentPort 后调用，把日志接到协议上。
 *
 * 时序：模块加载期产生的日志（各能力模块顶层的 `createLogger` 本身不打日志，但保险起见）
 * 会走 stderr 兜底 —— 那段窗口在 parentPort 就绪之前，没有别的出口。
 */
export function setWorkerLogSink(next: WorkerLogSink | null): void {
  sink = next;
}

/** stderr 兜底。**绝不写 stdout**：将来若换成真 stdio 承载，stdout 就是协议流。 */
function writeStderr(level: WorkerLogLevel, message: string): void {
  try {
    process.stderr.write(`[pi-host][${level}] ${message}\n`);
  } catch {
    // 连 stderr 都写不出去时无计可施，绝不能因为日志失败而中断调用方。
  }
}

/**
 * 把 electron-log 风格的可变参数拍平成一行文本。
 *
 * 复用方（native-hooks / pi-mcp-inproc / events…）的调用形态有两种：
 * `log.warn("文案", { k: v })` 与 `log.warn("文案:", errMessage)`，两种都要可读，
 * 且**绝不能因为参数不可序列化而抛错**——这些调用点全在 pi 的 agent loop 栈上。
 */
function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack ?? arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

/** 发一条日志。永不抛。 */
export function emitWorkerLog(level: WorkerLogLevel, scope: string, args: unknown[]): void {
  const message = `[${scope}] ${formatArgs(args)}`;
  if (!sink) {
    writeStderr(level, message);
    return;
  }
  try {
    sink(level, message);
  } catch {
    writeStderr(level, message);
  }
}

/** `createLogger()` 返回值的最小形状（与 electron-log 的 LogFunctions 结构兼容）。 */
export interface WorkerLogger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  verbose(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  silly(...args: unknown[]): void;
  log(...args: unknown[]): void;
}

/**
 * 与 `main/log` 的 `createLogger` 同名同形。构建期 alias 生效后，被复用的主进程模块里那些
 * `const log = createLogger("xxx")` 拿到的就是本函数的产物。
 *
 * 级别映射：verbose/silly 归到 debug（协议只有四级），log 归到 info。
 */
export function createLogger(scope: string): WorkerLogger {
  return {
    error: (...args) => emitWorkerLog("error", scope, args),
    warn: (...args) => emitWorkerLog("warn", scope, args),
    info: (...args) => emitWorkerLog("info", scope, args),
    verbose: (...args) => emitWorkerLog("debug", scope, args),
    debug: (...args) => emitWorkerLog("debug", scope, args),
    silly: (...args) => emitWorkerLog("debug", scope, args),
    log: (...args) => emitWorkerLog("info", scope, args),
  };
}

/**
 * 与 `main/log` 的 `isDevEnv` 同名同形（`agent-trace` 的 shim 会用到）。
 *
 * worker 拿不到 `app.isPackaged`，退回 `process.env.NODE_ENV`。判错的代价只是日志详略，
 * 不影响任何功能语义，故不值得为它加一条协议往返。
 */
export function isDevEnv(): boolean {
  return process.env.NODE_ENV !== "production";
}
