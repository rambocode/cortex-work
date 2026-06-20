// 个人工作区 IPC 类型（主进程侧）。与 packages/core/desktop/types.ts 镜像 ——
// core 不能依赖 app 包，故两侧各持一份；preload 以 core 的 DesktopBridge 为准对齐。

export type AgentKind = "claude" | "codex" | "pi";

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

export interface SessionMeta {
  id: string;
  // 关联项目;缺省 = 不使用项目（会话在 Documents/cortex/<日期> 工作）。
  projectId?: string;
  // 不使用项目时的工作目录（Documents/cortex/<YYYY-MM-DD>,创建时定下不漂移）。
  noProjectDir?: string;
  title: string;
  claudeSessionId?: string;
  agentSessionIds?: Partial<Record<AgentKind, string>>;
  agent: AgentKind;
  model?: string;
  providerId?: string;
  piSessionFile?: string; // 阶段4 pi 会话恢复用磁盘 JSONL 路径（与 core 镜像）
  useOwnSkills?: boolean;
  permissionMode?: PermissionMode; // 运行模式（与 core 镜像;主进程仅 round-trip 持久化,不按字段消费）
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

export interface ProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  endpointFormat: EndpointFormat;
  models: ProviderModelOption[];
  enabled: boolean;
}

export interface ProviderSettings {
  providers: ProviderProfile[];
  defaultProviderId?: string;
  defaultModel?: string;
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
}

export interface GeneralSettings {
  workspaceRoot?: string;
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
}

