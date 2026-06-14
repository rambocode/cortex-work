// 个人工作区客户端状态（Zustand，仅 core）。项目/session 元数据为内存态，
// 经 usePersonalPersistence 与主进程 JSON 双向同步；消息流不在这里 —— 它走
// React Query cache（personal/messages.ts）。

import { create } from "zustand";
import type {
  AgentKind,
  PersistedState,
  PiChannel,
  PiSettings,
  ProjectMeta,
  PromptNode,
  PushSettings,
  SessionMeta,
  SpotlightIntent,
  TimelineSettings,
  TodoMeta,
  TtsSettings,
} from "../desktop/types";
import {
  DEFAULT_MODEL,
  DEFAULT_PI_SETTINGS,
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
  // 首页点 Task 请求:右栏 TodosView 消费后打开该 task 文件详情（消费即清,仿 gitDiffRequest）。
  taskDetailRequest?: { projectId: string; path: string; name: string };
  // 右栏当前视图（顶栏下拉选择）。
  rightView: "files" | "skills" | "todos";
  // 右侧面板自定义宽度（px,拖拽调整,持久化）;undefined 走 CSS 自动档位。
  rightPanelWidth?: number;
  // 主区时间线视图：非空时主区显示该项目的时间线（替代会话区）。
  timelineProjectId?: string;
  // 主区首页视图（热力图/项目检索/全局日总结）。启动默认落地首页;不持久化。
  // 渲染优先级：automationOpen > homeOpen > timelineProjectId > 会话区。
  homeOpen: boolean;
  // 主区自动化视图（定时任务列表/详情）。不持久化,优先级最高。
  automationOpen: boolean;
  // 时间线日报设置（生成模型,持久化）。
  timelineSettings: TimelineSettings;
  // 全局推送渠道设置（独立持久化,所有推送场景共用）。
  pushSettings: PushSettings;
  // TTS 设置（自动朗读 + 引擎,持久化）。
  ttsSettings: TtsSettings;
  // 各 agent 是否可用（主进程探测,不持久化;启动时回填）。
  agentsAvailable?: Partial<Record<AgentKind, boolean>>;
  // 兜底 Agent（内置 pi）配置（持久化）。
  piSettings: PiSettings;
  // 「最后一次使用」记忆（持久化;Spotlight/新会话默认沿用）。
  lastAgent?: AgentKind;
  lastModel?: string;
  lastPiChannelId?: string;
  // Spotlight 接力:待主窗口个人工作区消费的发起意图（不持久化）。
  pendingSpotlightIntent?: SpotlightIntent;
  hydrate: (s: PersistedState) => void;
  addProject: (path: string) => ProjectMeta;
  removeProject: (id: string) => void;
  // 更新项目置顶/归档元数据（patch 单项目,数组引用替换）。
  updateProject: (id: string, patch: Partial<Pick<ProjectMeta, "pinnedAt" | "archivedAt">>) => void;
  // 归档项目:设 archivedAt、清 pinnedAt;若该项目正激活/在时间线则让出焦点。
  archiveProject: (id: string) => void;
  setAgentsAvailable: (avail: Partial<Record<AgentKind, boolean>>) => void;
  // 兜底 Agent（pi）多 LLM 通道配置:整体 patch + 通道级增删改 + 设默认。
  setPiSettings: (patch: Partial<PiSettings>) => void;
  addPiChannel: (channel: PiChannel) => void;
  updatePiChannel: (id: string, patch: Partial<PiChannel>) => void;
  removePiChannel: (id: string) => void;
  setPiDefaults: (patch: { defaultChannelId?: string; defaultModel?: string }) => void;
  setPromptRoot: (root: string, tree: PromptNode) => void;
  setPromptTree: (tree: PromptNode) => void;
  // projectId 缺省 = 不使用项目（会话在 opts.noProjectDir 工作目录运行）。
  createSession: (
    projectId: string | undefined,
    agent: AgentKind,
    model?: string,
    opts?: { noProjectDir?: string },
  ) => SessionMeta;
  updateSession: (id: string, patch: Partial<SessionMeta>) => void;
  archiveSession: (id: string) => void;
  unarchiveSession: (id: string) => void;
  removeSession: (id: string) => void;
  addTodo: (projectId: string, title: string, detailPath: string) => TodoMeta;
  updateTodo: (id: string, patch: Partial<Pick<TodoMeta, "title" | "status" | "detailPath">>) => void;
  removeTodo: (id: string) => void;
  setActiveSession: (sessionId: string) => void;
  // Spotlight 接力:暂存 / 原子消费发起意图。
  setPendingSpotlightIntent: (intent: SpotlightIntent) => void;
  consumePendingSpotlightIntent: () => SpotlightIntent | undefined;
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
  // 首页点 Task:右栏切到 Tasks 视图并请求打开该 task 文件详情。
  requestTaskDetail: (req: { projectId: string; path: string; name: string }) => void;
  consumeTaskDetailRequest: () => { projectId: string; path: string; name: string } | undefined;
  setRightView: (view: "files" | "skills" | "todos") => void;
  // 传 undefined 恢复自动宽度（双击拖拽条重置）。
  setRightPanelWidth: (width: number | undefined) => void;
  openTimeline: (projectId: string) => void;
  closeTimeline: () => void;
  openHome: () => void;
  openAutomation: () => void;
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
  automationOpen: false,
  timelineSettings: DEFAULT_TIMELINE_SETTINGS,
  pushSettings: DEFAULT_PUSH_SETTINGS,
  ttsSettings: DEFAULT_TTS_SETTINGS,
  piSettings: DEFAULT_PI_SETTINGS,
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
      // 旧结构（单 provider,无 channels）按空通道重置;用户重新配置。
      piSettings: Array.isArray(s.piSettings?.channels) ? s.piSettings : DEFAULT_PI_SETTINGS,
      rightPanelWidth: s.rightPanelWidth,
      lastAgent: s.lastAgent,
      lastModel: s.lastModel,
      lastPiChannelId: s.lastPiChannelId,
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

  updateProject: (id, patch) =>
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    })),

  archiveProject: (id) =>
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, archivedAt: Date.now(), pinnedAt: undefined } : p,
      ),
      // 归档项目若正激活/在时间线,让出焦点（与 removeProject 一致:清相关字段,
      // 但项目仍在列表,故不必回 homeOpen 态）。
      activeProjectId: s.activeProjectId === id ? undefined : s.activeProjectId,
      activeSessionId:
        s.sessions.find((x) => x.id === s.activeSessionId)?.projectId === id ? undefined : s.activeSessionId,
      timelineProjectId: s.timelineProjectId === id ? undefined : s.timelineProjectId,
    })),

  setAgentsAvailable: (avail) => set({ agentsAvailable: avail }),

  setPiSettings: (patch) => set((s) => ({ piSettings: { ...s.piSettings, ...patch } })),

  addPiChannel: (channel) =>
    set((s) => ({ piSettings: { ...s.piSettings, channels: [...s.piSettings.channels, channel] } })),

  updatePiChannel: (id, patch) =>
    set((s) => ({
      piSettings: {
        ...s.piSettings,
        channels: s.piSettings.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      },
    })),

  removePiChannel: (id) =>
    set((s) => {
      const channels = s.piSettings.channels.filter((c) => c.id !== id);
      // 删掉的通道若是默认通道,一并清掉默认指向。
      const defaultChannelId = s.piSettings.defaultChannelId === id ? undefined : s.piSettings.defaultChannelId;
      const defaultModel = s.piSettings.defaultChannelId === id ? undefined : s.piSettings.defaultModel;
      return { piSettings: { ...s.piSettings, channels, defaultChannelId, defaultModel } };
    }),

  setPiDefaults: (patch) => set((s) => ({ piSettings: { ...s.piSettings, ...patch } })),

  setPromptRoot: (root, tree) => set({ promptRoot: root, promptTree: tree }),
  setPromptTree: (tree) => set({ promptTree: tree }),

  createSession: (projectId, agent, model, opts) => {
    const now = Date.now();
    // count 仍按 projectId 分桶（undefined 自成「无项目」分桶,各自从 1 开始编号）。
    const count = get().sessions.filter((x) => x.projectId === projectId).length;
    // pi:挂上默认 LLM 通道与模型（缺省取默认通道首个模型）,无通道则留空待配置。
    const piSettings = get().piSettings;
    const piChannel =
      agent === "pi" ? piSettings.channels.find((c) => c.id === piSettings.defaultChannelId) : undefined;
    const sess: SessionMeta = {
      id: newId("sess"),
      projectId,
      // 无项目会话记下创建时定下的工作目录（cli:start 直接用此 cwd,不漂移）。
      noProjectDir: projectId ? undefined : opts?.noProjectDir,
      title: `Session ${count + 1}`,
      agent,
      model:
        agent === "pi"
          ? model ?? piSettings.defaultModel ?? piChannel?.models[0]?.id
          : model ?? DEFAULT_MODEL[agent],
      piChannelId: agent === "pi" ? piSettings.defaultChannelId : undefined,
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({
      sessions: [...s.sessions, sess],
      // projectId 为 undefined 即清空 activeProjectId（无项目会话不归属任何项目）。
      activeProjectId: projectId,
      activeSessionId: sess.id,
      homeOpen: false,
      automationOpen: false,
      // 记忆本次选择（下次 Spotlight/新会话默认沿用;用 sess.* 取已 resolve 的值）。
      lastAgent: agent,
      lastModel: sess.model,
      lastPiChannelId: sess.piChannelId,
    }));
    return sess;
  },

  updateSession: (id, patch) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...patch, updatedAt: Date.now() } : x)),
    })),

  // 归档/取消归档:只动 archivedAt,不刷新 updatedAt（避免改变会话列表排序）。
  // 归档当前会话时让出焦点（仿 archiveProject）。
  archiveSession: (id) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, archivedAt: Date.now() } : x)),
      activeSessionId: s.activeSessionId === id ? undefined : s.activeSessionId,
    })),

  unarchiveSession: (id) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, archivedAt: undefined } : x)),
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

  setPendingSpotlightIntent: (intent) => set({ pendingSpotlightIntent: intent }),
  consumePendingSpotlightIntent: () => {
    const cur = get().pendingSpotlightIntent;
    if (cur) set({ pendingSpotlightIntent: undefined });
    return cur;
  },

  setActiveSession: (sessionId) =>
    set((s) => {
      const sess = s.sessions.find((x) => x.id === sessionId);
      // 选中会话即离开时间线/首页视图。
      return {
        activeSessionId: sessionId,
        activeProjectId: sess?.projectId ?? s.activeProjectId,
        timelineProjectId: undefined,
        homeOpen: false,
        automationOpen: false,
      };
    }),

  activateProject: (projectId) =>
    set({
      activeProjectId: projectId,
      activeSessionId: undefined,
      timelineProjectId: undefined,
      homeOpen: false,
      automationOpen: false,
    }),

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

  // 首页点 Task:切右栏到 Tasks 并存请求,TodosView 消费后打开该文件详情。
  // 不动 homeOpen（保持落地页不切走）,只在右栏展示详情。
  requestTaskDetail: (req) => set({ taskDetailRequest: req, rightView: "todos" }),

  consumeTaskDetailRequest: () => {
    const req = get().taskDetailRequest;
    if (req) set({ taskDetailRequest: undefined });
    return req;
  },

  setRightView: (view) => set({ rightView: view }),

  setRightPanelWidth: (width) => set({ rightPanelWidth: width }),

  openTimeline: (projectId) =>
    set({ timelineProjectId: projectId, activeProjectId: projectId, homeOpen: false, automationOpen: false }),
  closeTimeline: () => set({ timelineProjectId: undefined }),

  // 回首页时右栏同步切回 todos（全部项目列表）——项目内的文件/Skills 面板
  // 是项目上下文,不应停留在首页。
  openHome: () => set({ homeOpen: true, automationOpen: false, timelineProjectId: undefined, rightView: "todos" }),

  // 进入自动化主区视图（优先级最高,互斥清其它视图字段）。
  openAutomation: () =>
    set({ automationOpen: true, homeOpen: false, timelineProjectId: undefined, activeSessionId: undefined }),

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
    piSettings: s.piSettings,
    rightPanelWidth: s.rightPanelWidth,
    lastAgent: s.lastAgent,
    lastModel: s.lastModel,
    lastPiChannelId: s.lastPiChannelId,
  };
}

