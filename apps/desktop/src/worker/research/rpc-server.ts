// Worker 侧 JSONL RPC 服务端（spec §12.1）：行缓冲 → 校验 → method 路由 → 错误信封。
//
// 承载说明（U0 spike S3）：spec 写的是 stdin/stdout，实际跑在 utilityProcess 的 postMessage 上。
// 本类只认「一行 JSONL 进 / 一行 JSONL 出」，与承载无关；换 Rust Worker 或换真 stdio 时不受影响。
//
// 行缓冲照抄 agents/pi-rpc.ts:482 的 feed()（生产验证过的实现）：
//   - **只按 LF 切分**：payload 里可能出现 U+2028 / U+2029，用 split(/\r?\n/) 之外的行分隔会切坏消息；
//   - 单行 1MB 溢出保护：无换行的异常输入会无限撑大缓冲区；
//   - JSON.parse 失败**静默 return**：非协议输出（第三方库偶发写行）不该产生错误响应风暴。
//
// 本文件跑在 utilityProcess Worker 里，**禁止 import electron**。
import type { z } from "zod";
import {
  RESEARCH_PROTOCOL_VERSION,
  WORKER_METHODS,
  WORKER_RESULT_SCHEMAS,
  parseWorkerInbound,
  workerErrorResponse,
  workerOkResponse,
  type WorkerInbound,
  type WorkerMethod,
} from "@cortex-work/core/research/protocol";

/// 单行缓冲上限，与 pi-rpc 一致。
const MAX_BUFFER_BYTES = 1_000_000;

type ParamsOf<M extends WorkerMethod> = Extract<WorkerInbound, { method: M }>["params"];
type ResultOf<M extends WorkerMethod> = z.infer<(typeof WORKER_RESULT_SCHEMAS)[M]>;

/// 各 method 的入参 / 出参类型，从 core 的协议 zod schema 推导而来（**不手写重复定义**：
/// 手写的副本会与 schema 悄悄漂移，而漂移只在运行时校验失败时才暴露）。
export type HelloParams = ParamsOf<"hello">;
export type DoctorParams = ParamsOf<"doctor">;
export type FetchPrepareParams = ParamsOf<"fetch_prepare">;
export type RerankParams = ParamsOf<"rerank">;
export type HelloResult = ResultOf<"hello">;
export type DoctorResult = ResultOf<"doctor">;
export type FetchPrepareResult = ResultOf<"fetch_prepare">;
export type RerankResult = ResultOf<"rerank">;

/// 进度事件的阶段枚举（与协议的 workerEventSchema 一致）。
export type ProgressStage = "fetching" | "extracting" | "chunking" | "ranking";

/// 交给 method handler 的上下文。
export interface MethodContext {
  /// 本 operation 的取消信号。handler **必须**把它透传给下游的抓取/解析，否则 cancel 无效。
  signal: AbortSignal;
  /// 发一条进度事件。事件没有 id，不占 main 侧的 pending 表，只用于更新 UI。
  emitProgress(update: { stage: ProgressStage; completed: number; total: number }): void;
}

/// 业务 method 的实现集合。cancel / shutdown 由 server 自身处理（它们是控制指令，不是业务）。
export interface WorkerMethodHandlers {
  hello(params: HelloParams, ctx: MethodContext): HelloResult | Promise<HelloResult>;
  doctor(params: DoctorParams, ctx: MethodContext): DoctorResult | Promise<DoctorResult>;
  fetch_prepare(
    params: FetchPrepareParams,
    ctx: MethodContext,
  ): FetchPrepareResult | Promise<FetchPrepareResult>;
  rerank(params: RerankParams, ctx: MethodContext): RerankResult | Promise<RerankResult>;
}

/// server 的注入依赖。
export interface RpcServerDeps {
  /// 输出一行 JSONL（不含换行符，由承载层负责成帧）。
  write(line: string): void;
  handlers: WorkerMethodHandlers;
  /// 收到 shutdown 时的回调（ack 已经发出）。由 index.ts 决定何时真正退出进程。
  onShutdown?(graceMs: number | undefined): void;
  /// 诊断日志。**只能写 stderr**：stdout/postMessage 通道只允许协议消息。
  log?(message: string): void;
}

