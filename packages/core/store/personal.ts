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
  LegacyProviderCleanupMark,
  DefaultModelRef,
  ProjectMeta,
  PromptNode,
  PushSettings,
  SessionMeta,
  SpotlightIntent,
  TimelineSettings,
  TodoMeta,
  TtsSettings,
  VoiceSettings,
  DesignSettings,
  DesignDocMeta,
  DesignUiState,
} from "../desktop/types";
// 设计设置的默认值/归一化逻辑在 design compat 层(移植自 Kun,与类型分离)。
import { defaultDesignSettings, normalizeDesignSettings } from "../design/compat/app-settings";
import {
  DEFAULT_AGENT_SKILL_ROOTS,
  DEFAULT_SHARED_SKILL_ROOTS,
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
  normalizeMediaGenSettings,
  defaultAsrSettings,
  defaultVoiceSettings,
  DEFAULT_WRITING_LLM_SETTINGS,
  clampWritingDebounceMs,
  clampWritingMaxTokens,
} from "../desktop/types";
import type { WritingLlmSettings } from "../desktop/types";
import { migratePiSettings, normalizeProviderProfile } from "../desktop/providers";
import { fromAdapterPermissions } from "../personal/permissionMode";
import { migrateProfile } from "../personal/avatars";

let seq = 0;
function newId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

// 右栏当前视图（顶栏下拉选择）。后续新增视图只需扩此联合,不必逐处改字面量。
export type RightView =
  | "files"
  | "skills"
  | "todos"
  | "notes"
  | "browser"
  | "artifact"
  | "research"
  // 知识库文档预览（点会话正文里的 kb:// 引用打开）。
  | "knowledge";

// 运行模式拦截提示（瞬态,不持久化）。当 plan 模式下 agent 尝试被该模式禁止的工具(写/执行)时,
// 在 composer 上方提示用户一键切「自动执行」并自动重发本轮(仅 plan 会触发,见 restrictedToolForMode)。
export interface ModeBlockHint {
  // edit=写类;exec=执行类;tool=plan 档白名单外工具(含扩展自定义工具)。仅影响提示文案。
  category: "edit" | "exec" | "tool";
  promptText: string;
  toolName: string;
}

