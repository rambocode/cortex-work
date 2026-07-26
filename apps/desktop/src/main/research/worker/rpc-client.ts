// main 侧的 Worker RPC 客户端（spec §12.1）。
//
// 职责边界：只负责「请求 ↔ 响应」的关联与协议校验，**不管进程生命周期**（那是 process-manager
// 的事）。这样单测可以在完全没有进程的情况下覆盖全部协议分支。
//
// 协议校验分两步，与 core/research/protocol 的设计一致：
//   1) parseWorkerOutbound 校验信封（result / error 严格互斥）；
//   2) parseWorkerResult 按 method 校验 result 形状——只有发请求的这一侧知道自己发的是什么 method。
import {
  parseWorkerOutbound,
  parseWorkerResult,
  WORKER_RESULT_SCHEMAS,
  type WorkerMethod,
} from "@cortex-work/core/research/protocol";
import type { z } from "zod";
import type { WorkerTransport } from "./transport";

/// 默认请求超时。fetch_prepare 自带资源上限（max_duration_ms），30 秒只兜底「Worker 假死」。
const DEFAULT_TIMEOUT_MS = 30_000;

type ResultOf<M extends WorkerMethod> = z.infer<(typeof WORKER_RESULT_SCHEMAS)[M]>;

/// Worker 返回的结构化错误。**保留 code** 是关键：上层按 code 决定重试 / 换 Worker / 放弃，
/// 按 message 文本判定会在措辞改动时静默失效。
export class WorkerRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "WorkerRpcError";
  }
}

/// 进度事件（协议里 type:"event" 的那条）。
export interface WorkerProgressEvent {
  operation_id: string;
  stage: "fetching" | "extracting" | "chunking" | "ranking";
  completed: number;
  total: number;
}

/// 客户端选项。
export interface RpcClientOptions {
  timeoutMs?: number;
  onEvent?: (event: WorkerProgressEvent) => void;
  /// 诊断日志（丢弃的畸形行等）。
  log?: (message: string) => void;
}

interface PendingRequest {
  method: WorkerMethod;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /// 本次请求的 operation_id（若参数里带）。请求了结时按它摘掉进度订阅。
  operationId?: string;
}

/// 从请求参数里取 operation_id。协议里所有长耗时 method 的参数都有这个字段，
/// 它同时是进度事件的路由键——**进度事件不带请求 id**，只能靠它找回发起方。
function operationIdOf(params: unknown): string | undefined {
  const id = (params as { operation_id?: unknown } | null)?.operation_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/// main 侧 RPC 客户端。
export class ResearchRpcClient {
  private sequence = 0;
  private readonly pending = new Map<string, PendingRequest>();
  /// operation_id → 进度订阅。请求了结（成功 / 失败 / 超时）时必须摘掉，
  /// 否则迟到的进度会回调到已经不在乎它的一方（甚至已卸载的 UI 状态）。
  private readonly progressListeners = new Map<
    string,
    (progress: { completed: number; total: number }) => void
  >();

  constructor(
    private readonly transport: WorkerTransport,
    private readonly options: RpcClientOptions = {},
  ) {
    this.transport.onLine((line) => this.handleLine(line));
  }

  /// 在途请求数，供 process-manager 与测试观察。
  get pendingCount(): number {
    return this.pending.size;
  }

  /// 发一条请求并等待应答。
  ///
  /// onProgress：本次请求期间 Worker 上报的进度（按 params.operation_id 路由）。
  /// 抓取一批 URL 可能要几十秒，没有它上层就只能在整批结束后才知道进展。
  request<M extends WorkerMethod>(
    method: M,
    params: unknown,
    onProgress?: (progress: { completed: number; total: number }) => void,
  ): Promise<ResultOf<M>> {
    this.sequence += 1;
    const id = `req_${this.sequence}`;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const operationId = operationIdOf(params);
    if (onProgress && operationId) this.progressListeners.set(operationId, onProgress);

    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id);
        reject(new WorkerRpcError("timeout", `Worker 请求 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        ...(operationId ? { operationId } : {}),
      });
      this.transport.writeLine(JSON.stringify({ type: "request", id, method, params }));
    });
  }

  /// 了结全部在途请求（Worker 退出时调用）。
  rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    this.progressListeners.clear();
  }

  /// 摘掉一条在途请求连同它的进度订阅。
  private settle(id: string): PendingRequest | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.operationId) this.progressListeners.delete(entry.operationId);
    return entry;
  }

  private handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // Worker 的 stderr 日志、第三方库输出都可能混进来，静默丢弃（照 pi-rpc 的既有做法）。
      return;
    }

    let message: ReturnType<typeof parseWorkerOutbound>;
    try {
      message = parseWorkerOutbound(raw);
    } catch (err) {
      // 信封非法（例如 result 与 error 同时存在）：**绝不能猜**。猜错会让 main 把失败当成功，
      // 进而提交一批不存在的证据。丢弃后该请求会走超时，是可观测的失败。
      this.options.log?.(`丢弃不合协议的出站消息: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (message.type === "event") {
      this.options.onEvent?.({
        operation_id: message.operation_id,
        stage: message.stage,
        completed: message.completed,
        total: message.total,
      });
      // 再按 operation_id 送给这次请求的发起方（它才知道这批进度属于哪个 Session）。
      this.progressListeners.get(message.operation_id)?.({
        completed: message.completed,
        total: message.total,
      });
      return;
    }

    const entry = this.settle(message.id);
    // 未知 id：迟到的旧请求响应（已超时被清掉）。忽略，避免串台。
    if (!entry) return;

    if (message.error) {
      entry.reject(new WorkerRpcError(message.error.code, message.error.message, message.error.data));
      return;
    }

    try {
      entry.resolve(parseWorkerResult(entry.method, message.result));
    } catch (err) {
      entry.reject(
        new WorkerRpcError(
          "invalid_result",
          `Worker 返回的 ${entry.method} 结果不符合协议: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
}
