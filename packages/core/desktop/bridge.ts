// DesktopBridge — 个人工作区的桌面端能力接口。由 app 壳（Electron renderer）
// 用 window.desktopAPI.personal 实现并经 CoreProvider 注入；web 端为 null。
// core/views 永不直接触碰 window.desktopAPI 或 node API（见 docs/floder.md）。

import type {
  AgentKind,
  AgentSessionRequest,
  AgentProjectInfo,
  AgentUsage,
  DailyUsage,
  AsrTranscribeRequest,
  AsrTranscribeResponse,
  AutomationInput,
  AutomationMeta,
  AutomationRun,
  AutomationRunEvent,
  CliExitEvent,
  CliStartRequest,
  CliStreamEvent,
  CronValidation,
  DesktopBehavior,
  EditorInfo,
  GitBranchesResult,
  GitChangesResult,
  GitCommit,
  GitDiffAllResult,
  GitInfoResult,
  GitOpResult,
  OpenAiCompleteRequest,
  PersistedState,
  ProviderProbeInput,
  ProviderProbeResult,
  PromptNode,
  PushResult,
  PushTarget,
  SpotlightIntent,
  PtySpawnRequest,
  PtySpawnResult,
  ReadFileResult,
  TrimSessionRequest,
  TtsListVoicesRequest,
  TtsSynthesizeRequest,
  TaskFilesResult,
  TtsStreamEvent,
  TtsVoiceOption,
  UpdateState,
} from "./types";

