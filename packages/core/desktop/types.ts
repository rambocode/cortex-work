// 个人工作区（桌面端）共享类型。与 apps/desktop/src/main/ipc/types.ts 保持
// 镜像（core 不能依赖 app 包，desktop 侧用 `satisfies` 对齐形状）。

export type AgentKind = "claude" | "codex" | "pi";

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
  pinnedAt?: number; // 置顶时间戳;缺省 = 未置顶
  archivedAt?: number; // 归档时间戳;缺省 = 在主列表
}

// 系统已安装的代码编辑器（主进程探测,Open in 菜单用）。
export interface EditorInfo {
  id: string; // 稳定标识,如 "vscode"、"cursor"
  name: string; // 展示名,如 "Visual Studio Code"
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
  // 关联项目;缺省 = 不使用项目（会话在 Documents/cortex/<日期> 工作）。
  projectId?: string;
  // 不使用项目时的工作目录（Documents/cortex/<YYYY-MM-DD>,创建时定下不漂移）。
  noProjectDir?: string;
  title: string;
  // 旧字段兼容:claude -p 首轮 system.init 返回的 session_id。
  claudeSessionId?: string;
  // 各 agent 自己的会话 id，后续轮次 resume 用。
  agentSessionIds?: Partial<Record<AgentKind, string>>;
  agent: AgentKind;
  model?: string;
  // pi 会话选中的供应商 id（指向 ProviderSettings.providers）;model 存该 provider 下的模型 id。
  providerId?: string;
  // 是否加载 agent 自身的 skills（claude: 关闭时传 --disable-slash-commands）。
  // 缺省视为 true。
  useOwnSkills?: boolean;
  // /clear 后默认隐藏到此游标为止的历史消息；消息文件本身仍完整保留。
  hiddenHistory?: HiddenHistoryMeta;
  // 归档时间戳;缺省 = 在会话列表。归档后默认从列表隐藏。
  archivedAt?: number;
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

// ── 供应商（Provider）配置：顶层 LLM 端点抽象（kun 风格） ─────────────────

// 协议类型（对齐 kun 的 endpointFormat）。运行期当前仅落地 chat_completions
//（OpenAI 兼容）；responses/messages/custom 数据模型与 UI 先就位，运行期接入延后。
export type EndpointFormat = "chat_completions" | "responses" | "messages" | "custom";

export interface ProviderModelOption {
  id: string; // 喂 pi --model 的模型 id
  label?: string; // 展示名,缺省用 id
  // 能力（可选,设置页能力徽标用;手动编辑填充,API 拉取一般只给 id）。
  contextTokens?: number; // 上下文窗口（token）,如 128000 → "128K 上下文"
  reasoning?: boolean; // 支持推理
  vision?: boolean; // 支持图片输入
}

// 一个 LLM 供应商（qwen / deepseek / kimi / 本地 / 企业网关 / anthropic 兼容均走此抽象）。
// 主进程把启用的 provider 渲染成 pi extension（registerProvider）,provider.id 即 pi provider 名。
export interface ProviderProfile {
  id: string; // slug,合法标识（无空格）,同时作为 pi provider 名
  name: string; // 展示名:"DeepSeek"、"通义千问"
  baseUrl: string; // API 根地址（OpenAI 兼容等）
  apiKey?: string;
  endpointFormat: EndpointFormat; // 协议类型,默认 chat_completions
  models: ProviderModelOption[];
  enabled: boolean; // 关闭的 provider 不出现在会话/自动化模型下拉
}

export interface ProviderSettings {
  providers: ProviderProfile[];
  defaultProviderId?: string; // 新建 pi 会话/未指定时用
  defaultModel?: string;
}

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = { providers: [] };

// 供应商连接测试（renderer 拍平 baseUrl/apiKey/endpointFormat 传入,主进程发探测请求）。
export interface ProviderProbeInput {
  baseUrl: string;
  apiKey?: string;
  endpointFormat: EndpointFormat;
}

export interface ProviderProbeResult {
  ok: boolean;
  models?: string[]; // 探测到的模型 id 列表（成功时）
  error?: string;
}

// 「添加供应商」预置模板（快速填充,不自动写入；用户填 key 即用,也可改 baseUrl/模型）。
export interface ProviderPreset {
  templateKey: string; // 模板唯一键 + 默认 provider id 前缀
  name: string;
  baseUrl: string;
  endpointFormat: EndpointFormat;
  models: ProviderModelOption[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    templateKey: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    endpointFormat: "chat_completions",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
    ],
  },
  {
    templateKey: "kimi",
    name: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.cn/v1",
    endpointFormat: "chat_completions",
    models: [
      { id: "kimi-k2-0711-preview", label: "Kimi K2" },
      { id: "moonshot-v1-128k", label: "Moonshot v1 128K" },
      { id: "moonshot-v1-32k", label: "Moonshot v1 32K" },
    ],
  },
  {
    templateKey: "qwen",
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    endpointFormat: "chat_completions",
    models: [
      { id: "qwen-max", label: "Qwen Max" },
      { id: "qwen-plus", label: "Qwen Plus" },
      { id: "qwen-turbo", label: "Qwen Turbo" },
      { id: "qwen3-coder-plus", label: "Qwen3 Coder Plus" },
    ],
  },
  {
    templateKey: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    endpointFormat: "chat_completions",
    models: [
      { id: "glm-4.6", label: "GLM-4.6" },
      { id: "glm-4-plus", label: "GLM-4-Plus" },
    ],
  },
  {
    templateKey: "siliconflow",
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpointFormat: "chat_completions",
    models: [{ id: "deepseek-ai/DeepSeek-V3", label: "DeepSeek-V3" }],
  },
  {
    templateKey: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    endpointFormat: "chat_completions",
    models: [
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4o-mini", label: "GPT-4o mini" },
    ],
  },
  {
    templateKey: "custom",
    name: "自定义",
    baseUrl: "",
    endpointFormat: "chat_completions",
    models: [],
  },
];

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

