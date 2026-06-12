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
  TodoMeta,
  TtsSettings,
} from "../desktop/types";
import {
  DEFAULT_MODEL,
  DEFAULT_PUSH_SETTINGS,
  DEFAULT_TIMELINE_SETTINGS,
  DEFAULT_TTS_SETTINGS,
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
  todos: TodoMeta[];
  activeProjectId?: string;
  activeSessionId?: string;
  collapsedProjects: Record<string, boolean>;
  // 每个 session 是否有正在运行的 CLI 轮次（runId），用于 UI 禁用发送等。
  runningBySession: Record<string, string | undefined>;
  // 底部终端面板（不持久化;收起时保留 PTY 进程）。
  terminalOpen: boolean;
  // 待写入终端的文本（文件预览「发送到终端」中转;终端未开/PTY 未就绪时暂存,
  // TerminalPanel 在激活终端可写时消费）。
  pendingTerminalText?: string;
  // 待插入 composer 输入框的文本（文件预览「发送到 Chat」中转;nonce 去重,
  // 防 composer 重挂载时重复插入）。
  composerInsert?: { text: string; nonce: number };
  // GitBar「查看 diff」请求（FilesView 消费后即清,不持久化;不用 nonce——
  // FilesView 可能在请求发出时未挂载,消费即清才能让挂载后的 effect 接到）。
  gitDiffRequest?: { projectId: string };
  // 右栏当前视图（顶栏下拉选择）。
  rightView: "files" | "skills" | "todos";
  // 右侧面板自定义宽度（px,拖拽调整,持久化）;undefined 走 CSS 自动档位。
  rightPanelWidth?: number;
  // 主区时间线视图：非空时主区显示该项目的时间线（替代会话区）。
  timelineProjectId?: string;
  // 主区首页视图（热力图/项目检索/全局日总结）。启动默认落地首页;不持久化。
  // 渲染优先级：homeOpen > timelineProjectId > 会话区。
  homeOpen: boolean;
  // 时间线日报设置（生成模型,持久化）。
  timelineSettings: TimelineSettings;
  // 全局推送渠道设置（独立持久化,所有推送场景共用）。
  pushSettings: PushSettings;
  // TTS 设置（自动朗读 + 引擎,持久化）。
  ttsSettings: TtsSettings;
  hydrate: (s: PersistedState) => void;
  addProject: (path: string) => ProjectMeta;
  removeProject: (id: string) => void;
  setPromptRoot: (root: string, tree: PromptNode) => void;
  setPromptTree: (tree: PromptNode) => void;
  createSession: (projectId: string, agent: AgentKind, model?: string) => SessionMeta;
  updateSession: (id: string, patch: Partial<SessionMeta>) => void;
  removeSession: (id: string) => void;
  addTodo: (projectId: string, title: string, detailPath: string) => TodoMeta;
  updateTodo: (id: string, patch: Partial<Pick<TodoMeta, "title" | "status" | "detailPath">>) => void;
  removeTodo: (id: string) => void;
  setActiveSession: (sessionId: string) => void;
  // 激活项目但不选会话（左栏点击项目名;项目无 session 时中间区显示新建聊天引导）。
  activateProject: (projectId: string) => void;
  toggleProjectCollapse: (id: string) => void;
  setRunning: (sessionId: string, runId: string | undefined) => void;
  toggleTerminal: () => void;
  // 发送文本到终端:暂存并确保终端面板打开,由 TerminalPanel 消费。
  sendToTerminal: (text: string) => void;
  // 原子消费待发送文本（TermSession spawn 完成 / 面板 effect 双路触发,先到先得）。
  consumePendingTerminalText: () => string | undefined;
  insertToComposer: (text: string) => void;
  // GitBar 点击 ± 徽章:右栏切到文件视图并请求整仓 diff 预览。
  requestGitDiff: (projectId: string) => void;
  consumeGitDiffRequest: () => { projectId: string } | undefined;
  setRightView: (view: "files" | "skills" | "todos") => void;
  // 传 undefined 恢复自动宽度（双击拖拽条重置）。
  setRightPanelWidth: (width: number | undefined) => void;
  openTimeline: (projectId: string) => void;
  closeTimeline: () => void;
  openHome: () => void;
  setTimelineSettings: (patch: Partial<TimelineSettings>) => void;
  setPushSettings: (patch: Partial<PushSettings>) => void;
  setTtsSettings: (patch: Partial<TtsSettings>) => void;
}

