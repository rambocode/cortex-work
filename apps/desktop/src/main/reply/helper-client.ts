// reply-helper 的主进程封装:对单个 Swift 伴生二进制的 spawn / NDJSON 协议 / 生命周期管理。
//
// 两种运行形态(见 native/reply-helper/Sources/reply-helper/main.swift):
//   1) events 长驻模式:`reply-helper events` 常驻进程,stdout 逐行推 draft-gesture /
//      voice-start / voice-end / key-event 等高层事件;stdin 收 intercept / config / quit 命令。
//      进程崩溃 → 指数退避重启;连续失败超上限 → 置降级标志(供 KTD7 兜底 accelerator 接管)。
//   2) one-shot 命令:`reply-helper ax-capture | ax-activate <pid> | paste <text> | ocr | calendar |
//      permissions`,每命令独立 spawn、带超时,读单行 JSON 响应后进程自然退出。
//
// 设计约束(务必遵守):本文件**不 import electron**——协议编解码、NDJSON 缓冲、退避序列
// 全部抽成纯函数/纯类可单测(仿 hotkey.ts)。二进制路径与 spawn 实现由调用方注入(helper-locate
// 提供路径,默认用 child_process.spawn),日志经可选 logger 注入,故测试无需 mock electron。

import { spawn as nodeSpawn } from "child_process";

// ── 协议类型 ──────────────────────────────────────────────────────────────────

/** events 长驻模式经 stdout 推来的高层事件。unknown 字段兜底未知事件,避免协议演进即崩。 */
export type HelperEvent =
  | { event: "ready" }
  | { event: "tap-unavailable" }
  | { event: "draft-gesture" }
  | { event: "voice-start" }
  | { event: "voice-end" }
  | { event: "key-event"; key: string }
  | { event: string; [k: string]: unknown };

/** 修饰键语义名,与 Swift 侧 EventsMode.flag(for:) 的 config 字符串对齐。 */
export type ModifierName = "command" | "option" | "control" | "shift" | "function";

