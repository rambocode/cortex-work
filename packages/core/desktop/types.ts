// 个人工作区（桌面端）共享类型。与 apps/desktop/src/main/ipc/types.ts 保持
// 镜像（core 不能依赖 app 包，desktop 侧用 `satisfies` 对齐形状）。

export type AgentKind = "claude" | "codex" | "pi";

// M3-A:用户 JSON(agents.local.json)派生/覆盖的 agent 元数据。与 ipc/types.ts 镜像同步。
export interface DerivedAgentMeta {
  id: string;
  base: AgentKind;
  label?: string;
}

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
  // pi 思考强度（阶段5）:运行时可切(set_thinking_level),冷启经 --thinking 设初值;缺省回退
  // generalSettings.piThinkingDefault,再缺省 = 不传 = pi 内置默认。
  thinkingLevel?: ThinkingLevel;
  // pi 会话选中的供应商 id（指向 ProviderSettings.providers）;model 存该 provider 下的模型 id。
  providerId?: string;
  // pi 侧会话磁盘 JSONL 路径（阶段4）。会话开启时由 get_state 取得并持久;崩溃/空闲/LRU/app 重启
  // 后重开时据此 switchSession 恢复上下文。持久化（随 SessionMeta 落盘）。
  piSessionFile?: string;
  // 是否加载 agent 自身的 skills（claude: 关闭时传 --disable-slash-commands）。
  // 缺省视为 true。
  useOwnSkills?: boolean;
  // 运行模式（权限松紧）:plan / accept-edits / full-auto。缺省 = full-auto（历史默认全自动）。
  // claude/codex 逐轮 fresh spawn,改值下一轮即生效;pi RPC 长驻,改值触发会话重开。
  permissionMode?: PermissionMode;
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
  // providerId 仅对 agent === "pi" 有意义:指向 providerSettings 里选中的供应商;
  // 缺省时回退 providerSettings.defaultProviderId。其余 agent 忽略该字段。
  | { kind: "agent"; agent: AgentKind; model?: string; providerId?: string }
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

export interface FeishuPushConfig {
  enabled: boolean;
  webhookUrl: string; // 自定义机器人 webhook,host 须为 open.feishu.cn 或 open.larksuite.com
  secret?: string; // 加签密钥（可选,机器人安全设置为「加签」时必填;算法见 push-sign.ts feishuSign）
}