// 项目分区：可见区（置顶在前按 pinnedAt 降序,未置顶维持原数组序）与
// 归档区（按 archivedAt 降序）。归档项目（有 archivedAt）只进归档区。
// 同值（pinnedAt/archivedAt 相等）显式以原数组下标升序兜底,不依赖
// Array.prototype.sort 的稳定性。
export function partitionProjects(projects: ProjectMeta[]): {
  visible: ProjectMeta[];
  archived: ProjectMeta[];
} {
  // 记录原始下标作为稳定 tiebreak,避免依赖 sort 实现的稳定性。
  const idx = new Map<ProjectMeta, number>();
  projects.forEach((p, i) => idx.set(p, i));
  const order = (a: ProjectMeta, b: ProjectMeta) => (idx.get(a) ?? 0) - (idx.get(b) ?? 0);

  const visibleSrc = projects.filter((p) => p.archivedAt == null);
  const pinned = visibleSrc
    .filter((p) => p.pinnedAt != null)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || order(a, b));
  const unpinned = visibleSrc.filter((p) => p.pinnedAt == null);
  const archived = projects
    .filter((p) => p.archivedAt != null)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || order(a, b));
  return { visible: [...pinned, ...unpinned], archived };
}

// 新建会话默认 agent：claude 可用→claude,否则 codex 可用→codex,否则内置 pi 兜底。
export function defaultAgent(avail?: Partial<Record<AgentKind, boolean>>): AgentKind {
  if (avail?.claude) return "claude";
  if (avail?.codex) return "codex";
  return "pi";
}