// 图片能力拦截提示（瞬态,不持久化）。当前会话选中的模型不支持图片输入、或 Catalog 里查不到
// 该模型（能力未知）时，send 会**拒绝发出本轮并保留草稿**，同时写入这条提示，由 composer 上方的
// VisionBlockBanner 渲染出「选择支持图片的模型」与「移除图片」两个出路。
//
// 为什么要区分 unsupported / unknown（研究文档 §5.1 的硬要求）：把「目录不知道」当成「明确不支持」
// 正是本次事故的形态之一——用户会以为模型真的不支持而去换模型，实际只是配置不完整。两态文案必须不同。
export interface VisionBlockHint {
  reason: "unsupported" | "unknown";
  /** 被拦下的模型引用（可能缺 modelId：会话尚未选定模型）。用于提示文案里回显具体模型。 */
  providerId?: string;
  modelId?: string;
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
  // Catalog 时代的全局默认模型引用（替代已废弃的 providerSettings.defaultProviderId/defaultModel）。
  // 新建会话 / 会话未指定模型时用它兜底；引用在 Catalog 中查不到或未认证时**不回退**，
  // 由消费方进「未配置模型」阻断态（计划 §5）——它绝不是一条绕过 §5 的静默回退路径。
  defaultModelRef?: DefaultModelRef;
  // 旧 providerSettings 一次性清理的留痕（主进程首启写入，渲染端只读镜像 + 原样透传）。
  //
  // ⚠️ 必须在 store 里留镜像：`toPersistedState` 是**白名单**构造，渲染端每次全量保存都用它
  // 整份覆盖磁盘——不在白名单里的字段会被抹掉，「Provider 配置已升级」的提示随之丢失。
  //（「显示/隐藏 Provider」偏好不在这里：它由主进程窄写进 main-owned 的 provider-prefs.json，
  // 经 ProviderAuthSnapshot.hiddenProviderIds 回读，正是为了绕开这个 clobber 问题。）
  legacyProviderSettingsCleared?: LegacyProviderCleanupMark;
  // 运行模式拦截提示（瞬态,不持久化;轮次检测到被拦工具时写,composer 上方读）。
  modeBlockHints: Record<string, ModeBlockHint | undefined>;
  // 图片能力拦截提示（瞬态,不持久化;send 判定当前模型不支持/未知图片能力时写,composer 上方读）。
  visionBlockHints: Record<string, VisionBlockHint | undefined>;
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
  // skill:落地页场景 chip「演示文稿 / 设计稿」预置的 skill 上下文,ComposerShell 消费时 setSelectedSkill
  //（等价用户在输入框敲 `/skill:xxx` 选中）。跨包契约:cmd 必须是 parseSkillSlash 认得的 `/skill:<name>`,
  //  displayName 仅用于 pill 展示。此路径的 text 通常为空串——纯预置 pill,由用户补主题后回车。
  composerInsert?: {
    text: string;
    nonce: number;
    submit?: boolean;
    plugin?: { id: string; name: string; icon?: string };
    images?: PendingImage[];
    skill?: { cmd: string; displayName: string };
  };
  // composer 当前选中的 skill pill。**单向镜像**:唯一写方是 ComposerShell(选中/发送/移除时同步),
  // 落地页 SceneChips 只读——据此在场景 chips 下方展示该 skill 的示例提示词。
  // 不做真源(pill 的真源仍是 ComposerShell 内部 state),避免会话切换时 pill 跨会话残留。
  // 瞬态,不进 toPersistedState。
  composerSkill?: { cmd: string; displayName: string };
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
  // 打开某篇知识库文档预览的请求(点会话正文里的 kb:// 引用)。右栏据此拉正文渲染;
  // nonce 让「同一篇再次点击」也能重新拉取(文档可能已更新)。瞬态,不进 toPersistedState。
  knowledgeDocRequest?: { sourceId: string; relPath: string; nonce: number };
  // 展开「执行过程」面板的请求(点聊天流 typing 活动行触发)。nonce 让同会话重复点击也能触发;
  // 用请求信号而非提升面板 userOpen,保留面板「每轮默认收起」的既有逻辑。瞬态,不进 toPersistedState。
  processPanelOpenReq?: { sessionId: string; nonce: number };
  // 已 auto_open 自动打开过的「会话:URL」键集合。防探测结果在重渲染/多会话来回切换中
  // 反复自动弹面板(同键不再触发)。用数组而非单槽,否则切到别的会话再切回会重复弹
  // (安全/正确性评审)。瞬态,不进 toPersistedState。
  autoOpenedPreviewKeys: string[];
  // 右栏当前视图（顶栏下拉选择）。
  rightView: RightView;
  // 右侧面板自定义宽度（px,拖拽调整,持久化）;undefined 走 CSS 自动档位。
  rightPanelWidth?: number;
  // 右侧面板放大态:绝对定位盖住中栏（产物编辑器用,见 .pw-prompts.is-maximized）。
  // 不持久化 —— 它是「这会儿想看大点」的临时姿态,不该跨重启粘住。
  rightPanelMaximized: boolean;
  // 右栏文件视图是否处于「文件打开」预览态（FilesView 本地 preview 的镜像,瞬态不持久化）。
  // 面板头据此决定 files 视图能否放大:列表态放大没有意义,预览态才开放。
  filePreviewOpen: boolean;
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
  // 主区设计工作台视图（AI 设计画布,desktop-only）。不持久化;与其它主区视图互斥。
  designOpen: boolean;
  // 当前打开的设计稿 id（进入设计视图时可指定;undefined = 设计首页/最近设计稿）。
  activeDesignDocId?: string;
  // 主区写作工作台视图（整窗覆盖层,desktop-only）。瞬态,不持久化（消掉 web 恢复白屏路径）;
  // 与其它主区视图互斥——所有 openXxx/切会话/切项目入口都清它。
  writingOpen: boolean;
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
  // 设计工作台三切片（持久化;与 PersistedState.designSettings/designDocs/designUi 镜像）:
  // designUi 是画布 UI 态 KV(替代 Kun localStorage,经 storage 适配器供 design 树读写)。
  designSettings: DesignSettings;
  designDocs: DesignDocMeta[];
  designUi: DesignUiState;
  // 语音识别设置（持久化;与 PersistedState.asrSettings 镜像）。
  asrSettings: AsrSettings;
  // 语音聊天与系统级听写的交互配置（持久化;引擎参数仍各自归属 ttsSettings/asrSettings）。
  voiceSettings: VoiceSettings;
  // 写作续写/改写(U3)独立模型配置（持久化;与 PersistedState.writingLlmSettings 镜像）。
  writingLlmSettings: WritingLlmSettings;
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
  // Design B(plan 002):根增删按目标类别——"shared"(共享,对三端) / 具体 AgentKind(该 agent 私有根)。
  addGlobalSkillRoot: (path: string, target: "shared" | AgentKind) => void;
  removeGlobalSkillRoot: (path: string, target: "shared" | AgentKind) => void;
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
  renameSession: (id: string, title: string) => void;
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
  // 请求展开「执行过程」面板(nonce 递增触发,面板侧 useEffect 消费)。
  requestOpenProcessPanel: (sessionId: string) => void;
  // 设置/清空某会话的运行模式拦截提示（hint=undefined 清空,如切档/忽略/新发送）。
  setModeBlockHint: (sessionId: string, hint: ModeBlockHint | undefined) => void;
  // 设置/清空某会话的图片能力拦截提示（hint=undefined 清空,如移除图片/换模型/新一轮发送）。
  setVisionBlockHint: (sessionId: string, hint: VisionBlockHint | undefined) => void;
  // 设置/清除全局默认模型引用（两个 id 必须成套；传 undefined = 清除）。
  setDefaultModelRef: (ref: DefaultModelRef | undefined) => void;
  // 「Provider 配置已升级」一次性提示：展示后置 true，随全量保存落盘，之后不再弹。
  acknowledgeLegacyProviderNotice: () => void;
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
    opts?: {
      submit?: boolean;
      plugin?: { id: string; name: string; icon?: string };
      images?: PendingImage[];
      skill?: { cmd: string; displayName: string };
    },
  ) => void;
  // ComposerShell 镜像当前 skill pill(传 undefined 表示已清除)。
  setComposerSkill: (skill?: { cmd: string; displayName: string }) => void;
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
  // 会话正文里点 kb:// 引用:右栏切到知识库视图并请求拉取该文档正文。
  openKnowledgeDoc: (ref: { sourceId: string; relPath: string }) => void;
  // auto_open 去重:记录已自动打开的「会话:URL」键。
  markAutoOpenedPreview: (key: string) => void;
  setRightView: (view: RightView) => void;
  // 传 undefined 恢复自动宽度（双击拖拽条重置）。
  setRightPanelWidth: (width: number | undefined) => void;
  setRightPanelMaximized: (maximized: boolean) => void;
  // FilesView 进入/退出文件预览时同步(镜像其本地 preview 状态,供面板头判断可否放大)。
  setFilePreviewOpen: (open: boolean) => void;
  setProjectsDetailWidth: (width: number | undefined) => void;
  openTimeline: (projectId: string) => void;
  closeTimeline: () => void;
  openHome: () => void;
  openAutomation: () => void;
  // 打开/关闭 loop 工作流主区视图（优先级最高,互斥清其它视图标志）。
  openWorkflow: () => void;
  closeWorkflow: () => void;
  // 打开/关闭设计工作台主区视图（互斥清其它视图标志;可指定要打开的设计稿）。
  openDesign: (docId?: string) => void;
  closeDesign: () => void;
  // 打开/关闭写作工作台整窗覆盖层（互斥清其它视图标志;closeWriting 回落首页,同 closeDesign 写法）。
  openWriting: () => void;
  closeWriting: () => void;
  // 打开/关闭设置整页（settingsOpen 瞬态;openSettings 不清底层视图标志,见实现注释）。
  // 可选 tab：外部入口（如快捷回复气泡「去设置」）指定要跳转的分区，SettingsMenu 据此切换。
  openSettings: (tab?: string) => void;
  // 设置整页要跳转到的目标分区 id（undefined = 沿用当前/默认）；SettingsMenu 消费后行为见其实现。
  settingsTab?: string;
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
  // 语音聊天/听写交互设置 patch（词典数组由调用方整体替换，避免就地变更破坏订阅比较）。
  setVoiceSettings: (patch: Partial<VoiceSettings>) => void;
  // 写作续写/改写模型配置 patch（浅合并;设置页「写作」分区编辑）。
  setWritingLlmSettings: (patch: Partial<WritingLlmSettings>) => void;
  // 设计工作台：设置 patch（合并后经归一化,拒绝脏数据落盘）。
  setDesignSettings: (patch: Partial<DesignSettings>) => void;
  // 设计稿索引 upsert/移除（重数据在工作区磁盘,这里只维护轻量索引）。
  upsertDesignDoc: (doc: DesignDocMeta) => void;
  removeDesignDoc: (docId: string) => void;
  // 画布 UI 态 KV 写入（value 为 null 表示删除;design 树经 storage 适配器调用）。
  setDesignUiItem: (key: string, value: string | null) => void;
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