// 内部通知渠道:主进程 Electron 原生系统通知(无头/关窗也能收到),独立于 chat 的
// notifications.turnComplete。无 webhookUrl,仅一个启用开关。
export interface InternalNotifyConfig {
  enabled: boolean;
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
  feishu?: FeishuPushConfig;
  internal?: InternalNotifyConfig;
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
  // i18n key（settings 命名空间）用于下拉展示;实例化时由 providerFromPreset 解析为具体本地化串
  // 再写入 ProviderProfile.name —— 绝不把翻译 key 持久化。
  nameKey: string;
  baseUrl: string;
  endpointFormat: EndpointFormat;
  models: ProviderModelOption[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    templateKey: "deepseek",
    nameKey: "providers.preset.deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    endpointFormat: "chat_completions",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
    ],
  },
  {
    templateKey: "kimi",
    nameKey: "providers.preset.kimi",
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
    nameKey: "providers.preset.qwen",
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
    nameKey: "providers.preset.zhipu",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    endpointFormat: "chat_completions",
    models: [
      { id: "glm-4.6", label: "GLM-4.6" },
      { id: "glm-4-plus", label: "GLM-4-Plus" },
    ],
  },
  {
    templateKey: "siliconflow",
    nameKey: "providers.preset.siliconflow",
    baseUrl: "https://api.siliconflow.cn/v1",
    endpointFormat: "chat_completions",
    models: [{ id: "deepseek-ai/DeepSeek-V3", label: "DeepSeek-V3" }],
  },
  {
    templateKey: "openai",
    nameKey: "providers.preset.openai",
    baseUrl: "https://api.openai.com/v1",
    endpointFormat: "chat_completions",
    models: [
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4o-mini", label: "GPT-4o mini" },
    ],
  },
  {
    templateKey: "custom",
    nameKey: "providers.preset.custom",
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

// ── 聊天图片上传 ──────────────────────────────────────────────────────────
// 与 apps/desktop/src/main/ipc/types.ts 镜像（PendingImage 是 composer 内存态,
// 不镜像到 main——主进程只见 ImageSaveRequest）。统一「落盘拿绝对路径」骨架,各
// agent 走原生通道:claude 路径进 prompt、codex -i flag、pi RPC images base64。

// composer 待发图片（renderer 内存态;dataUrl 供即时预览,data 供落盘）。
// id/name 是客户端值,**不得用于主进程路径构造**(文件名由主进程 randomUUID 生成)。
export interface PendingImage {
  id: string; // 客户端临时 id（列表 key / 同批去重辅助）
  name: string; // 原始文件名（仅显示）
  mimeType: string;
  dataUrl: string; // 即时预览用 data: URL（不落盘、不持久化）
  data: ArrayBuffer; // 落盘原始字节（结构化克隆跨 IPC,照抄 AsrTranscribeRequest.audio）
  width?: number;
  height?: number;
}

// 传给 claude/codex adapter 的精简图片引用（仅 claude/codex 消费;pi 走 piPrompt 独立参数）。
export interface CliImageRef {
  path: string; // 绝对路径
  mimeType: string;
}

// image:save 入参（renderer → 主进程;二进制经 ArrayBuffer 直传,照抄 AsrTranscribeRequest.audio）。
export interface ImageSaveRequest {
  sessionId: string; // 落盘目录键（主进程 SAFE_ID 校验）
  fileName: string; // 原始名（仅回带显示,不参与路径）
  mimeType: string; // 声明 MIME（主进程 magic-bytes 嗅探复核,错配拒绝）
  data: ArrayBuffer;
}

export interface ImageSaveResult {
  path: string; // 落盘后的绝对路径（randomUUID + 嗅探扩展名）
}

export interface ImageReadResult {
  dataUrl: string; // data:<mime>;base64,...（缩略图回读用）
}

// 推送目标（renderer 把设置拍平后传给主进程,主进程不读设置文件）。
// 注意:本类型在 apps/desktop/src/main/ipc/push.ts 有一份本地镜像,两侧须同步。
export type PushTarget =
  | { kind: "wecom"; webhookUrl: string }
  | { kind: "dingtalk"; webhookUrl: string; secret?: string }
  // 飞书自定义机器人:secret 为「加签」安全模式的密钥(可选)。加签算法与钉钉相反
  // (key=`${timestampSec}\n${secret}`、data 空、秒级、放请求体),见 push-sign.ts feishuSign。
  | { kind: "feishu"; webhookUrl: string; secret?: string }
  | { kind: "email"; smtp: Omit<EmailPushConfig, "enabled"> };

// 推送渠道标识(外部 webhook/邮件 + 内部原生通知)。自动化按此选择「完成后通知到哪些渠道」。
export type PushChannelKind = "wecom" | "dingtalk" | "feishu" | "email" | "internal";

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
// MCP 注入配置(M2 U2,与 apps/desktop/src/main/ipc/types.ts 逐字镜像)。renderer 设置区编辑,
// 主进程消费注入。enabled=总开关;关时不注入不覆盖,尊重用户自有 .mcp.json / ~/.codex。
export interface McpServerConfig {
  id: string;
  label?: string;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string; // stdio 工作目录（spawn cwd）
  envPassthrough?: string[]; // stdio:从宿主环境透传的变量名（注入时解析为 env 值，写入 gitignore 的 .mcp.json）
  url?: string;
  headers?: Record<string, string>;
}

export interface McpSettings {
  enabled: boolean;
  servers: McpServerConfig[];
}

export interface GeneralSettings {
  workspaceRoot?: string; // 默认工作目录（agent 启动未显式传 cwd 时兜底）
  // MCP 注入配置(U2);缺省视为不注入。
  mcp?: McpSettings;
  // 新会话默认 agent;缺省 = 按安装情况派生（resolveDefaultAgent / defaultAgent）。
  // 落地页激励文案的每日 LLM 增强也基于此 agent 生成。
  defaultAgent?: AgentKind;
  desktopBehavior: DesktopBehavior;
  notifications: NotificationSettings;
  log: LogSettings;
  // 闪记全局热键（Electron accelerator）;缺省 = 主进程用默认 NOTES_HOTKEY_ACCELERATOR。
  notesHotkey?: string;
  // pi 深度定制（阶段3）:经 extension 加载,会话开启时生效;缺省 = 全关。
  piCustomization?: PiCustomizationSettings;
  // pi 持久追加 system prompt（阶段4）:会话开启时经 --append-system-prompt 注入(系统级,不污染每轮
  // prompt);改动需重开会话才生效(pi RPC 无运行时改 system prompt 的命令)。缺省 = 不传 = pi 默认。
  piSystemPrompt?: string;
  // 全局指令（U3）:对 claude/codex/pi 三端统一生效的自定义系统提示词,经每轮 appendSystemPrompt 注入
  // （pi 走 buildPiPromptMessage 每轮前缀,claude --append-system-prompt,codex promptWithSkills 前置）。
  // 与 piSystemPrompt 区分:后者仅 pi、会话级;前者跨 agent、逐轮即时生效。缺省 = 不注入。
  globalInstruction?: string;
  // pi 新会话默认思考强度（阶段5）:会话级 SessionMeta.thinkingLevel 缺省时回退此值。
  piThinkingDefault?: ThinkingLevel;
  // pi 插件——Skill 管理（多目录扫描 + 逐项启用 + 工作区信任）。缺省 = DEFAULT_PI_SKILLS。
  piSkills?: PiSkillSettings;
  // pi 扩展市场——已装扩展溯源 + 启用集 + 信任集。缺省 = DEFAULT_PI_EXTENSIONS。
  piExtensions?: PiExtensionSettings;
  // 插件市场（agents 标准，第一期）——启停/信任态（只读库存之上的本地叠加层）。缺省 = DEFAULT_PLUGIN_ENABLE。
  // 主进程不读（注入根经 IPC 入参传入，见 skill-injection），故不在 main GeneralSettings 镜像。
  plugins?: PluginEnableSettings;
}

// pi 插件——Skill 配置。会话开启时由 messages.resolveEnabledSkillPaths 解析为 --skill 注入。
// 安全模型:全局根 skill 默认启用（用户自有目录,可信）;工作区根 skill 默认禁用,需显式授信
// （避免恶意仓库经 <项目>/.cortex-desktop/skills + -a 任意代码执行）。
export interface PiSkillSettings {
  // 内置默认全局根（含 ~,主进程 expand）。不可删,作为「可信」来源。
  globalRoots: string[];
  // 用户自增的全局根（需一次信任确认;可删）。与 globalRoots 区分以支持信任与删除策略。
  userGlobalRoots: string[];
  // 已禁用 skill 的复合键集合,键 = `${scope}:${name}`（非绝对目录,目录移动后禁用态仍生效）。
  disabledSkills: string[];
  // 已授信的工作区 skill 绝对目录集合（仅其中的工作区 skill 才进入注入集）。
  trustedWorkspaceSkillDirs: string[];
  // 是否扫描 / 注入工作区根 <项目>/.cortex-desktop/skills。
  workspaceEnabled: boolean;
}

export type SkillScope = "global" | "workspace";

export const DEFAULT_PI_SKILLS: PiSkillSettings = {
  globalRoots: ["~/.agents/skills", "~/.cortex-desktop/skills"],
  userGlobalRoots: [],
  disabledSkills: [],
  trustedWorkspaceSkillDirs: [],
  workspaceEnabled: true,
};

// ── pi 扩展市场（U2）─────────────────────────────────────────────────────────
// 用 pi 原生 `pi install` 作扩展（npm/git 包）的安装运行时。与 Skill 的「默认启用 + 禁用列表」
// 相反:扩展是「装≠启用」——默认禁用,经 enabled allowlist 显式启用;trusted allowlist 记过信任门。
// 安全模型(实测 pi 0.79.2):`--no-extensions` 抑制已装包自动发现,故仅显式 -e 注入的才加载;
// `-a` 整批信任,UI 信任门是唯一逐扩展强制点。v1 仅用户级(global);scope/ref 复合键为后续项目级
// (默认不授信)留路。唯一键 ref = 源类型+标识(npm:@foo/bar 与 git:... 视为两项)。
// 溯源(version/origin/installedAt)是安装时数据——`pi list` 仅给路径、不含这些,故安装时持久化于此。

// 已装扩展的溯源记录（安装成功时持久化;库存「存在性」由 pi list 重建,溯源字段由此提供）。
export interface InstalledExtensionRecord {
  ref: string; // 唯一键 = 源类型+标识,如 "npm:@foo/bar" / "git:github.com/u/r"
  scope: SkillScope; // global | workspace（v1 仅 global）
  sourceRef: string; // 原始安装 ref 字符串（用户在确认门输入的原值）
  origin: string; // 来源类型:npm | git | https | local
  version?: string; // 安装时解析到的版本（若可得）
  installedAt: number; // 安装时间戳（epoch ms）
  // 安装时解析到的本地 -e 路径（pi list 给出;注入需要,故随记录持久化）。pi list 不再含此路径 = missing。
  path: string;
}

export interface PiExtensionSettings {
  // 安装溯源记录（安装时写、卸载时删）。
  installed: InstalledExtensionRecord[];
  // 已启用扩展的复合键集合,键 = `${scope}:${ref}`（默认禁用,opt-in 启用）。
  enabled: string[];
  // 已授信（过信任门）扩展的复合键集合,键 = `${scope}:${ref}`。
  trusted: string[];
}

export const DEFAULT_PI_EXTENSIONS: PiExtensionSettings = {
  installed: [],
  enabled: [],
  trusted: [],
};

// ── 插件市场启停/信任态（第一期）──────────────────────────────────────────────
// 叠加在 ~/.agents/plugins 只读库存之上的 cortex 本地 opt-in 层（main 不读 store，注入接线见
// skill-injection 的 pluginSkillRoots 入参）。语义（KTD4）：
//   - 装≠启用 → enabled 是 opt-in 集合（默认未启用），键 = 插件 id。
//   - 已装插件在用户本机全局共享目录，类比全局 skill 默认「已授信」；为省存储，只记录「显式撤信」
//     的 id（distrusted），缺省即视为已授信。注入 gate（U6）= enabled.has(id) && !distrusted.has(id)。
export interface PluginEnableSettings {
  enabled: string[]; // 已启用插件 id（opt-in）
  distrusted: string[]; // 已显式撤信的插件 id（缺省 = 已授信）
}

export const DEFAULT_PLUGIN_ENABLE: PluginEnableSettings = {
  enabled: [],
  distrusted: [],
};

// 渲染端富扩展项:pi list 的存在性 + store 的溯源/启用/信任叠加后计算（bridge piExtList 返回 +
// store 派生）。missing = 在 store.installed 但 pi list 已不含（外部删除/损坏）→ UI 标失踪。
export interface InstalledExtension {
  ref: string;
  path?: string; // pi list 给出的本地 -e 路径（失踪时缺）
  scope: SkillScope;
  sourceRef: string;
  origin: string;
  version?: string;
  installedAt: number;
  enabled: boolean; // store.enabled 含 `${scope}:${ref}`
  trusted: boolean; // store.trusted 含 `${scope}:${ref}`
  missing: boolean; // store.installed 有但 pi list 无
}

// pi-ext:install 结果（与 apps/desktop/src/main/ipc/types.ts 镜像）。成功带落盘 path + 溯源。
export type PiExtInstallResult =
  | { ok: true; ref: string; sourceRef: string; origin: string; version?: string; path: string }
  | { ok: false; error: string };

// pi 深度定制开关（阶段3）。改动在下次 pi 会话开启时生效（extension 在 open 时加载）。
export interface PiCustomizationSettings {
  toolApproval: boolean; // 工具执行审批弹窗（拦 bash/write/edit 等,经弹窗确认）
  sampleTools: boolean; // 自定义工具样例 echo_upper
  sampleCommands: boolean; // 斜杠命令样例 /greet
  // toolApproval 开时需审批的工具集。undefined=默认三件(bash/write/edit);空数组=不审批任何工具。
  approvalTools?: string[];
}

// 审批工具:默认需审批的高风险工具 + UI 可勾选的工具全集。与 pi-extensions.ts 的
// DEFAULT_APPROVAL_TOOLS 同源（pi 工具名小写 bash/read/edit/write/grep/find/ls）。
export const DEFAULT_PI_APPROVAL_TOOLS = ["bash", "write", "edit"];
export const PI_APPROVAL_TOOL_OPTIONS = ["bash", "write", "edit", "read", "grep", "find", "ls"];

// pi 思考强度（阶段5）。与 pi-agent-core 的 ThinkingLevel 对齐（升级 pi 时复核 args.js 校验值）。
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const PI_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
// 档位中文展示名。
// @deprecated 展示文案改走 i18n（settings:thinkingLevel.* / 各消费方就近 t(...)）。此常量已无组件消费，仅保留导出兼容。
export const PI_THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
};

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  // closeToTray 默认 true：保留现有「关窗隐藏到后台、托盘常驻」行为;关闭则关窗即退出。
  desktopBehavior: { openAtLogin: false, startMinimized: false, closeToTray: true },
  notifications: { turnComplete: true },
  log: { enabled: true, retentionDays: 2 },
  piSkills: DEFAULT_PI_SKILLS,
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
  // 落地页激励问候语的「按天」LLM 增强缓存（day=YYYY-MM-DD;跨重启复用,跨天失效）。
  dailyEncouragement?: DailyEncouragement;
}