// Spotlight/新会话发起的初始 agent:优先记忆,回退按安装情况派生（记忆 agent 不可用则回退）。
export function initialAgent(s: Pick<PersonalState, "lastAgent" | "agentsAvailable">): AgentKind {
  if (s.lastAgent && (s.lastAgent === "pi" || s.agentsAvailable?.[s.lastAgent])) return s.lastAgent;
  return defaultAgent(s.agentsAvailable);
}

// 与 initialAgent 配对的初始模型/通道（pi 走通道;其余 lastModel 仅同 agent 时沿用,否则取该 agent 默认）。
export function initialModelDraft(
  s: Pick<PersonalState, "lastAgent" | "lastModel" | "lastPiChannelId" | "agentsAvailable" | "piSettings">,
): { agent: AgentKind; model: string | undefined; piChannelId: string | undefined } {
  const agent = initialAgent(s);
  const sameAgent = agent === s.lastAgent;
  if (agent === "pi") {
    const ch =
      s.piSettings.channels.find((c) => c.id === (s.lastPiChannelId ?? s.piSettings.defaultChannelId)) ??
      s.piSettings.channels[0];
    return {
      agent,
      model: (sameAgent ? s.lastModel : undefined) ?? s.piSettings.defaultModel ?? ch?.models[0]?.id,
      piChannelId: ch?.id,
    };
  }
  return { agent, model: (sameAgent ? s.lastModel : undefined) ?? DEFAULT_MODEL[agent], piChannelId: undefined };
}
