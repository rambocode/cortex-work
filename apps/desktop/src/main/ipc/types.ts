// 个人工作区 IPC 类型（主进程侧）。与 packages/core/desktop/types.ts 镜像 ——
// core 不能依赖 app 包，故两侧各持一份；preload 以 core 的 DesktopBridge 为准对齐。

export type AgentKind = "claude" | "codex";

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
  projectId: string;
  title: string;
  claudeSessionId?: string;
  agentSessionIds?: Partial<Record<AgentKind, string>>;
  agent: AgentKind;
  model?: string;
  useOwnSkills?: boolean;
  hiddenHistory?: HiddenHistoryMeta;
  createdAt: number;
  updatedAt: number;
}

export interface HiddenHistoryMeta {
  count: number;
  throughUid?: string;
  hiddenAt: number;
}

export interface PersistedState {
  version: 1;
  projects: ProjectMeta[];
  promptRoot?: string;
  sessions: SessionMeta[];
  todos?: TodoMeta[];
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
  text: string;
}

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