// 落地页激励问候语的每日 LLM 生成快照（按天缓存）。
export interface DailyEncouragement {
  day: string; // dayKey(ts) = YYYY-MM-DD
  title: string;
  sub: string;
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
  continueSession?: boolean; // 续接最近会话(U4):claude --continue / codex resume --last;与 resumeSessionId 互斥优先
  appendSystemPrompt?: string; // 拖入的 prompt md 内容（skill 注入）
  useOwnSkills?: boolean; // false → 会话级一键关 skill（清空 skillPaths）
  // pi 插件 Skill（U4）:已启用 + 去重后的 skill 目录绝对路径,buildArgs 逐个 --skill 注入。
  skillPaths?: string[];
  // 用户上传的图片（**仅 claude/codex 消费**:claude 把绝对路径 + 读取指令前置进 prompt,
  // codex 每张作 -i 参数;pi 不读此字段,图片走 piPrompt 独立参数）。
  images?: CliImageRef[];
  // 推理强度（自动化任务用）:各 agent adapter 尽力翻译成对应 CLI 参数
  //（claude --effort / codex model_reasoning_effort）;不支持的 agent（pi）忽略。
  effort?: ReasoningEffort;
  // 运行模式（权限松紧）:claude/codex adapter 翻译成原生标志（claude --permission-mode /
  // codex -s+approval_policy）;缺省 = full-auto（历史默认）。pi 不走本 DTO（走 PiOpenRequest）。
  permissionMode?: PermissionMode;
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

// 历史消息追问的临时流式应答请求（与 apps/desktop/src/main/ipc/types.ts 镜像）。
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
  // 运行模式:沿用主会话档位(claude/codex adapter 翻译)。与 tightenTools 自然叠加,更严者优先。
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
// M1 向后兼容扩展:新增 usage(U3)、retry(U7)两个变体,均有生产者。现有消费端(handleCliEvent/
// applyFollowupEvent 的 if 链、foldCliEvent 对非 text/tool 原样返回)自然忽略未知 type。
// ⚠️ 跨包契约:与 apps/desktop/src/main/ipc/types.ts 的 CliStreamEvent 逐字镜像,改动两处必须同步。
export type CliStreamEvent =
  | { type: "init"; sessionId: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; costUsd?: number } // 流式 usage/cost(补充磁盘来源)
  | { type: "retry"; attempt: number; maxAttempts?: number; reason?: string } // 安全重试发起(对齐 pi retry)
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
  useOwnSkills?: boolean; // false → 会话级一键关 skill（清空 skillPaths）
  // pi 插件 Skill（U4）:已启用 + 去重后的 skill 目录绝对路径,buildRpcArgs 逐个 --skill 注入。
  skillPaths?: string[];
  // pi 扩展市场（U3）:已启用 + 已授信的扩展 -e 路径,由 core resolveEnabledExtensionPaths 解析后传入,
  // buildRpcArgs 折入 -e 批次。与 skillPaths 同为「core 解析、装配单点」。仅长驻 RPC 会话注入;
  // 单发 headless（pi.ts buildArgs,用于闪记深化/plan 生成）有意不加载市场扩展。
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
  // 主进程内部填充:生成的 provider extension 文件绝对路径（renderer 不传,buildRpcArgs 读取）。
  piExtensionPath?: string;
  // 阶段3 深度定制开关（renderer 传）。
  enableToolApproval?: boolean;
  approvalTools?: string[];
  enableSampleTools?: boolean;
  enableSampleCommands?: boolean;
  // 运行模式 plan 档:只读工具白名单（renderer 由 permissionMode 派生）。存在则 buildRpcArgs
  // 注入 --tools <逗号拼接>;缺省 = 不传 = 全工具可用（accept-edits / full-auto）。
  toolWhitelist?: string[];
  // 主进程内部填充:除 provider 外追加的 extension 路径。
  extraExtensionPaths?: string[];
  // pi 持久追加 system prompt（阶段4）:renderer 传,buildRpcArgs → --append-system-prompt。
  appendSystemPrompt?: string;
  // pi 思考强度初值（阶段5）:renderer 传,buildRpcArgs → --thinking（冷启设初值;已开会话切档走运行时
  // pi:setThinking）。用 string 与 ipc 镜像一致(DTO 不强类型;UI 侧 SessionMeta.thinkingLevel /
  // GeneralSettings.piThinkingDefault 仍是 ThinkingLevel)。
  thinkingLevel?: string;
}

