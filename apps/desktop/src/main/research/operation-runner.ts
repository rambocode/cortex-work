// 原子提交边界的执行器（spec §9.1 的六步逐字实现）。
//
//   1. main 持久化 pending operation（beginOperation）；
//   2. 调 Search Server 或 Worker（execute）；
//   3. 校验响应大小、schema 和 request ID（validate）；
//   4. 在一个 SQLite transaction 中写 round/result/evidence/budget（commitOperation 的 apply）；
//   5. 标记 operation committed（由 commitOperation 在同一事务里完成）；
//   6. 崩溃恢复时只重试未 committed operation（已提交的这里直接拒绝重跑）。
//
// **apply 必须是同步的**，这不是风格偏好而是硬约束：node:sqlite 只有一个同步连接，事务是
// 连接级状态。apply 里一旦出现 await，事件循环就会把别的 operation 的写入穿插进这笔尚未
// COMMIT 的事务，两笔操作会一起提交或一起回滚（见 sqlite-driver.ts transaction 的注释）。
// 因此「Worker 返回后先改内存状态再异步落盘」被 spec §9.1 明确禁止——所有异步工作
//（写 blob、算 coverage）都必须在 commit **之前**做完。
import { createHash } from "node:crypto";
import type {
  RepositoryTx,
  ResearchOperationKind,
  ResearchRepository,
} from "./research-repository";

/// 操作被取消（用户 cancel / pause，或超时）。与"失败"分开是因为两者的终态不同：
/// 取消要把 Session 收敛到 cancelled/paused，失败才写 failed。
export class OperationCancelledError extends Error {
  constructor(readonly operationId: string) {
    super(`研究操作已取消：${operationId}`);
    this.name = "OperationCancelledError";
  }
}

/// 该 operation 已经提交过。崩溃恢复重放到一条已完成的操作时抛它，
/// **绝不重跑 execute**——那会重复发一次已经生效的外部调用（重复扣搜索配额、重复抓取）。
export class OperationAlreadyCommittedError extends Error {
  constructor(readonly operationId: string) {
    super(`研究操作已提交，跳过重试：${operationId}`);
    this.name = "OperationAlreadyCommittedError";
  }
}

/// runOperation 的依赖。全部显式注入，测试用 InMemoryResearchRepository + 手写函数即可覆盖。
export interface RunOperationDeps<T> {
  repository: ResearchRepository;
  sessionId: string;
  operationId: string;
  kind: ResearchOperationKind;
  /// 真正的外部调用（Search Server / Worker）。signal 必须被透传下去，否则取消无法生效。
  execute: (signal: AbortSignal) => Promise<T>;
  /// 响应可信性校验：大小、schema、request id。**抛错即视为响应不可信**，不提交。
  validate: (result: T) => void;
  /// 事务内的写入。**必须同步**（见文件头）。
  apply: (tx: RepositoryTx, result: T) => void;
  signal: AbortSignal;
  /// 请求载荷哈希，用于崩溃恢复时判断"重试请求与原请求是否一致"。
  requestPayloadHash?: string;
  /// 时钟注入，便于测试固定时间戳。
  now?: () => Date;
}

/// 执行一次带原子提交的研究操作。
export async function runOperation<T>(deps: RunOperationDeps<T>): Promise<T> {
  const { repository, operationId, signal } = deps;
  // 入口就取消：连 pending 记录都不留，避免在数据库里堆一堆永远不会被重试的空操作。
  if (signal.aborted) throw new OperationCancelledError(operationId);

  const at = (deps.now ?? (() => new Date()))().toISOString();
  await beginOrResume(deps, at);

  // 与取消信号赛跑，而不是傻等 execute 返回。
  // 为什么必须在这一层兜底：execute 的实现方（Search Client / Worker RPC）**不一定**尊重 signal
  //（例如 Worker 卡在一个 20 秒超时的连接上）。spec §19.1.3 要求"取消后 Session 终态是
  // cancelled"，这条保证不能建立在被调用方的自觉之上。注意在途请求仍会自然结束，
  // 只是它的结果不再被提交——未提交即等于没发生过。
  const result = await raceAbort(deps.execute(signal), signal, operationId);

  // execute 返回后再查一次 signal：取消可能发生在请求已发出、响应刚回来的窗口里。
  // 此时提交也不算错，但用户已经表达了停止意图，继续写库只会让"取消后还在长数据"更难解释。
  if (signal.aborted) throw new OperationCancelledError(operationId);

  // 第 3 步：不可信响应在这里被拦下。抛错不提交 → operation 保持 pending → 可被重试。
  deps.validate(result);

  // 第 4、5 步：写入与"标记已提交"在同一个事务里（由仓储保证）。
  await repository.commitOperation(operationId, (tx) => deps.apply(tx, result), at);
  return result;
}

/// 让一个 Promise 可被取消：signal 触发即以 OperationCancelledError 结束等待。
///
/// 仍然给原 Promise 挂上 then/catch，否则它稍后真的失败时会变成一条 unhandledRejection
///（在 Electron 主进程里那是会打印一整页堆栈、且可能被当成崩溃上报的）。
function raceAbort<T>(pending: Promise<T>, signal: AbortSignal, operationId: string): Promise<T> {
  if (!signal.aborted && typeof signal.addEventListener !== "function") return pending;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      pending.catch(() => {});
      reject(new OperationCancelledError(operationId));
      return;
    }
    const onAbort = (): void => reject(new OperationCancelledError(operationId));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/// 登记 pending operation；已存在时区分"未提交（可重试）"与"已提交（拒绝重跑）"。
///
/// 为什么靠 listPendingOperations 反查而不是加一个 getOperation：仓储接口是 P3 定稿的，
/// 这条判定只在恢复路径上跑，一次按 sessionId 的查询成本可以忽略。
async function beginOrResume<T>(deps: RunOperationDeps<T>, createdAt: string): Promise<void> {
  const { repository, operationId } = deps;
  try {
    await repository.beginOperation({
      sessionId: deps.sessionId,
      operationId,
      kind: deps.kind,
      requestPayloadHash: deps.requestPayloadHash ?? "",
      createdAt,
    });
  } catch {
    const pending = await repository.listPendingOperations(deps.sessionId);
    if (!pending.some((op) => op.operationId === operationId)) {
      throw new OperationAlreadyCommittedError(operationId);
    }
    // 仍然 pending：这是崩溃/失败后的重试，沿用原记录继续往下跑。
  }
}

/// 请求载荷的稳定哈希。**键按字典序排序**后再序列化，保证同一份逻辑载荷（字段书写顺序不同）
/// 得到同一个哈希——否则崩溃恢复时会把同一个请求判成"和原请求不一致"。
export function hashOperationPayload(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/// 确定性 JSON 序列化（对象键排序，数组保持原序）。
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}
