// 落地页「用量日历卡片」（借鉴 kun InitialSessionUsageHeatmap）：
// 替换原 HomeBoard 的「活动热力图」section。头部 segmented 在「活动」与「token 用量」
// 间切换 + 刷新 + 折叠；无数据时显示 warmup 空态。两模式共用 .pw-hm 网格 DOM，
// 仅数据源 / 定档 / 文案不同。活动数据由 HomeBoard 传入（复用既有 timeline 聚合），
// token 数据由本卡片经 useDailyUsage 自取。

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Icon } from "@cortex-work/ui/icons";
import {
  buildHeatmapWeeks,
  buildTokenWeeks,
  dayKey,
  homeHeatLevel,
  tokenHeatLevel,
  useDailyUsage,
} from "@cortex-work/core";
import type { DayGroup, DayStats, HeatCell, HeatWeek } from "@cortex-work/core";

const HEAT_WEEKS = 26;
const WEEKDAY_ROWS = ["一", "三", "五", "日"]; // 仅标注部分行,GitHub 风格

type Mode = "activity" | "tokens";

function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(n < 1e10 ? 1 : 0) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}

function activityTitle(day: string, stats?: DayStats): string {
  if (!stats) return `${day} · 无活动`;
  const parts: string[] = [];
  if (stats.runs) parts.push(`${stats.runs} 轮交互`);
  if (stats.sessions) parts.push(`${stats.sessions} 个新会话`);
  if (stats.files) parts.push(`${stats.files} 个文件变更`);
  return parts.length ? `${day} · ${parts.join(" · ")}` : `${day} · 无活动`;
}

function tokenTitle(day: string, tokens?: number): string {
  return tokens ? `${day} · ${fmtTokens(tokens)} tokens` : `${day} · 无用量`;
}

// ── 共用网格（复用 .pw-hm 样式，模式无关） ────────────────────────────────

