// in-process pi 会话的「并发租约表」：把「一个会话从建好到彻底释放」这段生命周期收成一处。
//
// ── 为什么需要它（迁移计划 §Risks「进程隔离消失」，U6 的并发场景）──────────────────────
// 旧路径下一个子 agent = 一个 pi 子进程，`kill()` 就是终极兜底：挂起的 UI 对话框、未解订阅的
// 事件监听、未结算的 Promise 全随进程一起消失，忘记清理也不会留下痕迹。
// in-process 之后这层兜底没了 —— 漏释放的会话会连同它持有的 agent loop 栈、订阅与挂起对话框
// **永久留在主进程里**，而且几乎没有症状（不占进程、不报错，只是内存与后台工具调用越攒越多）。
//
// 本模块解决三件在「并发起多个子 agent 会话」时反复出现、且各调用方各写一遍必然写歪的事：
//
//   1. **构造期竞态**：`openPiInProcSession()` 是 `await` 的，用户在这段窗口里点停止、或该段
//      超时，会话仍然会在之后建好。此时调用方的 settle 早已跑过、它手里的 session 变量还是
//      undefined —— 这个会话就再也没有任何引用能停它了。`adopt()` 把「登记」与「作废重判」
//      并成一次原子动作：判定为已作废就地释放，绝不留下无主会话。
//
//   2. **释放顺序**：in-process 的 `stop()` 只解订阅 + `dispose()`，**不打断已在跑的 agent 轮次**
//      （旧路径 kill 子进程天然是硬终止，这层语义是白送的）。不先 `abort()` 就释放的话，
//      超时/取消之后子 agent 仍在后台跑工具、烧 token，而事件已被丢弃 —— 用户看不见也停不掉。
//      故 in-process 会话按 `abort()` → `stop()` 顺序释放；二进制会话保持只 `stop()`
//      （`stop()` 就是 kill 子进程，多发一条 abort 命令属于行为变更，灰度期不做）。
//
//   3. **批量释放的故障隔离**：应用退出 / killAll 时逐个释放，任何一个抛错都不能让剩下的漏掉。
//      旧路径漏掉一个 `kill()` 只是留个会自己退出的子进程；in-process 漏掉一个就是永久驻留。

/** 释放一个会话所需要的最小面。`PiSessionEngine` 与 `PiRpcSession` 都天然满足。 */
export interface PiReleasableSession {
  abort(): Promise<unknown>;
  stop(): void;
}

/** 释放过程中的阶段标识，供调用方定位「是哪一步炸的」。 */
export type PiSessionReleasePhase = "before-release" | "abort" | "stop";

export interface PiSessionPoolOptions<S extends PiReleasableSession> {
  /**
   * 释放前的额外清理（编排侧用它摘掉 transient UI 请求的路由表条目）。
   * 抛错会被隔离并上报 `onError`，**不会**阻断后续的 abort/stop —— 清理失败远没有漏释放严重。
   */
  onBeforeRelease?: (session: S) => void;
  /** 释放过程中的故障回调。不给默认实现：静默吞错正是 KTD5 要避免的。 */
  onError?: (phase: PiSessionReleasePhase, err: unknown) => void;
}

export interface PiSessionAdoptOptions {
  /**
   * 释放时是否先 `abort()` 打断在跑的轮次。**只对 in-process 会话置 true**：
   * 二进制会话的 `stop()` 即 kill 子进程，已是硬终止（见文件头第 2 点）。
   */
  abortOnRelease?: boolean;
  /**
   * 「此刻是否已作废」。在 `adopt()` 的**同步瞬间**重新求值 —— 调用方在 await 期间
   * 可能已经 settle/abort 过（见文件头第 1 点）。返回 true 即就地释放且不登记。
   */
  isStale?: () => boolean;
}

export interface PiSessionPool<S extends PiReleasableSession> {
  /** 领取一个刚建好的会话。返回 false 表示已作废并已就地释放，调用方应立即放弃该会话。 */
  adopt(session: S, options?: PiSessionAdoptOptions): boolean;
  /** 释放单个会话。幂等（settle 去重与 releaseAll 可能重复触达同一个会话）。 */
  release(session: S): void;
  /** 释放全部在册会话。单个失败不影响其余。 */
  releaseAll(): void;
  /** 是否仍在册（诊断/测试用）。 */
  has(session: S): boolean;
  /** 在册数量（诊断/测试用；泄漏回归测试直接断言它归零）。 */
  size(): number;
}

interface PoolEntry {
  abortOnRelease: boolean;
}

/**
 * 建一个会话租约表。
 *
 * 并发模型：主进程单事件循环，所有方法都是同步的，因此不需要锁；真正的并发风险全在
 * 「`await` 期间外界状态变了」这一类时序缝隙上，由 `adopt(isStale)` 统一兜住。
 */
export function createPiSessionPool<S extends PiReleasableSession>(
  options: PiSessionPoolOptions<S> = {},
): PiSessionPool<S> {
  const entries = new Map<S, PoolEntry>();

  // 每一步都单独隔离：一个会话（甚至同一会话的某一步）出问题，绝不能影响其余会话的释放。
  const guard = (phase: PiSessionReleasePhase, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      try {
        options.onError?.(phase, err);
      } catch {
        /* 故障回调自身抛错同样不允许冒泡 —— 它跑在 app 退出钩子等不可失败的路径上 */
      }
    }
  };

  const releaseEntry = (session: S, entry: PoolEntry): void => {
    guard("before-release", () => options.onBeforeRelease?.(session));
    if (entry.abortOnRelease) {
      // abort() 本身走会话层的 run() 包裹（失败只回 {success:false} 而不抛），这里仍加双保险：
      // 「打断轮次失败」绝不能反过来阻断 stop() —— 后者才是真正防泄漏的那一步。
      guard("abort", () => {
        void Promise.resolve(session.abort()).catch((err: unknown) => {
          options.onError?.("abort", err);
        });
      });
    }
    guard("stop", () => session.stop());
  };

  return {
    adopt(session, adoptOptions = {}) {
      const entry: PoolEntry = { abortOnRelease: adoptOptions.abortOnRelease === true };
      if (adoptOptions.isStale?.()) {
        releaseEntry(session, entry);
        return false;
      }
      entries.set(session, entry);
      return true;
    },
    release(session) {
      const entry = entries.get(session);
      if (!entry) return; // 幂等
      entries.delete(session);
      releaseEntry(session, entry);
    },
    releaseAll() {
      // 先取出再清空：释放回调（onBeforeRelease / stop 的副作用）可能反过来调 release()，
      // 边遍历边改 Map 会漏项。与 ui-context.ts 的 cancelAll() 同一处理。
      const all = [...entries.entries()];
      entries.clear();
      for (const [session, entry] of all) releaseEntry(session, entry);
    },
    has: (session) => entries.has(session),
    size: () => entries.size,
  };
}
