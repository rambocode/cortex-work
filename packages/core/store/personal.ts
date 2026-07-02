// 个人工作区客户端状态（Zustand，仅 core）。项目/session 元数据为内存态，
// 经 usePersonalPersistence 与主进程 JSON 双向同步；消息流不在这里 —— 它走
// React Query cache（personal/messages.ts）。

import { create } from "zustand";
import type {
  AgentKind,
  AsrSettings,
  DerivedAgentMeta,
  RoleConfig,
  DailyEncouragement,
  GeneralSettings,
  MediaGenSettings,
  PermissionMode,
  ApprovalPolicy,
  PersistedState,
  PersonalProfile,
  PiSkillSettings,
  PiExtensionSettings,
  InstalledExtensionRecord,
  PluginEnableSettings,
  BrowserControlSettings,
  PendingImage,
  PiUiRequest,
  ProviderProfile,
  ProviderSettings,
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
  DEFAULT_GENERAL_SETTINGS,
  DEFAULT_MODEL,
  DEFAULT_PI_SKILLS,
  DEFAULT_PI_EXTENSIONS,
  DEFAULT_PLUGIN_ENABLE,
  DEFAULT_BROWSER_CONTROL,
  DEFAULT_PROVIDER_SETTINGS,
  DEFAULT_PUSH_SETTINGS,
  DEFAULT_TIMELINE_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  defaultMediaGenSettings,
  defaultAsrSettings,
} from "../desktop/types";
import { migratePiSettings, normalizeProviderProfile } from "../desktop/providers";
import { fromAdapterPermissions } from "../personal/permissionMode";

let seq = 0;
function newId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

// 右栏当前视图（顶栏下拉选择）。后续新增视图只需扩此联合,不必逐处改字面量。
export type RightView = "files" | "skills" | "todos" | "pipeline" | "notes" | "browser";

// 运行模式拦截提示（瞬态,不持久化）。当 plan/accept-edits 模式下 agent 尝试被该模式禁止的
// 工具(写/执行)时,在 composer 上方提示用户切档并自动重发本轮。category 决定可切到哪些档:
// edit=写类被拦(可切 accept-edits/full-auto);exec=执行类被拦(只能切 full-auto)。
export interface ModeBlockHint {
  fromMode: PermissionMode;
  // edit=写类;exec=执行类;tool=plan 档白名单外工具(含扩展自定义工具)。决定可切到的目标档。
  category: "edit" | "exec" | "tool";
  promptText: string;
  toolName: string;
}