// 旧扁平根默认值(Design B 迁移前的 DEFAULT_PI_SKILLS.globalRoots)。迁移时用它识别「老档 globalRoots
// 里哪些是内置默认(无需搬去 sharedRoots,因为新默认已覆盖)、哪些是异常残留(并入 sharedRoots 兜底)」。
const LEGACY_DEFAULT_GLOBAL_ROOTS = ["~/.agents/skills", "~/.cortex-desktop/skills"];

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

// Skill 根配置迁移(Design B,plan 002 U1)。把旧扁平结构 {globalRoots,userGlobalRoots} 幂等迁移为
// {sharedRoots, agentRoots},并保证「内置默认根」恒并入(代码拥有,默认变更对老档即时生效)。
//   · 已是新结构(有 agentRoots)→ 逐 agent/共享并入默认,保留用户自增根;
//   · 旧结构(无 agentRoots)→ userGlobalRoots + 非默认 globalRoots 并入 sharedRoots,agentRoots 用默认;
//   · 过渡期 deprecated 字段(globalRoots/userGlobalRoots)继续填充,未迁移消费点行为不变。
// 幂等:重复加载不重复搬运、不叠加(默认恒并入 + dedupe,用户根只来自持久化的 sharedRoots/agentRoots)。
function migratePiSkills(raw: Partial<PiSkillSettings> | undefined): PiSkillSettings {
  const base = { ...DEFAULT_PI_SKILLS, ...raw };
  // 新结构哨兵:agentRoots 或 sharedRoots 任一存在即视为新结构。仅看 agentRoots 会漏掉「只写了
  // sharedRoots(部分写入/手改)」的档,导致其 sharedRoots 被当旧结构忽略、用户共享根丢失(code review 修复)。
  const isNewShape = raw?.agentRoots !== undefined || raw?.sharedRoots !== undefined;

  // agentRoots:每 agent 恒并入默认原生根 + 保留已存的私有根。`raw?.agentRoots?.[agent] ?? []` 在旧结构
  // (agentRoots undefined)下自然为 [],无需再按 isNewShape 分支(等价,简化)。
  const agentRoots = {} as Record<AgentKind, string[]>;
  for (const agent of Object.keys(DEFAULT_AGENT_SKILL_ROOTS) as AgentKind[]) {
    const stored = raw?.agentRoots?.[agent] ?? [];
    agentRoots[agent] = dedupe([...DEFAULT_AGENT_SKILL_ROOTS[agent], ...stored]);
  }

  // sharedRoots 种子:
  //   · 新结构 → 已存的 sharedRoots(即使只写了 sharedRoots 也不丢);
  //   · 旧结构 → userGlobalRoots(用户自增) + globalRoots 里非旧默认的异常残留(兜底不丢)。
  const sharedSeed = isNewShape
    ? (raw?.sharedRoots ?? [])
    : [
        ...(raw?.userGlobalRoots ?? []),
        ...(raw?.globalRoots ?? []).filter((r) => !LEGACY_DEFAULT_GLOBAL_ROOTS.includes(r)),
      ];
  const sharedRoots = dedupe([...DEFAULT_SHARED_SKILL_ROOTS, ...sharedSeed]);

  return {
    ...base,
    sharedRoots,
    agentRoots,
    // 过渡期 deprecated:保留旧默认 globalRoots + 迁移后的 userGlobalRoots(=已并入 sharedRoots 的用户根),
    // 未迁移消费点仍读旧字段、行为不变。消费点全部切换后由收尾单元连同字段一并移除。
    globalRoots: DEFAULT_PI_SKILLS.globalRoots,
    userGlobalRoots: raw?.userGlobalRoots ?? [],
  };
}

