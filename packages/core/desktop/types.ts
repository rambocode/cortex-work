// 个人工作区（桌面端）共享类型。与 apps/desktop/src/main/ipc/types.ts 保持
// 镜像（core 不能依赖 app 包，desktop 侧用 `satisfies` 对齐形状）。

export type AgentKind = "claude" | "codex";

// Prompt 库目录树节点（递归扫描 .md 的结果）。
export interface PromptNode {
  name: string;
  path: string; // 绝对路径
  kind: "dir" | "file";
  children?: PromptNode[];
}

export interface ProjectMeta {
  id: string;
  name: string;
  path: string; // 本地文件夹绝对路径
  addedAt: number;
}

export type TodoStatus = "open" | "done";

export interface TodoMeta {
  id: string;
  projectId: string;
  title: string;
  status: TodoStatus;
  detailPath: string; // 项目 tasks/<id>.md 的绝对路径
  createdAt: number;
  updatedAt: number;
}

export interface SessionMeta {
  id: string; // 应用内 uuid
  projectId: string;
  title: string;
  // 旧字段兼容:claude -p 首轮 system.init 返回的 session_id。
  claudeSessionId?: string;
  // 各 agent 自己的会话 id，后续轮次 resume 用。
  agentSessionIds?: Partial<Record<AgentKind, string>>;
  agent: AgentKind;
  model?: string;
  // 是否加载 agent 自身的 skills（claude: 关闭时传 --disable-slash-commands）。
  // 缺省视为 true。
  useOwnSkills?: boolean;
  // /clear 后默认隐藏到此游标为止的历史消息；消息文件本身仍完整保留。
  hiddenHistory?: HiddenHistoryMeta;
  createdAt: number;
  updatedAt: number;
}

export interface HiddenHistoryMeta {
  count: number;
  throughUid?: string;
  hiddenAt: number;
}

// ── 时间线日报设置（模型选择 + 推送渠道） ────────────────────────────────

// 日报生成模型：现有集成 Agent,或自定义 OpenAI 兼容端点（Ollama/LM Studio 等）。
export type SummaryModelConfig =
  | { kind: "agent"; agent: AgentKind; model?: string }
  | { kind: "openai"; baseUrl: string; apiKey?: string; model: string };

export interface WecomPushConfig {
  enabled: boolean;
  webhookUrl: string;
}

export interface DingtalkPushConfig {
  enabled: boolean;
  webhookUrl: string;
  secret?: string; // 加签密钥（可选,机器人安全设置为「加签」时必填）
}

export interface EmailPushConfig {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  secure: boolean; // true = SMTPS(465),false = STARTTLS/明文(587/25)
  user: string;
  pass: string;
  from: string;
  to: string; // 多个收件人用逗号分隔
}

export interface TimelineSettings {
  summaryModel: SummaryModelConfig;
}

export const DEFAULT_TIMELINE_SETTINGS: TimelineSettings = {
  summaryModel: { kind: "agent", agent: "claude", model: "haiku" },
};

// 全局推送渠道设置（独立于时间线,所有需要推送的场景共用）。
export interface PushSettings {
  wecom?: WecomPushConfig;
  dingtalk?: DingtalkPushConfig;
  email?: EmailPushConfig;
  // 推送格式 Skill：Prompt 库中 .md 模板的绝对路径（占位符替换,首行为推送标题）;
  // 未设置时使用内置默认格式。
  formatSkillPath?: string;
}

export const DEFAULT_PUSH_SETTINGS: PushSettings = {};

// ── TTS（Agent 输出转语音） ──────────────────────────────────────────────

// system = 系统语音（renderer speechSynthesis,本地零配置）;
// openai = OpenAI 兼容 /v1/audio/speech 端点（本地部署或云端均可）。
export type TtsEngineConfig =
  | { kind: "system"; voice?: string; rate?: number }
  | {
      kind: "openai";
      baseUrl: string;
      apiKey?: string;
      model: string;
      voice: string;
      speed?: number;
      language?: string;
      stream?: boolean;
      streamingInterval?: number;
    };

export interface TtsSettings {
  // 开启后 Agent 每轮回复落定时自动朗读。
  autoSpeak: boolean;
  engine: TtsEngineConfig;
}

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  autoSpeak: false,
  engine: { kind: "system" },
};

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

// ── ASR（用户语音转输入文本） ────────────────────────────────────────────

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

// 推送目标（renderer 把设置拍平后传给主进程,主进程不读设置文件）。
export type PushTarget =
  | { kind: "wecom"; webhookUrl: string }
  | { kind: "dingtalk"; webhookUrl: string; secret?: string }
  | { kind: "email"; smtp: Omit<EmailPushConfig, "enabled"> };

export interface PushResult {
  ok: boolean;
  error?: string;
}

export interface OpenAiCompleteRequest {
  baseUrl: string;
  apiKey?: string;
  model: string;
  prompt: string;
}

// 主进程 userData JSON 中持久化的全量状态。
export interface PersistedState {
  version: 1;
  projects: ProjectMeta[];
  promptRoot?: string;
  sessions: SessionMeta[];
  todos?: TodoMeta[];
  timelineSettings?: TimelineSettings;
  pushSettings?: PushSettings;
  ttsSettings?: TtsSettings;
  // 右侧面板自定义宽度（px）;未设置时按视图走 CSS 自动档位。
  rightPanelWidth?: number;
}

export interface ReadFileResult {
  content: string;
  truncated: boolean;
}

// 项目变更文件（git status;非 git 仓库回退为最近修改文件）。
export interface ChangedFile {
  path: string; // 绝对路径
  rel: string; // 相对项目根
  status: string; // git 状态码（M/A/D/??…）
}

