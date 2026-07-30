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
  GLOBAL_TIMELINE_ID,
} from "@cortex-work/core";
import type { AgentKind, CalendarCell, DayGroup, NoteStatus, ProjectMeta, TimelineEvent } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";

// 译函数的最小签名（避免引入 react-i18next 的 TFunction 泛型,只需 key + 插值即可）。
type TFunction = (key: string, opts?: Record<string, unknown>) => string;

// 周几表头（日历用）。中文星期单字属展示数据,直接渲染;dayLabel 的 weekday 插值同理。
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

// run 事件的 agent 标签;未知值兜底 Claude。
const TL_AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", pi: "Pi" };
function tlAgentLabel(agent: AgentKind | undefined, t: TFunction): string {
  return (agent && TL_AGENT_LABEL[agent]) || t("agentDefault");
}

function fmtDayLabel(day: string, t: TFunction): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  const today = dayKey(Date.now());
  if (day === today) return t("today");
  const weekday = "日一二三四五六"[new Date(y, m - 1, d).getDay()];
  return t("dayLabel", { month: m, day: d, weekday });
}

function statChips(stats: DayGroup["stats"], t: TFunction): string[] {
  const chips: string[] = [];
  if (stats.runs) chips.push(t("stats.runs", { count: stats.runs }));
  if (stats.sessions) chips.push(t("stats.sessions", { count: stats.sessions }));
  if (stats.files) chips.push(t("stats.files", { count: stats.files }));
  if (stats.commits) chips.push(t("stats.commits", { count: stats.commits }));
  if (stats.notes) chips.push(t("stats.notes", { count: stats.notes }));
  return chips.length ? chips : [t("stats.noActivity")];
}

// 闪记状态 → 卡片徽标文案键（草稿不显示徽标,只深化中/已深化露出）。
const NOTE_STATUS_KEY: Partial<Record<NoteStatus, string>> = {
  deepening: "noteStatus.deepening",
  deepened: "noteStatus.deepened",
};

// ── 事件卡片 ──────────────────────────────────────────────────────────────

// summary.day 事件的标题在「渲染期」派生（落盘 title 仍是中文字面量,见 timeline.ts 的
// useGenerateDaySummary/useGenerateGlobalSummary 持久化路径,绝不在写入时翻译——否则语言被
// 冻结进磁盘）。全局日报由 projectId === GLOBAL_TIMELINE_ID 区分,其余 summary.day 为单项目 AI 日报。
function displayEventTitle(event: TimelineEvent, t: TFunction): string {
  if (event.kind === "summary.day") {
    return event.projectId === GLOBAL_TIMELINE_ID ? t("globalReport") : t("dailyReport");
  }
  return event.title;
}

