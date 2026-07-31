// 个人工作区 IPC 类型（主进程侧）。与 packages/core/desktop/types.ts 镜像 ——
// core 不能依赖 app 包，故两侧各持一份；preload 以 core 的 DesktopBridge 为准对齐。

import type { ResearchEngineMainSettings } from "./types-research";

export type { ResearchEngineMainSettings, ResearchSearchServerSettings } from "./types-research";

export type AgentKind = "claude" | "codex" | "pi";

export interface TurnTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type ConversationArtifactKind = "design" | "slides";

export interface ConversationArtifactRef {
  kind: ConversationArtifactKind;
  documentId: string;
  title: string;
  workspaceRoot: string;
  entryPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationArtifactCreateRequest {
  kind: ConversationArtifactKind;
  title: string;
  projectId?: string;
}

export type ConversationArtifactResult =
  | { ok: true; artifact: ConversationArtifactRef }
  | { ok: false; error: string };

// 会话与右栏研究面板之间持久化的深度研究引用。与 core 镜像同步（语义详见 core 侧注释）。
// 只存归属关系，状态/报告一律按 sessionId 现查 research.sqlite，不在这里存快照。
export interface ConversationResearchRef {
  sessionId: string;
  objective: string;
  createdAt: number;
  projectId?: string;
}

// M3-A:用户 JSON(agents.local.json)派生/覆盖的 agent 元数据(经 agents:profiles IPC 透出,
// 供渲染端在 agent 选择器列出新 agent)。spawn 时 agent 字段用其 id。与 core 镜像同步。
export interface DerivedAgentMeta {
  id: string;
  base: AgentKind;
  label?: string;
}

// 圆桌角色配置（全局角色库）。与 packages/core/desktop/types.ts 镜像同步。
export interface RoleConfig {
  id: string;
  label: string;
  agent: string;
  systemPrompt: string;
  color?: string;
  avatar?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  children?: PromptNode[];
}

export interface ProjectMeta {
  id: string;
  name: string;
  path: string;
  addedAt: number;
  pinnedAt?: number; // 置顶时间戳;缺省 = 未置顶
  archivedAt?: number; // 归档时间戳;缺省 = 在主列表
}

// 菜单栏 Spotlight 浮动框发起意图（与 packages/core/desktop/types.ts 镜像）。
export interface SpotlightIntent {
  id: string;
  prompt: string;
  agent: AgentKind;
  model?: string;
  providerId?: string;
  projectId?: string;
}

// 「项目管理」独立窗口 → 主窗口的委派意图（KTD10；与 packages/core/desktop/types.ts 镜像）。
export interface TaskDelegateIntent {
  taskId: string;
}

// 独立通知窗体的提醒载荷(主窗渲染端 → 主进程 → 通知窗体)。镜像 core 的 Toast 子集,
// 但跨进程经 IPC 传输,故只含可序列化的纯数据(无函数/图标组件,iconName 为名字字符串)。
export interface NotificationPayload {
  id: string;
  kind: "info" | "success" | "error";
  text: string;
  title?: string;
  description?: string;
  iconName?: string;
  // 自动消失时长(ms);0/缺省由窗体侧按默认处理;负数 = 常驻不自动消失(任务提醒用,
  // 用户可能不在电脑前,须等手动关闭或主窗重获焦点 clear)。
  duration?: number;
}

// 系统已安装的代码编辑器（editors.ts 探测结果）。
export interface EditorInfo {
  id: string;
  name: string;
}

export type TodoStatus = "open" | "done";

export interface TodoMeta {
  id: string;
  projectId: string;
  title: string;
  status: TodoStatus;
  detailPath: string;
  createdAt: number;
  updatedAt: number;
}

// ── 真任务系统 v2 类型 → 已抽到 ./tasks-types.ts（U1/KTD3）──
// 与 packages/core/desktop/tasks-types.ts 逐字镜像。
// 原导入路径 ./types 经此 re-export 保持不变。
export * from "./tasks-types";

// 快捷回复助手（reply）分片与桥接契约（U5）→ ./reply-types.ts。与 core 镜像。
export * from "./reply-types";
import type { ReplySettings, ReplyMemoryState, ReplyChannelsState } from "./reply-types";

// 设计工作台（design）设置/文档索引/画布 UI 态 → ./design-types.ts。与 core 镜像。
export * from "./design-types";
import type { DesignSettings, DesignDocMeta, DesignUiState } from "./design-types";

// 写作工作区（writing）空间列表/活跃空间 → ./writing-types.ts。与 core 镜像。
export * from "./writing-types";
import type { WritingUiState } from "./writing-types";

// 写作 LLM(U3,续写 + Cmd-K 改写）配置契约 → ./writing-llm-types.ts。与 core 镜像。
export * from "./writing-llm-types";
import type { WritingLlmSettings } from "./writing-llm-types";

export interface SessionMeta {
  id: string;
  // 关联项目;缺省 = 不使用项目（会话在 Documents/cortex/<日期> 工作）。
  projectId?: string;
  // 不使用项目时的工作目录（Documents/cortex/<YYYY-MM-DD>,创建时定下不漂移）。
  noProjectDir?: string;
  title: string;
  claudeSessionId?: string;
  agentSessionIds?: Partial<Record<AgentKind, string>>;
  activeArtifact?: ConversationArtifactRef;
  artifacts?: ConversationArtifactRef[];
  artifactSessionIds?: Record<string, string>;
  // /skill:research 发起过的深度研究引用与当前展示项。与 core 镜像同步。
  researchSessions?: ConversationResearchRef[];
  activeResearchSessionId?: string;
  agent: AgentKind;
  // M3-A/U7:用户 JSON 派生的新 id agent。缺省 = 用 agent(内置)。spawn 时 req.agent = derivedAgentId ?? agent。
  // agent 字段仍存其 base 内置值,使全仓 Record<AgentKind> 索引(模型/标签/头像/续接槽)无需放宽。
  derivedAgentId?: string;
  model?: string;
  // Claude/Codex 推理强度:普通会话逐轮 fresh spawn,改值下一轮生效。缺省 = 不传原生参数。
  effort?: ReasoningEffort;
  providerId?: string;
  piSessionFile?: string; // 阶段4 pi 会话恢复用磁盘 JSONL 路径（与 core 镜像）
  useOwnSkills?: boolean;
  execPermission?: ExecPermission; // 执行权限（与 core 镜像;主进程仅 round-trip 持久化,不按字段消费）
  hiddenHistory?: HiddenHistoryMeta;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface HiddenHistoryMeta {
  count: number;
  throughUid?: string;
  hiddenAt: number;
}

// ── 供应商（Provider）配置（与 core/desktop/types.ts 镜像） ────────────────
// 主进程仅需运行时解析:automation runner 据 providerId 从持久化的 providerSettings
// 取回完整 provider（含 apiKey）→ 拍平进 CliStartRequest.provider。
export type EndpointFormat = "chat_completions" | "responses" | "messages" | "custom";

export interface ProviderModelOption {
  id: string;
  label?: string;
  contextTokens?: number;
  reasoning?: boolean;
  vision?: boolean;
}

/**
 * @deprecated 阶段②起废弃且**不迁移**（计划 §5）：apiKey 明文落盘、models[] 会覆盖 pi 内置
 * 模型目录（事故根因）、enabled 把认证与显示混成一个开关。替代方案见
 * `main/providers/contract.ts`（Catalog + 凭据金库 + hiddenProviderIds）。
 * 本类型仅为清理逻辑保留。
 */
export interface ProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  endpointFormat: EndpointFormat;
  models: ProviderModelOption[];
  enabled: boolean;
}

/** @deprecated 见 ProviderProfile。 */
export interface ProviderSettings {
  providers: ProviderProfile[];
  defaultProviderId?: string;
  defaultModel?: string;
}

/** 旧 providerSettings 一次性清理的落盘标记（与 core/desktop/types.ts 镜像）。 */
export interface LegacyProviderCleanupMark {
  at: number;
  noticeAcknowledged?: boolean;
}

/** Catalog 时代的模型引用（与 core/desktop/types.ts 镜像）。 */
export interface DefaultModelRef {
  providerId: string;
  modelId: string;
}

// 供应商连接测试（与 core/desktop/types.ts 镜像）。
export interface ProviderProbeInput {
  baseUrl: string;
  apiKey?: string;
  endpointFormat: EndpointFormat;
}

export interface ProviderProbeResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

// ── pi extension 生成的输入契约（renderer → 主进程；agents/pi-providers.ts 消费） ──
// 单发（CliStartRequest）与 RPC（PiOpenRequest）两条路径共用同一形状，避免两处漂移。
//
// ⚠️ 能力字段（input/reasoning/contextWindow/maxTokens/cost）**只对自定义 Provider 有意义**：
// id 命中 pi 内置目录时 pi-providers 一律不下发 `models`，保留 pi 自带的完整模型元数据
// （registerProvider 传了 `models` 就整体替换该 provider 的内置目录，
// 见 pi-coding-agent/dist/core/provider-composer.js:108-131 —— 这正是本次能力事故的根因）。
export interface PiProviderModelInput {
  id: string;
  name?: string;
  // 完整 Pi Model 能力字段（阶段③ 的 JSON 编辑器直填）。自定义 Provider 必须齐全，
  // 缺失即视为配置不完整并拒绝注册——绝不再用猜测默认值兜底。
  input?: ("text" | "image")[];
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string>;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  compat?: unknown;
  // 旧设置页字段（阶段③ 落地前的过渡直转，非猜测）：vision→input、contextTokens→contextWindow。
  vision?: boolean;
  contextTokens?: number;
}

export interface PiProviderInput {
  id: string;
  baseUrl: string;
  apiKey?: string;
  endpointFormat?: EndpointFormat;
  models: PiProviderModelInput[];
}

// 通用设置（与 core/desktop/types.ts 镜像;主进程消费）。
export interface DesktopBehavior {
  openAtLogin: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
}

export interface NotificationSettings {
  turnComplete: boolean;
}

export interface LogSettings {
  enabled: boolean;
  retentionDays: number;
  // dev 细粒度日志 scope 白名单（与 packages/core/desktop/types.ts 逐字镜像）。
  debugScopes?: string[];
}

// MCP 注入配置(M2 U2,与 packages/core/desktop/types.ts 逐字镜像)。主进程消费(注入),
// renderer 设置区编辑。enabled=总开关;关时不注入不覆盖,尊重用户自有 .mcp.json / ~/.codex。
export interface McpServerConfig {
  id: string; // 稳定标识,同时作为注入 server 名
  label?: string;
  transport: "stdio" | "sse" | "http";
  command?: string; // stdio
  args?: string[];
  env?: Record<string, string>;
  cwd?: string; // stdio 工作目录（spawn cwd）
  envPassthrough?: string[]; // stdio:从宿主环境透传的变量名（注入时解析为 env 值，写入 gitignore 的 .mcp.json）
  url?: string; // sse/http
  headers?: Record<string, string>;
}

export interface McpSettings {
  enabled: boolean;
  servers: McpServerConfig[];
}

export interface AgentBrowserSettings {
  enabled: boolean;
}

export interface AgentBrowserRuntimeStatus {
  state: "disabled" | "checking" | "downloading" | "ready" | "error";
  message: string;
}

export interface GeneralSettings {
  workspaceRoot?: string;
  // MCP 注入配置(U2);缺省视为 { enabled:false, servers:[] }(不注入)。
  mcp?: McpSettings;
  // 内置 agent-browser MCP；旧存档缺省按开启处理。
  agentBrowser?: AgentBrowserSettings;
  desktopBehavior: DesktopBehavior;
  notifications: NotificationSettings;
  log: LogSettings;
  // 闪记全局热键（Electron accelerator）;缺省 = 主进程用默认 NOTES_HOTKEY_ACCELERATOR。
  notesHotkey?: string;
  // pi 深度定制（阶段3,与 core/desktop/types.ts 镜像）。主进程仅持久化,不直接读;
  // renderer 据此把 enable* 开关塞进 PiOpenRequest。
  piCustomization?: { toolApproval: boolean; sampleTools: boolean; sampleCommands: boolean; approvalTools?: string[] };
  // pi 持久 system prompt（阶段4,与 core 镜像,string 一致）。主进程仅持久化,不直接读。
  // 注:piThinkingDefault 是 ThinkingLevel enum、主进程不读,不在此镜像（避免 string/enum 跨包
  // 在 bridge 边界 bivariant 不兼容;core 侧 optional 字段缺失对结构子类型无碍）。
  piSystemPrompt?: string;
  // pi 插件 Skill 配置（与 core 镜像,纯 string/boolean/array,无 enum）。主进程仅持久化。
  piSkills?: PiSkillSettings;
  // pi 扩展市场配置（与 core 镜像）。主进程仅持久化。
  piExtensions?: PiExtensionSettings;
  // 浏览器控制（与 core 镜像）。主进程读 enabled 决定是否注入浏览器 MCP server（cli.ts，KTD5/KTD6）。
  browserControl?: BrowserControlSettings;
  // 用户记忆总开关（与 core 镜像）。主进程读它门控做梦整理管线（memory/dreamer.ts）;缺省 = 开启。
  memoryEnabled?: boolean;
  // 研究引擎（CRE）配置。形状见 ./types-research（单列文件以守住本文件 1200 行上限）。
  researchEngine?: ResearchEngineMainSettings;
  // 公司知识库（远端 MCP server）。主进程读它构建注入配置（capabilities/knowledge/inject.ts）。
  knowledgeBase?: KnowledgeBaseSettings;
  // Computer Use（与 core 镜像）。主进程读它做注入门控（capabilities/computer-use/inject.ts）。
  computerUse?: ComputerUseSettings;
}

// 公司知识库接入配置（与 packages/core/desktop/types.ts 逐字镜像）。
//
// 与其它内置能力不同：MCP server 跑在**知识库服务端**（kbserver 的 /api/mcp），
// 本地不起 host，故这里只有「连哪儿 + 拿什么令牌」，没有 port/enabled 之外的运行时状态。
//
// 凭据模式同研究引擎（见 core/research/settings.ts 的说明）：renderer 与 IPC 入参
// **永不传明文令牌**，设置页提交后由主进程立即用 safeStorage 加密成 encryptedToken 落盘；
// UI 连密文都不展示，只看 hasToken 显示「已配置」。
export interface KnowledgeBaseSettings {
  enabled: boolean;
  // 知识库服务基址，形如 http://kb.internal:8501（不含 /api/mcp，注入时拼）。
  baseUrl: string;
  // safeStorage 加密后的 MCP 令牌（base64）。只由主进程写。
  encryptedToken?: string;
  // 仅供 UI 显示「已配置」——真正的权限边界是服务端令牌的 scope，不是这个布尔。
  hasToken?: boolean;
}

// 一篇知识库文档的正文（会话里点开引用时预览用；与 core/desktop/types.ts 逐字镜像）。
export interface KnowledgeDocResult {
  ok: boolean;
  // 失败原因（面向用户的一句话）。ok=false 时必有。
  message?: string;
  fileName?: string;
  sourceId?: string;
  relPath?: string;
  text?: string;
  totalRunes?: number;
  // 文档超出单次读取上限、正文被截断。UI 据此提示「仅显示前 N 字」。
  hasMore?: boolean;
  // 服务端附注（如「本文档为非纯文本格式，此处是抽取文本」）。
  note?: string;
}

// 浏览器控制配置（与 packages/core/desktop/types.ts 逐字镜像）。
export interface BrowserControlSettings {
  enabled: boolean;
  cdpEnabled: boolean;
  approvedOrigins: string[];
  localUrlOpenTarget: "internal" | "system";
  annotateScreenshotMode: "always" | "ask" | "never";
  navigationApproval: "none" | "nonLocalOnly" | "all";
}

// pi 插件 Skill 配置（与 packages/core/desktop/types.ts 逐字镜像）。
// Design B(plan 002):新增 sharedRoots + agentRoots(per-agent 私有根);globalRoots/userGlobalRoots
// 为过渡期 deprecated 字段,待消费点切换完成后与 core 一并移除。
export interface PiSkillSettings {
  sharedRoots: string[];
  agentRoots: Record<AgentKind, string[]>;
  /** @deprecated 过渡期兼容字段(Design B),消费点切换完成后移除 */
  globalRoots: string[];
  /** @deprecated 过渡期兼容字段(Design B),消费点切换完成后移除 */
  userGlobalRoots: string[];
  disabledSkills: string[];
  trustedWorkspaceSkillDirs: string[];
  workspaceEnabled: boolean;
}

export type SkillScope = "global" | "workspace";

// pi 扩展市场配置（与 packages/core/desktop/types.ts 逐字镜像）。
export interface InstalledExtensionRecord {
  ref: string;
  scope: SkillScope;
  sourceRef: string;
  origin: string;
  version?: string;
  installedAt: number;
  path: string;
}
export interface PiExtensionSettings {
  installed: InstalledExtensionRecord[];
  enabled: string[];
  trusted: string[];
}
// 渲染端富扩展项（与 core 镜像）。pi-ext:list 产出存在性,enabled/trusted/missing 由渲染端叠加。
export interface InstalledExtension {
  ref: string;
  path?: string;
  scope: SkillScope;
  sourceRef: string;
  origin: string;
  version?: string;
  installedAt: number;
  enabled: boolean;
  trusted: boolean;
  missing: boolean;
}

// pi-ext:install 结果（与 core 镜像）。成功带解析到的落盘 path + 溯源;失败带可读 error。
export type PiExtInstallResult =
  | { ok: true; ref: string; sourceRef: string; origin: string; version?: string; path: string }
  | { ok: false; error: string };

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  desktopBehavior: { openAtLogin: false, startMinimized: false, closeToTray: true },
  notifications: { turnComplete: true },
  log: { enabled: true, retentionDays: 2 },
};

