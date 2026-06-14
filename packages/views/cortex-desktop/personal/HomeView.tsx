// 个人工作区首页看板：跨项目活动热力图（GitHub 风格周列）+ 全局一日总结 +
// 跨项目 Tasks。数据来自侧边栏可见项目的 timeline 聚合（useAllProjectsTimeline）
// 与 tasks/ 文件聚合（useAllProjectsTasks）。
// HomeBoard 供 NewSessionLanding 复用,HomeView 为兼容现有 import 的薄包装。

import { useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  dayKey,
  groupEventsByDay,
  partitionProjects,
  useAllProjectsTasks,
  useAllProjectsTimeline,
  useGenerateGlobalSummary,
  useGlobalSummaries,
  useCortexUIStore,
  usePersonalStore,
} from "@cortex-work/core";
import type { GlobalSummaryEntry, HomeTaskRow } from "@cortex-work/core";
import { relTime } from "./PersonalSidebar";
import { LandingHero } from "./LandingHero";
import { UsageCalendarCard } from "./UsageCalendarCard";

const HOME_TODOS_LIMIT = 5; // 首页 Tasks 区最多展示的条数(按 mtime 全局降序取前 N)

// ── 跨项目 Tasks 汇总 ─────────────────────────────────────────────────────

function HomeTodos() {
  const requestTaskDetail = usePersonalStore((s) => s.requestTaskDetail);
  const setRightView = usePersonalStore((s) => s.setRightView);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);
  const { rows, loading } = useAllProjectsTasks();

  const openTodos = () => {
    setRightView("todos");
    setRightOpen(true);
  };

  // 点 task:右栏直接打开该文件详情（不切走首页,只在右栏展示 markdown）。
  const openTaskDetail = (row: HomeTaskRow) => {
    requestTaskDetail({ projectId: row.projectId, path: row.file.path, name: row.file.name });
    setRightOpen(true);
  };

  if (rows.length === 0) {
    return (
      <div className="pw-home-todos-empty">
        <span>{loading ? "加载中…" : "还没有 Task"}</span>
        <button className="pw-tl-gen" onClick={openTodos}>
          <Icon.Task size={12} />
          打开 Tasks
        </button>
      </div>
    );
  }

  return (
    <div className="pw-home-todos">
      {rows.slice(0, HOME_TODOS_LIMIT).map((row) => (
        <button
          key={row.file.path}
          className="pw-home-todo-row"
          onClick={() => openTaskDetail(row)}
          title={row.file.path}
        >
          <Icon.Task size={14} />
          <span className="pw-home-todo-title">{row.file.name.replace(/\.md$/i, "")}</span>
          <span className="pw-home-todo-project">{row.projectName}</span>
          <span className="pw-home-proj-meta">{relTime(row.file.mtimeMs)}</span>
        </button>
      ))}
    </div>
  );
}

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
    entries.length ? `${entries.length} 个项目` : "",
    totals.runs ? `${totals.runs} 轮交互` : "",
    totals.sessions ? `${totals.sessions} 个新会话` : "",
    totals.files ? `${totals.files} 个文件变更` : "",
  ].filter(Boolean);

  const copy = async () => {
    if (!summary) return;
    await navigator.clipboard.writeText(`${day} 工作日报\n\n${summary}`);
    onToast("已复制全局日报");
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
              () => onToast(`${day} 全局日报已生成`),
              () => onToast("日报生成失败,请检查 设置 → 时间线 的模型配置"),
            );
          }}
          title={entries.length === 0 ? "当天没有任何项目活动" : "用 AI 汇总当天所有项目的工作（模型可在设置中配置）"}
        >
          <Icon.Sparkle size={12} />
          {generatingDay === day ? "生成中…" : summary ? "重新生成" : "生成总结"}
        </button>
        <button className="pw-tl-gen" disabled={!summary} onClick={() => void copy()} title="复制日报文本">
          <Icon.File size={12} />
          复制
        </button>
      </header>
      {summary ? (
        <div className="pw-tl-daily">{summary}</div>
      ) : (
        <div className="pw-empty-hint">
          {entries.length === 0 ? "这一天没有项目活动" : "点「生成总结」,AI 将汇总当天所有项目的工作"}
        </div>
      )}
      {entries.length > 0 ? (
        <div className="pw-home-summary-projects">
          {entries.map(({ projectName, group }) => (
            <span key={projectName} className="pw-tl-chip" title={`${group.stats.runs} 轮交互`}>
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
          <span>一日总结 · 所有项目</span>
          {loading ? <span className="pw-home-loading">加载中…</span> : null}
        </div>
        <GlobalSummary day={selectedDay} entries={entries} onToast={onToast} />
      </section>

      <section className="pw-home-section">
        <div className="pw-section-h">
          <span>Tasks · 所有项目</span>
        </div>
        <HomeTodos />
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
