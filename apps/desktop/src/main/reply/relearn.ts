// 「立即重新学习」的样本收集（源项目 relearn 的等价物）：从已落盘的回复历史重建
// 各渠道分区的语气样本队列。迁移计划原本因 KTD8「样本不落盘」砍掉此按钮;KTD8 修订
// 引入 history.json（historyEnabled 门控）后,历史即样本来源,relearn 得以恢复——
// 无需另外落盘样本,隐私边界不再额外扩大。
// LLM 蒸馏与写回由 index.ts 的 relearn 编排（复用 buildDistillPrompt / chatComplete）。

import type { ReplyHistoryEntry } from "@cortex-work/core/reply/history";
import { appendSample, channelScopeForCapturedApp } from "@cortex-work/core/reply/memory";
import { extractMineSamples } from "./distill";

/// 从回复历史收集重学样本,按渠道类别（im/email）分桶。
/// 入参为 newest-first 的历史数组;内部按旧→新入队,配合 appendSample 的 FIFO 上限
/// 保证「最新样本存活」——与后台蒸馏的采样时序语义一致。
export function collectRelearnSamples(
  entries: readonly ReplyHistoryEntry[],
): Map<"im" | "email", string[]> {
  const buckets = new Map<"im" | "email", string[]>();
  // 反向遍历（最旧在前）,让新样本后入队,超上限时淘汰的是旧样本。
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const scope = channelScopeForCapturedApp({
      bundleId: entry.appBundleId,
      name: entry.appName,
    });
    let queue = buckets.get(scope) ?? [];
    for (const sample of extractMineSamples(entry.conversation)) {
      queue = appendSample(queue, sample);
    }
    queue = appendSample(queue, entry.acceptedText);
    if (queue.length > 0) buckets.set(scope, queue);
  }
  return buckets;
}