// pi RPC 会话的运行时状态（瞬态展示用,不进 toPersistedState）。
export interface PiRuntimeStatus {
  steering?: number; // 待注入的 steer 条数
  followUp?: number; // 待执行的 follow-up 条数
  compacting?: boolean; // 正在压缩上下文
  retry?: { attempt: number; max?: number }; // 自动重试中
  thinkingLevel?: string; // 当前思考强度
  // 本轮是扩展命令(/cmd):pi 即时执行、不跑 agent、无过程步骤。据此抑制右侧「执行过程」面板的
  // 空态「运行中」闪现（命令输出走消息流,过程面板无内容可展示）。
  extensionCommand?: boolean;
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
  // 工作台中列子任务折叠态（U3）：taskId → 是否折叠（缺省展开）。会话内存态、不进 toPersistedState
  // （与 collapsedProjects 同款），故进出工作台不塌回、重启才重置。
  collapsedTasks: Record<string, boolean>;
  // 每个 session 是否有正在运行的 CLI 轮次（runId），用于 UI 禁用发送等。
  runningBySession: Record<string, string | undefined>;
  // pi RPC 会话运行时状态（瞬态,不持久化;由 handlePiEvent 写,头部/composer 读）:
  // 待注入队列计数 / 压缩中 / 自动重试 / 思考强度。
  piRuntimeBySession: Record<string, PiRuntimeStatus | undefined>;
  // 运行模式拦截提示（瞬态,不持久化;轮次检测到被拦工具时写,composer 上方读）。
  modeBlockHints: Record<string, ModeBlockHint | undefined>;
  // pi extension UI 待确认请求队列（瞬态,不持久化;阶段3 工具确认弹窗）。RPC 串行 → 通常 ≤1,
  // 跨会话才可能 >1;FIFO,弹窗只显队首。
  piUiPending: { uiSessionId: string; request: PiUiRequest }[];
  // 底部终端面板（不持久化;收起时保留 PTY 进程）。
  terminalOpen: boolean;
  // 待写入终端的文本（文件预览「发送到终端」中转;终端未开/PTY 未就绪时暂存,
  // TerminalPanel 在激活终端可写时消费）。
  pendingTerminalText?: string;
  // 待插入 composer 输入框的文本（文件预览「发送到 Chat」中转;nonce 去重,
  // 防 composer 重挂载时重复插入）。submit 为真时 ComposerShell 插入后自动提交
  // （tasks 文档「插入并运行」用;跨组件契约,见 ComposerShell 消费 effect）。
  // plugin:插件「在对话中试用」携带的插件上下文（id+名称），ComposerShell 据此在输入框前渲染插件 pill。
  // images:随文本注入 composer 的待发图片(如批注「始终包含截图」,plan U4)。瞬态,不进 toPersistedState。
  composerInsert?: {
    text: string;
    nonce: number;
    submit?: boolean;
    plugin?: { id: string; name: string; icon?: string };
    images?: PendingImage[];
  };
  // GitBar「查看 diff」请求（FilesView 消费后即清,不持久化;不用 nonce——
  // FilesView 可能在请求发出时未挂载,消费即清才能让挂载后的 effect 接到）。
  gitDiffRequest?: { projectId: string };
  // 首页点 Task 请求:右栏 TodosView 消费后打开该 task 文件详情（消费即清,仿 gitDiffRequest）。
  taskDetailRequest?: { projectId: string; path: string; name: string };
  // 会话消息文件链接点击请求:右栏 FilesView 消费后 openFile 预览（消费即清,仿 gitDiffRequest）。
  // path 为已解析的绝对路径;瞬态,不进 toPersistedState。
  filePreviewRequest?: { projectId: string; path: string; name: string };
  // 点击收件箱/时间线某条闪记 → 跨栏打开详情;消费即清,瞬态,不进 toPersistedState。
  noteDetailRequest?: { noteId: string };
  // 在内嵌浏览器打开某 URL 的请求(卡片点击 / auto_open)。BrowserView 监听 nonce 变化
  // 后加载;nonce 让「同 URL 再次请求」也能触发重载。瞬态,不进 toPersistedState。
  browserUrlRequest?: { url: string; nonce: number };
  // 已 auto_open 自动打开过的「会话:URL」键集合。防探测结果在重渲染/多会话来回切换中
  // 反复自动弹面板(同键不再触发)。用数组而非单槽,否则切到别的会话再切回会重复弹
  // (安全/正确性评审)。瞬态,不进 toPersistedState。
  autoOpenedPreviewKeys: string[];
  // 右栏当前视图（顶栏下拉选择）。
  rightView: RightView;
  // 右侧面板自定义宽度（px,拖拽调整,持久化）;undefined 走 CSS 自动档位。
  rightPanelWidth?: number;
  // 项目工作台右列详情宽度（px,拖拽调整,持久化）;undefined 走 CSS 默认 380。
  projectsDetailWidth?: number;
  // 主区时间线视图：非空时主区显示该项目的时间线（替代会话区）。
  timelineProjectId?: string;
  // 主区首页视图（热力图/项目检索/全局日总结）。启动默认落地首页;不持久化。
  // 渲染优先级：workflowOpen > automationOpen > homeOpen > timelineProjectId > 会话区。
  homeOpen: boolean;
  // 主区自动化视图（定时任务列表/详情）。不持久化,优先级高。
  automationOpen: boolean;
  // 主区 loop 工作流视图（节点式工作流列表/编辑器）。不持久化,优先级最高。
  // 与 automationOpen/homeOpen/timelineProjectId/noteEditorId 互斥。
  workflowOpen: boolean;
  // 设置整页视图（全屏覆盖层接管整窗、隐藏侧栏;底层工作区不卸载以保活终端）。
  // 瞬态,不持久化;与其它主区视图互斥（其它 open 入口清它,它不清底层视图标志,
  // 故 closeSettings 后回到打开设置前的视图）。
  settingsOpen: boolean;
  // 主区闪记写作面：非空时主区显示该闪记的宽编辑器（占据 .pw-center-col,替代会话区）。
  // 瞬态,不持久化;与 homeOpen/automationOpen/timelineProjectId 互斥。
  noteEditorId?: string;
  // 时间线日报设置（生成模型,持久化）。
  timelineSettings: TimelineSettings;
  // 全局推送渠道设置（独立持久化,所有推送场景共用）。
  pushSettings: PushSettings;
  // TTS 设置（自动朗读 + 引擎,持久化）。
  ttsSettings: TtsSettings;
  // 媒体生成设置（四模态:图片/语音/音乐/视频,持久化;与 PersistedState.mediaGenSettings 镜像）。
  mediaGenSettings: MediaGenSettings;
  // 语音识别设置（持久化;与 PersistedState.asrSettings 镜像）。
  asrSettings: AsrSettings;
  // 各 agent 是否可用（主进程探测,不持久化;启动时回填）。
  agentsAvailable?: Partial<Record<AgentKind, boolean>>;
  // 用户 JSON(agents.local.json)派生的 agent(主进程读盘,不持久化;启动时经 listAgentProfiles 回填,U7)。
  derivedAgents?: DerivedAgentMeta[];
  // 圆桌角色库（主进程读 roles.json,不持久化到 PersistedState;经 IPC + roles:changed 广播回填）。
  roles: RoleConfig[];
  // 供应商（Provider）注册表（持久化;pi 会话/自动化据此选端点）。
  providerSettings: ProviderSettings;
  // 通用设置（工作目录/桌面行为/通知/日志,持久化;主进程消费部分立即落盘）。
  generalSettings: GeneralSettings;
  // 用户资料（昵称 + 内置头像 id,持久化）。会话中 who="me" 的气泡据此渲染。
  profile: PersonalProfile;
  // 「最后一次使用」记忆（持久化;Spotlight/新会话默认沿用）。
  lastAgent?: AgentKind;
  lastModel?: string;
  lastProviderId?: string;
  // 最近活跃项目（持久化;浮层默认归属推导用,归档/删除该项目时清空）。
  lastActiveProjectId?: string;
  // 落地页激励问候语的「按天」LLM 增强缓存（持久化;跨天失效,失败不写）。
  dailyEncouragement?: DailyEncouragement;
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
  setDerivedAgents: (agents: DerivedAgentMeta[]) => void;
  setRoles: (roles: RoleConfig[]) => void;
  // 供应商注册表:整体 patch + provider 级增删改 + 设默认。
  setProviderSettings: (patch: Partial<ProviderSettings>) => void;
  addProvider: (provider: ProviderProfile) => void;
  updateProvider: (id: string, patch: Partial<ProviderProfile>) => void;
  removeProvider: (id: string) => void;
  setProviderDefaults: (patch: { defaultProviderId?: string; defaultModel?: string }) => void;
  // 通用设置整体 patch（嵌套子对象由调用方 spread 现值）。
  setGeneralSettings: (patch: Partial<GeneralSettings>) => void;
  // 落地页每日激励文案 LLM 缓存:生成成功后按天写入（失败不写,保持静态兜底）。
  setDailyEncouragement: (value: DailyEncouragement) => void;
  // 插件 Skill 配置 setter（U6）:逐项启用/禁用（scope:name 复合键）、工作区授信、全局根增删。
  togglePiSkill: (scope: string, name: string, enabled: boolean) => void;
  trustWorkspaceSkill: (dir: string, trusted: boolean) => void;
  addGlobalSkillRoot: (path: string) => void;
  removeGlobalSkillRoot: (path: string) => void;
  // pi 扩展市场 setter（U2）:装≠启用——enabled/trusted 默认空,opt-in;溯源安装时持久化。复合键 `${scope}:${ref}`。
  recordInstalledExtension: (record: InstalledExtensionRecord) => void; // 安装成功后 upsert 溯源
  removeInstalledExtension: (scope: string, ref: string) => void; // 卸载:清溯源 + 启用 + 信任
  toggleExtension: (scope: string, ref: string, enabled: boolean) => void; // 启用/禁用
  trustExtension: (scope: string, ref: string, trusted: boolean) => void; // 过/撤信任门
  // 插件市场 setter（U5）:启停（opt-in）+ 信任（默认已授信，仅记显式撤信）。键 = 插件 id。
  togglePlugin: (id: string, enabled: boolean) => void;
  setPluginTrusted: (id: string, trusted: boolean) => void;
  // 浏览器控制 setter（U1）:总开关/CDP 经 patch;非本地导航白名单单独增删（去重）。
  setBrowserControl: (patch: Partial<BrowserControlSettings>) => void;
  addApprovedOrigin: (origin: string) => void;
  removeApprovedOrigin: (origin: string) => void;
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
  toggleTaskCollapse: (id: string) => void;
  setRunning: (sessionId: string, runId: string | undefined) => void;
  // 合并/清空某 pi 会话的运行时状态（patch=undefined 整体清空,如轮结束/会话退出）。
  setPiRuntime: (sessionId: string, patch: Partial<PiRuntimeStatus> | undefined) => void;
  // 设置/清空某会话的运行模式拦截提示（hint=undefined 清空,如切档/忽略/新发送）。
  setModeBlockHint: (sessionId: string, hint: ModeBlockHint | undefined) => void;
  // pi extension UI 待确认请求:入队 / 按会话+请求 id 出队 / 清某会话全部（会话退出/删除时）。
  pushPiUiRequest: (item: { uiSessionId: string; request: PiUiRequest }) => void;
  resolvePiUiRequest: (uiSessionId: string, id: string) => void;
  clearPiUiForSession: (uiSessionId: string) => void;
  toggleTerminal: () => void;
  // 发送文本到终端:暂存并确保终端面板打开,由 TerminalPanel 消费。
  sendToTerminal: (text: string) => void;
  // 原子消费待发送文本（TermSession spawn 完成 / 面板 effect 双路触发,先到先得）。
  consumePendingTerminalText: () => string | undefined;
  insertToComposer: (
    text: string,
    opts?: { submit?: boolean; plugin?: { id: string; name: string; icon?: string }; images?: PendingImage[] },
  ) => void;
  // GitBar 点击 ± 徽章:右栏切到文件视图并请求整仓 diff 预览。
  requestGitDiff: (projectId: string) => void;
  consumeGitDiffRequest: () => { projectId: string } | undefined;
  // 首页点 Task:右栏切到 Tasks 视图并请求打开该 task 文件详情。
  requestTaskDetail: (req: { projectId: string; path: string; name: string }) => void;
  consumeTaskDetailRequest: () => { projectId: string; path: string; name: string } | undefined;
  // 会话消息文件链接点击:右栏切到文件视图并请求预览该文件（path 为绝对路径）。
  requestFilePreview: (req: { projectId: string; path: string; name: string }) => void;
  consumeFilePreviewRequest: () => { projectId: string; path: string; name: string } | undefined;
  // 收件箱/时间线点闪记:右栏切到 notes 视图并请求打开该闪记详情（消费即清,仿 filePreview）。
  requestNoteDetail: (req: { noteId: string }) => void;
  consumeNoteDetailRequest: () => { noteId: string } | undefined;
  // 在内嵌浏览器打开 URL:右栏切到 browser 视图并请求加载(右栏开关由调用方补,同 requestGitDiff)。
  requestBrowserUrl: (url: string) => void;
  // auto_open 去重:记录已自动打开的「会话:URL」键。
  markAutoOpenedPreview: (key: string) => void;
  setRightView: (view: RightView) => void;
  // 传 undefined 恢复自动宽度（双击拖拽条重置）。
  setRightPanelWidth: (width: number | undefined) => void;
  setProjectsDetailWidth: (width: number | undefined) => void;
  openTimeline: (projectId: string) => void;
  closeTimeline: () => void;
  openHome: () => void;
  openAutomation: () => void;
  // 打开/关闭 loop 工作流主区视图（优先级最高,互斥清其它视图标志）。
  openWorkflow: () => void;
  closeWorkflow: () => void;
  // 打开/关闭设置整页（settingsOpen 瞬态;openSettings 不清底层视图标志,见实现注释）。
  openSettings: () => void;
  closeSettings: () => void;
  // 点击某条闪记进入中心区宽写作面;互斥清理其他中心视图。closeNoteEditor 返回列表态。
  openNoteEditor: (noteId: string) => void;
  closeNoteEditor: () => void;
  setTimelineSettings: (patch: Partial<TimelineSettings>) => void;
  setPushSettings: (patch: Partial<PushSettings>) => void;
  setTtsSettings: (patch: Partial<TtsSettings>) => void;
  // 媒体生成设置 patch（浅合并整体 MediaGenSettings;单模态字段由调用方 spread 现值）。
  setMediaGenSettings: (patch: Partial<MediaGenSettings>) => void;
  // 语音识别设置 patch（浅合并;与 setTtsSettings 模式一致）。
  setAsrSettings: (patch: Partial<AsrSettings>) => void;
  // 用户资料 patch（浅合并;允许只改昵称或只改头像）。
  setProfile: (patch: Partial<PersonalProfile>) => void;
}

