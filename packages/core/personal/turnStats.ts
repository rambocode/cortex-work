// 会话统计（输入框底部统计条）的纯逻辑层：每轮统计量的类型、会话级折叠与数字格式化。
//
// 数据来源刻意选了**持久 `turnUsage` 消息**而不是瞬态过程流（personalProcessKeys）：
// 过程流每轮结束就清、只保留最近 30 轮归档，而统计条要显示「整个会话至今」的总量，
// 必须跨重启与分页稳定。turnUsage 与正文同档落盘、随回复分支切换，语义正好对上。
//
// 口径（与 packages/core/desktop/types.ts 的 TurnTokenUsage 注释同源）：四个 token 桶
// 互斥不重叠，计费输入 = input + cacheRead + cacheWrite；缓存命中率 = cacheRead / 计费输入。

// TurnStats 定义在 types/index.ts（与 Message 同处），这里只做 re-export：
// Message 的 turnUsage 变体要引用它，反向再由本文件定义就成了循环 import。
import type { Message, TurnStats } from "../types";

export type { TurnStats };

/** 会话级折叠结果：轮数 + 逐轮相加的耗时统计 + 四个 token 桶。 */
export interface SessionStats extends TurnStats {
  /** 完成的用户回合数（= 落盘的 turnUsage 消息条数）。 */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 是否有任一供应商上报过 token。全 0 与「没上报」要区分开，后者不展示 token 组。 */
  hasUsage: boolean;
}

const EMPTY_STATS: SessionStats = {
  turns: 0,
  steps: 0,
  llmMs: 0,
  toolMs: 0,
  ttftMs: 0,
  ttftSteps: 0,
  decodeMs: 0,
  decodeTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  hasUsage: false,
};

/** 负数 / NaN / 非数字一律读作 0，避免一条脏记录把整条统计带成 NaN。 */
function safe(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 把会话消息流里的全部 `turnUsage` 消息折叠成会话级统计。
 *
 * 只认 turnUsage 一种消息：它每轮成功收尾时落一条，天然等于「轮数」。老档里的
 * turnUsage 没有 `stats` 字段（本功能之前写入的），耗时项按 0 计——展示层据此
 * 自动省略耗时组，不会显示成「0s」。
 * @param messages - 会话的持久消息流（usePersonalChat 的 messages）。
 * @returns 会话级统计；无 turnUsage 时返回全 0。
 */
export function foldSessionStats(messages: readonly Message[]): SessionStats {
  let acc: SessionStats = EMPTY_STATS;
  let seen = false;
  for (const m of messages) {
    if (m.kind !== "turnUsage") continue;
    seen = true;
    const s = m.stats;
    const base: SessionStats = acc;
    const hasUsage =
      base.hasUsage ||
      m.inputTokens !== undefined ||
      m.outputTokens !== undefined ||
      m.cacheReadTokens !== undefined ||
      m.cacheWriteTokens !== undefined;
    acc = {
      turns: base.turns + 1,
      steps: base.steps + safe(s?.steps),
      llmMs: base.llmMs + safe(s?.llmMs),
      toolMs: base.toolMs + safe(s?.toolMs),
      ttftMs: base.ttftMs + safe(s?.ttftMs),
      ttftSteps: base.ttftSteps + safe(s?.ttftSteps),
      decodeMs: base.decodeMs + safe(s?.decodeMs),
      decodeTokens: base.decodeTokens + safe(s?.decodeTokens),
      inputTokens: base.inputTokens + safe(m.inputTokens),
      outputTokens: base.outputTokens + safe(m.outputTokens),
      cacheReadTokens: base.cacheReadTokens + safe(m.cacheReadTokens),
      cacheWriteTokens: base.cacheWriteTokens + safe(m.cacheWriteTokens),
      hasUsage,
    };
  }
  // 没有任何 turnUsage 时返回共享的空对象常量：调用方在 useMemo 里用它做引用比较，
  // 每次新建一份会让「空会话」也持续触发下游重渲。
  return seen ? acc : EMPTY_STATS;
}

/**
 * 计费输入 token = 三个互斥的输入桶之和（未命中缓存 + 缓存读 + 缓存写）。
 * @param stats - 会话级统计。
 * @returns 计费输入 token 数。
 */
export function billedInputTokens(stats: SessionStats): number {
  return stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens;
}

/**
 * 缓存命中率 = 缓存读 / 计费输入。
 * @param stats - 会话级统计。
 * @returns 取整百分比；无计费输入时返回 null（该组整体不展示）。
 */
export function cacheHitPercent(stats: SessionStats): number | null {
  const denominator = billedInputTokens(stats);
  return denominator === 0 ? null : Math.round((stats.cacheReadTokens / denominator) * 100);
}

/**
 * 紧凑 token 计数：517 / 12.2K / 517K / 1.2M（三位数以下保一位小数）。
 * @param n - token 数。
 * @returns 展示串。
 */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`;
  return `${scaled(n / 1_000_000)}M`;
}

/**
 * 紧凑时长：不足一分钟显示 45.2s，之后显示 2m42s。
 * @param ms - 毫秒。
 * @returns 展示串。
 */
export function formatStatsDuration(ms: number): string {
  const s = ms / 1_000;
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

/**
 * 吞吐：≥10 取整，<10 保一位小数（慢速率下 "7" 和 "7.4" 差别可感知）。
 * @param tps - 每秒 token 数。
 * @returns 展示串。
 */
export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}