/**
 * 写作 LLM 配置 hydrate：**按字段显式挑选**，不用 `{...默认, ...旧档}` 展开。
 *
 * 阶段③把寻址归并成 `{providerId, modelId}` 后，旧档里仍留着 `baseUrl / apiKey / model`。
 * 展开合并会把它们当作多余属性原样带进 store，再经 `toPersistedState` 原样写回磁盘——
 * 那份**明文 apiKey 就会永远留在 personal-workspace.json 里**，而清掉第二份明文密钥
 * 落盘点正是这次归并的目的（计划 §5）。所以这里显式挑字段，旧键就地丢弃、不迁移
 * （旧 baseUrl/apiKey 无法映射成 Catalog 引用，用户需重新选一次模型）。
 */
function hydrateWritingLlmSettings(raw: WritingLlmSettings | undefined): WritingLlmSettings {
  return {
    providerId: typeof raw?.providerId === "string" ? raw.providerId : DEFAULT_WRITING_LLM_SETTINGS.providerId,
    modelId: typeof raw?.modelId === "string" ? raw.modelId : DEFAULT_WRITING_LLM_SETTINGS.modelId,
    completionEnabled:
      typeof raw?.completionEnabled === "boolean"
        ? raw.completionEnabled
        : DEFAULT_WRITING_LLM_SETTINGS.completionEnabled,
    debounceMs: clampWritingDebounceMs(raw?.debounceMs),
    maxTokens: clampWritingMaxTokens(raw?.maxTokens),
  };
}