function HeatGrid({
  weeks,
  today,
  selectedDay,
  levelOf,
  titleOf,
  onPickDay,
}: {
  weeks: HeatWeek[];
  today: string;
  selectedDay?: string;
  levelOf: (cell: HeatCell) => number;
  titleOf: (cell: HeatCell) => string;
  onPickDay?: (day: string) => void;
}) {
  return (
    <div className="pw-hm">
      <div className="pw-hm-body">
        <div className="pw-hm-wd" aria-hidden="true">
          {WEEKDAY_ROWS.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        <div className="pw-hm-scroll">
          <div className="pw-hm-months">
            {weeks.map((w, i) => (
              <span key={i}>{w.monthLabel ?? ""}</span>
            ))}
          </div>
          <div className="pw-hm-grid">
            {weeks.map((w, i) => (
              <div key={i} className="pw-hm-col">
                {w.cells.map((c) => (
                  <button
                    key={c.day}
                    className="pw-hm-cell"
                    data-heat={levelOf(c)}
                    data-today={c.day === today}
                    data-selected={c.day === selectedDay}
                    disabled={c.inFuture || !onPickDay}
                    onClick={onPickDay ? () => onPickDay(c.day) : undefined}
                    title={c.inFuture ? undefined : titleOf(c)}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 卡片 ──────────────────────────────────────────────────────────────────

export function UsageCalendarCard({
  groups,
  selectedDay,
  onPickDay,
}: {
  groups: DayGroup[];
  selectedDay: string;
  onPickDay: (day: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("activity");
  // 默认收起：落地页只露出一个展开按钮（见效果图），点击后再显示活动 / token 面板。
  const [collapsed, setCollapsed] = useState(true);
  const queryClient = useQueryClient();
  const { days, loading, refresh: refreshTokens } = useDailyUsage(HEAT_WEEKS);

  const today = dayKey(Date.now());
  const activityWeeks = useMemo(() => buildHeatmapWeeks(HEAT_WEEKS, groups), [groups]);
  const tokenWeeks = useMemo(() => buildTokenWeeks(HEAT_WEEKS, days), [days]);

  const hasActivity = useMemo(() => groups.some((g) => g.stats.runs + g.stats.sessions > 0), [groups]);
  const hasTokens = useMemo(() => days.some((d) => d.tokens > 0), [days]);

  const tokensLoading = mode === "tokens" && loading && days.length === 0;
  const isEmpty = mode === "activity" ? !hasActivity : !hasTokens;

  const weeks = mode === "activity" ? activityWeeks : tokenWeeks;
  const levelOf = mode === "activity" ? (c: HeatCell) => homeHeatLevel(c.stats) : (c: HeatCell) => tokenHeatLevel(c.tokens ?? 0);
  const titleOf = mode === "activity" ? (c: HeatCell) => activityTitle(c.day, c.stats) : (c: HeatCell) => tokenTitle(c.day, c.tokens);

  const doRefresh = () => {
    if (mode === "tokens") refreshTokens();
    else void queryClient.invalidateQueries({ queryKey: ["personal", "timeline"] });
  };

  // 折叠态（默认）：只渲染一个居中的圆形展开按钮，不带卡片边框 / tab 头部（见效果图 1）。
  if (collapsed) {
    return (
      <section className="pw-usagecal pw-usagecal--collapsed" data-collapsed="true">
        <button
          type="button"
          className="pw-usagecal-expand"
          aria-label="展开用量日历"
          title="展开活动 / token 用量"
          onClick={() => setCollapsed(false)}
        >
          <Icon.Chevron size={16} />
        </button>
      </section>
    );
  }

  return (
    <section className="pw-usagecal" data-collapsed="false">
      <header className="pw-usagecal-head">
        <div className="pw-usagecal-modes" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "activity"}
            data-active={mode === "activity"}
            onClick={() => setMode("activity")}
          >
            活动
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "tokens"}
            data-active={mode === "tokens"}
            onClick={() => setMode("tokens")}
          >
            token 用量
          </button>
        </div>
        <span className="pw-usagecal-sp" />
        <button type="button" className="pw-usagecal-refresh" onClick={doRefresh}>
          <Icon.Retry size={12} />
          刷新
        </button>
        <button
          type="button"
          className="pw-usagecal-toggle"
          aria-label={collapsed ? "展开用量日历" : "折叠用量日历"}
          onClick={() => setCollapsed((v) => !v)}
        >
          <span className="chev" data-open={!collapsed}>
            <Icon.Chevron size={14} />
          </span>
        </button>
      </header>

      {tokensLoading ? (
        <div className="pw-usagecal-loading">统计中…</div>
      ) : isEmpty ? (
        <div className="pw-usagecal-warmup">
          <div className="pw-usagecal-preview">
            <HeatGrid weeks={weeks} today={today} levelOf={() => 0} titleOf={() => ""} />
          </div>
          <div className="pw-usagecal-warmup-text">
            <span className="pw-usagecal-badge">
              <Icon.Lightning size={11} />
              智能体用量
            </span>
            <strong>还没有记录到用量</strong>
            <p>发送一个请求并完成一轮回复后，第一个活跃日会自动出现在这里。</p>
          </div>
        </div>
      ) : (
        <>
          <HeatGrid
            weeks={weeks}
            today={today}
            selectedDay={selectedDay}
            levelOf={levelOf}
            titleOf={titleOf}
            onPickDay={onPickDay}
          />
          <div className="pw-hm-legend">
            <span className="pw-tl-cal-legend-heat">
              少
              {[1, 2, 3, 4].map((h) => (
                <i key={h} data-heat={h} />
              ))}
              多
            </span>
            <span className="pw-tl-day-sp" />
            <span>
              {mode === "activity"
                ? `近 ${HEAT_WEEKS} 周所有项目的活动 · 点击日期查看当天总结`
                : `近 ${HEAT_WEEKS} 周 Claude Code 的按天 token 用量 · 点击日期查看当天总结`}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
