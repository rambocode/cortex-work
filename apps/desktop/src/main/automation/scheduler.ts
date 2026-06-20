// 主进程常驻调度器（croner）。app.whenReady 后 initScheduler 一次:为每个启用的
// 自动化建一个 Cron job,到点 fire-and-forget 调 runner。CRUD 时由 ipc 层调
// scheduleOne/unschedule 增量重排。powerMonitor.resume 后 rescheduleAll 补漏 +
// 重建定时器（休眠期间内存定时器会漂移/错过,croner 不自动补触发）。

import { Cron } from "croner";
import type { AutomationMeta } from "../ipc/types";
import { broadcastChanged } from "./events";
import { runAutomation } from "./runner";
import { computeNextRun, scheduleToCron } from "./schedule-cron";
import { loadAutomations, markOrphanRunsKilled, patchAutomation } from "./store";

const jobs = new Map<string, Cron>();

export function unschedule(id: string): void {
  jobs.get(id)?.stop();
  jobs.delete(id);
}

// 重建单个自动化的 job（先停旧的,enabled 才建新的）。闭包捕获传入 meta 快照:
// CRUD 改配置时 ipc 层会用新 meta 再调一次,故闭包内 meta 恒为最新有效配置。
export function scheduleOne(meta: AutomationMeta): void {
  unschedule(meta.id);
  if (!meta.enabled) return;
  // 注意:croner 的 protect 仅在「上一次 callback 尚未返回」时拦截,而这里 callback
  // 同步 fire-and-forget 立即返回,protect 无效。并发去重真正靠 runner 的
  // pending + runningAutomations（见 runner.runAutomation）。
  const options = meta.timezone ? { timezone: meta.timezone } : {};
  const cb = () => {
    void runAutomation(meta, "schedule");
  };
  try {
    // once 为绝对 epoch ms,无 cron 表示(scheduleToCron 对 once 会抛错),须在此单独分支:
    // croner@10 的 Cron 构造器接受 Date 即建一次性 job,到点触发一次后自然结束。
    // 绝对时刻已含 UTC 偏移,timezone 不影响触发瞬间,故 once 分支不传 timezone。
    const job =
      meta.schedule.kind === "once"
        ? new Cron(new Date(meta.schedule.at), cb)
        : new Cron(scheduleToCron(meta.schedule), options, cb);
    jobs.set(meta.id, job);
  } catch (err) {
    console.error(`[scheduler] 无法调度 ${meta.id}:`, err);
  }
}

// 关机/休眠期间错过了触发点:lastRunAt 之后的第一个应触发时刻已过 → 补跑一次
// （只补一次,避免唤醒瞬间堆叠多次）。从未跑过的任务不补（新建不立即触发）。
function shouldCatchUp(meta: AutomationMeta, now: number): boolean {
  if (!meta.enabled || !meta.lastRunAt) return false;
  const missed = computeNextRun(meta.schedule, meta.timezone, new Date(meta.lastRunAt));
  return missed != null && missed < now;
}

// once 专属补漏:从未跑过的一次性任务若在 App 关闭/休眠期间错过了 at,需补触发一次。
// 为何要独立判定——shouldCatchUp 以 lastRunAt 为锚点找「下一应触发时刻」,而 once 在
// 触发前 lastRunAt 恒为空,永远进不了那条路径,关机期间错过 at 就会被永久漏掉(R5 缺口)。
// 二者天然互斥:本分支要求 !lastRunAt,shouldCatchUp 要求 lastRunAt 存在,同一任务不会双补。
// finalize 触发后会置 enabled:false,故补跑过的 once 不会在下次启动再次满足(只补一次)。
function shouldCatchUpOnce(meta: AutomationMeta, now: number): boolean {
  return (
    meta.enabled &&
    meta.schedule.kind === "once" &&
    !meta.lastRunAt &&
    meta.schedule.at < now
  );
}

// 启动初始化:自愈孤儿 run → 刷新所有 nextRunAt → 补漏 → 建定时器 → 广播快照。
export async function initScheduler(): Promise<void> {
  await markOrphanRunsKilled();
  const list = await loadAutomations();
  const now = Date.now();
  for (const meta of list) {
    const nextRunAt = meta.enabled ? (computeNextRun(meta.schedule, meta.timezone) ?? undefined) : undefined;
    if (nextRunAt !== meta.nextRunAt) await patchAutomation(meta.id, { nextRunAt });
    if (shouldCatchUp(meta, now) || shouldCatchUpOnce(meta, now)) void runAutomation(meta, "schedule");
    scheduleOne(meta);
  }
  broadcastChanged(await loadAutomations());
}

// 休眠唤醒后重排（补漏 + 重建定时器以消除漂移）。
export async function rescheduleAll(): Promise<void> {
  const list = await loadAutomations();
  const now = Date.now();
  for (const meta of list) {
    if (shouldCatchUp(meta, now) || shouldCatchUpOnce(meta, now)) void runAutomation(meta, "schedule");
    scheduleOne(meta);
  }
}

// 真正退出时停掉所有定时器（进程退出也会自然销毁,显式更干净）。
export function stopScheduler(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
}