// 推送渠道配置（与 core/desktop/types.ts 镜像;主进程 automation runner 完成后推送时读取）。
export interface WecomPushConfig {
  enabled: boolean;
  webhookUrl: string;
}
export interface DingtalkPushConfig {
  enabled: boolean;
  webhookUrl: string;
  secret?: string;
}
export interface FeishuPushConfig {
  enabled: boolean;
  webhookUrl: string;
  secret?: string;
}
export interface InternalNotifyConfig {
  enabled: boolean;
}
export interface EmailPushConfig {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
}
export interface PushSettings {
  wecom?: WecomPushConfig;
  dingtalk?: DingtalkPushConfig;
  feishu?: FeishuPushConfig;
  internal?: InternalNotifyConfig;
  email?: EmailPushConfig;
  formatSkillPath?: string;
}

// 推送渠道标识(与 core/desktop/types.ts 镜像)。自动化「完成后通知」按此选择渠道。
export type PushChannelKind = "wecom" | "dingtalk" | "feishu" | "email" | "internal";

// ── 媒体生成/ASR 设置镜像（与 packages/core/desktop/types.ts 逐字镜像;主进程
//    仅持久化转发,运行期由 U4/U7/U9 读取,故当前不在 GeneralSettings 里消费）。
// timeoutMs 全部 <300s:主进程看门狗上限约 300s TCP,卡在 280 以内可得清晰超时错误。

