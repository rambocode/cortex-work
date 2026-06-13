// 项目时间线：主区项目级视图（替代会话区），「时间线 | 日历」两个子视图。
// 数据来自 useProjectTimeline（存储事件 + 合成 session.created + git log）。

import { useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  buildCalendarWeeks,
  buildDailyReportText,
  dayKey,
  groupEventsByDay,
  hhmm,
  useGenerateDaySummary,
  useProjectTimeline,
  usePushDailyReport,
  usePersonalStore,
} from "@cortex-work/core";
import type { AgentKind, CalendarCell, DayGroup, ProjectMeta, TimelineEvent } from "@cortex-work/core";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

// run 事件的 agent 标签;未知值兜底 Claude。
const TL_AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", pi: "Pi" };
function tlAgentLabel(agent: AgentKind | undefined): string {
  return (agent && TL_AGENT_LABEL[agent]) || "Claude";
}

function fmtDayLabel(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  const today = dayKey(Date.now());
  if (day === today) return "今天";
  const weekday = "日一二三四五六"[new Date(y, m - 1, d).getDay()];
  return `${m} 月 ${d} 日 · 周${weekday}`;
}

function statChips(stats: DayGroup["stats"]): string[] {
  const chips: string[] = [];
  if (stats.runs) chips.push(`${stats.runs} 轮交互`);
  if (stats.sessions) chips.push(`${stats.sessions} 个新会话`);
  if (stats.files) chips.push(`${stats.files} 个文件变更`);
  if (stats.commits) chips.push(`${stats.commits} 次提交`);
  return chips.length ? chips : ["无活动"];
}

// ── 事件卡片 ──────────────────────────────────────────────────────────────

