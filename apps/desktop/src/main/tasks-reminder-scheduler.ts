// 任务提醒调度器（U11）——薄任务调度器，与 automation/workflow 调度器同源思路，但**不耦合
// AutomationMeta**：只认 TaskMeta.reminder。设计为纯依赖注入（now / createCron / notify /
// markFired / powerSaveBlocker / log 全部注入），本文件不静态 import electron 或 croner，
// 故可在 vitest 里零 mock 直接单测（electron 真实的通知投递与 croner 建 job 由 ipc/tasks.ts
// 注入真依赖，对齐 tasks-store.ts「纯核心」↔ ipc/tasks.ts「electron 绑定」的分层）。
//
// 幂等闸门（KTD）：TaskMeta.reminder.firedAt 是「只触发一次 / 只补跑一次」的唯一持久化闸门。
// automation 靠 enabled/lastRunAt 收敛，任务侧无这些字段，必须靠 firedAt 自建：
//   - 已置 firedAt 的提醒不再建 Cron、不再补触发 → 天然收敛，也是防「写 firedAt → 再 sync」环的根基。
// opt-in 门控在调度层：opt-in 关时 sync 直接不建任何 Cron、不持 powerSaveBlocker（否则设了提醒
// 却没开通知的用户白耗电、通知还从不弹）。opt-in 开→关要 unschedule 全部并释放 blocker。

import type { TaskMeta, TaskReminder } from "./ipc/tasks-types";

// 一次性定时器句柄的最小契约（croner Cron 的子集）。测试注入可手动触发的假实现。
export interface ReminderCronHandle {
  stop(): void;
}

// powerSaveBlocker 的最小契约（对齐 electron.powerSaveBlocker）。测试注入 spy。
export interface ReminderPowerSaveBlocker {
  start(): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

export interface TasksReminderSchedulerDeps {
  // 当前时间（测试注入冻结时钟 vi.useFakeTimers()）。
  now: () => number;
  // 建一次性 Cron（main 注入 `(at, cb) => new Cron(at, cb)`；测试注入可手动触发的假句柄）。
  createCron: (at: Date, cb: () => void) => ReminderCronHandle;
  // 到点/补跑时投递通知（main 注入原生 Notification 投递；测试注入 spy）。
  notify: (task: TaskMeta) => void;
  // 写 firedAt 幂等闸门（main 注入 tasksStore.update + 广播；测试注入 spy）。fire-and-forget。
  markFired: (task: TaskMeta, firedAt: number) => void;
  // 可选：有待触发提醒且 opt-in 开时持有，防睡眠唤醒漏触发。缺省 = 不管理 blocker。
  powerSaveBlocker?: ReminderPowerSaveBlocker;
  // 可选：脱敏日志（只记 id/计数，绝不打印任务标题）。
  log?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

// at 合理上下界（超出即视为非法脏值 → 跳过该条，不影响同批其它提醒）：
//   下界：不早于 now - 30 天。既作为「补跑宽限」（App 关闭数日内错过的提醒仍补触发一次），
//         也挡住离谱的过去值（负数 / 1970 epoch）——太老的提醒补触发只会打扰，不如静默跳过。
//   上界：不晚于 now + 5 年。挡住 year-9999 之类会让 croner 失效的脏值。
export const REMINDER_MAX_PAST_MS = 30 * 24 * 60 * 60 * 1000;
export const REMINDER_MAX_FUTURE_MS = 5 * 365 * 24 * 60 * 60 * 1000;

// 只对未完结任务调度提醒（done/dropped 的提醒无意义）。
const ACTIVE_STATUSES: ReadonlySet<TaskMeta["status"]> = new Set(["active", "in-progress", "waiting"]);

// at 合法性 + 上下界校验（纯函数，导出供测试）。非法返回 false → 调用方跳过该条。
export function reminderAtInRange(at: number, now: number): boolean {
  return Number.isFinite(at) && at >= now - REMINDER_MAX_PAST_MS && at <= now + REMINDER_MAX_FUTURE_MS;
}

export class TasksReminderScheduler {
  // taskId → 一次性 Cron 句柄。
  private jobs = new Map<string, ReminderCronHandle>();
  // powerSaveBlocker id，-1 = 未激活。
  private blockerHandle = -1;
  // opt-in 总开关（「内部原生通知」）。默认关（通知 opt-in）。
  private enabled = false;
  // 最近一次 sync 的任务快照：opt-in 变化时用它重排；补触发后就地更新其 firedAt，
  // 使 setEnabled(false→true) 不会因快照陈旧而重复补触发（详见 fire）。
  private lastTasks: TaskMeta[] = [];
  // 跨 sync 存活的「本会话已触发」闸门（taskId → 已触发的 at）：不被 this.lastTasks 覆盖影响。
  // 补住并发窗口——两个 emitChanged 各持一份 markFired 落盘前的陈旧 list（firedAt 仍 null），
  // 前者 fire 后就地标记的本地快照会被后者 `this.lastTasks = tasks.slice()` 覆盖，导致重复补触发
  //（correctness 复核 P2）。本 Map 是不被覆盖的第三重闸门；prune 时随提醒删除/改时而清。
  private firedThisSession = new Map<string, number>();

  constructor(private readonly deps: TasksReminderSchedulerDeps) {}

  // 重建调度（幂等）：缓存快照 + 应用。每次写任务后由 ipc/tasks.ts 的 emitChanged 调用。
  sync(tasks: TaskMeta[]): void {
    this.lastTasks = tasks.slice();
    this.applySync();
  }