export type ImageGenProtocol = "openai-images" | "minimax-image";
export type SpeechGenProtocol = "openai-speech" | "minimax-t2a" | "mimo-tts";
export type MusicGenProtocol = "minimax-music";
export type VideoGenProtocol = "minimax-video";

export interface ImageGenSettings {
  enabled: boolean;
  providerId: string;
  protocol: ImageGenProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultSize: string;
  timeoutMs: number;
}

export interface SpeechGenSettings {
  enabled: boolean;
  providerId: string;
  protocol: SpeechGenProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  format: string;
  timeoutMs: number;
}

export interface MusicGenSettings {
  enabled: boolean;
  providerId: string;
  protocol: MusicGenProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  format: string;
  timeoutMs: number;
}

export interface VideoGenSettings {
  enabled: boolean;
  providerId: string;
  protocol: VideoGenProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultDuration: number;
  defaultResolution: string;
  timeoutMs: number;
  pollIntervalMs: number;
}

export interface MediaGenSettings {
  image: ImageGenSettings;
  speech: SpeechGenSettings;
  music: MusicGenSettings;
  video: VideoGenSettings;
}

export type AsrProtocol = "openai-transcriptions" | "mimo-asr" | "local-whisper";
export type LocalWhisperDownloadSource = "huggingface" | "hf-mirror" | "hf-sufy";

export interface AsrSettings {
  enabled: boolean;
  providerId: string;
  protocol: AsrProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  localWhisperDownloadSource: LocalWhisperDownloadSource;
  language: string;
  timeoutMs: number;
}

export interface PersistedState {
  version: 1;
  projects: ProjectMeta[];
  promptRoot?: string;
  sessions: SessionMeta[];
  todos?: TodoMeta[];
  // 推送渠道设置（renderer 全量写入;主进程 automation 完成后推送时读取）。
  pushSettings?: PushSettings;
  /** @deprecated 阶段②起不再写入；主进程首启会**删除**该字段（含全部明文 apiKey），见计划 §5。 */
  providerSettings?: ProviderSettings;
  // Catalog 时代的全局默认模型（替代废弃的 providerSettings.defaultProviderId/defaultModel）。
  // ⚠️ 渲染端的 toPersistedState 白名单必须带上它，否则会被全量保存抹掉（详见 core 镜像注释）。
  defaultModelRef?: DefaultModelRef;
  // 旧 providerSettings 清理留痕：主进程删除旧字段后写入，renderer 据此弹一次升级提示。
  // （「显示/隐藏 Provider」与 baseUrl 覆盖不在这里 —— main-owned 的 provider-prefs.json。）
  legacyProviderSettingsCleared?: LegacyProviderCleanupMark;
  // 通用设置（renderer 全量写入;主进程读 workspaceRoot/desktopBehavior/log）。
  generalSettings?: GeneralSettings;
  rightPanelWidth?: number;
  // 「最后一次使用」记忆（与 packages/core/desktop/types.ts 镜像;Spotlight/新会话默认沿用）。
  lastAgent?: AgentKind;
  lastModel?: string;
  lastProviderId?: string;
  // 最近活跃项目（闪记浮层默认归属推导用;归档/删除该项目时清空）。与 core 镜像逐字一致。
  lastActiveProjectId?: string;
  // 媒体生成/ASR 设置（renderer 全量写入;主进程透传持久化;U4/U7/U9 读取路由）。
  mediaGenSettings?: MediaGenSettings;
  asrSettings?: AsrSettings;
  // 快捷回复助手分片（U5/KTD6）：renderer 全量写入，主进程透明落盘（U7/U9 消费）。
  // replyMemory 为【遗留只读】：KTD6 修订后记忆已迁 main-owned memory.json（reply/memory-store.ts），
  // 本字段仅作首启迁移源保留，渲染端不再写入。与 packages/core/desktop/types.ts 镜像。
  replySettings?: ReplySettings;
  replyMemory?: ReplyMemoryState;
  replyChannels?: ReplyChannelsState;
  // 设计工作台分片（renderer 全量写入，主进程透明落盘）。与 packages/core/desktop/types.ts 镜像。
  designSettings?: DesignSettings;
  designDocs?: DesignDocMeta[];
  designUi?: DesignUiState;
  // 写作工作区分片（renderer 全量写入，主进程透明落盘）。与 packages/core/desktop/types.ts 镜像。
  // 主进程 fs.allowedRoots 读取 spaces[].root 兜底放行白名单外的自定义空间根。
  writingUi?: WritingUiState;
  // 写作续写/改写(U3)独立模型配置。主进程 writing-llm handler 经 getPersistedState 读取。
  writingLlmSettings?: WritingLlmSettings;
}