// 通用设置 hydrate：完整透传顶层字段（workspaceRoot / notesHotkey / piCustomization /
// piThinkingDefault / piSystemPrompt 等），再以 DEFAULT_GENERAL_SETTINGS 逐层补全嵌套子对象。
// 注意：务必整体 spread `...g` 而非逐字段重建——后者会静默丢掉任何未显式列出的字段（可选字段连
// typecheck 都不报），曾导致 piCustomization 重启即失效。新增顶层设置字段无需再改本函数。
function resolveGeneralSettings(s: PersistedState): GeneralSettings {
  const g = s.generalSettings;
  if (!g) return DEFAULT_GENERAL_SETTINGS;
  const mcp = g.mcp ? migrateLegacyAgentBrowserMcp(g.mcp) : undefined;
  return {
    ...DEFAULT_GENERAL_SETTINGS,
    ...g,
    ...(mcp ? { mcp } : {}),
    desktopBehavior: { ...DEFAULT_GENERAL_SETTINGS.desktopBehavior, ...g.desktopBehavior },
    notifications: { ...DEFAULT_GENERAL_SETTINGS.notifications, ...g.notifications },
    log: { ...DEFAULT_GENERAL_SETTINGS.log, ...g.log },
    // 插件 Skill 配置(Design B):经 migratePiSkills 把旧扁平根幂等迁移为「共享根 + 每 agent 私有根」,
    // 并恒并入代码拥有的默认原生根,使默认变更对老档即时生效(见 migratePiSkills)。
    piSkills: migratePiSkills(g.piSkills),
    // pi 扩展市场:旧档无 piExtensions 或缺子字段时兜 DEFAULT_PI_EXTENSIONS（U2）。
    piExtensions: { ...DEFAULT_PI_EXTENSIONS, ...g.piExtensions },
    // 插件市场启停/信任:旧档无 plugins 或缺子字段时兜 DEFAULT_PLUGIN_ENABLE（U5）。
    plugins: { ...DEFAULT_PLUGIN_ENABLE, ...g.plugins },
    // 浏览器控制:旧档无 browserControl 或缺子字段时逐字段兜 DEFAULT_BROWSER_CONTROL（U1）。
    browserControl: { ...DEFAULT_BROWSER_CONTROL, ...g.browserControl },
  };
}