function baseName(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

// 旧版本持久化字段（仅 hydrate 向后兼容迁移用,新代码不写这些名字）。
type LegacyPersisted = PersistedState & {
  piSettings?: {
    channels?: { id: string; label?: string; baseUrl?: string; apiKey?: string; models?: { id: string; label?: string }[]; enabled?: boolean }[];
    defaultChannelId?: string;
    defaultModel?: string;
  };
  lastPiChannelId?: string;
};

// providerSettings 解析：新档直接用（逐个 normalize 兜底）；旧档 piSettings.channels
// 迁移为 providers；两者都无则空注册表。
function resolveProviderSettings(s: PersistedState): ProviderSettings {
  if (s.providerSettings?.providers) {
    return {
      providers: s.providerSettings.providers.map(normalizeProviderProfile),
      defaultProviderId: s.providerSettings.defaultProviderId,
      defaultModel: s.providerSettings.defaultModel,
    };
  }
  const legacy = s as LegacyPersisted;
  if (legacy.piSettings?.channels) return migratePiSettings(legacy.piSettings);
  return DEFAULT_PROVIDER_SETTINGS;
}

// 通用设置 hydrate：完整透传顶层字段（workspaceRoot / notesHotkey / piCustomization /
// piThinkingDefault / piSystemPrompt 等），再以 DEFAULT_GENERAL_SETTINGS 逐层补全嵌套子对象。
// 注意：务必整体 spread `...g` 而非逐字段重建——后者会静默丢掉任何未显式列出的字段（可选字段连
// typecheck 都不报），曾导致 piCustomization 重启即失效。新增顶层设置字段无需再改本函数。
function resolveGeneralSettings(s: PersistedState): GeneralSettings {
  const g = s.generalSettings;
  if (!g) return DEFAULT_GENERAL_SETTINGS;
  return {
    ...DEFAULT_GENERAL_SETTINGS,
    ...g,
    desktopBehavior: { ...DEFAULT_GENERAL_SETTINGS.desktopBehavior, ...g.desktopBehavior },
    notifications: { ...DEFAULT_GENERAL_SETTINGS.notifications, ...g.notifications },
    log: { ...DEFAULT_GENERAL_SETTINGS.log, ...g.log },
    // 插件 Skill 配置:旧档无 piSkills 或缺子字段时,逐字段兜 DEFAULT_PI_SKILLS（U6）。
    // globalRoots 是「内置默认根」、用户不可编辑（setter 只动 userGlobalRoots）,故恒由代码
    // 拥有——强制覆盖持久化值,使默认根变更（如 ~/.agent → ~/.agents）对老档即时生效。
    piSkills: { ...DEFAULT_PI_SKILLS, ...g.piSkills, globalRoots: DEFAULT_PI_SKILLS.globalRoots },
    // pi 扩展市场:旧档无 piExtensions 或缺子字段时兜 DEFAULT_PI_EXTENSIONS（U2）。
    piExtensions: { ...DEFAULT_PI_EXTENSIONS, ...g.piExtensions },
    // 插件市场启停/信任:旧档无 plugins 或缺子字段时兜 DEFAULT_PLUGIN_ENABLE（U5）。
    plugins: { ...DEFAULT_PLUGIN_ENABLE, ...g.plugins },
    // 浏览器控制:旧档无 browserControl 或缺子字段时逐字段兜 DEFAULT_BROWSER_CONTROL（U1）。
    browserControl: { ...DEFAULT_BROWSER_CONTROL, ...g.browserControl },
  };
}

// 老会话字段迁移（剥离旧名,避免死字段随快照回写）。field-presence 驱动,不 bump version。
function migrateSession(sess: SessionMeta): SessionMeta {
  let s = sess;
  // ① piChannelId → providerId。
  const legacy = s as SessionMeta & { piChannelId?: string };
  if (legacy.piChannelId !== undefined) {
    const { piChannelId, ...rest } = legacy;
    s = { ...rest, providerId: rest.providerId ?? piChannelId };
  }
  // ② 旧权限两轴 permissionMode/approvalPolicy → 新两轴 execPermission/dirPermission（无损,见
  //    fromAdapterPermissions）。仅当老会话尚无新字段、且带旧字段时迁移;缺省老会话不动,运行时回退 auto/all。
  const old = s as SessionMeta & { permissionMode?: PermissionMode; approvalPolicy?: ApprovalPolicy };
  if (s.execPermission === undefined && (old.permissionMode !== undefined || old.approvalPolicy !== undefined)) {
    const { permissionMode, approvalPolicy, ...rest } = old;
    s = { ...rest, ...fromAdapterPermissions(permissionMode, approvalPolicy) };
  }
  return s;
}

export const usePersonalStore = create<PersonalState>((set, get) => ({
  hydrated: false,
  projects: [],
  sessions: [],
  todos: [],
  collapsedProjects: {},
  collapsedTasks: {},
  runningBySession: {},
  piRuntimeBySession: {},
  modeBlockHints: {},
  piUiPending: [],
  autoOpenedPreviewKeys: [],
  terminalOpen: false,
  rightView: "todos" as const,
  homeOpen: true,
  automationOpen: false,
  workflowOpen: false,
  settingsOpen: false,
  timelineSettings: DEFAULT_TIMELINE_SETTINGS,
  pushSettings: DEFAULT_PUSH_SETTINGS,
  ttsSettings: DEFAULT_TTS_SETTINGS,
  mediaGenSettings: defaultMediaGenSettings(),
  asrSettings: defaultAsrSettings(),
  providerSettings: DEFAULT_PROVIDER_SETTINGS,
  generalSettings: DEFAULT_GENERAL_SETTINGS,
  profile: {},
  roles: [],
  hydrate: (s) =>
    set({
      hydrated: true,
      projects: s.projects,
      promptRoot: s.promptRoot,
      sessions: s.sessions.map(migrateSession),
      todos: s.todos ?? [],
      timelineSettings: s.timelineSettings ?? DEFAULT_TIMELINE_SETTINGS,
      // 兼容迁移:旧版本推送渠道存在 timelineSettings.push 下。
      pushSettings:
        s.pushSettings ??
        (s.timelineSettings as undefined | { push?: PushSettings })?.push ??
        DEFAULT_PUSH_SETTINGS,
      ttsSettings: s.ttsSettings ?? DEFAULT_TTS_SETTINGS,
      // 媒体生成/ASR：旧档无此字段时回落工厂默认（向后兼容）。
      // 各模态子字段全量覆盖（无 deep merge），旧档缺字段时整体回落工厂对象。
      mediaGenSettings: s.mediaGenSettings ?? defaultMediaGenSettings(),
      asrSettings: s.asrSettings ?? defaultAsrSettings(),
      // providerSettings：新档直接用；旧档 piSettings.channels 迁移；都没有则空。
      providerSettings: resolveProviderSettings(s),
      // 通用设置：嵌套子对象逐层以默认值补全。
      generalSettings: resolveGeneralSettings(s),
      // 旧存档无 profile 字段 → 回退空对象（会话渲染走默认昵称/头像）。
      profile: s.profile ?? {},
      rightPanelWidth: s.rightPanelWidth,
      projectsDetailWidth: s.projectsDetailWidth,
      lastAgent: s.lastAgent,
      lastModel: s.lastModel,
      // 旧档字段名 lastPiChannelId → lastProviderId。
      lastProviderId: s.lastProviderId ?? (s as LegacyPersisted).lastPiChannelId,
      lastActiveProjectId: s.lastActiveProjectId,
      dailyEncouragement: s.dailyEncouragement,
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
      lastActiveProjectId: s.lastActiveProjectId === id ? undefined : s.lastActiveProjectId,
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
      // 归档项目不应再作默认归属拉起。
      lastActiveProjectId: s.lastActiveProjectId === id ? undefined : s.lastActiveProjectId,
    })),

  setAgentsAvailable: (avail) => set({ agentsAvailable: avail }),
  setDerivedAgents: (agents) => set({ derivedAgents: agents }),
  setRoles: (roles) => set({ roles }),

  setProviderSettings: (patch) => set((s) => ({ providerSettings: { ...s.providerSettings, ...patch } })),

  addProvider: (provider) =>
    set((s) => ({
      providerSettings: { ...s.providerSettings, providers: [...s.providerSettings.providers, provider] },
    })),

  updateProvider: (id, patch) =>
    set((s) => {
      const providers = s.providerSettings.providers.map((p) => (p.id === id ? { ...p, ...patch } : p));
      // 停用当前默认 provider 时,清掉默认指向（避免新会话/下拉默认挂到停用项,
      // 与运行时 enabled 过滤保持单一真值）。
      const disablingDefault = patch.enabled === false && s.providerSettings.defaultProviderId === id;
      return {
        providerSettings: {
          ...s.providerSettings,
          providers,
          defaultProviderId: disablingDefault ? undefined : s.providerSettings.defaultProviderId,
          defaultModel: disablingDefault ? undefined : s.providerSettings.defaultModel,
        },
      };
    }),

  removeProvider: (id) =>
    set((s) => {
      const providers = s.providerSettings.providers.filter((p) => p.id !== id);
      // 删掉的 provider 若是默认,一并清掉默认指向。
      const defaultProviderId =
        s.providerSettings.defaultProviderId === id ? undefined : s.providerSettings.defaultProviderId;
      const defaultModel =
        s.providerSettings.defaultProviderId === id ? undefined : s.providerSettings.defaultModel;
      return { providerSettings: { ...s.providerSettings, providers, defaultProviderId, defaultModel } };
    }),

  setProviderDefaults: (patch) => set((s) => ({ providerSettings: { ...s.providerSettings, ...patch } })),

  setGeneralSettings: (patch) => set((s) => ({ generalSettings: { ...s.generalSettings, ...patch } })),
  setDailyEncouragement: (value) => set({ dailyEncouragement: value }),

  // ── 插件 Skill 配置 setter（U6）──────────────────────────────────────────────
  // 现值兜底 DEFAULT_PI_SKILLS（旧档/缺字段安全）；整体写回 generalSettings.piSkills。
  togglePiSkill: (scope, name, enabled) =>
    set((s) => {
      const cur: PiSkillSettings = { ...DEFAULT_PI_SKILLS, ...s.generalSettings.piSkills };
      const key = `${scope}:${name}`;
      const disabledSkills = enabled
        ? cur.disabledSkills.filter((k) => k !== key)
        : cur.disabledSkills.includes(key)
          ? cur.disabledSkills
          : [...cur.disabledSkills, key];
      return { generalSettings: { ...s.generalSettings, piSkills: { ...cur, disabledSkills } } };
    }),

  trustWorkspaceSkill: (dir, trusted) =>
    set((s) => {
      const cur: PiSkillSettings = { ...DEFAULT_PI_SKILLS, ...s.generalSettings.piSkills };
      const trustedWorkspaceSkillDirs = trusted
        ? cur.trustedWorkspaceSkillDirs.includes(dir)
          ? cur.trustedWorkspaceSkillDirs
          : [...cur.trustedWorkspaceSkillDirs, dir]
        : cur.trustedWorkspaceSkillDirs.filter((d) => d !== dir);
      return { generalSettings: { ...s.generalSettings, piSkills: { ...cur, trustedWorkspaceSkillDirs } } };
    }),

  addGlobalSkillRoot: (path) =>
    set((s) => {
      const cur: PiSkillSettings = { ...DEFAULT_PI_SKILLS, ...s.generalSettings.piSkills };
      const trimmed = path.trim();
      // 已是内置默认根或已加过 → 不重复。
      if (!trimmed || cur.globalRoots.includes(trimmed) || cur.userGlobalRoots.includes(trimmed)) return {};
      return {
        generalSettings: {
          ...s.generalSettings,
          piSkills: { ...cur, userGlobalRoots: [...cur.userGlobalRoots, trimmed] },
        },
      };
    }),

  removeGlobalSkillRoot: (path) =>
    set((s) => {
      const cur: PiSkillSettings = { ...DEFAULT_PI_SKILLS, ...s.generalSettings.piSkills };
      // 仅允许删用户自增根;内置默认根不可删。
      if (!cur.userGlobalRoots.includes(path)) return {};
      return {
        generalSettings: {
          ...s.generalSettings,
          piSkills: { ...cur, userGlobalRoots: cur.userGlobalRoots.filter((r) => r !== path) },
        },
      };
    }),

  // ── pi 扩展市场 setter（U2）─────────────────────────────────────────────────
  // 现值兜底 DEFAULT_PI_EXTENSIONS；整体写回 generalSettings.piExtensions。复合键 `${scope}:${ref}`。
  recordInstalledExtension: (record) =>
    set((s) => {
      const cur: PiExtensionSettings = { ...DEFAULT_PI_EXTENSIONS, ...s.generalSettings.piExtensions };
      // upsert:同 scope:ref 覆盖（重装/更新刷新溯源），否则追加。
      const others = cur.installed.filter((r) => !(r.scope === record.scope && r.ref === record.ref));
      return {
        generalSettings: {
          ...s.generalSettings,
          piExtensions: { ...cur, installed: [...others, record] },
        },
      };
    }),

  removeInstalledExtension: (scope, ref) =>
    set((s) => {
      const cur: PiExtensionSettings = { ...DEFAULT_PI_EXTENSIONS, ...s.generalSettings.piExtensions };
      const key = `${scope}:${ref}`;
      return {
        generalSettings: {
          ...s.generalSettings,
          piExtensions: {
            ...cur,
            installed: cur.installed.filter((r) => !(r.scope === scope && r.ref === ref)),
            enabled: cur.enabled.filter((k) => k !== key),
            trusted: cur.trusted.filter((k) => k !== key),
          },
        },
      };
    }),

  toggleExtension: (scope, ref, enabled) =>
    set((s) => {
      const cur: PiExtensionSettings = { ...DEFAULT_PI_EXTENSIONS, ...s.generalSettings.piExtensions };
      const key = `${scope}:${ref}`;
      const next = enabled
        ? cur.enabled.includes(key)
          ? cur.enabled
          : [...cur.enabled, key]
        : cur.enabled.filter((k) => k !== key);
      return { generalSettings: { ...s.generalSettings, piExtensions: { ...cur, enabled: next } } };
    }),

  trustExtension: (scope, ref, trusted) =>
    set((s) => {
      const cur: PiExtensionSettings = { ...DEFAULT_PI_EXTENSIONS, ...s.generalSettings.piExtensions };
      const key = `${scope}:${ref}`;
      const next = trusted
        ? cur.trusted.includes(key)
          ? cur.trusted
          : [...cur.trusted, key]
        : cur.trusted.filter((k) => k !== key);
      return { generalSettings: { ...s.generalSettings, piExtensions: { ...cur, trusted: next } } };
    }),

  // ── 插件市场 setter（U5）─────────────────────────────────────────────────────
  // 现值兜底 DEFAULT_PLUGIN_ENABLE；整体写回 generalSettings.plugins。键 = 插件 id。
  togglePlugin: (id, enabled) =>
    set((s) => {
      const cur: PluginEnableSettings = { ...DEFAULT_PLUGIN_ENABLE, ...s.generalSettings.plugins };
      const next = enabled
        ? cur.enabled.includes(id)
          ? cur.enabled
          : [...cur.enabled, id]
        : cur.enabled.filter((k) => k !== id);
      return { generalSettings: { ...s.generalSettings, plugins: { ...cur, enabled: next } } };
    }),

  // 默认已授信:trusted=false → 加入 distrusted（撤信）；trusted=true → 移出 distrusted。
  setPluginTrusted: (id, trusted) =>
    set((s) => {
      const cur: PluginEnableSettings = { ...DEFAULT_PLUGIN_ENABLE, ...s.generalSettings.plugins };
      const next = trusted
        ? cur.distrusted.filter((k) => k !== id)
        : cur.distrusted.includes(id)
          ? cur.distrusted
          : [...cur.distrusted, id];
      return { generalSettings: { ...s.generalSettings, plugins: { ...cur, distrusted: next } } };
    }),

  // ── 浏览器控制 setter（U1）─────────────────────────────────────────────────
  // 现值兜底 DEFAULT_BROWSER_CONTROL；patch 不覆盖未传字段;白名单增删去重。
  setBrowserControl: (patch) =>
    set((s) => ({
      generalSettings: {
        ...s.generalSettings,
        browserControl: { ...DEFAULT_BROWSER_CONTROL, ...s.generalSettings.browserControl, ...patch },
      },
    })),
  addApprovedOrigin: (origin) =>
    set((s) => {
      const cur: BrowserControlSettings = { ...DEFAULT_BROWSER_CONTROL, ...s.generalSettings.browserControl };
      const next = cur.approvedOrigins.includes(origin) ? cur.approvedOrigins : [...cur.approvedOrigins, origin];
      return { generalSettings: { ...s.generalSettings, browserControl: { ...cur, approvedOrigins: next } } };
    }),
  removeApprovedOrigin: (origin) =>
    set((s) => {
      const cur: BrowserControlSettings = { ...DEFAULT_BROWSER_CONTROL, ...s.generalSettings.browserControl };
      return {
        generalSettings: {
          ...s.generalSettings,
          browserControl: { ...cur, approvedOrigins: cur.approvedOrigins.filter((o) => o !== origin) },
        },
      };
    }),

  setPromptRoot: (root, tree) => set({ promptRoot: root, promptTree: tree }),
  setPromptTree: (tree) => set({ promptTree: tree }),

  createSession: (projectId, agent, model, opts) => {
    const now = Date.now();
    // count 仍按 projectId 分桶（undefined 自成「无项目」分桶,各自从 1 开始编号）。
    const count = get().sessions.filter((x) => x.projectId === projectId).length;
    // pi:挂上默认 provider 与模型（缺省取默认 provider 首个模型）,无 provider 则留空待配置。
    const providerSettings = get().providerSettings;
    const provider =
      agent === "pi"
        ? providerSettings.providers.find((p) => p.id === providerSettings.defaultProviderId && p.enabled)
        : undefined;
    const sess: SessionMeta = {
      id: newId("sess"),
      projectId,
      // 无项目会话记下创建时定下的工作目录（cli:start 直接用此 cwd,不漂移）。
      noProjectDir: projectId ? undefined : opts?.noProjectDir,
      title: `Session ${count + 1}`,
      agent,
      model:
        agent === "pi"
          ? model ?? providerSettings.defaultModel ?? provider?.models[0]?.id
          : model ?? DEFAULT_MODEL[agent],
      // 只挂启用的默认 provider（provider 已按 enabled 过滤;停用/无则留空走 pi 内置）。
      providerId: agent === "pi" ? provider?.id : undefined,
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
      workflowOpen: false,
      settingsOpen: false,
      // 记忆本次选择（下次 Spotlight/新会话默认沿用;用 sess.* 取已 resolve 的值）。
      lastAgent: agent,
      lastModel: sess.model,
      lastProviderId: sess.providerId,
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
      // 空标题持久化为空串,渲染时再用 t("common:todoUntitled") 兜底,避免把语言冻进存档。
      title: title.trim(),
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
      // 选中会话即离开时间线/首页/工作流视图。
      return {
        activeSessionId: sessionId,
        activeProjectId: sess?.projectId ?? s.activeProjectId,
        // 无项目会话不覆盖（保留上一个有效项目作浮层默认归属）。
        lastActiveProjectId: sess?.projectId ?? s.lastActiveProjectId,
        timelineProjectId: undefined,
        homeOpen: false,
        automationOpen: false,
        workflowOpen: false,
        noteEditorId: undefined,
        settingsOpen: false,
      };
    }),

  activateProject: (projectId) =>
    set({
      activeProjectId: projectId,
      lastActiveProjectId: projectId,
      activeSessionId: undefined,
      timelineProjectId: undefined,
      homeOpen: false,
      automationOpen: false,
      workflowOpen: false,
      noteEditorId: undefined,
      settingsOpen: false,
    }),

  toggleProjectCollapse: (id) =>
    set((s) => ({ collapsedProjects: { ...s.collapsedProjects, [id]: !s.collapsedProjects[id] } })),
  toggleTaskCollapse: (id) =>
    set((s) => ({ collapsedTasks: { ...s.collapsedTasks, [id]: !s.collapsedTasks[id] } })),

  setRunning: (sessionId, runId) =>
    set((s) => ({ runningBySession: { ...s.runningBySession, [sessionId]: runId } })),

  setPiRuntime: (sessionId, patch) =>
    set((s) => ({
      piRuntimeBySession: {
        ...s.piRuntimeBySession,
        [sessionId]: patch === undefined ? undefined : { ...s.piRuntimeBySession[sessionId], ...patch },
      },
    })),

  setModeBlockHint: (sessionId, hint) =>
    set((s) => ({ modeBlockHints: { ...s.modeBlockHints, [sessionId]: hint } })),

  pushPiUiRequest: (item) => set((s) => ({ piUiPending: [...s.piUiPending, item] })),
  resolvePiUiRequest: (uiSessionId, id) =>
    set((s) => ({ piUiPending: s.piUiPending.filter((p) => p.uiSessionId !== uiSessionId || p.request.id !== id) })),
  clearPiUiForSession: (uiSessionId) =>
    set((s) => ({ piUiPending: s.piUiPending.filter((p) => p.uiSessionId !== uiSessionId) })),

  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),

  sendToTerminal: (text) => set({ pendingTerminalText: text, terminalOpen: true }),

  consumePendingTerminalText: () => {
    const text = get().pendingTerminalText;
    if (text !== undefined) set({ pendingTerminalText: undefined });
    return text;
  },

  insertToComposer: (text, opts) =>
    set((s) => ({
      composerInsert: {
        text,
        nonce: (s.composerInsert?.nonce ?? 0) + 1,
        submit: opts?.submit,
        plugin: opts?.plugin,
        images: opts?.images,
      },
    })),

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

  // 会话消息点文件链接:切右栏到文件视图并存请求,FilesView 消费后 openFile 预览。
  // 右栏开关(rightOpen,属 useCortexUIStore)由调用方补,与 requestGitDiff/TaskDetail 一致。
  requestFilePreview: (req) => set({ filePreviewRequest: req, rightView: "files" }),

  consumeFilePreviewRequest: () => {
    const req = get().filePreviewRequest;
    if (req) set({ filePreviewRequest: undefined });
    return req;
  },

  // 收件箱/时间线点闪记:切右栏到 notes 视图并存请求,NotesView 消费后打开详情。
  // 消费即清而非 nonce:NotesView 可能在请求发出时未挂载,取出即清才能让挂载后 effect 接到。
  requestNoteDetail: (req) => set({ noteDetailRequest: req, rightView: "notes" }),

  consumeNoteDetailRequest: () => {
    const req = get().noteDetailRequest;
    if (req) set({ noteDetailRequest: undefined });
    return req;
  },

  requestBrowserUrl: (url) =>
    set((s) => ({
      browserUrlRequest: { url, nonce: (s.browserUrlRequest?.nonce ?? 0) + 1 },
      rightView: "browser",
    })),
  markAutoOpenedPreview: (key) =>
    set((s) =>
      s.autoOpenedPreviewKeys.includes(key)
        ? s
        : // 仅留最近 50 条,防长会话无限增长。
          { autoOpenedPreviewKeys: [...s.autoOpenedPreviewKeys, key].slice(-50) },
    ),
  setRightView: (view) => set({ rightView: view }),

  setRightPanelWidth: (width) => set({ rightPanelWidth: width }),
  setProjectsDetailWidth: (width) => set({ projectsDetailWidth: width }),

  openTimeline: (projectId) =>
    set({ timelineProjectId: projectId, activeProjectId: projectId, homeOpen: false, automationOpen: false, workflowOpen: false, noteEditorId: undefined, settingsOpen: false }),
  closeTimeline: () => set({ timelineProjectId: undefined }),

  // 回首页时右栏同步切回 todos（全部项目列表）——项目内的文件/Skills 面板
  // 是项目上下文,不应停留在首页。
  openHome: () => set({ homeOpen: true, automationOpen: false, workflowOpen: false, timelineProjectId: undefined, noteEditorId: undefined, settingsOpen: false, rightView: "todos" }),

  // 进入自动化主区视图（互斥清其它视图字段）。
  openAutomation: () =>
    set({ automationOpen: true, workflowOpen: false, homeOpen: false, timelineProjectId: undefined, activeSessionId: undefined, noteEditorId: undefined, settingsOpen: false }),

  // 进入 loop 工作流主区视图（优先级最高,互斥清其它视图字段）。
  openWorkflow: () =>
    set({ workflowOpen: true, automationOpen: false, homeOpen: false, timelineProjectId: undefined, activeSessionId: undefined, noteEditorId: undefined, settingsOpen: false }),
  closeWorkflow: () => set({ workflowOpen: false }),

  // 点击闪记进入中心区写作面：互斥清其它中心视图;noteEditorId 瞬态,不进 toPersistedState。
  openNoteEditor: (noteId) =>
    set({ noteEditorId: noteId, homeOpen: false, automationOpen: false, workflowOpen: false, timelineProjectId: undefined, settingsOpen: false }),
  closeNoteEditor: () => set({ noteEditorId: undefined }),

  // 设置整页：openSettings 仅置 settingsOpen（不清 homeOpen/timelineProjectId 等底层标志,
  // 故 closeSettings 后自然回到打开设置前的视图）;互斥由各 open 入口清 settingsOpen 保证。
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  setTimelineSettings: (patch) =>
    set((s) => ({ timelineSettings: { ...s.timelineSettings, ...patch } })),

  setPushSettings: (patch) =>
    set((s) => ({ pushSettings: { ...s.pushSettings, ...patch } })),

  setTtsSettings: (patch) =>
    set((s) => ({ ttsSettings: { ...s.ttsSettings, ...patch } })),

  setMediaGenSettings: (patch) =>
    set((s) => ({ mediaGenSettings: { ...s.mediaGenSettings, ...patch } })),

  setAsrSettings: (patch) =>
    set((s) => ({ asrSettings: { ...s.asrSettings, ...patch } })),

  setProfile: (patch) =>
    set((s) => ({ profile: { ...s.profile, ...patch } })),
}));