export interface ReadFileResult {
  content: string;
  truncated: boolean;
}

// ── 表格文件二进制通道（fs:readFileBinary / fs:writeFileBinary / fs:statFile）──
// 现有 fs:readFile/writeFile 是 UTF-8 文本通道，xlsx 等二进制走这里（base64 传输）。
// 与 packages/core/desktop/types.ts 镜像。

// 读结果：超过大小上限时 truncated=true 且 data=null（二进制截半无意义，直接降级系统打开）。
export interface ReadFileBinaryResult {
  data: string | null; // base64
  truncated: boolean;
  size: number;
  mtimeMs: number; // 读取时刻的文件 mtime，供外部变更（agent 改文件）检测比对
}

// 写结果：backupPath = 本次触发的首次备份落点（未备份则缺省）；mtimeMs = 写后新 mtime。
export interface WriteFileBinaryResult {
  backupPath?: string;
  mtimeMs: number;
}

// 轻量 stat：外部变更检测用（watch 信号后比对 mtime，避免整文件重读）。
export interface StatFileResult {
  size: number;
  mtimeMs: number;
}

// 写作工作区：粘贴/生成图片落盘入参（fs:writingSaveImage，与 core/desktop/types.ts 镜像）。
// bytesBase64 = 图片原始字节的 base64；ext = 落盘扩展名（不含点，主进程会再净化）。
// 落 <spaceRoot>/img/pasted-<ts>-<rand>.<ext>，返回落盘绝对路径（供渲染端换算相对链接）。
export interface WritingSaveImagePayload {
  spaceRoot: string;
  bytesBase64: string;
  ext: string;
}

export interface CliStartRequest {
  runId: string;
  sessionId: string;
  // 可为内置 AgentKind 或用户 JSON 派生的新 id(M3-A/U7);后端 getAgentDef 按 string 解析,故放宽为 string。
  agent: string;
  cwd: string;
  prompt: string;
  artifactContext?: ConversationArtifactRef;
  model?: string;
  resumeSessionId?: string;
  // 续接最近会话(U4):claude --continue / codex exec resume --last。与 resumeSessionId 互斥,优先生效。
  continueSession?: boolean;
  appendSystemPrompt?: string;
  useOwnSkills?: boolean;
  // pi 插件 Skill（U4）:已启用 + 去重后的 skill 目录绝对路径,buildArgs 逐个 --skill 注入。
  skillPaths?: string[];
  // U5:claude 原生 skill 目录发现用的已启用 skill 记录（renderer 填充）。cli.ts 据此建桥接目录
  // (buildClaudeSkillBridge)。形状镜像 core 的 InjectableSkill。与 core 镜像。
  // Design B(plan 002):origin 供 U6 去重(agent 私有原生根下的 skill claude 自发现,桥接不再重复)。
  skillRecords?: { name: string; description?: string; dir: string; origin?: "shared" | "agent" }[];
  // U2:claude skill 桥接目录绝对路径（主进程内部填充,renderer 不传）。cli.ts 建目录后写入,
  // claude.ts buildArgs 追加 --add-dir。与 core 镜像。
  skillsBridgeDir?: string;
  // 本轮注入的内置 MCP server id 清单（主进程内部填充,renderer 不传）。cli.ts 注入后写入,
  // claude.ts 在 acceptEdits/sandbox 模式下用 --allowed-tools 预授权这些 server —— print 模式
  // 无人审批回路,不预授权则 MCP 调用卡在权限请求。与 core 镜像。
  builtinMcpServers?: string[];
  // U4/U6:codex app-server(ws)原生 skill input item（renderer 填充）。与 core 镜像。
  invokedSkill?: { name: string; path: string };
  // 用户上传的图片。三端 adapter 各按自己的 imageDelivery 能力位消费:claude 拼进 prompt 文本、
  // codex `--image <path>`、pi `@<path>` 文件参数。（pi 的 RPC 长驻路径另有原生 prompt.images,
  // 见 pi-rpc.ts,不走本字段。）与 core 镜像。
  images?: CliImageRef[];
  // 推理强度（自动化任务用）:各 agent adapter 尽力翻译成对应 CLI 参数;pi 忽略。
  effort?: ReasoningEffort;
  // 访问范围（沙箱档）:claude/codex adapter 翻译成原生标志;缺省 = full-auto。pi 不走本 DTO。
  permissionMode?: PermissionMode;
  // 执行/审批策略:与 permissionMode 正交,adapter 据此决定 approval。缺省 = auto。
  approvalPolicy?: ApprovalPolicy;
  // pi 专用:renderer 只传 Catalog 中的 providerId,主进程据此从
  // 「Catalog + provider-prefs + 凭据金库」解析出 provider（resolvePiProviderInput）。
  // 阶段② 后凭据只在主进程金库里,渲染端不再持有 baseUrl/apiKey。
  providerId?: string;
  // 主进程内部填充（由 providerId 解析而来）:据此生成 extension 并注入 key env。
  // ⚠️ 含明文 apiKey,**不得**回传 renderer 或进日志/argv。
  provider?: PiProviderInput;
  // 主进程内部填充:生成的 extension 文件绝对路径（buildArgs 读取）。
  piExtensionPath?: string;
  // 委派（delegate）：本轮被 @ 的协作者角色。非空时 cli.ts 注入 cortex-delegate MCP server
  // （per-turn 工具集），主 agent 经 ask_<id> 工具自主委派子任务给这些协作者。与 core 镜像。
  delegateRoles?: RoleConfig[];
  // pi 专属:除 piExtensionPath 外的额外 -e 扩展路径（如 delegate 桥接）。主进程内部填充，
  // pi.ts buildArgs 逐个 -e 注入。与 core 镜像。
  extraExtensionPaths?: string[];
  // 本轮是否允许联网检索（SessionMeta.webSearch 的逐轮投影）。true 时才注入研究引擎 MCP
  // （web_search / web_read）,见 cli.ts 的 buildResearchMcpServerConfig 调用。
  // **缺省视为 false**：出站能力的默认必须落在保守那一侧。与 core 镜像。
  webSearch?: boolean;
}

