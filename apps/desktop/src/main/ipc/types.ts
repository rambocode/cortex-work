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
  useOwnSkills?: boolean;
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

export interface PersistedState {
  version: 1;
  projects: ProjectMeta[];
  promptRoot?: string;
  sessions: SessionMeta[];
  todos?: TodoMeta[];
  // 持久化的供应商配置（renderer 全量写入;主进程 automation runner 只读）。
  providerSettings?: ProviderSettings;
  rightPanelWidth?: number;
  // 「最后一次使用」记忆（与 packages/core/desktop/types.ts 镜像;Spotlight/新会话默认沿用）。
  lastAgent?: AgentKind;
  lastModel?: string;
  lastProviderId?: string;
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
  // 推理强度（自动化任务用）:各 agent adapter 尽力翻译成对应 CLI 参数;pi 忽略。
  effort?: ReasoningEffort;
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

export interface UsageBucket {
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  msgs: number;
}

export interface UsageWindow {
  usedPercent: number;
  resetsAt: number;
  windowMinutes?: number;
  stale?: boolean;
}

export interface AgentUsage {
  at: number;
  claude: {
    last5h: UsageBucket;
    today: UsageBucket;
    week: UsageBucket;
    official: { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null } | null;
  } | null;
  codex: {
    planType: string;
    capturedAt: number;
    primary: UsageWindow | null;
    secondary: UsageWindow | null;
  } | null;
}

// 按天 token 用量（usage:daily，落地页用量日历 token 模式；与 core/desktop/types.ts 镜像）。
export interface DailyUsagePoint {
  day: string; // YYYY-MM-DD（本地时区，与 core/personal/timeline.ts 的 dayKey 同语义）
  tokens: number; // 当天 in+output+cacheCreate+cacheRead 之和
  msgs: number; // 当天计入的 assistant 消息数
}

export interface DailyUsage {
  at: number;
  days: DailyUsagePoint[]; // 按 day 升序；无活动的天省略（前端补零）
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