export interface GitChangesResult {
  isRepo: boolean;
  files: ChangedFile[];
}

// GitBar:工作区 git 信息（分支 + ± 行数统计,含 untracked）。
export interface GitInfoResult {
  isRepo: boolean;
  branch?: string; // detached HEAD 时为 short SHA
  additions: number; // 含 untracked 文件行数
  deletions: number;
  dirty: boolean; // porcelain 有任意条目（纯重命名 ± 为 0 也算脏）
  truncated?: boolean; // 统计因文件过多/过大可能不全
}

// GitBar「查看 diff」:整仓 diff（tracked 真实 diff + untracked 合成片段）。
export interface GitDiffAllResult {
  diff: string;
  truncated: boolean;
}

// ── 项目时间线 ────────────────────────────────────────────────────────────

// 时间线事件。存储的只有 run / summary.day 两类；session.created 由
// SessionMeta（createdAt）在读取时合成,git commit 由 gitLog 按需合入,均不落盘。
export type TimelineEventKind = "run" | "summary.day" | "session.created" | "git.commit";

export interface TimelineEvent {
  id: string;
  projectId: string;
  sessionId?: string;
  ts: number; // epoch ms
  kind: TimelineEventKind;
  title: string; // run = prompt 首行；summary.day = "AI 日报"
  summary?: string; // run = 结果摘要；summary.day = 日报全文
  files?: string[]; // run 中写类工具触碰的文件（相对项目根）
  meta?: {
    agent?: AgentKind;
    durationMs?: number;
    ok?: boolean;
    day?: string; // summary.day 归属的天（YYYY-MM-DD）
    hash?: string; // git.commit
    backfilled?: boolean; // 历史回填事件（时间归到 session 最后活跃日）
  };
}

// timeline/<projectId>.json 的文件结构（对主进程不透明）。
export interface TimelineFileData {
  version: 1;
  backfilledAt?: number; // 缺失表示尚未做历史回填
  events: TimelineEvent[];
}

export interface GitCommit {
  ts: number; // epoch ms
  hash: string;
  subject: string;
}

// ── CLI 流式 ──────────────────────────────────────────────────────────────

export interface CliStartRequest {
  runId: string; // renderer 生成，关联事件流
  sessionId: string; // 主进程在事件中回显,renderer 重载后仍可恢复归属
  agent: AgentKind;
  cwd: string; // 项目路径
  prompt: string;
  model?: string;
  resumeSessionId?: string; // 多轮续接
  appendSystemPrompt?: string; // 拖入的 prompt md 内容（skill 注入）
  useOwnSkills?: boolean; // false → 禁用 agent 自身 skills
}

// claude stream-json 行解析后的归一化事件（adapter 输出）。
export type CliStreamEvent =
  | { type: "init"; sessionId: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "result"; ok: boolean; text?: string; error?: string };

export interface CliExitEvent {
  runId: string;
  sessionId?: string; // 回显,供 renderer 重载后兜底清理
  code: number | null;
  error?: string; // spawn 失败（如 ENOENT）等
}

// ── 内嵌终端（PTY） ───────────────────────────────────────────────────────

export interface PtySpawnRequest {
  id: string;
  cwd?: string;
  cols: number;
  rows: number;
}

export interface PtySpawnResult {
  ok: boolean;
  cwd?: string;
  error?: string; // node-pty 不可用等
}

// ── Agent 用量统计（参考 fanbox:本地会话日志 + 官方接口） ─────────────────

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
  resetsAt: number; // epoch 秒,0 表示未知
  windowMinutes?: number;
  stale?: boolean; // 快照已过窗口重置点,百分比失真
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

// 系统扫描发现的 agent 项目（来自 ~/.claude/projects 与 ~/.codex/sessions 的会话日志）。
export interface AgentProjectInfo {
  path: string; // 项目真实绝对路径（从会话日志 cwd 反解）
  name: string; // basename
  agents: AgentKind[];
  lastActive: number; // epoch ms，取会话日志文件 mtime 最大值
}

// agent → 可选模型列表（UI 下拉用）。
export const AGENT_MODELS: Record<AgentKind, { label: string; value: string }[]> = {
  claude: [
    { label: "Sonnet", value: "sonnet" },
    { label: "Opus", value: "opus" },
    { label: "Haiku", value: "haiku" },
  ],
  codex: [
    { label: "GPT-5.5", value: "gpt-5.5" },
    { label: "GPT-5.4", value: "gpt-5.4" },
    { label: "GPT-5.4 Mini", value: "gpt-5.4-mini" },
    { label: "GPT-5.3 Codex Spark", value: "gpt-5.3-codex-spark" },
  ],
};

export const DEFAULT_MODEL: Record<AgentKind, string> = {
  claude: "sonnet",
  codex: "gpt-5.5",
};

// ── 应用自动更新（与 apps/desktop/src/main/ipc/types.ts 镜像） ─────────────

// 主进程 electron-updater 状态快照。phase 流转:
// idle → checking → available → downloading → downloaded;失败进 error
//（保留 version,UI 可提供「重试」）。
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

// ── Tasks 面板:tasks/ 目录文件列表（与 apps/desktop/src/main/ipc/types.ts 镜像） ──

export interface TaskFileInfo {
  name: string;
  path: string; // 绝对路径
  mtimeMs: number;
}

export interface TaskFilesResult {
  // tasks/ 顶层 .md（按 mtime 降序）
  files: TaskFileInfo[];
  // tasks/archive/ 顶层 .md（压缩归档产物）
  archived: TaskFileInfo[];
}
