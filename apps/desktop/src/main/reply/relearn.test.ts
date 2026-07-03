// 「立即重新学习」样本收集的单测：按渠道分桶、时序（旧→新入队,FIFO 保最新）、
// 无效条目跳过。LLM 调用与落盘由 index.ts 的 relearn 编排负责,不在此测。

import { describe, expect, it } from "vitest";
import type { ReplyHistoryEntry } from "@cortex-work/core/reply/history";
import { SAMPLE_LIMIT } from "@cortex-work/core/reply/memory";
import { collectRelearnSamples } from "./relearn";

/// 最小历史条目工厂（newest-first 数组由调用方组装）。
function entry(patch: Partial<ReplyHistoryEntry>): ReplyHistoryEntry {
  return {
    id: "id",
    ts: 0,
    appName: "WeChat",
    appBundleId: "com.tencent.xinWeChat",
    counterpart: "",
    conversation: "",
    candidates: [],
    acceptedIndex: 0,
    acceptedText: "",
    ...patch,
  };
}

describe("collectRelearnSamples", () => {
  it("按应用类别分桶：IM 应用入 im，邮件应用入 email", () => {
    const buckets = collectRelearnSamples([
      entry({ id: "a", acceptedText: "好的" }),
      entry({ id: "b", appName: "Mail", appBundleId: "com.apple.mail", acceptedText: "已收到，谢谢" }),
    ]);
    expect(buckets.get("im")).toEqual(["好的"]);
    expect(buckets.get("email")).toEqual(["已收到，谢谢"]);
  });

  it("样本 = 对话「我：」侧行 + 已采纳回复；空白样本忽略", () => {
    const buckets = collectRelearnSamples([
      entry({
        conversation: "对方：在吗\n我：在的\n对方：好\n我：  ",
        acceptedText: "马上来",
      }),
    ]);
    expect(buckets.get("im")).toEqual(["在的", "马上来"]);
  });

  it("入参 newest-first：按旧→新入队，超上限时保留最新样本", () => {
    // 构造超过 SAMPLE_LIMIT 条历史（每条一个采纳样本），newest-first 排列。
    const entries = Array.from({ length: SAMPLE_LIMIT + 5 }, (_, i) =>
      entry({ id: `e${i}`, ts: 1000 - i, acceptedText: `回复${i}` }),
    );
    const samples = collectRelearnSamples(entries).get("im")!;
    expect(samples).toHaveLength(SAMPLE_LIMIT);
    // 最新条目（数组头部 e0）必须存活，最旧的被 FIFO 挤出。
    expect(samples[samples.length - 1]).toBe("回复0");
    expect(samples).not.toContain(`回复${SAMPLE_LIMIT + 4}`);
  });

  it("无有效样本的条目不产生分桶", () => {
    expect(collectRelearnSamples([entry({})]).size).toBe(0);
  });
});