function EventCard({ event, onJump }: { event: TimelineEvent; onJump?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const files = event.files ?? [];

  if (event.kind === "session.created") {
    return (
      <div className="pw-tl-event is-minor">
        <span className="pw-tl-time">{hhmm(event.ts)}</span>
        <Icon.Plus size={12} />
        <span>
          新建会话 <button className="pw-tl-link" onClick={onJump}>{event.title}</button>
        </span>
      </div>
    );
  }

  if (event.kind === "git.commit") {
    return (
      <div className="pw-tl-event is-minor">
        <span className="pw-tl-time">{hhmm(event.ts)}</span>
        <Icon.Diff size={12} />
        <span className="pw-tl-commit-hash">{event.meta?.hash?.slice(0, 7)}</span>
        <span className="pw-tl-commit-subject">{event.title}</span>
      </div>
    );
  }

  // run 事件卡片。
  return (
    <div className="pw-tl-card" data-ok={event.meta?.ok !== false}>
      <div className="pw-tl-card-h">
        <span className="pw-tl-time">{event.meta?.backfilled ? "历史" : hhmm(event.ts)}</span>
        <span className="pw-tl-agent">{tlAgentLabel(event.meta?.agent)}</span>
        {event.meta?.ok === false ? <span className="pw-tl-fail">失败</span> : null}
        {onJump ? (
          <button className="pw-icon-btn" title="打开对应会话" onClick={onJump}>
            <Icon.Reply size={12} />
          </button>
        ) : null}
      </div>
      <div className="pw-tl-card-title">{event.title}</div>
      {event.summary ? <div className="pw-tl-card-summary">{event.summary}</div> : null}
      {files.length > 0 ? (
        <div className="pw-tl-files">
          <button className="pw-tl-files-toggle" onClick={() => setExpanded((v) => !v)} data-open={expanded}>
            <Icon.Chevron size={10} />
            {files.length} 个文件变更
          </button>
          {expanded ? (
            <ul className="pw-tl-files-list">
              {files.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── 时间线子视图 ──────────────────────────────────────────────────────────

function TimelineList({
  project,
  groups,
  onToast,
}: {
  project: ProjectMeta;
  groups: DayGroup[];
  onToast: (text: string) => void;
}) {
  const setActiveSession = usePersonalStore((s) => s.setActiveSession);
  const sessions = usePersonalStore((s) => s.sessions);
  const { generate, generatingDay } = useGenerateDaySummary(project);
  const { push, pushing, channelCount } = usePushDailyReport(project);

  const copyReport = async (g: DayGroup) => {
    const { text } = buildDailyReportText(project.name, g);
    try {
      await navigator.clipboard.writeText(text);
      onToast("日报已复制到剪贴板");
    } catch {
      onToast("复制失败");
    }
  };

  const pushReport = (g: DayGroup) => {
    void push(g).then((results) => results.forEach((r) => onToast(r)));
  };

  const jump = (sessionId: string | undefined) => {
    if (!sessionId) return;
    if (!sessions.some((x) => x.id === sessionId)) {
      onToast("该会话已被删除");
      return;
    }
    setActiveSession(sessionId);
  };

  if (groups.length === 0) {
    return (
      <div className="pw-center">
        <Icon.Clock size={26} />
        <div className="pw-center-title">还没有时间线记录</div>
        <div className="pw-center-hint">在该项目下与 Agent 交互后,这里会按天记录做了什么</div>
      </div>
    );
  }

  return (
    <div className="pw-tl-list">
      {groups.map((g) => (
        <section key={g.day} id={`tl-day-${g.day}`} className="pw-tl-day">
          <header className="pw-tl-day-h">
            <span className="pw-tl-day-label">{fmtDayLabel(g.day)}</span>
            <span className="pw-tl-day-date">{g.day}</span>
            {statChips(g.stats).map((c) => (
              <span key={c} className="pw-tl-chip">
                {c}
              </span>
            ))}
            <span className="pw-tl-day-sp" />
            <button
              className="pw-tl-gen"
              disabled={generatingDay !== null}
              onClick={() => {
                void generate(g).then(
                  () => onToast(`${g.day} 日报已生成`),
                  () => onToast("日报生成失败,请检查 设置 → 时间线 的模型配置"),
                );
              }}
              title="用 AI 生成这一天的工作日报（模型可在设置中配置）"
            >
              <Icon.Sparkle size={12} />
              {generatingDay === g.day ? "生成中…" : g.summary ? "重新生成" : "生成日报"}
            </button>
            <button className="pw-tl-gen" onClick={() => void copyReport(g)} title="复制日报文本">
              <Icon.File size={12} />
              复制
            </button>
            <button
              className="pw-tl-gen"
              disabled={pushing}
              onClick={() => pushReport(g)}
              title={
                channelCount > 0
                  ? `推送到 ${channelCount} 个已启用渠道（企业微信 / 钉钉 / 邮件）`
                  : "推送渠道未配置,在 设置 → 时间线 中启用"
              }
            >
              <Icon.Send size={12} />
              {pushing ? "推送中…" : "推送"}
            </button>
          </header>
          {g.summary?.summary ? <div className="pw-tl-daily">{g.summary.summary}</div> : null}
          <div className="pw-tl-day-body">
            {g.events.map((ev) => (
              <EventCard key={ev.id} event={ev} onJump={ev.sessionId ? () => jump(ev.sessionId) : undefined} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ── 日历子视图 ────────────────────────────────────────────────────────────

function heatLevel(stats: CalendarCell["stats"]): number {
  if (!stats) return 0;
  const score = stats.runs + stats.commits;
  if (score <= 0) return 0;
  if (score <= 2) return 1;
  if (score <= 5) return 2;
  if (score <= 10) return 3;
  return 4;
}

function CalendarGrid({
  groups,
  onPickDay,
}: {
  groups: DayGroup[];
  onPickDay: (day: string) => void;
}) {
  const now = new Date();
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() });
  const weeks = useMemo(() => buildCalendarWeeks(ym.y, ym.m, groups), [ym, groups]);
  const today = dayKey(Date.now());

  // 当月汇总（活跃天数 / 轮次 / 文件 / 提交）。
  const monthPrefix = `${ym.y}-${String(ym.m + 1).padStart(2, "0")}-`;
  const monthTotal = useMemo(() => {
    const inMonth = groups.filter((g) => g.day.startsWith(monthPrefix));
    return inMonth.reduce(
      (acc, g) => ({
        days: acc.days + (g.stats.runs || g.stats.commits || g.stats.sessions ? 1 : 0),
        runs: acc.runs + g.stats.runs,
        files: acc.files + g.stats.files,
        commits: acc.commits + g.stats.commits,
      }),
      { days: 0, runs: 0, files: 0, commits: 0 },
    );
  }, [groups, monthPrefix]);

  const shift = (delta: number) => {
    setYm(({ y, m }) => {
      const d = new Date(y, m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  };

  return (
    <div className="pw-tl-cal">
      <div className="pw-tl-cal-nav">
        <span className="pw-tl-cal-title">
          {ym.y} 年 {ym.m + 1} 月
        </span>
        <span className="pw-tl-cal-month-sum">
          {monthTotal.days > 0
            ? `活跃 ${monthTotal.days} 天 · ${monthTotal.runs} 轮交互` +
              (monthTotal.files ? ` · ${monthTotal.files} 个文件` : "") +
              (monthTotal.commits ? ` · ${monthTotal.commits} 次提交` : "")
            : "本月暂无活动"}
        </span>
        <span className="pw-tl-day-sp" />
        <button className="pw-icon-btn" onClick={() => shift(-1)} title="上个月">
          <Icon.Back size={13} />
        </button>
        <button
          className="pw-tl-today"
          onClick={() => setYm({ y: now.getFullYear(), m: now.getMonth() })}
        >
          今天
        </button>
        <button className="pw-icon-btn" onClick={() => shift(1)} title="下个月">
          <Icon.Fwd size={13} />
        </button>
      </div>
      <div className="pw-tl-cal-grid">
        {WEEKDAYS.map((w, i) => (
          <div key={w} className="pw-tl-cal-wd" data-weekend={i >= 5}>
            {w}
          </div>
        ))}
        {weeks.flat().map((cell, idx) => {
          const active = !!cell.stats && (cell.stats.runs > 0 || cell.stats.commits > 0 || cell.stats.sessions > 0);
          return (
            <button
              key={cell.day}
              className="pw-tl-cal-cell"
              data-in-month={cell.inMonth}
              data-today={cell.day === today}
              data-heat={heatLevel(cell.stats)}
              data-weekend={idx % 7 >= 5}
              disabled={!active}
              onClick={() => onPickDay(cell.day)}
              title={active ? `${cell.day} · ${statChips(cell.stats!).join(" · ")}` : undefined}
            >
              <span className="pw-tl-cal-date">{cell.date}</span>
              {active ? (
                <>
                  <span className="pw-tl-cal-badge">
                    {cell.stats!.runs > 0 ? `${cell.stats!.runs} 轮` : `${cell.stats!.commits} 提交`}
                  </span>
                  <span className="pw-tl-cal-dots" aria-hidden="true">
                    {cell.stats!.files > 0 ? <i className="is-files" /> : null}
                    {cell.stats!.commits > 0 ? <i className="is-commits" /> : null}
                    {cell.stats!.sessions > 0 ? <i className="is-sessions" /> : null}
                  </span>
                </>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="pw-tl-cal-legend">
        <span className="pw-tl-cal-legend-heat">
          少
          {[1, 2, 3, 4].map((h) => (
            <i key={h} data-heat={h} />
          ))}
          多
        </span>
        <span className="pw-tl-cal-legend-item"><i className="is-files" /> 文件变更</span>
        <span className="pw-tl-cal-legend-item"><i className="is-commits" /> 提交</span>
        <span className="pw-tl-cal-legend-item"><i className="is-sessions" /> 新会话</span>
        <span className="pw-tl-day-sp" />
        <span>点击日期跳转到时间线对应的天</span>
      </div>
    </div>
  );
}

// ── 容器 ──────────────────────────────────────────────────────────────────

export function TimelineView({ project, onToast }: { project: ProjectMeta; onToast: (text: string) => void }) {
  const [view, setView] = useState<"timeline" | "calendar">("timeline");
  const closeTimeline = usePersonalStore((s) => s.closeTimeline);
  const { events, loading } = useProjectTimeline(project);
  const groups = useMemo(() => groupEventsByDay(events), [events]);

  const pickDay = (day: string) => {
    setView("timeline");
    // 等时间线子视图挂载后再滚动定位。
    requestAnimationFrame(() => {
      document.getElementById(`tl-day-${day}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <main className="chat pw-tl">
      <header className="pw-tl-h">
        <Icon.Clock size={15} />
        <span className="pw-tl-h-name">{project.name}</span>
        <span className="pw-tl-h-sub">项目时间线</span>
        <div className="pw-tl-switch" role="tablist">
          <button role="tab" aria-selected={view === "timeline"} data-active={view === "timeline"} onClick={() => setView("timeline")}>
            时间线
          </button>
          <button role="tab" aria-selected={view === "calendar"} data-active={view === "calendar"} onClick={() => setView("calendar")}>
            日历
          </button>
        </div>
        <button className="pw-icon-btn" title="返回会话" onClick={closeTimeline}>
          <Icon.XCircle size={15} />
        </button>
      </header>
      <div className="pw-tl-body">
        {loading ? (
          <div className="pw-center">
            <div className="pw-center-hint">正在加载时间线（首次会回填历史会话）…</div>
          </div>
        ) : view === "timeline" ? (
          <TimelineList project={project} groups={groups} onToast={onToast} />
        ) : (
          <CalendarGrid groups={groups} onPickDay={pickDay} />
        )}
      </div>
    </main>
  );
}