// 历史消息追问的临时流式应答请求（与 core/desktop/types.ts 镜像）。
// CliStartRequest 的不落盘子集:无 sessionId/resumeSessionId/runId（主进程内部用 askId 充当）,
// 不写 chats/、不进 run 注册表。askId 每轮唯一,既作子进程登记 key,也回带做代际守卫。
export interface AskFollowupRequest {
  askId: string;
  agent: AgentKind;
  // 工作目录（真实项目 path,或无项目会话的 Documents/cortex/<date>）。
  cwd: string;
  prompt: string;
  model?: string;
  appendSystemPrompt?: string;
  effort?: ReasoningEffort;
  // 运行模式:沿用主会话档位(claude/codex adapter 翻译)。与 tightenTools 叠加,更严者优先。
  permissionMode?: PermissionMode;
  // 执行/审批策略(同 CliStartRequest)。
  approvalPolicy?: ApprovalPolicy;
  // true = 无项目会话:主进程剥离 claude/codex 的跳审批/bypass 标志,回退默认审批/沙箱（R9/KTD8）。
  // 显式标志,不靠主进程猜 cwd（真实无项目 cwd 非 homedir,猜法会失效）。
  tightenTools?: boolean;
  // pi 自定义供应商:形状同 CliStartRequest.provider,主进程据此生成 extension + 注入 key。
  provider?: {
    id: string;
    baseUrl: string;
    apiKey?: string;
    models: { id: string; name?: string }[];
  };
}

// agent 自己的 session/thread id(resume 用的那个)。
export interface AgentSessionRequest {
  agent: AgentKind;
  agentSessionId: string;
}

// 编辑重发:截断 agent CLI 会话记忆文件的请求。
export interface TrimSessionRequest {
  agent: AgentKind;
  /** agent 自己的 session/thread id(resume 用的那个)。 */
  agentSessionId: string;
  /** 被编辑那条用户消息的原文(用于在会话文件中定位该轮)。 */
  promptText: string;
  /** 同文序号:UI 中相同原文的用户消息里,被编辑的是第几条(0-based)。 */
  occurrence: number;
}

// 系统扫描发现的 agent 项目（来自 ~/.claude/projects 与 ~/.codex/sessions 的会话日志）。
export interface AgentProjectInfo {
  path: string; // 项目真实绝对路径（从会话日志 cwd 反解）
  name: string; // basename
  agents: AgentKind[];
  lastActive: number; // epoch ms，取会话日志文件 mtime 最大值
}

// 归一化事件（adapter 输出）。M1 在原 4 变体上做**向后兼容扩展**(R2):
//   - usage(U3)/retry(U7)/thinking/turn 均为新变体;tool 增可选 phase/toolCallId 字段。
//   - 生产者:usage(claude result / codex turn.completed)、retry(主进程安全重试)、
//     thinking(claude thinking_delta)、turn(claude message_delta 的 stop_reason);
//     tool.phase/toolCallId 由 claude/codex/pi 标注；pi 单发同时产 start/end，
//     其余 adapter 可只产 start，消费端仍向后兼容无 phase 的旧事件。
// 现有消费端(if 链 / 无 default 的 switch)自然忽略未知 type;`foldCliEvent` 对非 text/tool 事件
// 原样返回,故 usage/retry/thinking/turn 不破坏文本/工具折叠;tool 的新增可选字段不影响既有读取。
// ⚠️ 跨包契约:本类型在 packages/core/desktop/types.ts 有逐字镜像,任何改动两处必须同步。
// stage / stageLabel 说明（orchestrate.ts 三段编排用）：
//   stage     — 编排阶段标注（"intent"意图理解/"subagent"子agent执行/"refine"二次加工），
//               非编排 run 不带此字段，向后兼容。
//   stageLabel — 段切换时的人可读提示文案（如「理解意图中…」），供渲染端更新 typing 占位，
//               可选增强字段；渲染端未消费时自然忽略。
export type CliStreamEvent =
  | { type: "init"; sessionId: string; stage?: "intent" | "subagent" | "refine"; stageLabel?: string; roleId?: string }
  | { type: "text"; delta: string; stage?: "intent" | "subagent" | "refine"; stageLabel?: string; roleId?: string }
  // tool 事件:phase:"start" 带 input(完整调用参数,原始 JSON);phase:"end" 带 output(工具输出文本,
  // adapter 侧已截断)+ isError。start/end 靠 toolCallId 配对(运行过程详情视图用)。
  | { type: "tool"; name: string; detail?: string; input?: unknown; output?: string; isError?: boolean; phase?: "start" | "end"; toolCallId?: string; stage?: "intent" | "subagent" | "refine"; stageLabel?: string; roleId?: string }
  | { type: "thinking"; delta: string; stage?: "intent" | "subagent" | "refine"; stageLabel?: string; roleId?: string }
  | { type: "turn"; stopReason?: string; stage?: "intent" | "subagent" | "refine"; stageLabel?: string; roleId?: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; costUsd?: number; stage?: "intent" | "subagent" | "refine"; stageLabel?: string; roleId?: string }
  | { type: "retry"; attempt: number; maxAttempts?: number; reason?: string; stage?: "intent" | "subagent" | "refine"; stageLabel?: string; roleId?: string }
  | { type: "result"; ok: boolean; text?: string; error?: string; stage?: "intent" | "subagent" | "refine"; stageLabel?: string; roleId?: string }
  // todo 事件:agent 任务清单整表快照(覆盖语义,每帧带全量 todos)。三端归一化产出:
  // claude TodoWrite / codex update_plan(todo_list item)/ pi 自定义 todo_write 工具。
  | { type: "todo"; todos: Array<{ text: string; status: "pending" | "in_progress" | "completed" }>; stage?: "intent" | "subagent" | "refine"; stageLabel?: string; roleId?: string };

// 圆桌编排启动参数（渲染端 → roundtable:start）。
// 管线式调度：主 agent 先执行用户 prompt，其输出作为 @mentioned agent 的上下文（KTD4）。
export interface RoundtableStartRequest {
  runId: string;
  sessionId: string;
  // 主会话 agent（管线第一段：先由它处理用户 prompt，输出再交给 @mentioned agent）。
  agent: string;
  cwd: string;
  text: string;
  mentions: Array<{ mention: string; role: RoleConfig }>;
  roles: RoleConfig[];
  permissionMode?: string;
  approvalPolicy?: string;
  appendSystemPrompt?: string;
  model?: string;
  effort?: string;
}

export interface CliExitEvent {
  runId: string;
  sessionId?: string;
  code: number | null;
  error?: string;
}

export interface AgentTraceEvent {
  id: string;
  ts: number;
  scope: "cli" | "oneshot" | "ask" | "pi" | "pi-rpc" | "roundtable" | "delegate";
  phase: string;
  summary: string;
  runId?: string;
  sessionId?: string;
  agent?: string;
  data?: unknown;
}

// ── pi RPC 长驻会话（--mode rpc） ────────────────────────────────────────
// pi 走 RPC 会话通道（可 steer/abort/fork/运行时切模型）；claude/codex 仍走 cli.ts
// 单发管线。事件契约（已实测）见 docs/plans/2026-06-16-003-feat-pi-rpc-session-plan.md。