// pi:open 的应答:回带 uiSessionId + pi 侧 sessionId（经 get_state 探测就绪时取得）。
export interface PiOpenResult {
  uiSessionId: string;
  sessionId: string;
  // 磁盘 JSONL 路径（阶段4 崩溃/空闲/LRU/重启恢复用;renderer 持久到 SessionMeta.piSessionFile）。
  sessionFile?: string;
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
  // 扩展命令（如 /memory-index-sessions）经 ctx.ui.notify 的输出。pi 对扩展命令即时执行后提前返回、
  // 不跑 agent（无 agent_end）,其输出只走 notify（fire-and-forget）。主进程把它转成此事件呈现。
  | { type: "notify"; message: string; level?: "info" | "warning" | "error" }
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
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
  // cortex 内部判别式（**非** pi 协议 method）：pi 实发 method:"input"，title 携带本会话 sentinel + JSON 信封;
  // 主进程 handleLine 检出 sentinel 后归一为本变体（见 askquestion 工具）。回写仍走 {value}（答案 JSON）。
  | { type: "extension_ui_request"; id: string; method: "askquestion"; envelope: AskQuestionEnvelope };

// 回写给 pi 的 UI 应答（host → pi）。confirm→confirmed;select/input/editor→value;取消→cancelled。
// askquestion 复用 {value}（答案 JSON）。
export type PiUiResponsePayload =
  | { confirmed: boolean }
  | { value: string }
  | { cancelled: true };

// askquestion 自定义工具的「多组提问」信封（与 apps/desktop/src/main/ipc/types.ts 镜像）。每组 options ≤ 3。
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
  // available 及之后:本次更新的 markdown 说明,来自打包写入清单的 release notes
  releaseNotes?: string;
}

