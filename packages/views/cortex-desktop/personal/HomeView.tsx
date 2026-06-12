// 个人工作区首页：跨项目活动热力图（GitHub 风格周列）+ 项目快速检索 +
// 全局一日总结。数据来自所有项目的 timeline 聚合（useAllProjectsTimeline）。

import { useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  buildHeatmapWeeks,
  dayKey,
  groupEventsByDay,
  homeHeatLevel,
  mergeProjectRows,
  useAgentProjects,
  useAllProjectsTimeline,
  useGenerateGlobalSummary,
  useGlobalSummaries,
  useCortexUIStore,
  usePersonalStore,
} from "@cortex-work/core";
import type { DayGroup, DayStats, GlobalSummaryEntry, HomeProjectRow, TodoMeta, WorkspaceProjectRow } from "@cortex-work/core";
import { relTime } from "./PersonalSidebar";

const HEAT_WEEKS = 26;
const WEEKDAY_ROWS = ["一", "三", "五", "日"]; // 仅标注部分行,GitHub 风格

function statsTitle(day: string, stats?: DayStats): string {
  if (!stats) return `${day} · 无活动`;
  const parts: string[] = [];
  if (stats.runs) parts.push(`${stats.runs} 轮交互`);
  if (stats.sessions) parts.push(`${stats.sessions} 个新会话`);
  if (stats.files) parts.push(`${stats.files} 个文件变更`);
  return parts.length ? `${day} · ${parts.join(" · ")}` : `${day} · 无活动`;
}

// ── 热力图 ────────────────────────────────────────────────────────────────

function Heatmap({
  groups,
  selectedDay,
  onPickDay,
}: {
  groups: DayGroup[];
  selectedDay: string;
  onPickDay: (day: string) => void;
}) {
  const weeks = useMemo(() => buildHeatmapWeeks(HEAT_WEEKS, groups), [groups]);
  const today = dayKey(Date.now());

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
                    data-heat={homeHeatLevel(c.stats)}
                    data-today={c.day === today}
                    data-selected={c.day === selectedDay}
                    disabled={c.inFuture}
                    onClick={() => onPickDay(c.day)}
                    title={c.inFuture ? undefined : statsTitle(c.day, c.stats)}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="pw-hm-legend">
        <span className="pw-tl-cal-legend-heat">
          少
          {[1, 2, 3, 4].map((h) => (
            <i key={h} data-heat={h} />
          ))}
          多
        </span>
        <span className="pw-tl-day-sp" />
        <span>近 {HEAT_WEEKS} 周所有项目的活动 · 点击日期查看当天总结</span>
      </div>
    </div>
  );
}

// ── Agent 项目（工作区 ∪ 系统扫描） ──────────────────────────────────────