export interface DesktopBridge {
  // fs
  pickDirectory(): Promise<string | null>;
  scanPromptTree(root: string): Promise<PromptNode>;
  // 项目目录全量文件树 / git 变更 / 单文件 diff（右侧「文件」视图）
  scanDirTree(root: string): Promise<PromptNode>;
  gitChanges(root: string): Promise<GitChangesResult>;
  gitDiff(root: string, rel: string): Promise<string>;
  // GitBar:分支 + 工作区 ± 统计（含 untracked）/ 整仓 diff。可选（旧壳/web 没有,
  // 无此能力时信息条不渲染）。
  gitInfo?(root: string): Promise<GitInfoResult>;
  gitDiffAll?(root: string): Promise<GitDiffAllResult>;
  // 无项目会话工作目录:确保 Documents/cortex/<dayKey> 存在,返回绝对路径。
  // 可选（web 端为 null;旧壳无此能力时不可创建无项目会话）。
  ensureNoProjectDir?(dayKey: string): Promise<string>;
  // GitBar 分支:列表 / 新建(switch -c) / 切换(dirty 时主进程禁止并回 message)。
  // 可选（旧壳/web 没有,无此能力时分支切换 UI 不渲染）。
  gitBranches?(root: string): Promise<GitBranchesResult>;
  gitCreateBranch?(root: string, name: string): Promise<GitOpResult>;
  gitCheckout?(root: string, name: string): Promise<GitOpResult>;
  readFile(path: string): Promise<ReadFileResult>;
  // 会话消息里文件链接的项目内定位:ref(相对路径或裸文件名)→ 真实绝对路径,找不到 → null。
  // 支持 ref 缺目录、真实文件在子目录的情况(yuque 导出表格只列文件名)。
  // 可选（web/旧壳没有 → chatMarkdown 退化为乐观可点击、handleOpenFile 走精确路径)。
  resolveProjectFile?(root: string, ref: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  createTaskFile(projectRoot: string, todoId: string, title: string): Promise<string>;
  // Tasks 面板:列出项目 tasks/ 与 tasks/archive/ 顶层 .md（带 mtime）。
  // 可选（旧壳没有;无此能力时面板退化为只显示已登记 todo）。
  listTaskFiles?(projectRoot: string): Promise<TaskFilesResult>;
  validateDir(path: string): Promise<boolean>;
  // 目录实时监听:watchDir 后主进程经噪声过滤+去抖推 onDirChanged(id),
  // renderer 收到后自行重扫。可选（旧壳/降级环境可能没有）。
  watchDir?(id: string, path: string): Promise<void>;
  unwatchDir?(id: string): void;
  onDirChanged?(cb: (id: string) => void): () => void;
  // 文件预览工具栏:用系统默认应用打开 / 在访达（文件管理器）中显示。
  openPath?(path: string): Promise<void>;
  revealInFolder?(path: string): Promise<void>;
  // 项目「Open in」菜单:列出系统已装代码编辑器 / 用指定编辑器打开项目目录。
  // 可选（旧壳/web/非 macOS 没有或返回空列表,菜单降级为只剩访达）。
  listEditors?(): Promise<EditorInfo[]>;
  openInEditor?(path: string, editorId: string): Promise<void>;
  // 检测 PATH 中已安装的 agent CLI（pi 内置恒可用）。可选,无此能力时
  // renderer 按全不可用处理,新建会话兜底到 pi。
  detectAgents?(): Promise<Record<AgentKind, boolean>>;
  // Markdown 预览里的链接:用系统默认浏览器打开（仅 http/https）。
  openExternal?(url: string): Promise<void>;
  // 持久化
  loadState(): Promise<PersistedState>;
  saveState(state: PersistedState): Promise<void>;
  // 会话消息持久化（按 sessionId 一文件,内容对桥接层不透明）
  loadChat(sessionId: string): Promise<unknown[]>;
  saveChat(sessionId: string, messages: unknown[]): Promise<void>;
  // 删除会话消息文件（物理删 chats/<id>.json;不存在不报错）
  deleteChat(sessionId: string): Promise<void>;
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
  // 供应商连接测试：主进程按 endpointFormat 选鉴权头探测 {baseUrl}/models,返回可用模型。
  // 可选（web 端为 null;custom 协议返回不支持探测）。
  probeProvider?(input: ProviderProbeInput): Promise<ProviderProbeResult>;
  // 桌面行为：renderer 切换开机自启/启动最小化/关闭到托盘时通知主进程立即应用
  //（登录项是系统设置,须即时设置）。可选（web 端为 null）。
  setDesktopBehavior?(behavior: DesktopBehavior): Promise<void>;
  // 打开日志目录（系统文件管理器）。可选。
  openLogsDir?(): Promise<void>;
  // 即时下发文件日志开关（本次运行内生效,无需重启）。可选。
  setLogEnabled?(enabled: boolean): Promise<void>;
  // 日报推送（企微/钉钉 webhook、SMTP 邮件;主进程发请求规避 CORS）
  pushReport(target: PushTarget, payload: { subject: string; text: string }): Promise<PushResult>;
  // TTS：OpenAI 兼容 /v1/audio/speech 合成,返回音频字节（renderer 播放）
  ttsSynthesize(req: TtsSynthesizeRequest): Promise<ArrayBuffer>;
  // TTS：流式合成,主进程边读响应边把音频块推给 renderer。
  ttsSynthesizeStream?(req: TtsSynthesizeRequest, cb: (event: TtsStreamEvent) => void): Promise<void>;
  // TTS：按模型发现可选音色；端点不支持时返回空数组。
  listTtsVoices(req: TtsListVoicesRequest): Promise<TtsVoiceOption[]>;
  // ASR：OpenAI 兼容 /v1/audio/transcriptions 转写,返回文本。
  asrTranscribe(req: AsrTranscribeRequest): Promise<AsrTranscribeResponse>;
  killCli(runId: string): Promise<void>;
  // 发送前校验外部 agent 的 resume 会话文件是否仍在本机。可选能力;旧壳缺失时保持原行为。
  agentSessionExists?(req: AgentSessionRequest): Promise<boolean>;
  // 编辑重发:截断 agent CLI 会话记忆(可选能力,旧壳无此方法时退化为带旧记忆 resume)。
  trimAgentSession?(req: TrimSessionRequest): Promise<boolean>;
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
  // 按天 token 用量序列（落地页用量日历 token 模式；Claude Code 本地日志按天聚合）。可选（旧壳/web 端没有）。
  dailyUsage?(weeks?: number): Promise<DailyUsage>;
  // 扫描本机 agent 会话日志,聚合系统上所有 agent 项目（首页「Agent 项目」）
  scanAgentProjects(): Promise<AgentProjectInfo[]>;
  onPtyData(cb: (id: string, data: string) => void): () => void;
  onPtyExit(cb: (id: string, exitCode: number) => void): () => void;
  // 应用自动更新（electron-updater + GitHub Releases）:主进程检测后推
  // onUpdateState,挂载时用 updateGetState 补拉;download 下载安装包,
  // install 重启安装。可选（旧壳/web 端没有）。
  updateGetState?(): Promise<UpdateState>;
  updateDownload?(): Promise<void>;
  updateInstall?(): Promise<void>;
  onUpdateState?(cb: (state: UpdateState) => void): () => void;
  // 自动化（定时任务）。main 是 owner:CRUD 经 IPC,main 持久化 + 常驻调度 + 推事件。
  // 可选能力（旧壳/web 端没有,UI 据此降级隐藏自动化入口）。create/update/setEnabled
  // 返回含 main 算好 nextRunAt 的完整 meta;runNow 立即触发并返回该次 run。
  automationList?(): Promise<AutomationMeta[]>;
  automationCreate?(input: AutomationInput): Promise<AutomationMeta>;
  automationUpdate?(id: string, patch: Partial<AutomationInput>): Promise<AutomationMeta | null>;
  automationDelete?(id: string): Promise<void>;
  automationSetEnabled?(id: string, enabled: boolean): Promise<AutomationMeta | null>;
  automationRunNow?(id: string): Promise<AutomationRun | null>;
  automationListRuns?(id: string): Promise<AutomationRun[]>;
  // cron 表达式校验 + nextRun 预览（ScheduleEditor 即时反馈,真相以 main 调度为准）。
  automationValidateCron?(expression: string, timezone?: string): Promise<CronValidation>;
  // 列表/元数据变化（任意 CRUD 或 lastRun 更新后推全量快照,renderer 直接替换）。
  onAutomationChanged?(cb: (list: AutomationMeta[]) => void): () => void;
  // 单次运行状态变化（start/end）,驱动详情刷新 + 完成 toast。
  onAutomationRunEvent?(cb: (event: AutomationRunEvent) => void): () => void;
  // 菜单栏 Spotlight 浮动框 → 主窗口接力:订阅发起意图 + 冷启动兜底拉取。
  // 可选能力（旧壳/web 端没有）。
  onSpotlightIntent?(cb: (intent: SpotlightIntent) => void): () => void;
  consumeSpotlightIntent?(): Promise<SpotlightIntent | null>;
}