// 个人工作区用户资料（昵称 + 内置头像 id）。两字段均可选:
// 未设置时会话渲染回退到默认昵称「我」+ 首字母头像。
export interface PersonalProfile {
  nickname?: string;
  avatarId?: string;
}

// ── 通用设置（generalSettings：主进程消费 + 持久化） ───────────────────────

// 桌面行为（主进程据此设登录项/关窗行为/启动状态）。
export interface DesktopBehavior {
  openAtLogin: boolean; // 开机自启（仅 win32/darwin 生效）
  startMinimized: boolean; // 启动时最小化/不显示主窗口
  closeToTray: boolean; // 关窗（X）隐藏到托盘而非退出
}

export interface NotificationSettings {
  turnComplete: boolean; // agent 回合结束系统通知
}

export interface LogSettings {
  enabled: boolean; // 主进程文件日志落盘开关
  retentionDays: number; // 日志保留天数
}

// 通用设置容器（与外观项 Tweaks 分属两套存储：这里随 personal-workspace.json 落盘）。
export interface GeneralSettings {
  workspaceRoot?: string; // 默认工作目录（agent 启动未显式传 cwd 时兜底）
  desktopBehavior: DesktopBehavior;
  notifications: NotificationSettings;
  log: LogSettings;
  // 闪记全局热键（Electron accelerator）;缺省 = 主进程用默认 NOTES_HOTKEY_ACCELERATOR。
  notesHotkey?: string;
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  // closeToTray 默认 true：保留现有「关窗隐藏到后台、托盘常驻」行为;关闭则关窗即退出。
  desktopBehavior: { openAtLogin: false, startMinimized: false, closeToTray: true },
  notifications: { turnComplete: true },
  log: { enabled: true, retentionDays: 2 },
};

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
  providerSettings?: ProviderSettings;
  // 通用设置（工作目录/桌面行为/通知/日志;主进程消费）。
  generalSettings?: GeneralSettings;
  // 用户资料（昵称 + 头像;会话中 who="me" 的气泡据此渲染）。
  profile?: PersonalProfile;
  // 右侧面板自定义宽度（px）;未设置时按视图走 CSS 自动档位。
  rightPanelWidth?: number;
  // 「最后一次使用」记忆（Spotlight/新会话默认沿用;读取回退见 initialAgent）。
  lastAgent?: AgentKind;
  lastModel?: string;
  lastProviderId?: string;
  // 最近活跃项目（浮层默认归属推导用；归档/删除该项目时清空）。
  lastActiveProjectId?: string;
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

// 右侧「文件」视图内容搜索（? 前缀）：一条命中行（行号 + 整行文本）。
export interface ContentMatchLine {
  line: number; // 1-based 行号
  text: string; // 整行文本（已 trimEnd，可能截断超长行）
}

// 一个命中文件及其前若干条命中行。
export interface ContentMatchFile {
  path: string; // 绝对路径
  rel: string; // 相对项目根
  name: string; // basename
  lines: ContentMatchLine[];
}

