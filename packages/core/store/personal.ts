// 个人工作区客户端状态（Zustand，仅 core）。项目/session 元数据为内存态，
// 经 usePersonalPersistence 与主进程 JSON 双向同步；消息流不在这里 —— 它走
// React Query cache（personal/messages.ts）。

import { create } from "zustand";
import type {
  AgentKind,
  PersistedState,
  ProjectMeta,
  PromptNode,
  PushSettings,
  SessionMeta,
  TimelineSettings,
} from "../desktop/types";
import {
  DEFAULT_MODEL,
  DEFAULT_PUSH_SETTINGS,
  DEFAULT_TIMELINE_SETTINGS,
} from "../desktop/types";

let seq = 0;
function newId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PersonalState {
  hydrated: boolean;
  projects: ProjectMeta[];
  promptRoot?: string;
  promptTree?: PromptNode;
  sessions: SessionMeta[];
  activeProjectId?: string;
  activeSessionId?: string;
  collapsedProjects: Record<string, boolean>;
  // 每个 session 是否有正在运行的 CLI 轮次（runId），用于 UI 禁用发送等。
  runningBySession: Record<string, string | undefined>;
  // 底部终端面板（不持久化;收起时保留 PTY 进程）。
  terminalOpen: boolean;
  // 右栏当前视图（顶栏下拉选择）。
  rightView: "files" | "skills";
  // 主区时间线视图：非空时主区显示该项目的时间线（替代会话区）。
  timelineProjectId?: string;
  // 时间线日报设置（生成模型,持久化）。
  timelineSettings: TimelineSettings;
  // 全局推送渠道设置（独立持久化,所有推送场景共用）。
  pushSettings: PushSettings;
  hydrate: (s: PersistedState) => void;
  addProject: (path: string) => ProjectMeta;
  removeProject: (id: string) => void;
  setPromptRoot: (root: string, tree: PromptNode) => void;
  setPromptTree: (tree: PromptNode) => void;
  createSession: (projectId: string, agent: AgentKind, model?: string) => SessionMeta;
  updateSession: (id: string, patch: Partial<SessionMeta>) => void;
  removeSession: (id: string) => void;
  setActiveSession: (sessionId: string) => void;
  toggleProjectCollapse: (id: string) => void;
  setRunning: (sessionId: string, runId: string | undefined) => void;
  toggleTerminal: () => void;
  setRightView: (view: "files" | "skills") => void;
  openTimeline: (projectId: string) => void;
  closeTimeline: () => void;
  setTimelineSettings: (patch: Partial<TimelineSettings>) => void;
  setPushSettings: (patch: Partial<PushSettings>) => void;
}

function baseName(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

export const usePersonalStore = create<PersonalState>((set, get) => ({
  hydrated: false,
  projects: [],
  sessions: [],
  collapsedProjects: {},
  runningBySession: {},
  terminalOpen: false,
  rightView: "files" as const,
  timelineSettings: DEFAULT_TIMELINE_SETTINGS,
  pushSettings: DEFAULT_PUSH_SETTINGS,
  hydrate: (s) =>
    set({
      hydrated: true,
      projects: s.projects,
      promptRoot: s.promptRoot,
      sessions: s.sessions,
      timelineSettings: s.timelineSettings ?? DEFAULT_TIMELINE_SETTINGS,
      // 兼容迁移:旧版本推送渠道存在 timelineSettings.push 下。
      pushSettings:
        s.pushSettings ??
        (s.timelineSettings as undefined | { push?: PushSettings })?.push ??
        DEFAULT_PUSH_SETTINGS,
    }),

  addProject: (path) => {
    const existing = get().projects.find((p) => p.path === path);
    if (existing) {
      set({ activeProjectId: existing.id });
      return existing;
    }
    const proj: ProjectMeta = { id: newId("proj"), name: baseName(path), path, addedAt: Date.now() };
    set((s) => ({ projects: [...s.projects, proj], activeProjectId: proj.id }));
    return proj;
  },

  removeProject: (id) =>
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      sessions: s.sessions.filter((x) => x.projectId !== id),
      activeProjectId: s.activeProjectId === id ? undefined : s.activeProjectId,
      activeSessionId:
        s.sessions.find((x) => x.id === s.activeSessionId)?.projectId === id ? undefined : s.activeSessionId,
      timelineProjectId: s.timelineProjectId === id ? undefined : s.timelineProjectId,
    })),

  setPromptRoot: (root, tree) => set({ promptRoot: root, promptTree: tree }),
  setPromptTree: (tree) => set({ promptTree: tree }),

  createSession: (projectId, agent, model) => {
    const now = Date.now();
    const count = get().sessions.filter((x) => x.projectId === projectId).length;
    const sess: SessionMeta = {
      id: newId("sess"),
      projectId,
      title: `Session ${count + 1}`,
      agent,
      model: model ?? DEFAULT_MODEL[agent],
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({
      sessions: [...s.sessions, sess],
      activeProjectId: projectId,
      activeSessionId: sess.id,
    }));
    return sess;
  },

  updateSession: (id, patch) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...patch, updatedAt: Date.now() } : x)),
    })),

  removeSession: (id) =>
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== id),
      activeSessionId: s.activeSessionId === id ? undefined : s.activeSessionId,
    })),

  setActiveSession: (sessionId) =>
    set((s) => {
      const sess = s.sessions.find((x) => x.id === sessionId);
      // 选中会话即离开时间线视图。
      return { activeSessionId: sessionId, activeProjectId: sess?.projectId ?? s.activeProjectId, timelineProjectId: undefined };
    }),

  toggleProjectCollapse: (id) =>
    set((s) => ({ collapsedProjects: { ...s.collapsedProjects, [id]: !s.collapsedProjects[id] } })),

  setRunning: (sessionId, runId) =>
    set((s) => ({ runningBySession: { ...s.runningBySession, [sessionId]: runId } })),

  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),

  setRightView: (view) => set({ rightView: view }),

  openTimeline: (projectId) => set({ timelineProjectId: projectId, activeProjectId: projectId }),
  closeTimeline: () => set({ timelineProjectId: undefined }),

  setTimelineSettings: (patch) =>
    set((s) => ({ timelineSettings: { ...s.timelineSettings, ...patch } })),

  setPushSettings: (patch) =>
    set((s) => ({ pushSettings: { ...s.pushSettings, ...patch } })),
}));

// 持久化切片快照（usePersonalPersistence 用）。promptTree 不持久化，启动重扫。
export function toPersistedState(s: PersonalState): PersistedState {
  return {
    version: 1,
    projects: s.projects,
    promptRoot: s.promptRoot,
    sessions: s.sessions,
    timelineSettings: s.timelineSettings,
    pushSettings: s.pushSettings,
  };
}