function migrateLegacyAgentBrowserMcp(mcp: NonNullable<GeneralSettings["mcp"]>): NonNullable<GeneralSettings["mcp"]> {
  const occupied = new Set(mcp.servers.filter((s) => s.id !== "agent-browser").map((s) => s.id));
  let changed = false;
  const servers = mcp.servers.flatMap((server) => {
    if (
      server.id === "agent-browser" &&
      server.transport === "stdio" &&
      server.command === "agent-browser" &&
      JSON.stringify(server.args ?? []) === JSON.stringify(["mcp"])
    ) {
      changed = true;
      return [];
    }
    if (server.id !== "agent-browser") return [server];
    let suffix = 1;
    let id = "agent-browser-user";
    while (occupied.has(id)) id = `agent-browser-user-${++suffix}`;
    occupied.add(id);
    changed = true;
    return [{ ...server, id }];
  });
  return changed ? { ...mcp, servers } : mcp;
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
  // ② 旧权限线格式 permissionMode/approvalPolicy → execPermission（有损,目录语义丢弃,见
  //    fromAdapterPermissions）。仅当老会话尚无新字段、且带旧字段时迁移;缺省老会话不动,运行时回退 auto。
  const old = s as SessionMeta & { permissionMode?: PermissionMode; approvalPolicy?: ApprovalPolicy };
  if (s.execPermission === undefined && (old.permissionMode !== undefined || old.approvalPolicy !== undefined)) {
    const { permissionMode, approvalPolicy, ...rest } = old;
    s = { ...rest, ...fromAdapterPermissions(permissionMode, approvalPolicy) };
  }
  // ③ 剥离已废弃的目录轴 dirPermission（无条件按字段存在性剥离;须在 ② 之后,②不再产出该字段）。
  const withDir = s as SessionMeta & { dirPermission?: string };
  if (withDir.dirPermission !== undefined) {
    const { dirPermission: _dropped, ...rest } = withDir;
    s = rest;
  }
  // ④ 剥离已升为全局设置的会话级 subagentOrchestration（现读 GeneralSettings,默认关闭;
  //    旧会话字段不迁移值，全局编排只有用户在设置中显式开启才生效）。
  const withOrch = s as SessionMeta & { subagentOrchestration?: boolean };
  if (withOrch.subagentOrchestration !== undefined) {
    const { subagentOrchestration: _dropped2, ...rest } = withOrch;
    s = rest;
  }
  // ⑤ claude 的 `opus` 别名档已从 AGENT_MODELS 移除（Opus 只保留 1M 一档）。不迁移的话会漂移:
  //    下拉在显示层回落到首项(Sonnet),但 session.model 仍是 "opus" 且 CLI 依旧认这个别名 ——
  //    用户看到 Sonnet、实际跑 Opus。故就地改写成保留的 1M 档,让显示与实际一致。
  //    只动 claude:pi 的模型值来自用户自配 provider,与本表无关。
  if (s.agent === "claude" && s.model === "opus") {
    s = { ...s, model: "claude-opus-5[1m]" };
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
  visionBlockHints: {},
  piUiPending: [],
  autoOpenedPreviewKeys: [],
  terminalOpen: false,
  rightView: "todos" as const,
  rightPanelMaximized: false,
  filePreviewOpen: false,
  homeOpen: true,
  automationOpen: false,
  workflowOpen: false,
  designOpen: false,
  writingOpen: false,
  settingsOpen: false,
  settingsTab: undefined,
  timelineSettings: DEFAULT_TIMELINE_SETTINGS,
  pushSettings: DEFAULT_PUSH_SETTINGS,
  ttsSettings: DEFAULT_TTS_SETTINGS,
  mediaGenSettings: defaultMediaGenSettings(),
  asrSettings: defaultAsrSettings(),
  voiceSettings: defaultVoiceSettings(),
  writingLlmSettings: DEFAULT_WRITING_LLM_SETTINGS,
  designSettings: defaultDesignSettings(),
  designDocs: [],
  designUi: {},
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
      // 媒体生成：旧档经 normalizeMediaGenSettings 归一化——缺字段 deep-merge 工厂默认、
      // 枚举兜底、非法 providerId 归 "custom"、数值按 MAX_TIMEOUT_MS_BY_MODALITY 钳制。
      // （旧版「?? 整体回落」在旧档缺新字段 quality 等时会 undefined 穿透，已废弃。）
      mediaGenSettings: normalizeMediaGenSettings(s.mediaGenSettings),
      // ASR：旧档无此字段时回落工厂默认（向后兼容）。
      asrSettings: s.asrSettings ?? defaultAsrSettings(),
      // 语音交互设置：旧档缺失时回落新的默认对象，词典数组不会跨 store 实例共享。
      voiceSettings: s.voiceSettings ?? defaultVoiceSettings(),
      // 写作续写/改写模型配置：旧档缺字段（如 debounceMs/maxTokens）由默认补齐。
      writingLlmSettings: hydrateWritingLlmSettings(s.writingLlmSettings),
      // 设计工作台：设置经归一化兜底（旧档/脏数据回落默认）,索引与 UI 态缺省为空。
      designSettings: normalizeDesignSettings(s.designSettings),
      designDocs: s.designDocs ?? [],
      designUi: s.designUi ?? {},
      // providerSettings：新档直接用；旧档 piSettings.channels 迁移；都没有则空。
      // （@deprecated：阶段②起主进程首启即删除，此处仅为旧档启动不报错保留。）
      providerSettings: resolveProviderSettings(s),
      // 全局默认模型：两个 id 必须成套才算数（缺一半 = 未配置，不做半截引用）。
      defaultModelRef:
        s.defaultModelRef?.providerId && s.defaultModelRef.modelId ? s.defaultModelRef : undefined,
      // 清理留痕：原样回灌，渲染端只在「用户点了知道了」时改 noticeAcknowledged。
      legacyProviderSettingsCleared: s.legacyProviderSettingsCleared,
      // 通用设置：嵌套子对象逐层以默认值补全。
      generalSettings: resolveGeneralSettings(s),
      // 旧存档无 profile 字段 → 回退空对象;带旧 avatarId 的存档在此迁移为 emoji 头像。
      profile: migrateProfile(s.profile ?? {}),
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

  // Design B:target="shared" → 写 sharedRoots(对三端);target=AgentKind → 写 agentRoots[target](该 agent 私有)。
  addGlobalSkillRoot: (path, target) =>
    set((s) => {
      const cur: PiSkillSettings = { ...DEFAULT_PI_SKILLS, ...s.generalSettings.piSkills };
      const trimmed = path.trim();
      if (!trimmed) return {};
      if (target === "shared") {
        if (cur.sharedRoots.includes(trimmed)) return {}; // 已存(含内置默认)→ 不重复
        return { generalSettings: { ...s.generalSettings, piSkills: { ...cur, sharedRoots: [...cur.sharedRoots, trimmed] } } };
      }
      const existing = cur.agentRoots[target] ?? [];
      if (existing.includes(trimmed)) return {};
      return {
        generalSettings: {
          ...s.generalSettings,
          piSkills: { ...cur, agentRoots: { ...cur.agentRoots, [target]: [...existing, trimmed] } },
        },
      };
    }),

  removeGlobalSkillRoot: (path, target) =>
    set((s) => {
      const cur: PiSkillSettings = { ...DEFAULT_PI_SKILLS, ...s.generalSettings.piSkills };
      if (target === "shared") {
        if (DEFAULT_SHARED_SKILL_ROOTS.includes(path)) return {}; // 内置默认共享根不可删(迁移恒并入)
        return { generalSettings: { ...s.generalSettings, piSkills: { ...cur, sharedRoots: cur.sharedRoots.filter((r) => r !== path) } } };
      }
      if ((DEFAULT_AGENT_SKILL_ROOTS[target] ?? []).includes(path)) return {}; // 内置默认原生根不可删
      const existing = cur.agentRoots[target] ?? [];
      return {
        generalSettings: {
          ...s.generalSettings,
          piSkills: { ...cur, agentRoots: { ...cur.agentRoots, [target]: existing.filter((r) => r !== path) } },
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
      // Skills 默认打开(用户要求):新会话即启用 skill 发现/注入,可在 composer 里关。
      useOwnSkills: true,
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
      designOpen: false,
      writingOpen: false,
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

  renameSession: (id, title) => {
    const normalized = title.trim();
    if (!normalized) return;
    set((s) => {
      const session = s.sessions.find((x) => x.id === id);
      if (!session || session.title === normalized) return s;
      return {
        sessions: s.sessions.map((x) =>
          x.id === id ? { ...x, title: normalized, titleManuallyEdited: true } : x,
        ),
      };
    });
  },

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
    set((s) => {
      const removingActiveSession = s.activeSessionId === id;
      const removedSession = removingActiveSession ? s.sessions.find((x) => x.id === id) : undefined;
      return {
        sessions: s.sessions.filter((x) => x.id !== id),
        activeSessionId: removingActiveSession ? undefined : s.activeSessionId,
        // 侧栏上下文优先取活动会话所属项目；删除它前先固化该项目，
        // 无项目会话的 projectId=undefined 也是有效上下文，不能回退到旧项目。
        activeProjectId: removingActiveSession && removedSession ? removedSession.projectId : s.activeProjectId,
      };
    }),

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
        designOpen: false,
        writingOpen: false,
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
      designOpen: false,
      writingOpen: false,
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

  // nonce 用「上个值 +1」而非时间戳:同会话快速连点也保证变化,且不依赖时钟。
  requestOpenProcessPanel: (sessionId) =>
    set((s) => ({ processPanelOpenReq: { sessionId, nonce: (s.processPanelOpenReq?.nonce ?? 0) + 1 } })),

  setModeBlockHint: (sessionId, hint) =>
    set((s) => ({ modeBlockHints: { ...s.modeBlockHints, [sessionId]: hint } })),

  setVisionBlockHint: (sessionId, hint) =>
    set((s) => ({ visionBlockHints: { ...s.visionBlockHints, [sessionId]: hint } })),

  setDefaultModelRef: (ref) => set({ defaultModelRef: ref }),

  acknowledgeLegacyProviderNotice: () =>
    set((s) =>
      s.legacyProviderSettingsCleared
        ? { legacyProviderSettingsCleared: { ...s.legacyProviderSettingsCleared, noticeAcknowledged: true } }
        : {},
    ),

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
        skill: opts?.skill,
      },
    })),

  setComposerSkill: (skill) => set({ composerSkill: skill }),

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
  // nonce 自增:同一篇文档再次点击也要重新拉取(知识库内容可能已被更新)。
  openKnowledgeDoc: (ref) =>
    set((s) => ({
      knowledgeDocRequest: { ...ref, nonce: (s.knowledgeDocRequest?.nonce ?? 0) + 1 },
      rightView: "knowledge",
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
  setRightPanelMaximized: (maximized) => set({ rightPanelMaximized: maximized }),
  setFilePreviewOpen: (open) => set({ filePreviewOpen: open }),
  setProjectsDetailWidth: (width) => set({ projectsDetailWidth: width }),

  openTimeline: (projectId) =>
    set({ timelineProjectId: projectId, activeProjectId: projectId, homeOpen: false, automationOpen: false, workflowOpen: false, designOpen: false, writingOpen: false, noteEditorId: undefined, settingsOpen: false }),
  closeTimeline: () => set({ timelineProjectId: undefined }),

  // 回首页时右栏同步切回 todos（全部项目列表）——项目内的文件/Skills 面板
  // 是项目上下文,不应停留在首页。
  openHome: () => set({ homeOpen: true, automationOpen: false, workflowOpen: false, designOpen: false, writingOpen: false, timelineProjectId: undefined, noteEditorId: undefined, settingsOpen: false, rightView: "todos" }),

  // 进入自动化主区视图（互斥清其它视图字段）。
  openAutomation: () =>
    set({ automationOpen: true, workflowOpen: false, designOpen: false, writingOpen: false, homeOpen: false, timelineProjectId: undefined, activeSessionId: undefined, noteEditorId: undefined, settingsOpen: false }),

  // 进入 loop 工作流主区视图（优先级最高,互斥清其它视图字段）。
  openWorkflow: () =>
    set({ workflowOpen: true, automationOpen: false, designOpen: false, writingOpen: false, homeOpen: false, timelineProjectId: undefined, activeSessionId: undefined, noteEditorId: undefined, settingsOpen: false }),
  closeWorkflow: () => set({ workflowOpen: false }),

  // 进入设计工作台主区视图（互斥清其它视图字段;docId 缺省沿用上次打开的设计稿）。
  openDesign: (docId) =>
    set((s) => ({ designOpen: true, activeDesignDocId: docId ?? s.activeDesignDocId, writingOpen: false, workflowOpen: false, automationOpen: false, homeOpen: false, timelineProjectId: undefined, activeSessionId: undefined, noteEditorId: undefined, settingsOpen: false })),
  closeDesign: () => set({ designOpen: false, homeOpen: true }),

  // 进入写作工作台整窗覆盖层（互斥清其它视图字段,同 openDesign 写法）。
  openWriting: () =>
    set({ writingOpen: true, designOpen: false, workflowOpen: false, automationOpen: false, homeOpen: false, timelineProjectId: undefined, activeSessionId: undefined, noteEditorId: undefined, settingsOpen: false }),
  // 关闭写作工作台回落首页（瞬态 writingOpen 复位;同 closeDesign）。
  closeWriting: () => set({ writingOpen: false, homeOpen: true }),

  // 点击闪记进入中心区写作面：互斥清其它中心视图;noteEditorId 瞬态,不进 toPersistedState。
  openNoteEditor: (noteId) =>
    set({ noteEditorId: noteId, homeOpen: false, automationOpen: false, workflowOpen: false, designOpen: false, writingOpen: false, timelineProjectId: undefined, settingsOpen: false }),
  closeNoteEditor: () => set({ noteEditorId: undefined }),

  // 设置整页：openSettings 仅置 settingsOpen（不清 homeOpen/timelineProjectId 等底层标志,
  // 故 closeSettings 后自然回到打开设置前的视图）;互斥由各 open 入口清 settingsOpen 保证。
  // 注意:openSettings 刻意不清底层视图标志（homeOpen/designOpen 等,见 KTD2a 覆盖层叠加语义）,
  // 唯独清 writingOpen——瞬态整窗态,不参与「关设置回原视图」的保活,
  // 进设置即退出（否则 z-40 覆盖层会盖住设置页拦截点击,见 PersonalWorkspace 的挂载条件）。
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab, writingOpen: false }),
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

  setVoiceSettings: (patch) =>
    set((s) => ({ voiceSettings: { ...s.voiceSettings, ...patch } })),

  setWritingLlmSettings: (patch) =>
    set((s) => ({ writingLlmSettings: { ...s.writingLlmSettings, ...patch } })),

  // 设计设置：合并后整体归一化(枚举/长度上限兜底),避免脏值经 UI 写穿到磁盘。
  setDesignSettings: (patch) =>
    set((s) => ({ designSettings: normalizeDesignSettings({ ...s.designSettings, ...patch }) })),

  upsertDesignDoc: (doc) =>
    set((s) => ({
      designDocs: s.designDocs.some((d) => d.id === doc.id)
        ? s.designDocs.map((d) => (d.id === doc.id ? { ...d, ...doc } : d))
        : [...s.designDocs, doc],
    })),

  removeDesignDoc: (docId) =>
    set((s) => ({ designDocs: s.designDocs.filter((d) => d.id !== docId) })),

  setDesignUiItem: (key, value) =>
    set((s) => {
      const next = { ...s.designUi };
      if (value === null) delete next[key];
      else next[key] = value;
      return { designUi: next };
    }),

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
    voiceSettings: s.voiceSettings,
    writingLlmSettings: s.writingLlmSettings,
    designSettings: s.designSettings,
    designDocs: s.designDocs,
    designUi: s.designUi,
    providerSettings: s.providerSettings,
    // 必须透传（白名单构造）：漏了会把用户设的默认模型 / 主进程写的升级提示静默抹掉。
    // 新增 PersistedState 字段时请一并加到这里，`toPersistedState 白名单` 单测会兜住漏项。
    defaultModelRef: s.defaultModelRef,
    legacyProviderSettingsCleared: s.legacyProviderSettingsCleared,
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

// 与 initialAgent 配对的初始模型/供应商（pi 走 Catalog 引用;其余 lastModel 仅同 agent 时沿用,
// 否则取该 agent 默认）。
//
// pi 分支的来源改为「上次用过的 → 全局 defaultModelRef」，不再读 @deprecated 的 providerSettings
// （§5 首启即删除，继续读它会让新会话草稿恒定没有供应商）。原实现末尾那两级静默兜底
// （`?? enabled[0]` 取第一个启用的供应商、`?? provider.models[0].id` 取第一个模型）也已删除：
// 那会让用户在毫无提示的情况下被安排一个自己没选过的模型（§5 明令禁止）。
// 解析不出就返回 undefined，由消费方进「未配置模型」阻断态。
export function initialModelDraft(
  s: Pick<PersonalState, "lastAgent" | "lastModel" | "lastProviderId" | "agentsAvailable" | "defaultModelRef">,
): { agent: AgentKind; model: string | undefined; providerId: string | undefined } {
  const agent = initialAgent(s);
  const sameAgent = agent === s.lastAgent;
  if (agent === "pi") {
    const providerId = s.lastProviderId ?? s.defaultModelRef?.providerId;
    return {
      agent,
      // 沿用上次模型只在「同 agent 且同 provider」时成立：换了供应商还带着旧 modelId，
      // 会拼出一个 Catalog 里不存在的组合，白白落进阻断态。
      model:
        (sameAgent && providerId === s.lastProviderId ? s.lastModel : undefined) ??
        (providerId === s.defaultModelRef?.providerId ? s.defaultModelRef?.modelId : undefined),
      providerId,
    };
  }
  return { agent, model: (sameAgent ? s.lastModel : undefined) ?? DEFAULT_MODEL[agent], providerId: undefined };
}