function ProjectSearch({ onToast }: { onToast: (text: string) => void }) {
  const projects = usePersonalStore((s) => s.projects);
  const sessions = usePersonalStore((s) => s.sessions);
  const setActiveSession = usePersonalStore((s) => s.setActiveSession);
  const openTimeline = usePersonalStore((s) => s.openTimeline);
  const addProject = usePersonalStore((s) => s.addProject);
  const { projects: scanned } = useAgentProjects();
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const workspace: WorkspaceProjectRow[] = projects.map((project) => {
      const list = sessions.filter((x) => x.projectId === project.id);
      const latest = list.reduce<(typeof list)[number] | undefined>(
        (best, x) => (!best || x.updatedAt > best.updatedAt ? x : best),
        undefined,
      );
      return {
        project,
        sessionCount: list.length,
        latest,
        lastActive: latest?.updatedAt ?? project.addedAt,
        agents: [...new Set(list.map((x) => x.agent))],
      };
    });
    const merged = mergeProjectRows(workspace, scanned);
    const q = query.trim().toLowerCase();
    return q ? merged.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : merged;
  }, [projects, sessions, scanned, query]);

  const open = (row: HomeProjectRow) => {
    if (!row.inWorkspace) {
      // 系统扫描发现但未加入工作区的项目,点击即添加。
      const proj = addProject(row.path);
      onToast(`已添加项目 ${proj.name} 到工作区`);
      return;
    }
    if (row.latest) {
      setActiveSession(row.latest.id);
    } else if (row.project) {
      openTimeline(row.project.id);
      onToast(`${row.name} 还没有 Session,已打开项目时间线`);
    }
  };

  return (
    <div className="pw-home-projects">
      <div className="sb-row sb-search pw-home-search">
        <Icon.Search size={13} />
        <input
          className="sb-search-input"
          placeholder="检索项目（名称 / 路径）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query ? (
          <button className="sb-clear" onClick={() => setQuery("")} title="清除">
            ×
          </button>
        ) : null}
      </div>
      <div className="pw-home-proj-list">
        {rows.map((row) => (
          <button
            key={row.path}
            className="pw-home-proj-row"
            onClick={() => open(row)}
            title={row.inWorkspace ? row.path : `${row.path}\n点击添加到工作区`}
          >
            <Icon.Folder size={14} />
            <span className="pw-home-proj-name">{row.name}</span>
            <span className="pw-home-proj-path">{row.path}</span>
            {!row.inWorkspace ? <span className="pw-home-proj-badge">未添加</span> : null}
            <span className="pw-agent-dots" aria-hidden="true">
              {row.agents.map((a) => (
                <i key={a} className="pw-agent-dot" data-agent={a} title={a} />
              ))}
            </span>
            <span className="pw-home-proj-meta">
              {row.inWorkspace ? `${row.sessionCount} 个 Session · ` : ""}
              {relTime(row.lastActive)}
            </span>
          </button>
        ))}
        {rows.length === 0 ? (
          <div className="pw-empty-hint">
            {query ? `没有匹配「${query}」的项目` : "还没有发现 agent 项目,在左侧添加一个文件夹开始"}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── 全局 Todo 汇总 ───────────────────────────────────────────────────────

function HomeTodos() {
  const projects = usePersonalStore((s) => s.projects);
  const todos = usePersonalStore((s) => s.todos);
  const setRightView = usePersonalStore((s) => s.setRightView);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);

  const openTodos = () => {
    setRightView("todos");
    setRightOpen(true);
  };

  const rows = useMemo(
    () =>
      projects
        .map((project) => {
          const list = todos
            .filter((todo) => todo.projectId === project.id)
            .sort((a, b) => {
              if (a.status !== b.status) return a.status === "open" ? -1 : 1;
              return b.updatedAt - a.updatedAt;
            });
          const open = list.filter((todo) => todo.status === "open");
          return { project, list, open, latest: list[0] as TodoMeta | undefined };
        })
        .filter((row) => row.list.length > 0)
        .sort((a, b) => (b.latest?.updatedAt ?? 0) - (a.latest?.updatedAt ?? 0)),
    [projects, todos],
  );

  if (rows.length === 0) {
    return (
      <div className="pw-home-todos-empty">
        <span>还没有 Task</span>
        <button className="pw-tl-gen" onClick={openTodos}>
          <Icon.Task size={12} />
          打开 Tasks
        </button>
      </div>
    );
  }

  return (
    <div className="pw-home-todos">
      {rows.map(({ project, open, latest }) => (
        <button key={project.id} className="pw-home-todo-row" onClick={openTodos} title={project.path}>
          <Icon.Task size={14} />
          <span className="pw-home-todo-project">{project.name}</span>
          <span className="pw-home-todo-title">{latest?.title ?? "无标题"}</span>
          <span className="pw-home-proj-meta">
            {open.length} open · {latest ? relTime(latest.updatedAt) : ""}
          </span>
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

// ── 首页容器 ──────────────────────────────────────────────────────────────

export function HomeView({ onToast }: { onToast: (text: string) => void }) {
  const projects = usePersonalStore((s) => s.projects);
  const { eventsByProject, allEvents, loading } = useAllProjectsTimeline(projects);
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

  // 注:工作区为空时不再整页空态——「Agent 项目」区块会列出系统扫描发现的
  // 项目供一键添加,热力图/总结区块自然为空。

  return (
    <main className="chat">
      <div className="pw-home">
        <section className="pw-home-section">
          <div className="pw-section-h">
            <span>活动热力图</span>
            {loading ? <span className="pw-home-loading">加载中…</span> : null}
          </div>
          <Heatmap groups={groups} selectedDay={selectedDay} onPickDay={setSelectedDay} />
        </section>

        <section className="pw-home-section">
          <div className="pw-section-h">
            <span>一日总结 · 所有项目</span>
          </div>
          <GlobalSummary day={selectedDay} entries={entries} onToast={onToast} />
        </section>

        <section className="pw-home-section">
          <div className="pw-section-h">
            <span>Tasks · 所有项目</span>
          </div>
          <HomeTodos />
        </section>

        <section className="pw-home-section">
          <div className="pw-section-h">
            <span>Agent 项目</span>
          </div>
          <ProjectSearch onToast={onToast} />
        </section>
      </div>
    </main>
  );
}