// 用户资料 selector（会话渲染 / 设置页共用;窄订阅 profile 切片）。
export function usePersonalProfile(): PersonalProfile {
  return usePersonalStore((s) => s.profile);
}

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
    mediaGenSettings: s.mediaGenSettings,
    asrSettings: s.asrSettings,
    providerSettings: s.providerSettings,
    generalSettings: s.generalSettings,
    profile: s.profile,
    rightPanelWidth: s.rightPanelWidth,
    projectsDetailWidth: s.projectsDetailWidth,
    lastAgent: s.lastAgent,
    lastModel: s.lastModel,
    lastProviderId: s.lastProviderId,
    lastActiveProjectId: s.lastActiveProjectId,
    dailyEncouragement: s.dailyEncouragement,
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

// 解析「新会话默认 agent」：优先用户在设置里指定的 generalSettings.defaultAgent
// （pi 恒可用,其余须已安装）;未设置或所选不可用则回退按安装情况派生（claude>codex>pi）。
// 校验范式与 initialAgent 一致。落地页激励文案的每日 LLM 增强也用它选 agent。
export function resolveDefaultAgent(
  s: Pick<PersonalState, "generalSettings" | "agentsAvailable">,
): AgentKind {
  const pref = s.generalSettings.defaultAgent;
  if (pref && (pref === "pi" || s.agentsAvailable?.[pref])) return pref;
  return defaultAgent(s.agentsAvailable);
}

