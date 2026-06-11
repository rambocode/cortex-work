// 个人工作区首页数据层：跨项目 timeline 聚合 + GitHub 风格热力图纯函数。
// 聚合 hook 与单项目 useProjectTimeline 共用 queryKey/queryFn（loadTimelineData），
// react-query 据此去重,保证历史回填只发生一次、缓存一致。

import { useQueries, useQuery } from "@tanstack/react-query";
import type {
  AgentKind,
  AgentProjectInfo,
  ProjectMeta,
  SessionMeta,
  TimelineEvent,
  TimelineFileData,
} from "../desktop/types";
import { useDesktopBridge } from "../provider";
import { usePersonalStore } from "../store/personal";
import {
  dayKey,
  loadTimelineData,
  sessionCreatedEvents,
  timelineKeys,
  type DayGroup,
  type DayStats,
} from "./timeline";

// ── 跨项目聚合 ────────────────────────────────────────────────────────────

export interface ProjectEvents {
  project: ProjectMeta;
  events: TimelineEvent[]; // 落盘事件 + 合成 session.created
}

// 读取所有项目的时间线并合并（不拉 gitLog：N 个项目并行 git log 拖慢首屏,
// 热力图档位用 runs + sessions 代替 runs + commits）。
export function useAllProjectsTimeline(projects: ProjectMeta[]): {
  eventsByProject: ProjectEvents[];
  allEvents: TimelineEvent[];
  loading: boolean;
} {
  const bridge = useDesktopBridge();
  const sessions = usePersonalStore((s) => s.sessions);

  const results = useQueries({
    queries: projects.map((p) => ({
      queryKey: timelineKeys.detail(p.id),
      enabled: !!bridge,
      staleTime: Infinity,
      gcTime: Infinity,
      queryFn: () => (bridge ? loadTimelineData(bridge, p.id) : Promise.resolve({ version: 1, events: [] } as TimelineFileData)),
    })),
  });

  const eventsByProject: ProjectEvents[] = projects.map((project, i) => ({
    project,
    events: [...(results[i]?.data?.events ?? []), ...sessionCreatedEvents(sessions, project.id)],
  }));
  return {
    eventsByProject,
    allEvents: eventsByProject.flatMap((x) => x.events),
    loading: results.some((r) => r.isLoading),
  };
}

// ── 热力图纯函数 ──────────────────────────────────────────────────────────

export interface HeatCell {
  day: string; // YYYY-MM-DD
  date: number; // 几号
  inFuture: boolean; // 晚于今天（无活动,渲染为占位）
  stats?: DayStats;
}

export interface HeatWeek {
  cells: HeatCell[]; // 7 格,周一起始
  monthLabel?: string; // 该周含某月 1 号时标注（如 "6月"）
}

// 近 N 周的周列方格（GitHub 风格）：周一起始,今天所在周为最后一列。
export function buildHeatmapWeeks(weeks: number, groups: DayGroup[], today: number = Date.now()): HeatWeek[] {
  const statsByDay = new Map(groups.map((g) => [g.day, g.stats]));
  const todayDay = dayKey(today);
  const t = new Date(today);
  // 本周一,再往前推 weeks-1 周。
  const start = new Date(t.getFullYear(), t.getMonth(), t.getDate() - ((t.getDay() + 6) % 7) - (weeks - 1) * 7);
  const out: HeatWeek[] = [];
  const cursor = new Date(start);
  for (let w = 0; w < weeks; w += 1) {
    const cells: HeatCell[] = [];
    let monthLabel: string | undefined;
    for (let i = 0; i < 7; i += 1) {
      const day = dayKey(cursor.getTime());
      if (cursor.getDate() === 1) monthLabel = `${cursor.getMonth() + 1}月`;
      cells.push({
        day,
        date: cursor.getDate(),
        inFuture: day > todayDay,
        stats: statsByDay.get(day),
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    out.push(monthLabel ? { cells, monthLabel } : { cells });
  }
  return out;
}

// 热力档位：与项目时间线日历同阈值,但 score 用 runs + sessions（首页不聚合 git log）。
export function homeHeatLevel(stats: DayStats | undefined): number {
  if (!stats) return 0;
  const score = stats.runs + stats.sessions;
  if (score <= 0) return 0;
  if (score <= 2) return 1;
  if (score <= 5) return 2;
  if (score <= 10) return 3;
  return 4;
}

// ── 系统 agent 项目（扫描 + 与工作区合并） ────────────────────────────────

// 扫描本机 agent 会话日志发现的项目（主进程另有 60s 结果缓存）。
export function useAgentProjects(): { projects: AgentProjectInfo[]; loading: boolean } {
  const bridge = useDesktopBridge();
  const { data, isLoading } = useQuery<AgentProjectInfo[]>({
    queryKey: ["personal", "agent-projects"],
    enabled: !!bridge,
    staleTime: 60_000,
    queryFn: () => (bridge ? bridge.scanAgentProjects() : Promise.resolve([])),
  });
  return { projects: data ?? [], loading: isLoading };
}

// 首页项目列表的工作区侧输入（由 HomeView 从 store 推导）。
export interface WorkspaceProjectRow {
  project: ProjectMeta;
  sessionCount: number;
  latest?: SessionMeta; // 最近活跃 session（点击跳转用）
  lastActive: number;
  agents: AgentKind[]; // 工作区 sessions 用过的 agent
}

// 合并后的首页项目行：工作区项目 ∪ 系统扫描项目。
export interface HomeProjectRow {
  path: string;
  name: string;
  agents: AgentKind[];
  lastActive: number;
  inWorkspace: boolean;
  project?: ProjectMeta;
  latest?: SessionMeta;
  sessionCount: number;
}

const normPath = (p: string): string => p.replace(/[/\\]+$/, "") || p;

// 按 path 合并（忽略尾部斜杠）：工作区行补上扫描发现的 agents/lastActive,
// 纯扫描行标记 inWorkspace=false;统一按 lastActive 倒序。
export function mergeProjectRows(workspace: WorkspaceProjectRow[], scanned: AgentProjectInfo[]): HomeProjectRow[] {
  const rows = new Map<string, HomeProjectRow>();
  for (const w of workspace) {
    rows.set(normPath(w.project.path), {
      path: w.project.path,
      name: w.project.name,
      agents: [...w.agents],
      lastActive: w.lastActive,
      inWorkspace: true,
      project: w.project,
      latest: w.latest,
      sessionCount: w.sessionCount,
    });
  }
  for (const s of scanned) {
    const key = normPath(s.path);
    const existing = rows.get(key);
    if (existing) {
      existing.lastActive = Math.max(existing.lastActive, s.lastActive);
      existing.agents = [...new Set([...existing.agents, ...s.agents])];
    } else {
      rows.set(key, {
        path: s.path,
        name: s.name,
        agents: [...s.agents],
        lastActive: s.lastActive,
        inWorkspace: false,
        sessionCount: 0,
      });
    }
  }
  return [...rows.values()].sort((a, b) => b.lastActive - a.lastActive);
}