/// 被取消时用的 reason，保证 handler 能区分「取消」与「真错误」。
class OperationCancelledError extends Error {
  constructor(operationId: string) {
    super(`operation ${operationId} cancelled by main`);
    this.name = "OperationCancelledError";
  }
}

/// Worker 侧 RPC 服务端。用法：`transport.on("message", (line) => server.feed(line + "\n"))`。
export class ResearchRpcServer {
  private buffer = "";
  /// 握手闸：收到合法 hello 之前，一切业务请求回 not_ready。
  private ready = false;
  /// 在途 operation 的取消句柄。key 是 params.operation_id（不是请求 id）——
  /// main 的 cancel 是按 operation 发的，一个 operation 可能对应多轮请求。
  private readonly operations = new Map<string, AbortController>();
  /// 在途请求 id。进程级异常兜底（见 failAllPending）要靠它把 pending 一次性了结。
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: RpcServerDeps) {}

  /// 当前缓冲区长度，仅供测试断言溢出保护生效。
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  /// 把所有在途请求以同一个错误码了结（进程级 uncaughtException / unhandledRejection 兜底）。
  ///
  /// 为什么必须有它：Worker 里的进程级异常不属于任何一个 handler 的 try/catch，不主动应答的话
  /// main 侧那些 pending 只能干等 30 秒超时，用户看到的是「研究卡住了」而不是「Worker 出错了」。
  /// 兜底后 handler 若仍然完成，会对同一 id 再写一条响应——main 的 pending 已删除，该行被忽略，
  /// 这是刻意接受的良性冗余。
  failAllPending(
    code: "internal_error" | "cancelled" | "budget_exceeded",
    message: string,
  ): void {
    for (const id of this.inFlight) {
      this.deps.write(workerErrorResponse(id, code, message));
    }
    this.inFlight.clear();
  }

  /// 喂入一段原始文本（可以是半行、多行或整行）。
  feed(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim()) this.handleLine(line);
    }
    // 无换行的超长输入：只保留尾部，防止内存被撑爆（残行会因此损坏，但那本就不是合法协议输入）。
    if (this.buffer.length > MAX_BUFFER_BYTES) this.buffer = this.buffer.slice(-MAX_BUFFER_BYTES);
  }

  private handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // 非 JSON 行静默丢弃：Worker 进程内任何库都可能往通道里写点东西，不能因此制造错误风暴。
      return;
    }

    const envelope = raw as { type?: unknown; id?: unknown; method?: unknown };
    // 没有 id 就无法应答，只能丢弃（回一条无 id 的错误响应会违反协议信封）。
    if (typeof envelope.id !== "string" || envelope.id.length === 0) {
      this.deps.log?.(`丢弃缺少 id 的入站消息: ${line.slice(0, 200)}`);
      return;
    }
    const id = envelope.id;

    // 先判 method 是否已知：zod 的 discriminatedUnion 会把未知 method 报成通用解析错误，
    // 而协议区分 unknown_method 与 invalid_params，main 据此决定「换 Worker」还是「改参数」。
    if (
      typeof envelope.method !== "string" ||
      !(WORKER_METHODS as readonly string[]).includes(envelope.method)
    ) {
      this.deps.write(
        workerErrorResponse(id, "unknown_method", `未知 method: ${String(envelope.method)}`),
      );
      return;
    }

    let message: WorkerInbound;
    try {
      message = parseWorkerInbound(raw);
    } catch (err) {
      this.deps.write(
        workerErrorResponse(id, "invalid_params", err instanceof Error ? err.message : String(err)),
      );
      return;
    }

    this.dispatch(message);
  }

  /// 路由一条已校验的入站消息。
  private dispatch(message: WorkerInbound): void {
    const { id, method } = message;

    if (method === "hello") {
      this.handleHello(message.params, id);
      return;
    }

    // shutdown 是进程生命周期指令，不受握手闸限制：main 可能在握手失败后直接要求退出。
    if (method === "shutdown") {
      this.deps.write(workerOkResponse(id, { ok: true }));
      this.deps.onShutdown?.(message.params.grace_ms);
      return;
    }

    if (!this.ready) {
      this.deps.write(workerErrorResponse(id, "not_ready", "Worker 尚未完成 hello 握手"));
      return;
    }

    if (method === "cancel") {
      this.handleCancel(message.params.operation_id);
      this.deps.write(workerOkResponse(id, { ok: true }));
      return;
    }

    void this.runOperation(method, message, id);
  }

  /// 处理握手。**版本不兼容时不进入 ready**，此后所有业务请求继续 not_ready，
  /// 避免「降级到未知行为」（spec §21）。
  private handleHello(params: HelloParams, id: string): void {
    if (params.protocol_version > RESEARCH_PROTOCOL_VERSION) {
      this.deps.write(
        workerErrorResponse(
          id,
          "protocol_mismatch",
          `worker supports protocol <= ${RESEARCH_PROTOCOL_VERSION}, main requested ${params.protocol_version}`,
        ),
      );
      return;
    }
    this.ready = true;
    void this.invoke("hello", params, id, undefined);
  }

  /// abort 指定 operation；缺 operation_id 时 abort 全部。无论目标是否存在都视为成功（幂等）。
  private handleCancel(operationId: string | undefined): void {
    if (operationId) {
      this.operations.get(operationId)?.abort(new OperationCancelledError(operationId));
      return;
    }
    for (const [key, controller] of this.operations) {
      controller.abort(new OperationCancelledError(key));
    }
  }

  /// 执行带 operation_id 的业务方法：注册取消句柄 → 调用 handler → 清理。
  private runOperation(
    method: "doctor" | "fetch_prepare" | "rerank",
    message: Extract<WorkerInbound, { method: "doctor" | "fetch_prepare" | "rerank" }>,
    id: string,
  ): Promise<void> {
    const operationId = "operation_id" in message.params ? message.params.operation_id : undefined;
    return this.invoke(method, message.params, id, operationId);
  }

  /// 统一的 handler 调用收口：上下文构造、结果/错误信封、operation 注册表清理都在这里。
  private async invoke(
    method: WorkerMethod,
    params: unknown,
    id: string,
    operationId: string | undefined,
  ): Promise<void> {
    const controller = new AbortController();
    if (operationId) this.operations.set(operationId, controller);
    this.inFlight.add(id);

    const ctx: MethodContext = {
      signal: controller.signal,
      emitProgress: (update) => {
        // 没有 operation_id 的方法（hello/doctor）不该发进度：协议要求 event 必带 operation_id。
        if (!operationId) return;
        this.deps.write(
          JSON.stringify({
            type: "event",
            event: "progress",
            operation_id: operationId,
            stage: update.stage,
            completed: update.completed,
            total: update.total,
          }),
        );
      },
    };

    try {
      const handler = this.deps.handlers[method as keyof WorkerMethodHandlers];
      const result = await (handler as (p: unknown, c: MethodContext) => unknown)(params, ctx);
      this.deps.write(workerOkResponse(id, result));
      this.inFlight.delete(id);
    } catch (err) {
      // 取消与真错误必须分开：main 对 cancelled 不重试，对 internal_error 会记失败并可能换 Worker。
      if (controller.signal.aborted) {
        this.deps.write(
          workerErrorResponse(id, "cancelled", `operation ${operationId ?? id} cancelled by main`),
        );
      } else {
        this.deps.write(
          workerErrorResponse(id, "internal_error", err instanceof Error ? err.message : String(err)),
        );
      }
      this.inFlight.delete(id);
    } finally {
      if (operationId) this.operations.delete(operationId);
    }
  }
}
