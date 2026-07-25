// CRE 的启动恢复（spec §9、§13.1、KTD8、验收 §19.1.4）。
//
// 进程重启后，磁盘上必然留着一批「看起来在跑、其实早就没有在途工作」的 Session 与操作。
// 本模块在 main 启动阶段跑一次，把它们归一到可恢复的静止态：
//   1. 全部非终态 Session → interrupted（用 core 的 statusOnAppRestart，不在这里重复判定规则）；
//   2. 未 committed 的 operation 标记为可重试（spec §9.1「崩溃恢复时只重试未 committed operation」）；
//   3. 清理 tmp/ 中超过 24 小时且不属于任何 active operation 的文件。
//
// `now` 是显式参数而不是读 Date.now()：24 小时这条边界必须能在测试里精确落在两侧。
import { join } from "node:path";
import { NON_TERMINAL_RESEARCH_STATUSES, statusOnAppRestart } from "@cortex-work/core/research/session-status";
import type { ResearchRepository } from "./research-repository";

/// tmp 目录清理所需的最小文件系统面。注入而非直接用 node:fs，
/// 是为了让「24 小时边界 + active operation 保护」这两条规则能零真实文件地被测。
export interface RecoveryTmpFs {
  readdir(dir: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  unlink(path: string): Promise<void>;
}

/// 恢复结果，供日志与调试（不进 renderer，不含正文）。
export interface RecoveryReport {
  /// 被归一为 interrupted 的 sessionId。
  interruptedSessions: string[];
  /// 被标记为可重试的 operationId。
  retryableOperations: string[];
  /// 清理掉的 tmp 文件数量。
  removedTmpFiles: number;
}

/// 启动恢复的注入依赖（仓储 + tmp 文件系统 + 时钟），全部显式注入以便零 mock 框架测试。
export interface StartupRecoveryDeps {
  repository: ResearchRepository;
  /// tmp 目录绝对路径（生产传 paths.ts 的 researchTmpDir()）。
  tmpDir: string;
  now: Date;
  /// 缺省用真实 node:fs；测试注入替身。
  tmpFs?: RecoveryTmpFs;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

/// tmp 文件的保留时长（spec §13.1：清理超过 24 小时的临时文件）。
const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/// 执行一次启动恢复。**幂等**：第二次跑没有可归一的 Session，返回空列表。
///
/// 单条失败不中断整体：某个 Session 写不进去（磁盘只读、行被锁）不应该让整个应用启动失败，
/// 更不该让其余 Session 卡在「进行中」。失败记 warn，继续处理下一条。
export async function runResearchStartupRecovery(deps: StartupRecoveryDeps): Promise<RecoveryReport> {
  const { repository, now, logger } = deps;
  const report: RecoveryReport = { interruptedSessions: [], retryableOperations: [], removedTmpFiles: 0 };
  const updatedAt = now.toISOString();

  // 1. 非终态 Session 归一。一次查询取全部 5 个运行阶段，避免逐状态查询漏掉分页。
  const stale = await repository.listSessions({ statuses: NON_TERMINAL_RESEARCH_STATUSES });
  for (const summary of stale) {
    const target = statusOnAppRestart(summary.status);
    if (target === summary.status) continue;
    try {
      await repository.updateSessionStatus(summary.sessionId, target, summary.errorMessage, updatedAt);
      report.interruptedSessions.push(summary.sessionId);
    } catch (err) {
      logger?.warn("[research] 恢复 Session 状态失败", summary.sessionId, err);
    }
  }

  // 2. 未提交的操作标记可重试。它们同时构成下一步 tmp 清理的"豁免名单"。
  const pending = await repository.listPendingOperations();
  for (const operation of pending) {
    try {
      await repository.markOperationRetryable(operation.operationId);
      report.retryableOperations.push(operation.operationId);
    } catch (err) {
      logger?.warn("[research] 标记 operation 可重试失败", operation.operationId, err);
    }
  }

  // 3. tmp 清理。
  report.removedTmpFiles = await cleanTmpDir(
    deps,
    new Set(pending.map((op) => op.operationId)),
    now.getTime(),
  );

  logger?.info?.(
    `[research] 启动恢复完成：${report.interruptedSessions.length} 个 Session 转 interrupted，` +
      `${report.retryableOperations.length} 个 operation 待重试，清理 ${report.removedTmpFiles} 个临时文件`,
  );
  return report;
}

/// 清理 tmp 目录。返回删除数量。
///
/// 保留规则有两条，缺一不可：
/// - 修改时间在 24 小时内的一律保留——本次启动前刚崩溃的抓取，其半成品可能马上就要被重试；
/// - 属于 active operation 的一律保留，**即使它已经很旧**：这条操作重启后仍会被重试，
///   删掉它的中间产物等于白跑一遍。约定文件名以 `<operationId>.` 开头或恰好等于 operationId。
async function cleanTmpDir(
  deps: StartupRecoveryDeps,
  activeOperationIds: ReadonlySet<string>,
  nowMs: number,
): Promise<number> {
  const fs = deps.tmpFs ?? (await defaultTmpFs());
  let entries: string[];
  try {
    entries = await fs.readdir(deps.tmpDir);
  } catch (err) {
    // 目录不存在（ENOENT）是全新安装 / 从未跑过研究的正常形态：无临时文件可清，
    // **静默返回**——每次启动打一条带堆栈的日志只会被误读成故障。
    // 其余错误（EACCES、EIO 等）是真故障：不阻断启动，但必须留 warn 供诊断。
    if (!isMissingDirError(err)) {
      deps.logger?.warn("[research] tmp 目录不可读，跳过清理", err);
    }
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (belongsToActiveOperation(entry, activeOperationIds)) continue;
    const path = joinPath(deps.tmpDir, entry);
    try {
      const stat = await fs.stat(path);
      if (nowMs - stat.mtimeMs <= TMP_MAX_AGE_MS) continue;
      await fs.unlink(path);
      removed += 1;
    } catch (err) {
      deps.logger?.warn("[research] 清理临时文件失败", entry, err);
    }
  }
  return removed;
}

/// 判断错误是否为「目录不存在」。只认 code，不匹配 message——后者随 Node 版本与语言环境变化。
function isMissingDirError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/// 判断 tmp 文件是否归属某个仍在重试队列里的 operation。
function belongsToActiveOperation(entry: string, activeOperationIds: ReadonlySet<string>): boolean {
  if (activeOperationIds.has(entry)) return true;
  const dot = entry.indexOf(".");
  return dot > 0 && activeOperationIds.has(entry.slice(0, dot));
}

/// 生产用的 tmp 文件系统实现。动态 import 是为了让注入替身的测试
/// 完全不加载 node:fs 相关代码路径。
async function defaultTmpFs(): Promise<RecoveryTmpFs> {
  const { promises: fsp } = await import("node:fs");
  return {
    readdir: (dir) => fsp.readdir(dir),
    stat: async (path) => ({ mtimeMs: (await fsp.stat(path)).mtimeMs }),
    unlink: (path) => fsp.unlink(path),
  };
}

/// tmp 目录内的路径拼接。用 node:path 而非手写字符串拼接，
/// 保证 Windows 下的分隔符正确（tmpDir 来自 paths.ts，是平台原生绝对路径）。
function joinPath(dir: string, entry: string): string {
  return join(dir, entry);
}