// pi 插件 Skill 配置（与 packages/core/desktop/types.ts 逐字镜像）。
export interface PiSkillSettings {
  globalRoots: string[];
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

export interface PersistedState {
  version: 1;
  projects: ProjectMeta[];
  promptRoot?: string;
  sessions: SessionMeta[];
  todos?: TodoMeta[];
  // 持久化的供应商配置（renderer 全量写入;主进程 automation runner 只读）。
  providerSettings?: ProviderSettings;
  // 通用设置（renderer 全量写入;主进程读 workspaceRoot/desktopBehavior/log）。
  generalSettings?: GeneralSettings;
  rightPanelWidth?: number;
  // 「最后一次使用」记忆（与 packages/core/desktop/types.ts 镜像;Spotlight/新会话默认沿用）。
  lastAgent?: AgentKind;
  lastModel?: string;
  lastProviderId?: string;
  // 最近活跃项目（闪记浮层默认归属推导用;归档/删除该项目时清空）。与 core 镜像逐字一致。
  lastActiveProjectId?: string;
}

export interface ReadFileResult {
  content: string;
  truncated: boolean;
}

export interface CliStartRequest {
  runId: string;
  sessionId: string;
  agent: AgentKind;
  cwd: string;
  prompt: string;
  model?: string;
  resumeSessionId?: string;
  appendSystemPrompt?: string;
  useOwnSkills?: boolean;
  // pi 插件 Skill（U4）:已启用 + 去重后的 skill 目录绝对路径,buildArgs 逐个 --skill 注入。
  skillPaths?: string[];
  // 用户上传的图片（仅 claude/codex 消费;pi 走 piPrompt 独立参数）。与 core 镜像。
  images?: CliImageRef[];
  // 推理强度（自动化任务用）:各 agent adapter 尽力翻译成对应 CLI 参数;pi 忽略。
  effort?: ReasoningEffort;
  // 运行模式（权限松紧）:claude/codex adapter 翻译成原生标志;缺省 = full-auto。pi 不走本 DTO。
  permissionMode?: PermissionMode;
  // pi 专用:renderer 传入当前会话选中供应商的完整配置,主进程据此生成 extension
  // 并注入 key env。
  provider?: {
    id: string;
    baseUrl: string;
    apiKey?: string;
    models: { id: string; name?: string }[];
  };
  // 主进程内部填充:生成的 extension 文件绝对路径（buildArgs 读取）。
  piExtensionPath?: string;
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

export type CliStreamEvent =
  | { type: "init"; sessionId: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "result"; ok: boolean; text?: string; error?: string };

export interface CliExitEvent {
  runId: string;
  sessionId?: string;
  code: number | null;
  error?: string;
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
  // 自定义供应商:比 CliStartRequest.provider 多带 endpointFormat + per-model 能力标记
  // (reasoning/vision/contextTokens),供 renderPiExtension 渲染高级配置;主进程据此生成
  // extension 并注入 key。单发路径不需要高级配置,故 CliStartRequest.provider 不扩展。
  provider?: {
    id: string;
    baseUrl: string;
    apiKey?: string;
    endpointFormat?: EndpointFormat;
    models: { id: string; name?: string; reasoning?: boolean; vision?: boolean; contextTokens?: number }[];
  };
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
  | { type: "tool-start"; name: string; toolCallId: string; detail?: string }
  | { type: "tool-end"; name: string; toolCallId: string; isError: boolean }
  | { type: "turn-end" } // 一轮（含工具）结束
  | { type: "error"; error: string } // assistant stopReason=error/aborted
  | { type: "result"; willRetry: boolean } // 一次 run 结束（agent_end）
  | { type: "compaction"; phase: "start" | "end"; reason?: string }
  | { type: "retry"; attempt: number; maxAttempts?: number; error?: string }
  | { type: "queue"; steering: number; followUp: number }
  | { type: "session-info"; name?: string }
  | { type: "thinking-level"; level: string }
  | { type: "crashed"; error?: string }; // 进程非正常退出（session 注入,非 RPC 事件）

// pi extension 经 ctx.ui.* 发起的「需用户输入」请求（pi → host，独立于单向 PiSessionEvent 流）。
// 镜像 pi 0.79.2 rpc-types.d.ts 的 RpcExtensionUIRequest（已 spike 实测 confirm envelope）。
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

// ── 应用自动更新（与 core/desktop/types.ts 镜像） ────────────────────────

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";

export interface UpdateState {
  phase: UpdatePhase;
  // available 及之后:待更新的新版本号
  version?: string;
  // downloading:下载进度 0-100
  percent?: number;
  // error:失败描述
  error?: string;
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

// ── Tasks 面板:docs/{ideation,brainstorms,plans} 文档列表（与 core/desktop/types.ts 镜像） ──
// dumb 列表：只列目录 + 回传文件头部文本，语义解析（DocMeta/状态/标签/血缘）全在 core 纯函数。
export type DocFileKind = "ideation" | "brainstorm" | "plan";

export interface DocFileRaw {
  name: string;
  path: string; // 绝对路径
  kind: DocFileKind; // 由所在子目录决定
  mtimeMs: number;
  head: string; // 文件头部文本（含 frontmatter / inline 元数据块，供 core parseDocMeta 解析）
}

// ── 自动化（定时任务,与 core/desktop/types.ts 镜像） ──────────────────────

export type ReasoningEffort = "low" | "medium" | "high";

// 运行模式（权限松紧）三档,与 core/desktop/types.ts 镜像。adapter 翻译成各 CLI 原生标志。
export type PermissionMode = "plan" | "accept-edits" | "full-auto";
// pi plan 档只读工具白名单,与 core/desktop/types.ts 的 PI_PLAN_TOOL_WHITELIST 镜像。
// 主进程 pi.ts 单发路径无法 import core barrel,故此处镜像一份供 adapter 引用(避免硬编码漂移)。
export const PI_PLAN_TOOL_WHITELIST = ["read", "grep", "find", "ls"];

// weekday: 0=周日 .. 6=周六（与 JS Date.getDay() / croner 一致）。
export type ScheduleSpec =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "cron"; expression: string };

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

// ── 插件管理：富 skill 项（与 packages/core/desktop/types.ts 逐字镜像）─────────────
export interface PluginSkill {
  name: string;
  description: string;
  argumentHint?: string;
  dir: string; // skill 根目录绝对路径（即 --skill 注入值）
  rootPath: string; // 来源根（已 expand 的绝对路径）
  scope: SkillScope; // global | workspace
  enabled: boolean;
  trusted: boolean;
  shadowedBy?: string;
}
