// 做梦触发调度（混合策略,经用户确认）：
//   1. 深睡：croner 每日 03:00 定时整理（app 需在运行,桌面 app 常驻托盘时命中）;
//   2. 补跑：启动 / 休眠唤醒时,若距上次成功整理超过 24h → 补一次（覆盖「凌晨没开机」）;
//   3. 小睡：会话有新落盘后进入 debounce——连续 IDLE_NAP_MS 无新活动即增量整理一次
//      （chat:save 每轮落盘,由 ipc/chat.ts 调 noteMemoryActivity 上报活动）;
//   4. 手动：设置页「立即整理」直接调 dreamer.dreamNow("manual")（不经本模块）。
// 并发安全由 Dreamer 单飞保证,本模块只管触发时机;独立于用户自动化列表（不入 automations.json）。

import { Cron } from "croner";
import { powerMonitor } from "electron";
import type { DreamTrigger, MemoryDreamResult } from "@cortex-work/core/memory/memory";

/// 深睡 cron：每日 03:00（本地时区）。
const DEEP_DREAM_CRON = "0 3 * * *";

/// 补跑阈值：距上次成功整理超过 24h 即视为「错过了深睡」。
const CATCH_UP_AFTER_MS = 24 * 60 * 60 * 1000;

/// 小睡 debounce：最后一次会话落盘后空闲这么久才整理（会话进行中不打扰,LLM 调用也省）。
const IDLE_NAP_MS = 5 * 60 * 1000;

/// 启动补跑延迟：避开 app 启动高峰（窗口创建/各 store 物化）。
const STARTUP_CATCHUP_DELAY_MS = 60 * 1000;

export interface DreamSchedulerDeps {
  dreamNow: (trigger: DreamTrigger) => Promise<MemoryDreamResult>;
  /// 读上次成功整理时刻（dream-state.json 的 lastDreamAt）。
  getLastDreamAt: () => Promise<number | null>;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

// 模块级活动上报入口：ipc/chat.ts 在 chat:save 后调用。调度器未初始化时安全 no-op
// （如测试环境/初始化早期）。用模块级函数而非依赖注入,避免 chat.ts 与调度器互相持有。
let activitySink: (() => void) | null = null;

/// 会话活动上报（chat:save 成功后调）：重置小睡 debounce 计时器。
export function noteMemoryActivity(): void {
  activitySink?.();
}

/// 初始化做梦调度：建深睡 Cron + 启动/唤醒补跑 + 小睡 debounce。返回清理函数（app 退出时调）。
export function initMemoryDream(deps: DreamSchedulerDeps): () => void {
  const fire = (trigger: DreamTrigger) => {
    void deps.dreamNow(trigger).catch((err) => deps.logger?.warn("[memory] 做梦触发失败", err));
  };

  // 1. 深睡：每日定时。
  const deepJob = new Cron(DEEP_DREAM_CRON, () => fire("scheduled"));

  // 2. 补跑：从未整理过（lastDreamAt=null）也补——首启后一小时内完成首次记忆固化。
  const catchUpIfOverdue = async () => {
    try {
      const last = await deps.getLastDreamAt();
      if (last == null || Date.now() - last > CATCH_UP_AFTER_MS) fire("catchup");
    } catch (err) {
      deps.logger?.warn("[memory] 补跑判定失败", err);
    }
  };
  const startupTimer = setTimeout(() => void catchUpIfOverdue(), STARTUP_CATCHUP_DELAY_MS);
  const onResume = () => void catchUpIfOverdue();
  powerMonitor.on("resume", onResume);

  // 3. 小睡：活动 debounce。会话进行中每次落盘都会重置计时器,真正空闲才触发。
  let napTimer: NodeJS.Timeout | null = null;
  activitySink = () => {
    if (napTimer) clearTimeout(napTimer);
    napTimer = setTimeout(() => {
      napTimer = null;
      fire("idle");
    }, IDLE_NAP_MS);
  };

  deps.logger?.info?.("[memory] 做梦调度已启动(深睡 03:00 + 补跑 + 空闲小睡)");

  return () => {
    deepJob.stop();
    clearTimeout(startupTimer);
    if (napTimer) clearTimeout(napTimer);
    powerMonitor.off("resume", onResume);
    activitySink = null;
  };
}