// pi RPC 会话启动参数（renderer → 主进程 pi:open）。
export interface PiOpenRequest {
  uiSessionId: string; // 渲染层会话标识（一个 UI 会话 = 一个长驻 pi 进程）
  cwd: string;
  model?: string;
  useOwnSkills?: boolean; // false → 会话级一键关 skill（清空 skillPaths）
  // pi 插件 Skill（U4）:已启用 + 去重后的 skill 目录绝对路径,buildRpcArgs 逐个 --skill 注入。
  skillPaths?: string[];
  // pi 扩展市场（U3）:已启用+已授信的扩展 -e 路径,core 解析后传入,buildRpcArgs 折入 -e 批次。
  extensionPaths?: string[];
  // 供应商:与 CliStartRequest 同一契约 —— renderer 只传 providerId,主进程解析出 provider。
  // 两条路径共用同一契约,避免「RPC 能力字段全、单发字段缺」的漂移。
  providerId?: string;
  // 同一 providerId 下「会影响 extension 内容」的配置摘要（endpoint 覆盖 / 认证来源）,
  // 由渲染端从 ProviderAuthSnapshot 派生,仅用于 extensionFingerprint 判定是否重开会话。
  // ⚠️ 不含任何密钥或其摘要。
  providerFingerprint?: string;
  // 主进程内部填充（由 providerId 解析而来）。⚠️ 含明文 apiKey,不得回传 renderer。
  provider?: PiProviderInput;
  // 主进程内部填充:生成的 provider extension 文件绝对路径（buildRpcArgs 读取）。
  piExtensionPath?: string;
  // 阶段3 深度定制开关（renderer 传）:启用「工具执行审批」/「自定义工具样例」/「斜杠命令样例」。
  enableToolApproval?: boolean;
  approvalTools?: string[]; // 需审批的工具集（缺省 DEFAULT_APPROVAL_TOOLS）
  enableSampleTools?: boolean;
  enableSampleCommands?: boolean;
  // 运行模式 plan 档:只读工具白名单。存在则 buildRpcArgs 注入 --tools <逗号拼接>;缺省 = 全工具。
  toolWhitelist?: string[];
  // 主进程内部填充:除 provider 外追加的 extension 路径（审批/样例工具/命令），各加一个 -e。
  extraExtensionPaths?: string[];
  // pi 持久追加 system prompt（阶段4）:renderer 传,buildRpcArgs → --append-system-prompt。
  appendSystemPrompt?: string;
  // pi 思考强度初值（阶段5）:renderer 传,buildRpcArgs → --thinking（冷启设初值）。
  thinkingLevel?: string;
  // 会话级联网检索（SessionMeta.webSearch）:pi-session.ts 据此决定是否把研究引擎 MCP
  // 并进桥接扩展。renderer 侧计入 extensionFingerprint,改值触发会话重开。缺省视为 false。与 core 镜像。
  webSearch?: boolean;
  // 主进程内部填充:askquestion extension 的会话级 sentinel。renderer 不传。
  askQuestionSentinel?: string;
  // 主进程内部填充（同 piExtensionPath 的模式）:Computer Use 需要经环境变量传给 pi 子进程的
  // 额外配置（当前只有 PI_COMPUSE_GROUNDING_MODEL）。空/缺省 = 不加任何变量。
  // 走 env 而非 CLI 参数,因为这是 pi-computer-use package 自己读的配置,pi 无对应 flag。
  computerUseEnv?: Record<string, string>;
}

// pi:open 的应答:回带 uiSessionId + pi 侧 sessionId（经 get_state 探测就绪时取得）。
export interface PiOpenResult {
  uiSessionId: string;
  sessionId: string;
  // 磁盘 JSONL 路径（阶段4 崩溃/空闲/LRU 恢复用;renderer 持久到 SessionMeta.piSessionFile）。
  sessionFile?: string;
}

// pi RPC 会话的归一化事件（主进程 → 渲染层 pi:event）,由 AgentSessionEvent 映射而来
// （mapPiEvent）。比单发 CliStreamEvent 更细:区分 reasoning / 工具起止 / 轮结束 / 压缩 /
// 重试 / 队列,并以 result.willRetry 表达自动重试。
export type PiSessionEvent =
  | { type: "text"; delta: string } // assistant 正文增量
  | { type: "reasoning"; delta: string } // 思考增量（仅 reasoning 模型）
  // tool-start.input = 完整调用参数(pi tool_execution_start.args);tool-end.output = 工具输出文本
  // (tool_execution_end.result 归一化,主进程已截断)。供运行过程详情视图展示。
  | { type: "tool-start"; name: string; toolCallId: string; detail?: string; input?: unknown }
  | { type: "tool-end"; name: string; toolCallId: string; isError: boolean; output?: string }
  // todo 事件:自定义 todo_write 工具(pi-todo extension)调用的任务清单整表快照(覆盖语义)。
  // adapter 侧把 tool_execution_start 特判转成本事件,对应 tool-end 被吞掉(避免过程流噪音)。
  | { type: "todo"; todos: Array<{ text: string; status: "pending" | "in_progress" | "completed" }> }
  | { type: "turn-end"; usage?: TurnTokenUsage } // 一次模型调用（含工具）结束
  | { type: "error"; error: string } // assistant stopReason=error/aborted
  | { type: "result"; willRetry: boolean; usage?: TurnTokenUsage } // 一次 run 结束（agent_end）
  // agent 完全静默（pi 0.82.1 agent_settled）。晚于 result 到达,正常轮次是冗余信号;
  // pi 漏发 agent_end 时作为终态兜底,由渲染侧幂等收尾。
  | { type: "settled" }
  | { type: "compaction"; phase: "start" | "end"; reason?: string }
  | { type: "retry"; attempt: number; maxAttempts?: number; error?: string }
  | { type: "queue"; steering: number; followUp: number }
  | { type: "session-info"; name?: string }
  | { type: "thinking-level"; level: string }
  // 扩展命令（如 /memory-index-sessions）经 ctx.ui.notify 的输出（与 core/desktop/types.ts 镜像）。
  | { type: "notify"; message: string; level?: "info" | "warning" | "error" }
  | { type: "crashed"; error?: string }; // 进程非正常退出（session 注入,非 RPC 事件）

// pi extension 经 ctx.ui.* 发起的「需用户输入」请求（pi → host，独立于单向 PiSessionEvent 流）。
// 镜像 pi rpc-types.d.ts 的 RpcExtensionUIRequest（0.79.2 spike 实测 confirm envelope 建立,
// 已 diff 复核至 0.82.1:9 个 method 及其字段逐条一致,无漂移）。
// 9 个 method 中需回写的仅 confirm/select/input/editor;其余 5 个 fire-and-forget。`id` 是 pi 侧
// crypto.randomUUID()，回写必须原样带回（见 PiUiResponsePayload）。
export type PiUiRequest =
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines: string[] | undefined; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
  // cortex 内部判别式（**非** pi 协议 method）：pi 实发的是 method:"input"，title 携带本会话 sentinel + JSON
  // 信封;handleLine 检出 sentinel 后解析归一为本变体（见 askquestion 工具）。回写仍走 {value}（答案 JSON）。
  | { type: "extension_ui_request"; id: string; method: "askquestion"; envelope: AskQuestionEnvelope };

// 回写给 pi 的应答（host → pi stdin）。三态:confirm 用 confirmed;select/input/editor 用 value;
// 取消/关闭(任意 method)用 cancelled。镜像 RpcExtensionUIResponse。askquestion 复用 {value}（答案 JSON）。
export type PiUiResponsePayload =
  | { confirmed: boolean }
  | { value: string }
  | { cancelled: true };

// askquestion 自定义工具的「多组提问」信封。extension 经 ctx.ui.input 的 title 借 sentinel+JSON 承载,
// handleLine 解析后归一为 PiUiRequest{method:"askquestion"}。渲染侧约束每组 options ≤ 3。
export interface AskQuestionOption {
  label: string;
  description?: string;
}
export interface AskQuestionGroup {
  id: string;
  header?: string;
  question: string;
  options: AskQuestionOption[];
  recommended?: number; // options 下标;越界由渲染侧降级为无推荐
  allowCustom?: boolean;
}
export interface AskQuestionEnvelope {
  groups: AskQuestionGroup[];
}
// 用户作答聚合,经 {value} 回写 pi（JSON.stringify）。每组互斥:value 取自选项 label 或自定义文本。
export interface AskQuestionAnswer {
  groupId: string;
  value: string;
  isCustom: boolean;
}
export interface AskQuestionAnswers {
  answers: AskQuestionAnswer[];
}

