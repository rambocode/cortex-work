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
  const pattern = scheduleToCron(meta.schedule);
  // 注意:croner 的 protect 仅在「上一次 callback 尚未返回」时拦截,而这里 callback
  // 同步 fire-and-forget 立即返回,protect 无效。并发去重真正靠 runner 的
  // pending + runningAutomations（见 runner.runAutomation）。
  const options = meta.timezone ? { timezone: meta.timezone } : {};
  try {
    const job = new Cron(pattern, options, () => {
      void runAutomation(meta, "schedule");
    });
    jobs.set(meta.id, job);
  } catch (err) {
    console.error(`[scheduler] 无法调度 ${meta.id}（${pattern}）:`, err);
  }
}

// 关机/休眠期间错过了触发点:lastRunAt 之后的第一个应触发时刻已过 → 补跑一次
// （只补一次,避免唤醒瞬间堆叠多次）。从未跑过的任务不补（新建不立即触发）。
function shouldCatchUp(meta: AutomationMeta, now: number): boolean {
  if (!meta.enabled || !meta.lastRunAt) return false;
  const missed = computeNextRun(meta.schedule, meta.timezone, new Date(meta.lastRunAt));
  return missed != null && missed < now;
}

// 启动初始化:自愈孤儿 run → 刷新所有 nextRunAt → 补漏 → 建定时器 → 广播快照。
export async function initScheduler(): Promise<void> {
  await markOrphanRunsKilled();
  const list = await loadAutomations();
  const now = Date.now();
  for (const meta of list) {
    const nextRunAt = meta.enabled ? (computeNextRun(meta.schedule, meta.timezone) ?? undefined) : undefined;
    if (nextRunAt !== meta.nextRunAt) await patchAutomation(meta.id, { nextRunAt });
    if (shouldCatchUp(meta, now)) void runAutomation(meta, "schedule");
    scheduleOne(meta);
  }
  broadcastChanged(await loadAutomations());
}

// 休眠唤醒后重排（补漏 + 重建定时器以消除漂移）。
export async function rescheduleAll(): Promise<void> {
  const list = await loadAutomations();
  const now = Date.now();
  for (const meta of list) {
    if (shouldCatchUp(meta, now)) void runAutomation(meta, "schedule");
    scheduleOne(meta);
  }
}

// 真正退出时停掉所有定时器（进程退出也会自然销毁,显式更干净）。
export function stopScheduler(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
}