function baseName(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

export const usePersonalStore = create<PersonalState>((set, get) => ({
  hydrated: false,
  projects: [],
  sessions: [],
  todos: [],
  collapsedProjects: {},
  runningBySession: {},
  terminalOpen: false,
  rightView: "todos" as const,
  homeOpen: true,
  timelineSettings: DEFAULT_TIMELINE_SETTINGS,
  pushSettings: DEFAULT_PUSH_SETTINGS,
  ttsSettings: DEFAULT_TTS_SETTINGS,
  hydrate: (s) =>
    set({
      hydrated: true,
      projects: s.projects,
      promptRoot: s.promptRoot,
      sessions: s.sessions,
      todos: s.todos ?? [],
      timelineSettings: s.timelineSettings ?? DEFAULT_TIMELINE_SETTINGS,
      // 兼容迁移:旧版本推送渠道存在 timelineSettings.push 下。
      pushSettings:
        s.pushSettings ??
        (s.timelineSettings as undefined | { push?: PushSettings })?.push ??
        DEFAULT_PUSH_SETTINGS,
      ttsSettings: s.ttsSettings ?? DEFAULT_TTS_SETTINGS,
      rightPanelWidth: s.rightPanelWidth,
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
      todos: s.todos.filter((x) => x.projectId !== id),
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
      homeOpen: false,
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

  addTodo: (projectId, title, detailPath) => {
    const now = Date.now();
    const todo: TodoMeta = {
      id: newId("todo"),
      projectId,
      title: title.trim() || "未命名 Todo",
      status: "open",
      detailPath,
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({ todos: [...s.todos, todo], activeProjectId: projectId }));
    return todo;
  },

  updateTodo: (id, patch) =>
    set((s) => ({
      todos: s.todos.map((x) => (x.id === id ? { ...x, ...patch, updatedAt: Date.now() } : x)),
    })),

  removeTodo: (id) => set((s) => ({ todos: s.todos.filter((x) => x.id !== id) })),

  setActiveSession: (sessionId) =>
    set((s) => {
      const sess = s.sessions.find((x) => x.id === sessionId);
      // 选中会话即离开时间线/首页视图。
      return {
        activeSessionId: sessionId,
        activeProjectId: sess?.projectId ?? s.activeProjectId,
        timelineProjectId: undefined,
        homeOpen: false,
      };
    }),

  activateProject: (projectId) =>
    set({ activeProjectId: projectId, activeSessionId: undefined, timelineProjectId: undefined, homeOpen: false }),

  toggleProjectCollapse: (id) =>
    set((s) => ({ collapsedProjects: { ...s.collapsedProjects, [id]: !s.collapsedProjects[id] } })),

  setRunning: (sessionId, runId) =>
    set((s) => ({ runningBySession: { ...s.runningBySession, [sessionId]: runId } })),

  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),

  sendToTerminal: (text) => set({ pendingTerminalText: text, terminalOpen: true }),

  consumePendingTerminalText: () => {
    const text = get().pendingTerminalText;
    if (text !== undefined) set({ pendingTerminalText: undefined });
    return text;
  },

  insertToComposer: (text) =>
    set((s) => ({ composerInsert: { text, nonce: (s.composerInsert?.nonce ?? 0) + 1 } })),

  requestGitDiff: (projectId) => set({ gitDiffRequest: { projectId }, rightView: "files" }),

  consumeGitDiffRequest: () => {
    const req = get().gitDiffRequest;
    if (req) set({ gitDiffRequest: undefined });
    return req;
  },

  setRightView: (view) => set({ rightView: view }),

  setRightPanelWidth: (width) => set({ rightPanelWidth: width }),

  openTimeline: (projectId) => set({ timelineProjectId: projectId, activeProjectId: projectId, homeOpen: false }),
  closeTimeline: () => set({ timelineProjectId: undefined }),

  // 回首页时右栏同步切回 todos（全部项目列表）——项目内的文件/Skills 面板
  // 是项目上下文,不应停留在首页。
  openHome: () => set({ homeOpen: true, timelineProjectId: undefined, rightView: "todos" }),

  setTimelineSettings: (patch) =>
    set((s) => ({ timelineSettings: { ...s.timelineSettings, ...patch } })),

  setPushSettings: (patch) =>
    set((s) => ({ pushSettings: { ...s.pushSettings, ...patch } })),

  setTtsSettings: (patch) =>
    set((s) => ({ ttsSettings: { ...s.ttsSettings, ...patch } })),
}));

// 持久化切片快照（usePersonalPersistence 用）。promptTree 不持久化，启动重扫。
export function toPersistedState(s: PersonalState): PersistedState {
  return {
    version: 1,
    projects: s.projects,
    promptRoot: s.promptRoot,
    sessions: s.sessions,
    todos: s.todos,
    timelineSettings: s.timelineSettings,
    pushSettings: s.pushSettings,
    ttsSettings: s.ttsSettings,
    rightPanelWidth: s.rightPanelWidth,
  };
}