// ── TTS（与 core/desktop/types.ts 镜像） ─────────────────────────────────

export interface TtsSynthesizeRequest {
  baseUrl: string;
  apiKey?: string;
  model: string;
  voice: string;
  speed?: number;
  language?: string;
  stream?: boolean;
  streamingInterval?: number;
  text: string;
}

export interface TtsSynthesizeStreamRequest extends TtsSynthesizeRequest {
  streamId: string;
}

export type TtsStreamEvent =
  | { type: "chunk"; chunk: ArrayBuffer; mimeType?: string }
  | { type: "done" }
  | { type: "error"; error: string };

export interface TtsListVoicesRequest {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export interface TtsVoiceOption {
  id: string;
  label?: string;
  locale?: string;
}

// ── ASR（与 core/desktop/types.ts 镜像） ─────────────────────────────────

export interface AsrTranscribeRequest {
  baseUrl: string;
  apiKey?: string;
  model: string;
  language?: string;
  fileName: string;
  mimeType: string;
  audio: ArrayBuffer;
}

export interface AsrTranscribeResponse {
  text: string;
  language?: string | null;
  duration?: number | null;
  segments?: Record<string, unknown>[] | null;
}

// ── 聊天图片上传（与 core/desktop/types.ts 镜像;PendingImage 不镜像,主进程只见 ImageSaveRequest） ──
export interface CliImageRef {
  path: string;
  mimeType: string;
}

export interface ImageSaveRequest {
  sessionId: string;
  fileName: string;
  mimeType: string;
  data: ArrayBuffer;
}

export interface ImageSaveResult {
  path: string;
}

export interface ImageReadResult {
  dataUrl: string;
}

// ── 聊天文档附件（PDF / 现代 Office / 纯文本;与 core/desktop/types.ts 镜像。
//    PendingDocFile 只活在 composer 内存态,不镜像;主进程只见 DocSaveRequest/Result） ──
export interface DocSaveRequest {
  sessionId: string;
  fileName: string; // 原始文件名,仅用于显示与扩展名嗅探,不参与落盘路径构造
  mimeType: string;
  // 二选一,优先 srcPath:file-picker / 拖拽给出的本地路径(Electron File.path),
  // 主进程直接从该路径拷贝,避免最大 50MB 的 ArrayBuffer 过 IPC 结构化克隆卡住 renderer。
  // 粘贴等无路径的内存态数据才走 data。
  srcPath?: string;
  data?: ArrayBuffer;
}

export interface DocSaveResult {
  path: string; // 落盘绝对路径(chatDocsRoot()/<sessionId>/<uuid>.<ext>)
  sizeBytes: number;
}

// ── 应用自动更新（与 core/desktop/types.ts 镜像） ────────────────────────

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";

export interface UpdateState {
  phase: UpdatePhase;
  // available 及之后:待更新的新版本号
  version?: string;
  // downloading:下载进度 0-100
  percent?: number;
  // downloading:已下载/总字节数与瞬时速率(B/s)。差量下载时 total 即本次实际需
  // 下载的差量字节数,用户可据此看出「只需 55MB 而非整包」。可选:缺字段时 UI
  // 降级只显示百分比(旧主进程无此字段)。
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  // error:失败描述
  error?: string;
  // available 及之后:本次更新的 markdown 说明,来自打包写入清单的 release notes
  releaseNotes?: string;
}

// ── GitBar:工作区 git 信息（与 core/desktop/types.ts 镜像） ──────────────

export interface GitInfoResult {
  isRepo: boolean;
  branch?: string; // detached HEAD 时为 short SHA
  additions: number; // 含 untracked 文件行数
  deletions: number;
  dirty: boolean; // porcelain 有任意条目（纯重命名 ± 为 0 也算脏）
  truncated?: boolean; // 统计因文件过多/过大可能不全
}

export interface GitDiffAllResult {
  diff: string;
  truncated: boolean;
}

// ── 右侧「文件」视图内容搜索（与 core/desktop/types.ts 镜像） ──────────────

export interface ContentMatchLine {
  line: number; // 1-based 行号
  text: string; // 整行文本（已 trimEnd，可能截断超长行）
}

export interface ContentMatchFile {
  path: string; // 绝对路径
  rel: string; // 相对项目根
  name: string; // basename
  lines: ContentMatchLine[];
}

export interface ContentSearchResult {
  files: ContentMatchFile[];
  truncated: boolean;
}

// ── GitBar 分支操作（与 core/desktop/types.ts 镜像） ──────────────────────

// 本地分支列表 + 当前分支（非 git 仓库 isRepo:false）。
export interface GitBranchesResult {
  isRepo: boolean;
  branches: string[]; // 本地分支名（refs/heads）
  current: string; // 当前分支;detached HEAD 时为 short SHA 或空
}

// 创建/切换分支结果。失败时 message 携带 git stderr 供 UI 透出。
export interface GitOpResult {
  ok: boolean;
  message?: string;
}

// ── Tasks 面板:tasks/ 目录文件列表（与 core/desktop/types.ts 镜像） ──────

export interface TaskFileInfo {
  name: string;
  path: string; // 绝对路径
  mtimeMs: number;
}

export interface TaskFilesResult {
  files: TaskFileInfo[];
  archived: TaskFileInfo[];
}

// ── 自动化（定时任务,与 core/desktop/types.ts 镜像） ──────────────────────

export type ReasoningEffort = "low" | "medium" | "high";

// 访问范围（沙箱档），与 core/desktop/types.ts 镜像。adapter 翻译成各 CLI 原生标志(线格式)。
export type PermissionMode = "plan" | "accept-edits" | "full-auto" | "sandbox";
// 执行/审批策略（与访问范围正交），与 core 镜像(线格式)。
export type ApprovalPolicy = "auto" | "ask";
// UI 单一真源执行权限单轴(与 core 镜像;主进程仅 round-trip 持久化,不按字段消费——发送边界在渲染端派生成线格式)。
export type ExecPermission = "plan" | "ask" | "auto";
// ── Computer Use 常量,与 core/desktop/types.ts 逐字镜像（改一处必改两处）──────────
// 工具名按 pi-computer-use@0.1.0 的 src/index.ts 实测抄录(17 个),官网文档漏了 gui_triple_click,
// 升级版本时必须重新核对源码:漏一个写工具 = 一个不经审批即可操作用户电脑的缺口。
export const COMPUTER_USE_SOURCE_REF = "npm:pi-computer-use@0.1.0";
export const COMPUTER_USE_READONLY_TOOLS = [
  "gui_read",
  "gui_screenshot",
  "gui_cursor_position",
  "gui_clipboard_read",
];
export const COMPUTER_USE_WRITE_TOOLS = [
  "gui_click",
  "gui_right_click",
  "gui_double_click",
  "gui_triple_click",
  "gui_hover",
  "gui_drag",
  "gui_scroll",
  "gui_type",
  "gui_keypress",
  "gui_hotkey",
  "gui_clipboard_write",
  "gui_batch",
];

// pi plan 档只读工具白名单,与 core/desktop/types.ts 的 PI_PLAN_TOOL_WHITELIST 镜像。
// 主进程 pi.ts 单发路径无法 import core barrel,故此处镜像一份供 adapter 引用(避免硬编码漂移)。
// 浏览器控制工具(browser_*,沙箱 + URL 闸)与 Computer Use 只读工具并入,须与 core 镜像逐字一致。
export const PI_PLAN_TOOL_WHITELIST = [
  "read",
  "grep",
  "find",
  "ls",
  "browser_navigate",
  "browser_screenshot",
  "browser_read_dom",
  "browser_read_console",
  "browser_click",
  "browser_type",
  "browser_network",
  "browser_accessibility",
  ...COMPUTER_USE_READONLY_TOOLS,
];

// Computer Use 设置,与 core/desktop/types.ts 的 ComputerUseSettings 逐字镜像。
// enabled 缺省视为启用;groundingModel 为空则回退会话模型（详见 core 侧注释）。
export interface ComputerUseSettings {
  enabled?: boolean;
  groundingModel?: string;
}

// Computer Use 环境自检结果（与 core/desktop/types.ts 逐字镜像）。
// ready 与「此刻会不会真给 Agent 注入 gui_* 工具」等价——它和注入决策共用 resolveComputerUse,
// 不是另算一遍,避免 UI 说可用而实际不注入。
export interface ComputerUseStatus {
  ready: boolean;
  installed: boolean;
  // ready=false 时的原因,设置页据此给出对应的引导（去授权 / 装 CLT / 重试安装）。
  reason?: ComputerUseBlockReason;
  groundingModel?: string;
}

// 可「重新申请授权」的权限种类（与 core/desktop/types.ts 镜像）。
// 只有这两项没有应用内授权弹窗、必须靠系统提示或手动添加,故只对它们做 reprompt。
export type ComputerUsePermissionKind = "accessibility" | "screenRecording";

// 不可用原因。与 capabilities/computer-use/env.ts 的同名联合类型同源。
export type ComputerUseBlockReason =
  | "not-macos"
  | "disabled"
  | "not-installed"
  | "no-swiftc"
  | "no-accessibility"
  | "no-screen-recording";

// weekday: 0=周日 .. 6=周六（与 JS Date.getDay() / croner 一致）。
export type ScheduleSpec =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "cron"; expression: string }
  // once: 一次性,绝对时刻 at(epoch ms)触发一次。与 core/desktop/types.ts 镜像。
  | { kind: "once"; at: number };