export interface AppInfo {
  version: string;
  os: "macos" | "windows" | "linux" | "unknown";
  devMode?: boolean;
}

// 与 apps/desktop/src/main/ipc/agent-trace.ts 镜像。segmentType/streaming/deltaCount
// 为流式合并段专用字段:连续同类增量(text / reasoning)在记录端合并为实时生长的一条段。
export type TraceSegmentType = "text" | "reasoning";

export interface AgentTraceEvent {
  id: string;
  ts: number;
  scope: "cli" | "oneshot" | "ask" | "pi" | "pi-rpc";
  phase: string;
  summary: string;
  runId?: string;
  sessionId?: string;
  agent?: string;
  data?: unknown;
  segmentType?: TraceSegmentType; // 段类型(仅合并段带)
  streaming?: boolean; // true=生长中,false=已收尾
  deltaCount?: number; // 累积增量个数
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

// ── Tasks 面板:docs/{ideation,brainstorms,plans} 文档列表（与 apps/desktop/src/main/ipc/types.ts 镜像） ──
// dumb 列表：只列目录 + 回传文件头部文本，语义解析（DocMeta/状态/标签/血缘）全在 core 纯函数。
export type DocFileKind = "ideation" | "brainstorm" | "plan";

export interface DocFileRaw {
  name: string;
  path: string; // 绝对路径
  kind: DocFileKind; // 由所在子目录决定
  mtimeMs: number;
  head: string; // 文件头部文本（含 frontmatter / inline 元数据块，供 core parseDocMeta 解析）
}

// ── 自动化（定时任务,与 apps/desktop/src/main/ipc/types.ts 镜像） ─────────
// 自动化是主进程拥有的状态域:配置 + 运行历史存于 ~/.cortex-desktop/automations.json
// 与 automation-runs/<id>.json,由 main 常驻调度器(croner)按时无头调用 agent CLI 执行。
// renderer 经 IPC 做 CRUD + 读历史,main 是唯一写者并通过事件推回最新快照。

// 推理强度三档。各 agent adapter 尽力翻译:claude `--effort`、codex
// `-c model_reasoning_effort=`;pi 无对应 flag,忽略。
export type ReasoningEffort = "low" | "medium" | "high";

// 运行模式（权限松紧）三档。各 agent 在非交互 print 模式下尽力翻译成原生标志:
//   plan        只读分析+出计划,不改文件/不跑写执行类工具
//               (claude `--permission-mode plan`、codex `-s read-only`、pi `--tools read,grep,find,ls`)
//   accept-edits 自动接受文件编辑,写工作区放行;危险/执行类工具受限或仍审批
//               (claude `--permission-mode acceptEdits`、codex `-s workspace-write`、pi 审批 hook 排除 edit/write)
//   full-auto   跳过全部权限,所有工具直接执行(= 历史默认行为)
//               (claude `--dangerously-skip-permissions`、codex `--dangerously-bypass-approvals-and-sandbox`、pi 不注入审批 extension)
export type PermissionMode = "plan" | "accept-edits" | "full-auto";
// 选择器展示顺序（从严到松）。
export const PERMISSION_MODES: PermissionMode[] = ["plan", "accept-edits", "full-auto"];
// 缺省回退:旧会话无 permissionMode 字段时按此处理,与历史「全自动」行为一致(adapter 同款兜底,
// 不改它以免存量会话被静默收紧为只读)。
export const DEFAULT_PERMISSION_MODE: PermissionMode = "full-auto";
// 新建会话的默认档位:从只读 plan 起步,用户确认后再放权(更安全的默认)。仅落地页草稿用,
// 与上面的「存量回退」解耦:新会话显式持久化 plan,旧会话仍回退 full-auto。
export const DEFAULT_NEW_SESSION_PERMISSION_MODE: PermissionMode = "plan";
// pi plan 档只读工具白名单(pi 官方钦定的 read-only 配方,物理上无 write/edit/bash)。
export const PI_PLAN_TOOL_WHITELIST = ["read", "grep", "find", "ls"];

// 定时规则。weekday: 0=周日 .. 6=周六（与 JS Date.getDay() / croner 一致）。
// minute 0-59,hour 0-23。cron 为 5 段标准表达式（分 时 日 月 周）。
export type ScheduleSpec =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number } // 周一~周五
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "cron"; expression: string }
  // once: 一次性,在绝对时刻 at(epoch ms)触发一次。无 cron 表示,调度/计算时单独分支;
  // 触发后不再重排(nextRunAt 归空)并自动停用。at 为绝对时刻,与任务 timezone 无关。
  | { kind: "once"; at: number };

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
  notifyChannels?: PushChannelKind[]; // 完成后通知:终态时推送到所选(且已配置)的渠道;空/缺省=不通知
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
  notifyChannels?: PushChannelKind[];
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

