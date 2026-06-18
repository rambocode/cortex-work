// 个人工作区首页看板：落地页 Hero + 用量日历卡片（活动/token）+ 全局一日总结。
// 数据来自侧边栏可见项目的 timeline 聚合（useAllProjectsTimeline）。
// HomeBoard 供 NewSessionLanding 复用,HomeView 为兼容现有 import 的薄包装。

import { useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  dayKey,
  groupEventsByDay,
  partitionProjects,
  useAllProjectsTimeline,
  useGenerateGlobalSummary,
  useGlobalSummaries,
  usePersonalStore,
} from "@cortex-work/core";
import type { GlobalSummaryEntry } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { LandingHero } from "./LandingHero";
import { UsageCalendarCard } from "./UsageCalendarCard";

// ── 全局一日总结 ──────────────────────────────────────────────────────────

function GlobalSummary({
  day,
  entries,
  onToast,
}: {
  day: string;
  entries: GlobalSummaryEntry[];
  onToast: (text: string) => void;
}) {
  const { t } = useTranslation("timeline");
  const summaries = useGlobalSummaries();
  const { generate, generatingDay } = useGenerateGlobalSummary();
  const summary = summaries[day]?.summary;

  const totals = entries.reduce(
    (acc, { group }) => ({
      runs: acc.runs + group.stats.runs,
      sessions: acc.sessions + group.stats.sessions,
      files: acc.files + group.stats.files,
    }),
    { runs: 0, sessions: 0, files: 0 },
  );
  const statChips = [
    entries.length ? t("home.projects", { count: entries.length }) : "",
    totals.runs ? t("stats.runs", { count: totals.runs }) : "",
    totals.sessions ? t("stats.sessions", { count: totals.sessions }) : "",
    totals.files ? t("stats.files", { count: totals.files }) : "",
  ].filter(Boolean);

  const copy = async () => {
    if (!summary) return;
    await navigator.clipboard.writeText(`${t("home.dailyReportTitle", { day })}\n\n${summary}`);
    onToast(t("home.reportCopied"));
  };

  return (
    <div className="pw-home-summary">
      <header className="pw-home-summary-h">
        <span className="pw-home-summary-day">{day}</span>
        {statChips.map((c) => (
          <span key={c} className="pw-tl-chip">
            {c}
          </span>
        ))}
        <span className="pw-tl-day-sp" />
        <button
          className="pw-tl-gen"
          disabled={generatingDay !== null || entries.length === 0}
          onClick={() => {
            void generate(day, entries).then(
              () => onToast(t("home.reportGenerated", { day })),
              () => onToast(t("home.reportGenerateFailed")),
            );
          }}
          title={entries.length === 0 ? t("home.genTitleEmpty") : t("home.genTitle")}
        >
          <Icon.Sparkle size={12} />
          {generatingDay === day ? t("home.generating") : summary ? t("home.regenerate") : t("home.generate")}
        </button>
        <button className="pw-tl-gen" disabled={!summary} onClick={() => void copy()} title={t("home.copyTitle")}>
          <Icon.File size={12} />
          {t("home.copy")}
        </button>
      </header>
      {summary ? (
        <div className="pw-tl-daily">{summary}</div>
      ) : (
        <div className="pw-empty-hint">
          {entries.length === 0 ? t("home.noActivity") : t("home.generateHint")}
        </div>
      )}
      {entries.length > 0 ? (
        <div className="pw-home-summary-projects">
          {entries.map(({ projectName, group }) => (
            <span key={projectName} className="pw-tl-chip" title={t("home.projectChipTitle", { count: group.stats.runs })}>
              {projectName}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── 首页看板（供 NewSessionLanding 复用） ─────────────────────────────────

export function HomeBoard({ onToast }: { onToast: (text: string) => void }) {
  const { t } = useTranslation("timeline");
  const projects = usePersonalStore((s) => s.projects);
  // 热力图/总结统计侧边栏可见项目（与新版侧边栏一致,排除归档项目）。
  const visible = useMemo(() => partitionProjects(projects).visible, [projects]);
  const { eventsByProject, allEvents, loading } = useAllProjectsTimeline(visible);
  const [selectedDay, setSelectedDay] = useState(() => dayKey(Date.now()));

  const groups = useMemo(() => groupEventsByDay(allEvents), [allEvents]);
  // 选中天的跨项目条目（仅含当天有事件的项目）。
  const entries = useMemo<GlobalSummaryEntry[]>(
    () =>
      eventsByProject
        .map(({ project, events }) => ({
          projectName: project.name,
          group: groupEventsByDay(events).find((g) => g.day === selectedDay),
        }))
        .filter((x): x is GlobalSummaryEntry => !!x.group && x.group.events.length > 0),
    [eventsByProject, selectedDay],
  );

  return (
    <div className="pw-home">
      <LandingHero />

      <UsageCalendarCard groups={groups} selectedDay={selectedDay} onPickDay={setSelectedDay} />

      <section className="pw-home-section">
        <div className="pw-section-h">
          <span>{t("home.sectionTitle")}</span>
          {loading ? <span className="pw-home-loading">{t("home.loading")}</span> : null}
        </div>
        <GlobalSummary day={selectedDay} entries={entries} onToast={onToast} />
      </section>
    </div>
  );
}

// ── 首页容器（兼容 PersonalWorkspace 现有 import） ─────────────────────────

export function HomeView({ onToast }: { onToast: (text: string) => void }) {
  return (
    <main className="chat">
      <HomeBoard onToast={onToast} />
    </main>
  );
}
