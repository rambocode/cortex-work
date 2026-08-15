import { describe, expect, it } from "vitest";
import type { Message } from "../types";
import {
  billedInputTokens,
  cacheHitPercent,
  foldSessionStats,
  formatStatsDuration,
  formatTokens,
  formatTokensPerSecond,
} from "./turnStats";

/** 造一条 turnUsage 消息，只填被测字段。 */
function usageMsg(over: Partial<Extract<Message, { kind: "turnUsage" }>>): Message {
  return {
    kind: "turnUsage",
    who: "pi",
    time: "10:00",
    runId: "r1",
    ...over,
  } as Message;
}

describe("foldSessionStats", () => {
  it("没有 turnUsage 时全 0 且 hasUsage=false", () => {
    const stats = foldSessionStats([{ kind: "text", who: "me", time: "10:00", text: "hi" } as Message]);
    expect(stats.turns).toBe(0);
    expect(stats.hasUsage).toBe(false);
  });

  it("轮数按 turnUsage 条数计，各项逐轮相加", () => {
    const stats = foldSessionStats([
      usageMsg({
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
        stats: { steps: 2, llmMs: 3000, toolMs: 500, ttftMs: 800, ttftSteps: 2, decodeMs: 2000, decodeTokens: 40 },
      }),
      usageMsg({
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 100,
        stats: { steps: 1, llmMs: 1000, toolMs: 0, ttftMs: 400, ttftSteps: 1, decodeMs: 600, decodeTokens: 12 },
      }),
    ]);
    expect(stats.turns).toBe(2);
    expect(stats.steps).toBe(3);
    expect(stats.llmMs).toBe(4000);
    expect(stats.toolMs).toBe(500);
    expect(stats.ttftSteps).toBe(3);
    expect(stats.decodeTokens).toBe(52);
    expect(stats.inputTokens).toBe(150);
    expect(stats.cacheReadTokens).toBe(1000);
    expect(stats.hasUsage).toBe(true);
  });

  it("老档没有 stats 字段：耗时项按 0，token 仍统计", () => {
    const stats = foldSessionStats([usageMsg({ inputTokens: 10, outputTokens: 2 })]);
    expect(stats.turns).toBe(1);
    expect(stats.steps).toBe(0);
    expect(stats.llmMs).toBe(0);
    expect(stats.hasUsage).toBe(true);
  });

  it("脏数据（负数 / NaN）读作 0，不把整条统计带成 NaN", () => {
    const stats = foldSessionStats([
      usageMsg({
        inputTokens: Number.NaN,
        outputTokens: -5,
        stats: { steps: -1, llmMs: Number.NaN, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
      }),
    ]);
    expect(stats.inputTokens).toBe(0);
    expect(stats.outputTokens).toBe(0);
    expect(stats.steps).toBe(0);
    expect(stats.llmMs).toBe(0);
    // 字段存在（即使值无效）仍算「上报过」——这与「完全没有 token 字段」是两回事。
    expect(stats.hasUsage).toBe(true);
  });
});

describe("token 口径", () => {
  it("计费输入是三个互斥输入桶之和", () => {
    const stats = foldSessionStats([
      usageMsg({ inputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100, outputTokens: 5 }),
    ]);
    expect(billedInputTokens(stats)).toBe(1000);
    expect(cacheHitPercent(stats)).toBe(80);
  });

  it("无计费输入时缓存命中率为 null（该组整体不展示）", () => {
    expect(cacheHitPercent(foldSessionStats([usageMsg({ outputTokens: 5 })]))).toBeNull();
  });
});

describe("格式化", () => {
  it("token 计数分档", () => {
    expect(formatTokens(517)).toBe("517");
    expect(formatTokens(12_240)).toBe("12.2K");
    expect(formatTokens(517_000)).toBe("517K");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });

  it("时长不足一分钟保一位小数，之后用 m/s", () => {
    expect(formatStatsDuration(1_240)).toBe("1.2s");
    expect(formatStatsDuration(55_700)).toBe("55.7s");
    expect(formatStatsDuration(162_000)).toBe("2m42s");
  });

  it("吞吐 ≥10 取整，<10 保一位小数", () => {
    expect(formatTokensPerSecond(174.4)).toBe("174");
    expect(formatTokensPerSecond(7.44)).toBe("7.4");
    expect(formatTokensPerSecond(-3)).toBe("0");
  });
});