// 内容搜索结果：命中文件列表 + 是否因限额截断。
export interface ContentSearchResult {
  files: ContentMatchFile[];
  truncated: boolean;
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

// GitBar 分支操作:本地分支列表 + 当前分支（非 git 仓库 isRepo:false）。
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

// ── 项目时间线 ────────────────────────────────────────────────────────────

// 时间线事件。存储的只有 run / summary.day 两类；session.created 由
// SessionMeta（createdAt）在读取时合成,git commit 由 gitLog 按需合入,note 由
// notes.json 在读取时合成（KTD6,不落盘）,均不写入 timeline/<projectId>.json。
export type TimelineEventKind = "run" | "summary.day" | "session.created" | "git.commit" | "note";

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
    noteId?: string; // note 合成事件回链的闪记 id（卡片点击跳详情用）
    noteStatus?: NoteStatus; // note 合成事件的闪记状态（草稿/深化中/已深化）
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
  // 推理强度（自动化任务用）:各 agent adapter 尽力翻译成对应 CLI 参数
  //（claude --effort / codex model_reasoning_effort）;不支持的 agent（pi）忽略。
  effort?: ReasoningEffort;
  // pi 专用:renderer 把当前会话选中的供应商完整配置拍平传入,主进程据此生成
  // extension（registerProvider）+ 注入 key env（与 llm.ts「主进程不读设置文件」惯例一致）。
  provider?: {
    id: string;
    baseUrl: string;
    apiKey?: string;
    models: { id: string; name?: string }[];
  };
  // 主进程内部填充:生成的 extension 文件绝对路径（renderer 不传,buildArgs 读取）。
  piExtensionPath?: string;
}

export interface AgentSessionRequest {
  agent: AgentKind;
  agentSessionId: string;
}