// skill 目录内的配套文档（除 SKILL.md 外的 .md/.txt/.json/.yaml 等,仅展示用,不影响注入）。
export interface SkillDoc {
  name: string; // 文件名（含后缀）
  path: string; // 绝对路径（点击经 bridge.openPath 打开）
}

// ── 插件管理：富 skill 项 ─────────────────────────────────────────────────────
// 与 apps/desktop/src/main/ipc/types.ts 逐字镜像。pi-skills:list 扫描多根产出;
// enabled/trusted/shadowedBy 由渲染端叠加配置后计算（主进程扫描时 enabled=true、
// trusted 仅 workspace 有意义、shadowedBy 由 UI 计算）。
export interface PluginSkill {
  name: string;
  description: string;
  argumentHint?: string;
  supportedAgents?: AgentKind[]; // frontmatter 声明的适用 agent;缺省=全 agent（注入时按会话 agent 过滤）
  dir: string; // skill 根目录绝对路径（即 --skill 注入值）
  rootPath: string; // 来源根（已 expand 的绝对路径）
  scope: SkillScope; // global | workspace
  enabled: boolean; // 是否启用（渲染端据 disabledSkills 叠加）
  trusted: boolean; // 工作区 skill 是否已授信（global 恒 true）
  shadowedBy?: string; // 被同名覆盖时的覆盖来源 scope（UI 标注用）
  docs: SkillDoc[]; // 配套文档清单（浅层枚举,不含 SKILL.md;空数组表示无）
}

// 插件市场（第一期，只读）类型。集中在 ./plugin-types 以免本已超 1200 行的类型文件继续膨胀。
export * from "./plugin-types";