function EventCard({ event, onJump }: { event: TimelineEvent; onJump?: () => void }) {
  const { t } = useTranslation("timeline");
  const [expanded, setExpanded] = useState(false);
  const requestNoteDetail = usePersonalStore((s) => s.requestNoteDetail);
  const files = event.files ?? [];

  if (event.kind === "session.created") {
    return (
      <div className="pw-tl-event is-minor">
        <span className="pw-tl-time">{hhmm(event.ts)}</span>
        <Icon.Plus size={12} />
        <span>
          {t("card.newSession")} <button className="pw-tl-link" onClick={onJump}>{event.title}</button>
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

  // 闪记事件卡片（整卡可点 → 跳收件箱详情）。务必在 run 默认分支之前,否则掉进 run 富卡片错渲。
  if (event.kind === "note") {
    const noteId = event.meta?.noteId;
    const badgeKey = event.meta?.noteStatus ? NOTE_STATUS_KEY[event.meta.noteStatus] : undefined;
    const badge = badgeKey ? t(badgeKey) : undefined;
    return (
      <button
        type="button"
        className="pw-tl-note"
        onClick={() => noteId && requestNoteDetail({ noteId })}
        title={t("noteCardTitle")}
      >
        <span className="pw-tl-time">{hhmm(event.ts)}</span>
        <Icon.Pin size={12} />
        <span className="pw-tl-note-title">{event.title}</span>
        {badge ? <span className="pw-tl-note-badge">{badge}</span> : null}
      </button>
    );
  }

  // run 事件卡片。
  return (
    <div className="pw-tl-card" data-ok={event.meta?.ok !== false}>
      <div className="pw-tl-card-h">
        <span className="pw-tl-time">{event.meta?.backfilled ? t("card.history") : hhmm(event.ts)}</span>
        <span className="pw-tl-agent">{tlAgentLabel(event.meta?.agent, t)}</span>
        {event.meta?.ok === false ? <span className="pw-tl-fail">{t("card.fail")}</span> : null}
        {onJump ? (
          <button className="pw-icon-btn" title={t("card.openSession")} onClick={onJump}>
            <Icon.Reply size={12} />
          </button>
        ) : null}
      </div>
      <div className="pw-tl-card-title">{displayEventTitle(event, t)}</div>
      {event.summary ? <div className="pw-tl-card-summary">{event.summary}</div> : null}
      {files.length > 0 ? (
        <div className="pw-tl-files">
          <button className="pw-tl-files-toggle" onClick={() => setExpanded((v) => !v)} data-open={expanded}>
            <Icon.Chevron size={10} />
            {t("card.filesChanged", { count: files.length })}
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
  const { t } = useTranslation("timeline");
  const setActiveSession = usePersonalStore((s) => s.setActiveSession);
  const sessions = usePersonalStore((s) => s.sessions);
  const { generate, generatingDay } = useGenerateDaySummary(project);
  const { push, pushing, channelCount } = usePushDailyReport(project);

  const copyReport = async (g: DayGroup) => {
    const { text } = buildDailyReportText(project.name, g);
    try {
      await navigator.clipboard.writeText(text);
      onToast(t("list.reportCopied"));
    } catch {
      onToast(t("list.copyFailed"));
    }
  };

  const pushReport = (g: DayGroup) => {
    void push(g).then((results) => results.forEach((r) => onToast(r)));
  };

  const jump = (sessionId: string | undefined) => {
    if (!sessionId) return;
    if (!sessions.some((x) => x.id === sessionId)) {
      onToast(t("list.sessionDeleted"));
      return;
    }
    setActiveSession(sessionId);
  };

  if (groups.length === 0) {
    return (
      <div className="pw-center">
        <Icon.Clock size={26} />
        <div className="pw-center-title">{t("list.empty")}</div>
        <div className="pw-center-hint">{t("list.emptyHint")}</div>
      </div>
    );
  }

  return (
    <div className="pw-tl-list">
      {groups.map((g) => (
        <section key={g.day} id={`tl-day-${g.day}`} className="pw-tl-day">
          <header className="pw-tl-day-h">
            <span className="pw-tl-day-label">{fmtDayLabel(g.day, t)}</span>
            <span className="pw-tl-day-date">{g.day}</span>
            {statChips(g.stats, t).map((c) => (
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
                  () => onToast(t("list.reportGenerated", { day: g.day })),
                  () => onToast(t("list.reportGenerateFailed")),
                );
              }}
              title={t("list.genTitle")}
            >
              <Icon.Sparkle size={12} />
              {generatingDay === g.day ? t("list.generating") : g.summary ? t("list.regenerate") : t("list.generate")}
            </button>
            <button className="pw-tl-gen" onClick={() => void copyReport(g)} title={t("list.copyTitle")}>
              <Icon.File size={12} />
              {t("list.copy")}
            </button>
            <button
              className="pw-tl-gen"
              disabled={pushing}
              onClick={() => pushReport(g)}
              title={
                channelCount > 0
                  ? t("list.pushTitleEnabled", { count: channelCount })
                  : t("list.pushTitleDisabled")
              }
            >
              <Icon.Send size={12} />
              {pushing ? t("list.pushing") : t("list.push")}
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
  const { t } = useTranslation("timeline");
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
          {t("calendar.monthLabel", { year: ym.y, month: ym.m + 1 })}
        </span>
        <span className="pw-tl-cal-month-sum">
          {monthTotal.days > 0
            ? t("calendar.monthSummary", { days: monthTotal.days, runs: monthTotal.runs }) +
              (monthTotal.files ? t("calendar.monthSummaryFiles", { count: monthTotal.files }) : "") +
              (monthTotal.commits ? t("calendar.monthSummaryCommits", { count: monthTotal.commits }) : "")
            : t("calendar.noActivity")}
        </span>
        <span className="pw-tl-day-sp" />
        <button className="pw-icon-btn" onClick={() => shift(-1)} title={t("calendar.prevMonth")}>
          <Icon.Back size={13} />
        </button>
        <button
          className="pw-tl-today"
          onClick={() => setYm({ y: now.getFullYear(), m: now.getMonth() })}
        >
          {t("calendar.today")}
        </button>
        <button className="pw-icon-btn" onClick={() => shift(1)} title={t("calendar.nextMonth")}>
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
              title={active ? `${cell.day} · ${statChips(cell.stats!, t).join(" · ")}` : undefined}
            >
              <span className="pw-tl-cal-date">{cell.date}</span>
              {active ? (
                <>
                  <span className="pw-tl-cal-badge">
                    {cell.stats!.runs > 0 ? t("calendar.cellRuns", { count: cell.stats!.runs }) : t("calendar.cellCommits", { count: cell.stats!.commits })}
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
          {t("calendar.legendLess")}
          {[1, 2, 3, 4].map((h) => (
            <i key={h} data-heat={h} />
          ))}
          {t("calendar.legendMore")}
        </span>
        <span className="pw-tl-cal-legend-item"><i className="is-files" /> {t("calendar.legendFiles")}</span>
        <span className="pw-tl-cal-legend-item"><i className="is-commits" /> {t("calendar.legendCommits")}</span>
        <span className="pw-tl-cal-legend-item"><i className="is-sessions" /> {t("calendar.legendSessions")}</span>
        <span className="pw-tl-day-sp" />
        <span>{t("calendar.legendHint")}</span>
      </div>
    </div>
  );
}

// ── 容器 ──────────────────────────────────────────────────────────────────

export function TimelineView({ project, onToast }: { project: ProjectMeta; onToast: (text: string) => void }) {
  const { t } = useTranslation("timeline");
  const [view, setView] = useState<"timeline" | "calendar">("timeline");
  const [onlyNotes, setOnlyNotes] = useState(false);
  const closeTimeline = usePersonalStore((s) => s.closeTimeline);
  const { events, loading } = useProjectTimeline(project);
  // 日历/热力图永远用全量 groups（口径不变）;「只看闪记」只过滤时间线子视图的事件流。
  const groups = useMemo(() => groupEventsByDay(events), [events]);
  const timelineGroups = useMemo(
    () => (onlyNotes ? groupEventsByDay(events.filter((ev) => ev.kind === "note")) : groups),
    [onlyNotes, events, groups],
  );

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
        <span className="pw-tl-h-sub">{t("header.subtitle")}</span>
        <div className="pw-tl-switch" role="tablist">
          <button role="tab" aria-selected={view === "timeline"} data-active={view === "timeline"} onClick={() => setView("timeline")}>
            {t("header.timeline")}
          </button>
          <button role="tab" aria-selected={view === "calendar"} data-active={view === "calendar"} onClick={() => setView("calendar")}>
            {t("header.calendar")}
          </button>
        </div>
        {view === "timeline" ? (
          <button
            className="pw-tl-only-notes"
            data-active={onlyNotes}
            onClick={() => setOnlyNotes((v) => !v)}
            title={onlyNotes ? t("header.showAll") : t("header.onlyNotes")}
          >
            <Icon.Pin size={12} />
            {t("header.onlyNotes")}
          </button>
        ) : null}
        <button className="pw-icon-btn" title={t("header.back")} onClick={closeTimeline}>
          <Icon.XCircle size={15} />
        </button>
      </header>
      <div className="pw-tl-body">
        {loading ? (
          <div className="pw-center">
            <div className="pw-center-hint">{t("loadingTimeline")}</div>
          </div>
        ) : view === "timeline" ? (
          <TimelineList project={project} groups={timelineGroups} onToast={onToast} />
        ) : (
          <CalendarGrid groups={groups} onPickDay={pickDay} />
        )}
      </div>
    </main>
  );
}