// 编辑重发:截断 agent CLI 会话记忆文件的请求(尽力而为,失败退化为带旧记忆 resume)。
export interface TrimSessionRequest {
  agent: AgentKind;
  agentSessionId: string;
  promptText: string;
  /** 同文序号:相同原文的用户消息里,被编辑的是第几条(0-based)。 */
  occurrence: number;
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

// ── pi RPC 长驻会话（--mode rpc） ────────────────────────────────────────
// 与 apps/desktop/src/main/ipc/types.ts 的 Pi* 类型镜像（core 不能依赖 app 包）。
// pi 走 RPC 会话通道（可 steer/abort/fork/运行时切模型）；claude/codex 仍走单发
// startCli 管线。事件契约（已实测）见 docs/plans/2026-06-16-003-feat-pi-rpc-session-plan.md。

// pi RPC 会话启动参数（renderer → 主进程 pi:open）。
export interface PiOpenRequest {
  uiSessionId: string; // 渲染层会话标识（一个 UI 会话 = 一个长驻 pi 进程）;复用个人会话 id。
  cwd: string;
  model?: string;
  useOwnSkills?: boolean;
  // 自定义供应商:与 CliStartRequest.provider 同形;主进程据此生成 extension 并注入 key。
  provider?: {
    id: string;
    baseUrl: string;
    apiKey?: string;
    models: { id: string; name?: string }[];
  };
  // 主进程内部填充:生成的 extension 文件绝对路径（renderer 不传,buildRpcArgs 读取）。
  piExtensionPath?: string;
}

// pi:open 的应答:回带 uiSessionId + pi 侧 sessionId（经 get_state 探测就绪时取得）。
export interface PiOpenResult {
  uiSessionId: string;
  sessionId: string;
}

// pi RPC 会话的归一化事件（主进程 → 渲染层 pi:event），由 AgentSessionEvent 映射而来
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

// pi extension 经 ctx.ui.* 发起的「需用户输入」请求（与 apps/desktop/src/main/ipc/types.ts 镜像）。
// 独立于单向 PiSessionEvent 流;阶段3 工具确认弹窗用 method:"confirm"。`id` 由 pi 生成,回写原样带回。
export type PiUiRequest =
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines: string[] | undefined; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// 回写给 pi 的 UI 应答（host → pi）。confirm→confirmed;select/input/editor→value;取消→cancelled。
export type PiUiResponsePayload =
  | { confirmed: boolean }
  | { value: string }
  | { cancelled: true };

// 菜单栏 Spotlight 浮动框提交的发起意图（bar → 主进程 → 主窗口接力新建会话）。
export interface SpotlightIntent {
  id: string; // 去重用唯一 id
  prompt: string;
  agent: AgentKind;
  model?: string;
  providerId?: string; // pi 选中供应商
  projectId?: string; // 缺省 = 不使用项目
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

// 按天 token 用量（usage:daily，落地页用量日历 token 模式；与 apps/desktop/src/main/ipc/types.ts 镜像）。
export interface DailyUsagePoint {
  day: string; // YYYY-MM-DD（本地时区，与 personal/timeline.ts 的 dayKey 同语义）
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
  // value 直接喂 pi --model（支持别名与 provider/model 模式串）。
  pi: [
    { label: "Claude Sonnet", value: "sonnet" },
    { label: "Claude Opus", value: "opus" },
    { label: "Claude Haiku", value: "haiku" },
    { label: "GPT-5.5", value: "openai/gpt-5.5" },
    { label: "Gemini 3.1 Pro", value: "google/gemini-3.1-pro" },
  ],
};

export const DEFAULT_MODEL: Record<AgentKind, string> = {
  claude: "sonnet",
  codex: "gpt-5.5",
  pi: "sonnet",
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

// ── 自动化（定时任务,与 apps/desktop/src/main/ipc/types.ts 镜像） ─────────
// 自动化是主进程拥有的状态域:配置 + 运行历史存于 ~/.cortex-desktop/automations.json
// 与 automation-runs/<id>.json,由 main 常驻调度器(croner)按时无头调用 agent CLI 执行。
// renderer 经 IPC 做 CRUD + 读历史,main 是唯一写者并通过事件推回最新快照。

// 推理强度三档。各 agent adapter 尽力翻译:claude `--effort`、codex
// `-c model_reasoning_effort=`;pi 无对应 flag,忽略。
export type ReasoningEffort = "low" | "medium" | "high";

// 定时规则。weekday: 0=周日 .. 6=周六（与 JS Date.getDay() / croner 一致）。
// minute 0-59,hour 0-23。cron 为 5 段标准表达式（分 时 日 月 周）。
export type ScheduleSpec =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number } // 周一~周五
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "cron"; expression: string };

// 一次执行的状态。skipped = 上轮还在跑、本轮到点被并发去重跳过;
// killed = 应用退出/被终止时中断;timeout = 超过执行时限。
export type AutomationRunStatus = "running" | "ok" | "error" | "timeout" | "killed" | "skipped";

export interface AutomationMeta {
  id: string; // "auto-..." 由 main 生成,SAFE_ID 安全
  name: string; // 自动化标题
  enabled: boolean; // false = 暂停,不调度
  projectId?: string; // 关联项目;可空（空 = 中性目录,仿 oneshot 不传 cwd）
  cwd?: string; // 创建时项目 path 快照（项目改名/删除后仍可执行）
  agent: AgentKind; // 默认 agent
  model?: string;
  effort?: ReasoningEffort; // 推理强度
  prompt: string; // 内容即提示词
  useOwnSkills?: boolean;
  providerId?: string; // pi 自定义供应商:仅存 id,apiKey 运行时由 main 从 providerSettings 解析
  schedule: ScheduleSpec;
  timezone?: string; // IANA 时区,缺省 = 创建时本机时区
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number; // 上次运行(开始)时间
  lastStatus?: Exclude<AutomationRunStatus, "running">; // 上次执行结果
  nextRunAt?: number; // 由 main 用 croner.nextRun() 计算后推给 UI
}

// 创建自动化的输入（id/时间戳/nextRunAt 由 main 生成）。
export interface AutomationInput {
  name: string;
  enabled?: boolean; // 缺省 true
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
  id: string; // run id（uuid）
  automationId: string;
  startedAt: number;
  endedAt?: number;
  status: AutomationRunStatus;
  trigger: "schedule" | "manual"; // 定时触发 vs 快速执行
  agent: AgentKind;
  agentSessionId?: string; // 从 init 事件捕获,便于追溯
  prompt: string; // 执行时的 prompt 快照
  output: string; // 聚合文本(截断上限)
  error?: string;
}

// cron 表达式校验结果（供 ScheduleEditor 即时预览;真相以 main 调度为准）。
export interface CronValidation {
  ok: boolean;
  nextRun?: number; // 下次触发 epoch ms
  error?: string;
}

// main → renderer 的运行事件:phase=start 标记开跑,end 标记收尾（带最终 run）。
export interface AutomationRunEvent {
  automationId: string;
  run: AutomationRun;
  phase: "start" | "end";
}

// ── 闪记（Flash Notes）──────────────────────────────────────────────────────
// 以下四个类型与 apps/desktop/src/main/ipc/types.ts 逐字镜像（两侧必须完全一致,
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
// 与 apps/desktop/src/main/ipc/types.ts 逐字镜像（两侧必须完全一致）。深化注入
// ce-ideate / 生成 plan 注入 ce-plan：只把 skill 的 frontmatter 源数据 + 文件路径
// 喂给 agent（不内联全文,让 agent 自己 Read）。
export interface SkillMeta {
  name: string; // frontmatter name（== 目录名）
  description: string; // frontmatter description
  argumentHint?: string; // frontmatter argument-hint
  skillMdPath: string; // SKILL.md 绝对路径（喂给 agent Read）
  dir: string; // skill 根目录绝对路径（references 相对路径的绝对前缀基准）
}
