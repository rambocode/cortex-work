// 抓取并发闸（spec §12.3：全局并发 6、每域并发 2）。
//
// 为什么要两级而不是只限全局：只限全局时 6 个名额可能全部落到同一个域名上，等于对单站点
// 发起小型压测——既容易被封禁，也不礼貌。每域 2 是「礼貌抓取」的下限约定。
//
// 排队策略是 FIFO，且**先拿全局名额再拿域名名额**，两者顺序固定以避免交叉等待造成的死锁。
// 本文件跑在 utilityProcess Worker 里，禁止 import electron。

/// 并发上限配置。默认值即 spec §12.3 的数字。
export interface FetchLimiterOptions {
  global?: number;
  perHost?: number;
}

/// 一个 FIFO 计数信号量。
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

/// 全局 + 每域两级并发闸。用法：`limiter.run(host, () => safeRequest(...))`。
export class FetchLimiter {
  readonly limits: { global: number; perHost: number };
  private readonly globalSemaphore: Semaphore;
  private readonly hostSemaphores = new Map<string, Semaphore>();

  constructor(options: FetchLimiterOptions = {}) {
    this.limits = {
      global: Math.max(1, options.global ?? 6),
      perHost: Math.max(1, options.perHost ?? 2),
    };
    this.globalSemaphore = new Semaphore(this.limits.global);
  }

  /// 在并发闸内执行任务。任务抛错也必定释放两个名额（finally），否则一次异常就会永久卡死队列。
  async run<T>(host: string, task: () => Promise<T>): Promise<T> {
    const hostSemaphore = this.semaphoreFor(host);
    await this.globalSemaphore.acquire();
    try {
      await hostSemaphore.acquire();
      try {
        return await task();
      } finally {
        hostSemaphore.release();
      }
    } finally {
      this.globalSemaphore.release();
    }
  }

  private semaphoreFor(host: string): Semaphore {
    const key = host.toLowerCase();
    let semaphore = this.hostSemaphores.get(key);
    if (!semaphore) {
      semaphore = new Semaphore(this.limits.perHost);
      this.hostSemaphores.set(key, semaphore);
    }
    return semaphore;
  }
}
