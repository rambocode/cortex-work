// Browser 降级路径的次数与并发预算（spec §19.4：Browser 并发默认 1、最多 2）。
//
// 为什么 Worker 侧要自己再夹一次：`max_browser_fetches` 由 main 经协议下发，但 Worker 是被
// 独立进程托管的执行体，**不能假设上游一定夹取过**（协议只约束 `>= 0`）。起 Chrome 的代价是
// 几百 MB RSS 与秒级启动，一次配置失误就能把用户机器拖垮，所以这里做最后一道硬闸。
//
// 本文件跑在 utilityProcess Worker 里，**禁止 import electron**。

/// Browser 并发的默认值（spec §19.4）。
export const DEFAULT_BROWSER_CONCURRENCY = 1;

/// Browser 并发的硬上限（spec §19.4）。超出即夹取，不报错——上游配置错误不该让整轮抓取失败。
export const MAX_BROWSER_CONCURRENCY = 2;

/// 把任意来源的并发配置夹到 [1, MAX_BROWSER_CONCURRENCY]。
/// 非有限数（undefined / NaN）视为「没配」，回落默认值；小数向下取整，避免 1.9 被当成 2。
export function clampBrowserConcurrency(value?: number): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_BROWSER_CONCURRENCY;
  return Math.min(MAX_BROWSER_CONCURRENCY, Math.max(1, Math.floor(value)));
}

/// BrowserBudget 的构造参数。maxFetches 直接取协议里的 `max_browser_fetches`。
export interface BrowserBudgetOptions {
  maxFetches: number;
  concurrency?: number;
}

/// 一次预算申请的结果。exhausted 不是「抓取失败」而是「本轮没有额度」——
/// 调用方应把它记为跳过（或降级回纯 HTTP），不要生成 fetch failure。
export type BrowserBudgetOutcome<T> = { ok: true; value: T } | { ok: false; reason: "exhausted" };

/// 次数 + 并发双闸。用法：`await budget.run(() => browserFetch(...))`。
export class BrowserBudget {
  readonly maxFetches: number;
  readonly concurrency: number;
  private reserved = 0;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: BrowserBudgetOptions) {
    this.maxFetches = Number.isFinite(options.maxFetches)
      ? Math.max(0, Math.floor(options.maxFetches))
      : 0;
    this.concurrency = clampBrowserConcurrency(options.concurrency);
  }

  /// 已经占用的次数（含正在执行的）。
  get used(): number {
    return this.reserved;
  }

  /// 剩余可用次数。
  get remaining(): number {
    return Math.max(0, this.maxFetches - this.reserved);
  }

  /// 在预算内执行一次 Browser 抓取。
  ///
  /// **次数在同步阶段就扣**（在 await 并发名额之前）：否则 N 个并发调用会同时看到「还有额度」，
  /// 排队等名额，最终突破 maxFetches。已扣的次数不因任务抛错而退还——进程已经起过，
  /// 资源已经消耗，退还等于给失败重试开无限额度。
  async run<T>(task: () => Promise<T>): Promise<BrowserBudgetOutcome<T>> {
    if (this.reserved >= this.maxFetches) return { ok: false, reason: "exhausted" };
    this.reserved += 1;

    await this.acquire();
    try {
      return { ok: true, value: await task() };
    } finally {
      this.release();
    }
  }

  /// FIFO 获取一个并发名额。
  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  /// 释放并发名额并唤醒队首。任务抛错时也必须走到这里，否则一次异常永久卡死队列。
  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}
