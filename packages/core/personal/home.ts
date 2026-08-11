// 个人工作区首页数据层：系统 Agent 项目扫描、工作区项目合并与跨项目任务列表。

import { useQueries, useQuery } from "@tanstack/react-query";
import type {
  AgentKind,
  AgentProjectInfo,
  ProjectMeta,
  SessionMeta,
  TaskFileInfo,
  TaskFilesResult,
} from "../desktop/types";
import { useDesktopBridge } from "../provider";
import { partitionProjects, usePersonalStore } from "../store/personal";
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

// ── 新会话落地页:最近活跃项目 + 跨项目 Tasks ──────────────────────────────

// 取 updatedAt 最大的会话的 projectId（新会话 ProjectPicker 默认选中）。
// 无会话 / 最近会话为无项目会话 → undefined。
export function latestActiveProjectId(sessions: SessionMeta[]): string | undefined {
  let latest: SessionMeta | undefined;
  for (const s of sessions) {
    if (!latest || s.updatedAt > latest.updatedAt) latest = s;
  }
  return latest?.projectId;
}

// 跨项目 Tasks 行：一个 md 文件 + 其所属项目（首页 Tasks·所有项目）。
export interface HomeTaskRow {
  file: TaskFileInfo;
  projectId: string;
  projectName: string;
}

// 列出所有可见项目的 tasks/ md 文件,按 mtime 全局降序取前 limit（仅 files,不含 archived）。
// 各项目并行拉取并使用独立缓存。
export function useAllProjectsTasks(limit = 10): { rows: HomeTaskRow[]; loading: boolean } {
  const bridge = useDesktopBridge();
  const projects = usePersonalStore((s) => s.projects);
  const visible = partitionProjects(projects).visible;

  const results = useQueries({
    queries: visible.map((p) => ({
      queryKey: ["personal", "tasks", p.id],
      enabled: !!bridge?.listTaskFiles,
      staleTime: 30_000,
      queryFn: () =>
        bridge?.listTaskFiles
          ? bridge.listTaskFiles(p.path).catch(() => ({ files: [], archived: [] }) as TaskFilesResult)
          : Promise.resolve({ files: [], archived: [] } as TaskFilesResult),
    })),
  });

  const rows: HomeTaskRow[] = [];
  visible.forEach((p, i) => {
    for (const file of results[i]?.data?.files ?? []) {
      rows.push({ file, projectId: p.id, projectName: p.name });
    }
  });
  rows.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs);
  return { rows: rows.slice(0, limit), loading: results.some((r) => r.isLoading) };
}