export type AutomationRunStatus = "running" | "ok" | "error" | "timeout" | "killed" | "skipped";

export interface AutomationMeta {
  id: string;
  name: string;
  enabled: boolean;
  projectId?: string;
  cwd?: string;
  agent: AgentKind;
  model?: string;
  effort?: ReasoningEffort;
  prompt: string;
  useOwnSkills?: boolean;
  notifyChannels?: PushChannelKind[];
  providerId?: string;
  schedule: ScheduleSpec;
  timezone?: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastStatus?: Exclude<AutomationRunStatus, "running">;
  nextRunAt?: number;
}

export interface AutomationInput {
  name: string;
  enabled?: boolean;
  projectId?: string;
  cwd?: string;
  agent: AgentKind;
  model?: string;
  effort?: ReasoningEffort;
  prompt: string;
  useOwnSkills?: boolean;
  notifyChannels?: PushChannelKind[];
  providerId?: string;
  schedule: ScheduleSpec;
  timezone?: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  startedAt: number;
  endedAt?: number;
  status: AutomationRunStatus;
  trigger: "schedule" | "manual";
  agent: AgentKind;
  agentSessionId?: string;
  prompt: string;
  output: string;
  error?: string;
}

export interface CronValidation {
  ok: boolean;
  nextRun?: number;
  error?: string;
}

export interface AutomationRunEvent {
  automationId: string;
  run: AutomationRun;
  phase: "start" | "end";
}

// ── 闪记（Flash Notes）──────────────────────────────────────────────────────
// 以下四个类型与 packages/core/desktop/types.ts 逐字镜像（两侧必须完全一致,
// 否则 preload 编译通过但运行期字段错位）。

// 闪记状态机：草稿 → 深化中 → 已深化（失败/放弃回落草稿）。
export type NoteStatus = "draft" | "deepening" | "deepened";

// 闪记单条记录：元数据 + 正文内联（单文件 notes.json,v1 不分文件）。
export interface NoteMeta {
  id: string;
  projectId?: string; // 缺省 = 未归类（事后可归档到项目）
  status: NoteStatus; // 默认 "draft"
  content: string; // 正文（markdown 文本,内联）
  tags?: string[];
  sourceSessionId?: string; // 捕捉时若在某会话内唤起则记下该会话
  conversationIds?: string[]; // 深化新开的会话 id（支持再深化,追加不覆盖）
  docPaths?: string[]; // 深化产出文档路径（追加不覆盖,再深化累加）
  createdAt: number; // epoch ms（main 生成）
  updatedAt: number; // epoch ms（main 每次写刷新）
}

// 渲染端创建闪记的入参（id/status/createdAt/updatedAt 由 main 生成,不传）。
export interface NoteInput {
  projectId?: string;
  content: string;
  tags?: string[];
  sourceSessionId?: string;
}

// notes.json 文件结构（对桥接层不透明,主进程独占写）。
export interface NotesFileData {
  version: 1;
  notes: NoteMeta[];
}

// ── 内置 skill 元数据 ────────────────────────────────────────────────────────
// 与 packages/core/desktop/types.ts 逐字镜像（两侧必须完全一致）。深化注入
// ce-ideate / 生成 plan 注入 ce-plan：只把 skill 的 frontmatter 源数据 + 文件路径
// 喂给 agent（不内联全文,让 agent 自己 Read）。
export interface SkillMeta {
  name: string; // frontmatter name（== 目录名）
  description: string; // frontmatter description
  argumentHint?: string; // frontmatter argument-hint
  skillMdPath: string; // SKILL.md 绝对路径（喂给 agent Read）
  dir: string; // skill 根目录绝对路径（references 相对路径的绝对前缀基准）
}

// skill 目录内的配套文档（除 SKILL.md 外的 .md/.txt/.json/.yaml 等,仅展示用,不影响注入）。
export interface SkillDoc {
  name: string; // 文件名（含后缀）
  path: string; // 绝对路径（点击经 bridge.openPath 打开）
}

// ── 插件管理：富 skill 项（与 packages/core/desktop/types.ts 逐字镜像）─────────────
export interface PluginSkill {
  name: string;
  description: string;
  argumentHint?: string;
  supportedAgents?: AgentKind[]; // frontmatter 声明的适用 agent;缺省=全 agent（注入时按会话 agent 过滤）
  dir: string; // skill 根目录绝对路径（即 --skill 注入值）
  rootPath: string; // 来源根（已 expand 的绝对路径）
  scope: SkillScope; // global | workspace
  origin?: "shared" | "agent"; // Design B(plan 002):shared/agent 私有原生根;缺省=shared
  enabled: boolean;
  trusted: boolean;
  shadowedBy?: string;
  docs: SkillDoc[]; // 配套文档清单（浅层枚举,不含 SKILL.md;空数组表示无）
}

// 插件市场（第一期，只读）类型。集中在 ./plugin-types 以免本已超 1200 行的类型文件继续膨胀。
export * from "./plugin-types";

// 工作流（loop）类型。集中在 ../workflow/types 以遵守单文件 1200 行上限。
// ⚠️ 与 packages/core/desktop/workflow-types.ts 逐字镜像（KTD5 双写契约）。
export * from "../workflow/types";

// 桌面宠物脱离主窗体(独立 overlay 窗口)状态快照。与 packages/core/desktop/types.ts 镜像同步
// (core 不能依赖 app 包,两侧各持一份;联合类型字面量须与 packages/core/store/pet.ts 保持一致)。
export type PetState = "idle" | "typing" | "thinking" | "working" | "replying" | "sleeping" | "happy";
export type PetKind = "cat" | "dog" | "mint";
export type PetMode = "free" | "perch";
export interface PetStateSnapshot {
  state: PetState;
  kind: PetKind;
  mode: PetMode;
  walk: boolean;
  enabled: boolean;
  size: number;
  color: string | null;
}
