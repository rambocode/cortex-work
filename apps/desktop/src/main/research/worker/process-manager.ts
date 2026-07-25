// Research Worker 的生命周期管理（spec §12.1、§21）。
//
// 取舍（照 agents/pi-rpc.ts 的既有实践）：
//   - **崩溃不自动重启**。这里只上报 crashed 事件，重拉与否由上层 service 决定——自动重启会把
//     「Worker 每次都在同一份 PDF 上崩」变成无限重启风暴，而且会掩盖真正的失败原因。
//   - **版本不兼容不降级**（spec §21）：Worker 支持的协议低于 main 要求时直接停掉并报错，
//     而不是「试试看能不能用」。降级到未知行为比功能不可用更糟。
//   - stop 与 handleExit 用 exited 标志去重：error 与 exit 可能先后到达，crashed 只能报一次。
import { RESEARCH_PROTOCOL_VERSION, type WorkerMethod } from "@cortex-work/core/research/protocol";
import { ResearchRpcClient, WorkerRpcError, type WorkerProgressEvent } from "./rpc-client";
import type { WorkerTransport } from "./transport";
import type { z } from "zod";
import type { WORKER_RESULT_SCHEMAS } from "@cortex-work/core/research/protocol";

type ResultOf<M extends WorkerMethod> = z.infer<(typeof WORKER_RESULT_SCHEMAS)[M]>;

/// 优雅退出的宽限期：超过它就强杀（两段式 kill 的第二段）。
const DEFAULT_KILL_DELAY_MS = 3_000;

/// 上报给上层的生命周期事件。
export type ResearchWorkerEvent =
  | { type: "started"; workerVersion: string; browserAvailable: boolean }
  | { type: "crashed"; error: Error }
  | { type: "stopped" }
  | { type: "progress"; progress: WorkerProgressEvent };

/// 注入依赖。createTransport 是唯一的进程创建点，测试传假 transport 即可覆盖全部分支。
export interface ResearchWorkerProcessDeps {
  createTransport: () => WorkerTransport;
  desktopVersion: string;
  timeoutMs?: number;
  killDelayMs?: number;
  onEvent?: (event: ResearchWorkerEvent) => void;
  log?: (message: string) => void;
}

/// 一个 Worker 进程实例。
export class ResearchWorkerProcess {
  private transport: WorkerTransport | null = null;
  private client: ResearchRpcClient | null = null;
  private starting: Promise<void> | null = null;
  private running = false;
  /// 退出去重标志：close 与 error 可能先后到达，两者只能触发一次收尾。
  private exited = false;
  /// 主动停止标志：主动 stop 的退出**不算崩溃**，不能上报 crashed。
  private stopping = false;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private workerVersion = "";

  constructor(private readonly deps: ResearchWorkerProcessDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  /// 启动并完成握手。重复调用返回同一个 Promise（不会重复 fork）。
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    this.exited = false;
    this.stopping = false;

    const transport = this.deps.createTransport();
    this.transport = transport;
    this.client = new ResearchRpcClient(transport, {
      ...(this.deps.timeoutMs === undefined ? {} : { timeoutMs: this.deps.timeoutMs }),
      ...(this.deps.log ? { log: this.deps.log } : {}),
      onEvent: (progress) => this.deps.onEvent?.({ type: "progress", progress }),
    });

    transport.onExit((code, stderrTail) => this.handleExit(code, stderrTail));
    transport.onError((err) => this.handleExit(null, err.message));

    let hello: ResultOf<"hello">;
    try {
      hello = await this.client.request("hello", {
        protocol_version: RESEARCH_PROTOCOL_VERSION,
        desktop_version: this.deps.desktopVersion,
      });
    } catch (err) {
      this.teardown();
      throw err;
    }

    // 版本闸：Worker 支持的最高版本低于我们要求的版本 → 停机并报错，不降级（spec §21）。
    if (hello.max_protocol_version < RESEARCH_PROTOCOL_VERSION) {
      this.teardown();
      throw new WorkerRpcError(
        "protocol_mismatch",
        `Worker 协议版本过低：支持到 ${hello.max_protocol_version}，需要 ${RESEARCH_PROTOCOL_VERSION}`,
      );
    }

    this.workerVersion = hello.worker_version;
    this.running = true;
    this.deps.onEvent?.({
      type: "started",
      workerVersion: hello.worker_version,
      browserAvailable: hello.browser_available,
    });
  }

  /// 发一条业务请求。未启动时立即失败，绝不静默挂起。
  request<M extends WorkerMethod>(method: M, params: unknown): Promise<ResultOf<M>> {
    if (!this.running || !this.client) {
      return Promise.reject(new WorkerRpcError("not_ready", "Research Worker 未启动或已停止"));
    }
    return this.client.request(method, params);
  }

  /// 主动停止：先请求优雅退出，宽限期内没走就强杀。
  ///
  /// 两段式的第一段用 shutdown 请求而不是 SIGTERM：utilityProcess.kill() 没有信号参数
  /// （见 ./transport 注释），而协议里本就有 shutdown。语义等价——先礼后兵。
  async stop(): Promise<void> {
    if (!this.transport) return;
    this.stopping = true;

    try {
      this.transport.writeLine(
        JSON.stringify({ type: "request", id: "shutdown_stop", method: "shutdown", params: { grace_ms: this.killDelay() } }),
      );
    } catch {
      // 管道已断，直接进入强杀路径。
    }
    this.transport.kill();

    if (!this.exited) {
      this.killTimer = setTimeout(() => {
        this.transport?.kill(true);
      }, this.killDelay());
      // 定时器不该拖住 Electron 的退出流程。
      this.killTimer.unref?.();
    }

    this.running = false;
    this.workerVersion = "";
  }

  private killDelay(): number {
    return this.deps.killDelayMs ?? DEFAULT_KILL_DELAY_MS;
  }

  /// 进程退出的统一收口（正常退出与崩溃都走这里）。
  private handleExit(code: number | null, stderrTail?: string): void {
    if (this.exited) return;
    this.exited = true;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }

    const wasStopping = this.stopping;
    const error = new Error(
      `Research Worker 退出（code=${code ?? "null"}）${stderrTail ? `: ${stderrTail}` : ""}`,
    );
    // pending 必须在上报之前了结：上层收到 crashed 后可能立刻重拉，届时旧 pending 仍挂着就成了泄漏。
    this.client?.rejectAllPending(error);
    this.running = false;

    if (wasStopping) {
      this.deps.onEvent?.({ type: "stopped" });
      return;
    }
    // 崩溃只上报，**不自动重启**——重拉与否由上层 service 决定。
    this.deps.onEvent?.({ type: "crashed", error });
  }

  /// 启动失败时的清理：杀进程但不上报 crashed（这是我们主动放弃，不是它崩了）。
  private teardown(): void {
    this.stopping = true;
    this.running = false;
    try {
      this.transport?.kill();
    } catch {
      // 忽略：进程可能还没起来。
    }
    this.client?.rejectAllPending(new Error("Research Worker 启动失败"));
  }

  /// 当前 Worker 自报的版本（未启动时为空串）。
  get version(): string {
    return this.workerVersion;
  }
}