  // opt-in 变更（由 store:save 钩子驱动）：值变才重排。开→建/补，关→拆全部 + 释放 blocker。
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.applySync();
  }

  // 退出收尾：停掉所有 Cron + 释放 blocker。
  stop(): void {
    this.unscheduleAll();
    this.releaseBlocker();
  }

  private unscheduleAll(): void {
    for (const h of this.jobs.values()) h.stop();
    this.jobs.clear();
  }

  // 核心：先全量 unschedule（幂等重建），opt-in 关则直接释放 blocker 返回；
  // opt-in 开则逐条建 Cron / 补触发，最后按有无待触发 job 更新 blocker。
  private applySync(): void {
    this.unscheduleAll();
    this.pruneFiredGate();
    if (!this.enabled) {
      this.releaseBlocker();
      return;
    }
    const now = this.deps.now();
    for (const task of this.lastTasks) {
      const rem = task.reminder;
      if (!rem || rem.firedAt != null) continue; // 无提醒 / 已触发（幂等闸门）→ 跳过
      if (this.firedThisSession.get(task.id) === rem.at) continue; // 本会话已触发同一 at（跨 sync 闸门）
      if (!ACTIVE_STATUSES.has(task.status)) continue; // 已完结 → 跳过
      // at 校验：非法/越界 → 跳过该条，绝不让整个 sync 抛错（保护同批其它提醒）。
      if (!reminderAtInRange(rem.at, now)) {
        this.deps.log?.warn(`跳过越界提醒 at（task=${task.id}）`);
        continue;
      }
      try {
        if (rem.at <= now) {
          // 错过补跑「只补一次」：立即触发 + 写 firedAt。firedAt 是唯一幂等闸门。
          this.fire(task, now);
        } else {
          // 未来提醒：建一次性 Cron，到点触发。
          const handle = this.deps.createCron(new Date(rem.at), () => this.fire(task, this.deps.now()));
          this.jobs.set(task.id, handle);
        }
      } catch (err) {
        // 单条建 job 失败（脏 Date 等）不拖垮同批其它提醒。
        this.deps.log?.error(`调度提醒失败（task=${task.id}）`, err);
      }
    }
    this.updateBlocker();
  }

  // 投递 + 写 firedAt（幂等闸门）。fire 是唯一触发出口（补跑 & 到点 Cron 都经此）。
  // task 可能是 Cron 闭包捕获的**陈旧快照**（用户在触发前删了提醒/改了时间/任务完结），
  // 或并发 sync 的陈旧 list——故投递前必须以当前权威快照 + firedThisSession 闸门复核（correctness 复核 P2）。
  private fire(task: TaskMeta, firedAt: number): void {
    const id = task.id;
    const at = task.reminder?.at;
    // 先停掉该任务的 Cron（无论后续是否投递，防重复触发；补跑路径无 job，delete 为 no-op）。
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    // 以当前快照复核：提醒已删/改时/已触发、任务已完结、或本会话已触发同一 at → no-op（不弹、不写 firedAt，
    // 杜绝「删提醒瞬间 Cron 触发」误弹 + 并发重复弹）。markFired 侧还有 store 锁内二次守卫（不复活已删提醒）。
    const cur = this.lastTasks.find((t) => t.id === id);
    const stale =
      at == null ||
      !cur ||
      !cur.reminder ||
      cur.reminder.at !== at ||
      cur.reminder.firedAt != null ||
      !ACTIVE_STATUSES.has(cur.status) ||
      this.firedThisSession.get(id) === at;
    if (stale) {
      this.updateBlocker();
      return;
    }
    this.firedThisSession.set(id, at); // 先占闸门，再投递（并发第二个 sync 命中即跳过）
    this.deps.notify(cur);
    // 持久化 firedAt（main 注入：store 锁内条件写 + 广播；不经 emitChanged，避免再触发 sync 成环）。
    this.deps.markFired(cur, firedAt);
    // 就地把本地快照该条标 firedAt（不改共享 store 对象，做浅拷贝）：防陈旧快照重复补触发。
    const next: TaskReminder = { ...(cur.reminder as TaskReminder), firedAt };
    this.lastTasks = this.lastTasks.map((t) => (t.id === id ? { ...t, reminder: next } : t));
    this.updateBlocker();
  }

  // 清理失效的 fired 闸门（提醒被删 / 改时 / 任务消失）：防 Map 无限增长，并让重设的提醒能再次触发。
  private pruneFiredGate(): void {
    for (const [id, at] of this.firedThisSession) {
      const t = this.lastTasks.find((x) => x.id === id);
      if (!t || !t.reminder || t.reminder.at !== at) this.firedThisSession.delete(id);
    }
  }

  // 有待触发 Cron 且 opt-in 开 → 持有 blocker；否则释放。
  private updateBlocker(): void {
    const psb = this.deps.powerSaveBlocker;
    if (!psb) return;
    const need = this.enabled && this.jobs.size > 0;
    if (need && (this.blockerHandle === -1 || !psb.isStarted(this.blockerHandle))) {
      this.blockerHandle = psb.start();
    } else if (!need && this.blockerHandle !== -1 && psb.isStarted(this.blockerHandle)) {
      psb.stop(this.blockerHandle);
      this.blockerHandle = -1;
    }
  }

  private releaseBlocker(): void {
    const psb = this.deps.powerSaveBlocker;
    if (!psb || this.blockerHandle === -1) return;
    if (psb.isStarted(this.blockerHandle)) psb.stop(this.blockerHandle);
    this.blockerHandle = -1;
  }
}
