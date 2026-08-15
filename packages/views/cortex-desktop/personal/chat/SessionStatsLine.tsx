// 会话统计条：输入框下方一行弱化文本，展示整个会话至今的轮数/步数、LLM 与工具耗时、
// TTFT 与解码吞吐、缓存命中率、输入/输出 token。
//
// 数据源是持久 `turnUsage` 消息的折叠（core 的 foldSessionStats），所以它跨重启、
// 跨分页、跨回复分支都稳定——不是「当前屏上有什么」，而是「这个会话累计花了多少」。
//
// 分组语义：组与组之间用 `|` 分隔，**任何一组数据缺失就整组消失**（不显示 0）。这样
// 老档（没有耗时字段）与 claude/codex（CLI 适配层没有 pi 的 turn_start 计时锚点）都能
// 优雅降级成「只有 token 的一行」，而不是摆一排具有误导性的 0。

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import {
  billedInputTokens,
  cacheHitPercent,
  foldSessionStats,
  formatStatsDuration,
  formatTokens,
  formatTokensPerSecond,
  type SessionStats,
} from "@cortex-work/core/personal/turnStats";
import type { Message } from "@cortex-work/core";

/**
 * 把会话统计折叠成待展示的分组文本。纯函数，便于单测锁住「哪组在什么条件下出现」。
 * @param stats - 会话级统计。
 * @param t - i18n 取词函数（chat 命名空间）。
 * @returns 分组文本数组；无任何可展示内容时为空数组。
 */
export function buildStatsGroups(
  stats: SessionStats,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string[] {
  const groups: string[] = [];
  // 轮数/步数：步数为 0 说明这条通道没有计时锚点，此时只报轮数，不假装有步数。
  if (stats.turns > 0) {
    groups.push(
      stats.steps > 0
        ? t("stats.counts", { turns: stats.turns, steps: stats.steps })
        : t("stats.turnsOnly", { turns: stats.turns }),
    );
  }
  const durations: string[] = [];
  if (stats.llmMs > 0) durations.push(t("stats.llm", { duration: formatStatsDuration(stats.llmMs) }));
  if (stats.toolMs > 0) durations.push(t("stats.toolCall", { duration: formatStatsDuration(stats.toolMs) }));
  if (durations.length > 0) groups.push(durations.join(" · "));

  const speeds: string[] = [];
  // TTFT 取平均：分母是「记录到首 token 的步数」，纯工具步不参与，否则平均值会被摊薄。
  if (stats.ttftSteps > 0) {
    speeds.push(t("stats.ttftAverage", { duration: formatStatsDuration(stats.ttftMs / stats.ttftSteps) }));
  }
  if (stats.decodeMs > 0) {
    speeds.push(
      t("stats.tokensPerSecond", {
        throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
      }),
    );
  }
  if (speeds.length > 0) groups.push(speeds.join(" · "));

  // token 组：门控在「确实有供应商上报过」，全部请求都失败的会话只显示轮数、不挂一组 0 token。
  if (stats.hasUsage && (billedInputTokens(stats) > 0 || stats.outputTokens > 0)) {
    const hit = cacheHitPercent(stats);
    if (hit !== null) groups.push(t("stats.cacheHit", { percent: hit }));
    groups.push(
      t("stats.tokens", {
        input: formatTokens(billedInputTokens(stats)),
        output: formatTokens(stats.outputTokens),
      }),
    );
  }
  return groups;
}

/** Props：会话的持久消息流（usePersonalChat 的结果）。 */
export interface SessionStatsLineProps {
  messages: readonly Message[];
}

export function SessionStatsLine({ messages }: SessionStatsLineProps) {
  const { t } = useTranslation("chat");
  // 折叠要遍历整条消息流，长会话下不该每次父组件重渲都重算一遍。
  const stats = useMemo(() => foldSessionStats(messages), [messages]);
  const groups = buildStatsGroups(stats, t as (key: string, opts?: Record<string, unknown>) => string);
  const line = groups.join(" | ");

  // 窄栏下这行会被省略号截断，此时才挂 title 把完整内容交出去。
  // 未截断时不挂 —— 否则鼠标划过就弹一个与可见文本一模一样的提示，纯噪音。
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setTruncated(el.scrollWidth > el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [line]);

  if (groups.length === 0) return null;
  return (
    <div ref={rootRef} className="pw-stats-line" {...(truncated ? { title: line } : {})}>
      {groups.map((group, i) => (
        <span key={group}>
          {i > 0 ? <span className="pw-stats-sep" aria-hidden="true">|</span> : null}
          {group}
        </span>
      ))}
    </div>
  );
}
