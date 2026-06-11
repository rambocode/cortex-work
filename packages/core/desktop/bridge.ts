// DesktopBridge — 个人工作区的桌面端能力接口。由 app 壳（Electron renderer）
// 用 window.desktopAPI.personal 实现并经 CoreProvider 注入；web 端为 null。
// core/views 永不直接触碰 window.desktopAPI 或 node API（见 docs/floder.md）。

import type {
  AgentKind,
  AgentProjectInfo,
  AgentUsage,
  AsrTranscribeRequest,
  AsrTranscribeResponse,
  CliExitEvent,
  CliStartRequest,
  CliStreamEvent,
  GitChangesResult,
  GitCommit,
  OpenAiCompleteRequest,
  PersistedState,
  PromptNode,
  PushResult,
  PushTarget,
  PtySpawnRequest,
  PtySpawnResult,
  ReadFileResult,
  TtsListVoicesRequest,
  TtsSynthesizeRequest,
  TtsVoiceOption,
} from "./types";

export interface DesktopBridge {
  // fs
  pickDirectory(): Promise<string | null>;
  scanPromptTree(root: string): Promise<PromptNode>;
  // 项目目录全量文件树 / git 变更 / 单文件 diff（右侧「文件」视图）
  scanDirTree(root: string): Promise<PromptNode>;
  gitChanges(root: string): Promise<GitChangesResult>;
  gitDiff(root: string, rel: string): Promise<string>;
  readFile(path: string): Promise<ReadFileResult>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  createTaskFile(projectRoot: string, todoId: string, title: string): Promise<string>;
  validateDir(path: string): Promise<boolean>;
  // 持久化
  loadState(): Promise<PersistedState>;
  saveState(state: PersistedState): Promise<void>;
  // 会话消息持久化（按 sessionId 一文件,内容对桥接层不透明）
  loadChat(sessionId: string): Promise<unknown[]>;
  saveChat(sessionId: string, messages: unknown[]): Promise<void>;
  // 项目时间线持久化（按 projectId 一文件,内容对桥接层不透明;不存在返回 null）
  loadTimeline(projectId: string): Promise<unknown>;
  saveTimeline(projectId: string, data: unknown): Promise<void>;
  // git 提交记录（非 git 仓库返回空数组）
  gitLog(root: string, opts?: { sinceTs?: number; max?: number }): Promise<GitCommit[]>;
  // CLI 流式
  startCli(req: CliStartRequest): Promise<void>;
  // 一次性短任务（生成 session 标题/日报等）,返回纯文本输出。
  // agent 缺省 claude;走各 agent 的 adapter,新接入的 agent 自动支持。
  // 不传 cwd 在中性目录运行,不加载项目上下文。
  oneshotCli(req: { agent?: AgentKind; cwd?: string; prompt: string; model?: string }): Promise<string>;
  // OpenAI 兼容端点一次性补全（自定义日报模型;主进程发请求,密钥不出 main）
  openaiComplete(req: OpenAiCompleteRequest): Promise<string>;
  // 日报推送（企微/钉钉 webhook、SMTP 邮件;主进程发请求规避 CORS）
  pushReport(target: PushTarget, payload: { subject: string; text: string }): Promise<PushResult>;
  // TTS：OpenAI 兼容 /v1/audio/speech 合成,返回音频字节（renderer 播放）
  ttsSynthesize(req: TtsSynthesizeRequest): Promise<ArrayBuffer>;
  // TTS：按模型发现可选音色；端点不支持时返回空数组。
  listTtsVoices(req: TtsListVoicesRequest): Promise<TtsVoiceOption[]>;
  // ASR：OpenAI 兼容 /v1/audio/transcriptions 转写,返回文本。
  asrTranscribe(req: AsrTranscribeRequest): Promise<AsrTranscribeResponse>;
  killCli(runId: string): Promise<void>;
  onCliEvent(cb: (runId: string, event: CliStreamEvent, sessionId?: string) => void): () => void;
  onCliExit(cb: (exit: CliExitEvent) => void): () => void;
  // 内嵌终端（xterm.js ↔ node-pty）
  ptySpawn(req: PtySpawnRequest): Promise<PtySpawnResult>;
  ptyInput(id: string, data: string): void;
  ptyResize(id: string, cols: number, rows: number): void;
  ptyKill(id: string): void;
  // shell 当前真实目录（跟随 cd）,不可用时返回 null
  ptyCwd(id: string): Promise<string | null>;
  // Agent 用量统计（Claude/Codex 本地会话日志 + Claude 官方限额接口）
  agentUsage(): Promise<AgentUsage>;
  // 扫描本机 agent 会话日志,聚合系统上所有 agent 项目（首页「Agent 项目」）
  scanAgentProjects(): Promise<AgentProjectInfo[]>;
  onPtyData(cb: (id: string, data: string) => void): () => void;
  onPtyExit(cb: (id: string, exitCode: number) => void): () => void;
}