// Spotlight/新会话发起的初始 agent:优先记忆,回退按安装情况派生（记忆 agent 不可用则回退）。
export function initialAgent(s: Pick<PersonalState, "lastAgent" | "agentsAvailable">): AgentKind {
  if (s.lastAgent && (s.lastAgent === "pi" || s.agentsAvailable?.[s.lastAgent])) return s.lastAgent;
  return defaultAgent(s.agentsAvailable);
}

// 与 initialAgent 配对的初始模型/供应商（pi 走 provider;其余 lastModel 仅同 agent 时沿用,否则取该 agent 默认）。
export function initialModelDraft(
  s: Pick<PersonalState, "lastAgent" | "lastModel" | "lastProviderId" | "agentsAvailable" | "providerSettings">,
): { agent: AgentKind; model: string | undefined; providerId: string | undefined } {
  const agent = initialAgent(s);
  const sameAgent = agent === s.lastAgent;
  if (agent === "pi") {
    // 仅在启用的 provider 中选默认（停用项不挂到新会话/草稿）。
    const enabled = s.providerSettings.providers.filter((p) => p.enabled);
    const provider =
      enabled.find((p) => p.id === (s.lastProviderId ?? s.providerSettings.defaultProviderId)) ?? enabled[0];
    return {
      agent,
      model: (sameAgent ? s.lastModel : undefined) ?? s.providerSettings.defaultModel ?? provider?.models[0]?.id,
      providerId: provider?.id,
    };
  }
  return { agent, model: (sameAgent ? s.lastModel : undefined) ?? DEFAULT_MODEL[agent], providerId: undefined };
}