/** 注入用的最小子进程形状(child_process.ChildProcess 的可测子集)。 */
export interface SpawnedProcess {
  stdout: { on(ev: "data", cb: (chunk: Buffer | string) => void): void } | null;
  stderr?: { on(ev: "data", cb: (chunk: Buffer | string) => void): void } | null;
  stdin: { write(data: string): void; end(): void } | null;
  on(ev: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(ev: "error", cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
  killed?: boolean;
}

/** 注入用 spawn 签名(默认 child_process.spawn)。 */
export type SpawnFn = (bin: string, args: string[]) => SpawnedProcess;

/** 可选日志接口(默认 no-op),由 U7 接线时注入 createLogger,保持本模块 electron-free。 */
export interface HelperLogger {
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

const NOOP_LOGGER: HelperLogger = { warn: () => {}, info: () => {}, debug: () => {} };

// ── 纯函数:NDJSON 解析(跨 chunk 半行缓冲 + 脏行丢弃)────────────────────────

/**
 * NDJSON 增量解析缓冲。stdout 的 chunk 边界与「一行」边界无关:一行可能跨多个 chunk 到达,
 * 一个 chunk 也可能含多行。push 把 chunk 追加进内部缓冲,只切出以 '\n' 结尾的完整行解析,
 * 半行留在缓冲等下一 chunk;非 JSON / 空行静默丢弃(helper 的诊断噪声不应污染事件流)。
 */
export class NdjsonBuffer {
  private buf = "";

  /** 追加一段原始输出,返回本次新解析出的对象数组(可能为空)。 */
  push(chunk: string): Record<string, unknown>[] {
    this.buf += chunk;
    const out: Record<string, unknown>[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const parsed = parseJsonLine(line);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /** 尚未以换行结束的残留半行(调试用)。 */
  pending(): string {
    return this.buf;
  }
}

/** 解析单行为对象;空行 / 非法 JSON / 非对象一律返回 null(脏行丢弃)。 */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
    return null;
  } catch {
    return null; // 脏行丢弃
  }
}

/** 把一条 stdin 命令对象编码为一行 NDJSON(带结尾换行,helper 逐行 readLine)。 */
export function encodeCommand(cmd: Record<string, unknown>): string {
  return JSON.stringify(cmd) + "\n";
}

// ── 纯函数:崩溃重启退避序列 ────────────────────────────────────────────────

/** events 进程连续崩溃的最大重启次数;超过即置降级标志、停止重启。 */
export const MAX_RESTART_ATTEMPTS = 5;

/**
 * 第 attempt 次重启前的退避延迟(指数退避 + 上限钳制)。attempt 从 1 计。
 * 零延迟连环重启在 tap 反复被系统禁用时会空转刷屏,指数退避给系统一个恢复窗口。
 */
export function backoffDelayMs(attempt: number, baseMs = 500, maxMs = 30_000): number {
  if (attempt < 1) return 0;
  const delay = baseMs * 2 ** (attempt - 1);
  return Math.min(delay, maxMs);
}

/** 连续失败次数是否已达降级阈值(超过上限:放弃重启,降级到兜底 accelerator)。 */
export function shouldDegrade(attempt: number, max = MAX_RESTART_ATTEMPTS): boolean {
  return attempt > max;
}

/**
 * events 进程被视为「已稳定存活」的最短时长(ms)。仅当进程存活超过此阈值,才认为它真正
 * 建起并稳住了 tap,可安全复位退避计数。取值为最大退避间隔(30s)量级,确保跨过一整个
 * 退避窗口的存活才算稳定。
 *
 * 为什么需要它:events 进程可能「ready → 立刻崩溃」反复循环。若一见 ready 就无条件复位
 * 退避计数,计数永远清零、恒以最短间隔重启,MAX_RESTART_ATTEMPTS / 降级安全网被彻底绕过,
 * 形成每约 500ms 一次的 spawn/tap 风暴且永不切兜底 accelerator(KTD7)。故复位条件收紧为
 * 「存活超过本阈值」——短命的 ready→崩溃循环保持计数累加,直到触发降级。
 */
export const STABLE_UPTIME_MS = 30_000;

// ── events 长驻客户端 ──────────────────────────────────────────────────────

export interface ReplyHelperClientOptions {
  /** helper 可执行文件绝对路径(helper-locate.resolveReplyHelperBinary 提供)。 */
  binaryPath: string;
  /** spawn 实现,默认 child_process.spawn;测试注入假实现。 */
  spawnFn?: SpawnFn;
  /** 日志,默认 no-op。 */
  logger?: HelperLogger;
  /** 收到 events 事件的回调。 */
  onEvent?: (event: HelperEvent) => void;
  /** 降级(连续崩溃超上限 / tap 不可用)回调,供切换兜底 accelerator。 */
  onDegrade?: () => void;
  /** 当前时间源(ms),默认 Date.now;测试注入以控制存活时长判定,避免真实 sleep。 */
  nowFn?: () => number;
}

/**
 * reply-helper 客户端。管理 events 长驻进程(崩溃退避重启 + 降级)与 one-shot 命令 spawn。
 * 所有可测纯逻辑已抽为上方独立函数;本类只做进程编排与副作用。
 */
export class ReplyHelperClient {
  private readonly binaryPath: string;
  private readonly spawnFn: SpawnFn;
  private readonly log: HelperLogger;
  private readonly onEvent?: (event: HelperEvent) => void;
  private readonly onDegrade?: () => void;
  private readonly now: () => number;

  private eventsProc: SpawnedProcess | null = null;
  private eventsBuffer = new NdjsonBuffer();
  private restartAttempts = 0;
  // 当前 events 进程的 spawn 时间戳(ms,来自注入的时间源);进程不在时为 0。
  // 用于判断进程是否「稳定存活」——只有存活超过 STABLE_UPTIME_MS 才复位退避计数,
  // 从而识别并拦截 ready→崩溃风暴(见 resetBackoffIfStable)。
  private spawnedAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  // 显式停止(stopEvents)后不再自动重启;区分「主动关」与「崩溃」。
  private stopped = false;
  // 降级标志:events 进程连续崩溃超上限 / tap 不可用后置位,供调用方查询走兜底 accelerator。
  private degraded = false;
  // 最近一次下发给 helper 的修饰键配置,重启后重放(否则重启进程回退默认 ⌘/Fn)。
  private lastConfig: { draft?: ModifierName; voice?: ModifierName } | null = null;
  private interceptOn = false;

  constructor(opts: ReplyHelperClientOptions) {
    this.binaryPath = opts.binaryPath;
    this.spawnFn = opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
    this.log = opts.logger ?? NOOP_LOGGER;
    this.onEvent = opts.onEvent;
    this.onDegrade = opts.onDegrade;
    this.now = opts.nowFn ?? (() => Date.now());
  }

  /** 是否已降级(events 不可用)。true 时调用方应改用兜底 accelerator。 */
  isDegraded(): boolean {
    return this.degraded;
  }

  /** 启动 events 长驻进程。已在运行则 no-op。 */
  startEvents(): void {
    this.stopped = false;
    if (this.eventsProc) return;
    this.spawnEvents();
  }

  /** 实际 spawn events 进程并挂接 stdout / exit / error。 */
  private spawnEvents(): void {
    let proc: SpawnedProcess;
    try {
      proc = this.spawnFn(this.binaryPath, ["events"]);
    } catch (err) {
      // spawn 本身抛错(二进制缺失 / 权限)——按一次崩溃计入退避。
      this.log.warn("[reply-helper] events spawn 失败", err);
      this.scheduleRestart();
      return;
    }
    this.eventsProc = proc;
    this.spawnedAt = this.now(); // 记录起始时刻,供稳定存活判定
    this.eventsBuffer = new NdjsonBuffer();

    proc.stdout?.on("data", (chunk) => {
      for (const obj of this.eventsBuffer.push(chunk.toString())) {
        this.handleEventObject(obj);
      }
    });
    proc.stderr?.on("data", (chunk) => {
      this.log.debug("[reply-helper] events stderr", chunk.toString());
    });
    proc.on("error", (err) => {
      this.log.warn("[reply-helper] events 进程错误", err);
    });
    proc.on("exit", (code, signal) => {
      this.eventsProc = null;
      if (this.stopped) return; // 主动关闭,不重启
      // 崩溃前若已稳定存活足够久,视为偶发崩溃 → 复位退避计数;短命的 ready→崩溃循环
      // 则保持计数累加,直到触发降级(而非被无条件复位绕过 MAX_RESTART_ATTEMPTS 安全网)。
      this.resetBackoffIfStable();
      this.spawnedAt = 0;
      this.log.warn(`[reply-helper] events 退出 code=${code} signal=${signal},准备重启`);
      this.scheduleRestart();
    });
  }

  /** 处理一条 events 对象:ready 复位退避计数;tap-unavailable 直接降级;其余转发。 */
  private handleEventObject(obj: Record<string, unknown>): void {
    const event = obj as HelperEvent;
    if (event.event === "ready") {
      // 成功建起 tap:仅当进程已稳定存活超过阈值才复位退避计数——否则「ready→崩溃」风暴会
      // 借每轮 ready 把计数清零、绕过降级安全网(见 STABLE_UPTIME_MS)。重放配置与 intercept
      // 状态不受此限制(新进程无论新旧都需恢复到期望配置)。
      this.resetBackoffIfStable();
      if (this.lastConfig) this.sendConfig(this.lastConfig);
      if (this.interceptOn) this.setIntercept(true);
      return;
    }
    if (event.event === "tap-unavailable") {
      // tap 建不起来(辅助功能未授权):无重试意义,直接降级。
      this.markDegraded();
      return;
    }
    this.onEvent?.(event);
  }

  /**
   * 若当前 events 进程已稳定存活超过 STABLE_UPTIME_MS,则复位退避计数。
   * 这是修复「ready→崩溃风暴」的关键:短命进程(存活不足阈值)不复位,计数持续累加至降级;
   * 只有真正稳住的进程才把计数清零,恢复到最短退避起点。
   */
  private resetBackoffIfStable(): void {
    if (this.spawnedAt === 0) return; // 无有效 spawn 时间(未启动 / 已清空),不复位
    if (this.now() - this.spawnedAt >= STABLE_UPTIME_MS) {
      this.restartAttempts = 0;
    }
  }

  /** 安排一次退避重启;超上限则降级、不再重启。 */
  private scheduleRestart(): void {
    if (this.stopped) return;
    this.restartAttempts += 1;
    if (shouldDegrade(this.restartAttempts)) {
      this.log.warn(`[reply-helper] events 连续崩溃 ${this.restartAttempts} 次,降级到兜底 accelerator`);
      this.markDegraded();
      return;
    }
    const delay = backoffDelayMs(this.restartAttempts);
    this.log.info(`[reply-helper] ${delay}ms 后第 ${this.restartAttempts} 次重启 events`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) this.spawnEvents();
    }, delay);
  }

  /** 置降级标志并回调一次(幂等,仅首次回调)。 */
  private markDegraded(): void {
    if (this.degraded) return;
    this.degraded = true;
    this.onDegrade?.();
  }

  /** 下发修饰键配置(起草键 / 语音键);记住以便重启后重放。 */
  sendConfig(config: { draft?: ModifierName; voice?: ModifierName }): void {
    this.lastConfig = { ...this.lastConfig, ...config };
    this.writeCommand({ cmd: "config", ...config });
  }

  /** 开/关吞键(仅气泡激活期间开)。记住状态以便重启后重放。 */
  setIntercept(on: boolean): void {
    this.interceptOn = on;
    this.writeCommand({ cmd: "intercept", on });
  }

  /** 向 events 进程 stdin 写一条命令(进程不在时静默忽略)。 */
  private writeCommand(cmd: Record<string, unknown>): void {
    const stdin = this.eventsProc?.stdin;
    if (!stdin) return;
    try {
      stdin.write(encodeCommand(cmd));
    } catch (err) {
      this.log.warn("[reply-helper] 写 stdin 失败", err);
    }
  }

  /** 主动停止 events 进程(应用退出 / 降级切换时调用)。 */
  stopEvents(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const proc = this.eventsProc;
    this.eventsProc = null;
    if (proc && !proc.killed) {
      try {
        proc.stdin?.write(encodeCommand({ cmd: "quit" }));
        proc.stdin?.end();
      } catch {
        /* 忽略:随后 kill 兜底 */
      }
      proc.kill("SIGTERM");
    }
  }

  // ── one-shot 命令 ──────────────────────────────────────────────────────────

  /**
   * 执行一次 one-shot 命令并解析单行 JSON 响应。每命令独立 spawn、带超时:
   * 进程正常退出后取首个解析出的对象 resolve;超时则 kill 并 reject。
   */
  runCommand(args: string[], timeoutMs = 5_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let proc: SpawnedProcess;
      try {
        proc = this.spawnFn(this.binaryPath, args);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const buffer = new NdjsonBuffer();
      let result: Record<string, unknown> | null = null;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          if (!proc.killed) proc.kill("SIGKILL");
        } catch {
          /* 忽略 */
        }
        reject(new Error(`reply-helper 命令超时(${timeoutMs}ms): ${args[0]}`));
      }, timeoutMs);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      proc.stdout?.on("data", (chunk) => {
        // 只保留首个对象:one-shot 命令按协议只输出一行;多余行忽略。
        for (const obj of buffer.push(chunk.toString())) {
          if (result === null) result = obj;
        }
      });
      proc.on("error", (err) => {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      });
      proc.on("exit", () => {
        finish(() => {
          if (result) resolve(result);
          else reject(new Error(`reply-helper 命令无有效输出: ${args[0]}`));
        });
      });
    });
  }

  /** ax-capture:读取前台应用对话文本 + 焦点输入框 frame + pid。 */
  axCapture(timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.runCommand(["ax-capture"], timeoutMs);
  }

  /** ax-activate <pid>:把捕获时的目标应用重新激活到前台。 */
  axActivate(pid: number, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.runCommand(["ax-activate", String(pid)], timeoutMs);
  }

  /** paste <text>:把草稿写回目标输入框(内部备份/恢复剪贴板)。 */
  paste(text: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.runCommand(["paste", text], timeoutMs);
  }

  /** ocr [pid]:截屏 + Vision OCR,输出归一化坐标文本块。OCR 较慢,默认给更长超时。 */
  ocr(pid?: number, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const args = pid != null ? ["ocr", String(pid)] : ["ocr"];
    return this.runCommand(args, timeoutMs);
  }

  /** calendar:未来 3 天非全天事件忙碌区间。 */
  calendar(timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.runCommand(["calendar"], timeoutMs);
  }

  /** permissions:五项 TCC 权限状态(node-mac-permissions 加载失败时的兜底源)。 */
  permissions(timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.runCommand(["permissions"], timeoutMs);
  }
}
