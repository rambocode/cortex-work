// Session 状态推进的守卫层（spec §9、KTD8）。
//
// 仓储的 updateSessionStatus **刻意不做状态机校验**（启动恢复要能强写 interrupted），
// 所以「转移是否合法」这件事必须由编排层负责——也就是这里。非法转移一律抛错而不是静默写库：
// 一个悄悄从 completed 跳回 searching 的 Session，会让证据的因果链彻底不可信。
import {
  RESEARCH_SESSION_STATUSES,
  canTransition,
} from "@cortex-work/core/research/session-status";
import type { ResearchSessionStatus } from "@cortex-work/core/research/types";
import type { ResearchRepository } from "./research-repository";

/// 非法状态转移。带 from/to 便于日志定位。
export class IllegalStatusTransitionError extends Error {
  constructor(
    readonly from: ResearchSessionStatus,
    readonly to: ResearchSessionStatus,
  ) {
    super(`非法的研究状态转移：${from} → ${to}`);
    this.name = "IllegalStatusTransitionError";
  }
}

/// 求一条从 from 到 to 的合法转移路径（含 to，不含 from）；不可达返回 null。
///
/// 为什么需要多跳：状态图里 paused / interrupted 都**没有**直达 cancelled 的边
///（core 的转移表如此，且不在本批次的修改范围）。但「取消一个已暂停的 Session」是必须支持的
/// 用户操作，否则它会永远卡在 paused。多跳路径（paused → interrupted → planning → cancelled）
/// 的每一步都合法，落库结果也正确。
/// 深度上限 4：状态图很小，超过这个深度只会是环。
export function resolveStatusPath(
  from: ResearchSessionStatus,
  to: ResearchSessionStatus,
): ResearchSessionStatus[] | null {
  if (from === to) return [];
  const queue: Array<{ status: ResearchSessionStatus; path: ResearchSessionStatus[] }> = [
    { status: from, path: [] },
  ];
  const visited = new Set<ResearchSessionStatus>([from]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.path.length >= 4) continue;
    for (const next of RESEARCH_SESSION_STATUSES) {
      if (visited.has(next) || !canTransition(current.status, next)) continue;
      const path = [...current.path, next];
      if (next === to) return path;
      visited.add(next);
      queue.push({ status: next, path });
    }
  }
  return null;
}

/// 单个 Session 的状态写入器。持有内存中的当前状态，避免每次推进都回库读一次。
///
/// 并发约定：一个 Session 同时只有一个编排在跑（由 research-service 的注册表保证），
/// 因此这里的内存状态不会与别的写者竞争。
export class SessionStateWriter {
  constructor(
    private readonly repository: ResearchRepository,
    readonly sessionId: string,
    private status: ResearchSessionStatus,
    private readonly deps: {
      now?: () => Date;
      onStatus?: (status: ResearchSessionStatus) => void;
    } = {},
  ) {}

  get current(): ResearchSessionStatus {
    return this.status;
  }

  /// 推进一步。非法转移抛 IllegalStatusTransitionError（不写库）。
  async to(target: ResearchSessionStatus, errorMessage?: string): Promise<void> {
    if (target === this.status) return;
    if (!canTransition(this.status, target)) {
      throw new IllegalStatusTransitionError(this.status, target);
    }
    await this.write(target, errorMessage);
  }

  /// 强制收敛到某个终态：直达不通时走 resolveStatusPath 的合法多跳路径。
  /// 仍然完全不可达时抛错——绝不绕过状态机直接写库。
  async forceTo(target: ResearchSessionStatus, errorMessage?: string): Promise<void> {
    if (target === this.status) return;
    const path = resolveStatusPath(this.status, target);
    if (path === null) throw new IllegalStatusTransitionError(this.status, target);
    for (const step of path) {
      // 中间态不带 errorMessage：错误文案只属于最终落点，否则中途状态会闪现一条误导性的报错。
      await this.write(step, step === target ? errorMessage : undefined);
    }
  }

  private async write(target: ResearchSessionStatus, errorMessage?: string): Promise<void> {
    const at = (this.deps.now ?? (() => new Date()))().toISOString();
    await this.repository.updateSessionStatus(this.sessionId, target, errorMessage, at);
    this.status = target;
    this.deps.onStatus?.(target);
  }
}
