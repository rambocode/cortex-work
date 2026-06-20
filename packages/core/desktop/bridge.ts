// DesktopBridge — 个人工作区的桌面端能力接口。由 app 壳（Electron renderer）
// 用 window.desktopAPI.personal 实现并经 CoreProvider 注入；web 端为 null。
// core/views 永不直接触碰 window.desktopAPI 或 node API（见 docs/floder.md）。

import type {
  AgentKind,
  AgentTraceEvent,
  AgentSessionRequest,
  AgentProjectInfo,
  AskFollowupRequest,
  AsrTranscribeRequest,
  AsrTranscribeResponse,
  AutomationInput,
  AutomationMeta,
  AutomationRun,
  AutomationRunEvent,
  CliExitEvent,
  CliStartRequest,
  CliStreamEvent,
  ContentSearchResult,
  CronValidation,
  DesktopBehavior,
  EditorInfo,
  GitBranchesResult,
  GitChangesResult,
  GitCommit,
  GitDiffAllResult,
  GitInfoResult,
  GitOpResult,
  ImageReadResult,
  ImageSaveRequest,
  ImageSaveResult,
  NoteInput,
  NoteMeta,
  NoteStatus,
  OpenAiCompleteRequest,
  PersistedState,
  PiOpenRequest,
  PiOpenResult,
  PiSessionEvent,
  PiUiRequest,
  PiUiResponsePayload,
  ProviderProbeInput,
  ProviderProbeResult,
  PluginSkill,
  PiExtInstallResult,
  PromptNode,
  PushResult,
  PushTarget,
  SkillMeta,
  SpotlightIntent,
  PtySpawnRequest,
  PtySpawnResult,
  ReadFileResult,
  TrimSessionRequest,
  TtsListVoicesRequest,
  TtsSynthesizeRequest,
  TaskFilesResult,
  DocFileRaw,
  TtsStreamEvent,
  TtsVoiceOption,
  AppInfo,
  UpdateState,
} from "./types";
import type { Locale } from "../i18n/locales";

export interface DesktopBridge {
  appInfo?: AppInfo;
  // fs
  pickDirectory(): Promise<string | null>;
  scanPromptTree(root: string): Promise<PromptNode>;
  // 项目目录全量文件树 / git 变更 / 单文件 diff（右侧「文件」视图）
  scanDirTree(root: string): Promise<PromptNode>;
  // 项目内文件内容搜索（右侧「文件」视图 ? 前缀）:逐行子串匹配,返回命中文件 + 命中行。
  // 可选（web/旧壳没有 → UI 不提供内容搜索）。
  searchContent?(root: string, query: string): Promise<ContentSearchResult>;
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
  // Tasks 面板:列出 docs/{ideation,brainstorms,plans} 顶层 .md（kind/mtime/头部文本）。
  // 可选（web/旧壳没有 → 文档面板退化为空态）。语义解析在 core 纯函数，本方法只回传 dumb 列表。
  listDocs?(projectRoot: string): Promise<DocFileRaw[]>;
  validateDir(path: string): Promise<boolean>;
  // 文件存在性探测（深化 / 生成 plan run 收尾判产出用:确定路径,绕开 changedFiles 截断）。
  // 可选:旧壳缺失时探测降级为 false（闪记保持原状态,不误判已深化）。
  fileExists?(path: string): Promise<boolean>;
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
  // 聊天图片上传:落盘返回绝对路径 / 按路径回读为 dataURL（缩略图）。
  // 可选（web/旧壳无 → composer 图片上传入口降级隐藏）。
  imageSave?(req: ImageSaveRequest): Promise<ImageSaveResult>;
  imageRead?(path: string): Promise<ImageReadResult>;
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
  // provider 仅 pi 用:挂载选中供应商（生成 extension + 注入 key），日报选 pi 时据此运行。
  oneshotCli(req: {
    agent?: AgentKind;
    cwd?: string;
    prompt: string;
    model?: string;
    provider?: { id: string; baseUrl: string; apiKey?: string; models: { id: string; name?: string }[] };
  }): Promise<string>;
  // OpenAI 兼容端点一次性补全（自定义日报模型;主进程发请求,密钥不出 main）
  openaiComplete(req: OpenAiCompleteRequest): Promise<string>;
  // 供应商连接测试：主进程按 endpointFormat 选鉴权头探测 {baseUrl}/models,返回可用模型。
  // 可选（web 端为 null;custom 协议返回不支持探测）。
  probeProvider?(input: ProviderProbeInput): Promise<ProviderProbeResult>;
  // 桌面行为：renderer 切换开机自启/启动最小化/关闭到托盘时通知主进程立即应用
  //（登录项是系统设置,须即时设置）。可选（web 端为 null）。
  setDesktopBehavior?(behavior: DesktopBehavior): Promise<void>;
  // 渲染端(主窗口 i18next 为权威源)切语言时下发主进程,主进程据此广播给所有窗口 +
  // 重建托盘菜单（原生 chrome 无法用 react-i18next,只能镜像）。可选（web 端为 null）。
  setLocale?(locale: Locale): Promise<void>;
  // 订阅主进程 locale 广播（次级窗口据此与主窗口语言保持一致）。可选;返回退订函数。
  onLocaleChange?(cb: (locale: Locale) => void): () => void;
  // 打开日志目录（系统文件管理器）。可选。
  openLogsDir?(): Promise<void>;
  // 即时下发文件日志开关（本次运行内生效,无需重启）。可选。
  setLogEnabled?(enabled: boolean): Promise<void>;
  // 渲染端把会话内不落盘的 agent 报错/失败信息写入主进程文件日志（脱敏由主进程负责）,保留可排查性。
  // fire-and-forget,可选（web 端为 null）。
  logMessage?(level: "warn" | "error", message: string): Promise<void>;
  // 渲染端改闪记全局热键 → 主进程即时校验 + 重注册（仿 setDesktopBehavior 的即时通路）。
  // ok=true 表示新键已生效;ok=false 表示格式无效或被占用（已回退旧键,toast 含原因）。可选。
  setNotesHotkey?(accelerator: string): Promise<{ ok: boolean; toast?: string }>;
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
  // ── 历史消息追问的临时流式应答（ask:*）。复用 CliStreamEvent,但不落盘/不进 run 注册表; ──
  // 关闭浮层即弃。全部可选（web 端 bridge 为 null、旧壳无此方法时 UI 降级隐藏追问入口）。
  // 一轮一个 askId:既作 invoke 入参的登记 key,也经 onAskFollowupEvent 回带做代际守卫。
  askFollowupStream?(req: AskFollowupRequest): Promise<void>;
  // 订阅追问事件流（仿 onCliEvent:回调 + 返回退订）。回调参数 (askId, event)。
  onAskFollowupEvent?(cb: (askId: string, event: CliStreamEvent) => void): () => void;
  // 取消在途追问（幂等;askId 不存在或已退出时静默）。
  cancelFollowup?(askId: string): Promise<void>;
  // ── pi RPC 长驻会话（pi --mode rpc）。claude/codex 仍走上面单发 startCli/killCli/onCliEvent。 ──
  // 一个 UI 会话 = 一个长驻 pi 子进程;命令经 invoke,事件流经 onPiEvent。全部可选（web/旧壳
  // 缺失时为 undefined → UI 退回单发或隐藏运行时控制）。uiSessionId 复用个人会话 id。
  piOpen?(req: PiOpenRequest): Promise<PiOpenResult>;
  // runId（阶段4 代际）:renderer 自造每轮唯一 id,经事件回带供守卫。
  // imagePaths:本轮上传图片的绝对路径,主进程读盘转 base64 注入 RPC prompt.images。
  piPrompt?(uiSessionId: string, message: string, runId?: string, imagePaths?: string[]): Promise<unknown>;
  // 运行中插话（注入当前轮的引导）/ 排队追问。
  piSteer?(uiSessionId: string, message: string): Promise<unknown>;
  piFollowUp?(uiSessionId: string, message: string): Promise<unknown>;
  // 优雅打断当前轮（不杀长驻进程,进程存活待下一轮）。
  piAbort?(uiSessionId: string): Promise<unknown>;
  // 编辑重发:在 entryId 处分支（替代单发的 trimAgentSession 截断会话文件）。
  piFork?(uiSessionId: string, entryId: string): Promise<unknown>;
  piGetForkMessages?(uiSessionId: string): Promise<unknown>;
  // 运行时切模型 / 思考强度 / 压缩上下文。
  piSetModel?(uiSessionId: string, provider: string, modelId: string): Promise<unknown>;
  piSetThinking?(uiSessionId: string, level: string): Promise<unknown>;
  piCompact?(uiSessionId: string, customInstructions?: string): Promise<unknown>;
  piGetState?(uiSessionId: string): Promise<unknown>;
  piGetStats?(uiSessionId: string): Promise<unknown>;
  // 阶段4 恢复:从磁盘 JSONL switchSession 恢复上下文（崩溃/空闲/LRU/重启后重开时调）。
  piSwitchSession?(uiSessionId: string, sessionPath: string): Promise<unknown>;
  // 显式关闭会话（终止子进程,幂等）。
  piClose?(uiSessionId: string): Promise<void>;
  // 归一化事件流（仿 onCliEvent:回调 + 返回退订）。按 uiSessionId 分派;runId 供阶段4 代际守卫。
  onPiEvent?(cb: (uiSessionId: string, event: PiSessionEvent, runId?: string) => void): () => void;
  // extension UI 请求（pi → host,阶段3 工具确认弹窗等）。订阅 + 回写应答。全可选（web/旧壳缺失）。
  onPiUiRequest?(cb: (uiSessionId: string, request: PiUiRequest) => void): () => void;
  piUiResponse?(uiSessionId: string, id: string, payload: PiUiResponsePayload): Promise<void>;
  // 内嵌终端（xterm.js ↔ node-pty）
  ptySpawn(req: PtySpawnRequest): Promise<PtySpawnResult>;
  ptyInput(id: string, data: string): void;
  ptyResize(id: string, cols: number, rows: number): void;
  ptyKill(id: string): void;
  // shell 当前真实目录（跟随 cd）,不可用时返回 null
  ptyCwd(id: string): Promise<string | null>;
  // 扫描本机 agent 会话日志,聚合系统上所有 agent 项目（首页「Agent 项目」）
  scanAgentProjects(): Promise<AgentProjectInfo[]>;
  // dev 环境 Agent 调试跟踪:主进程旁路记录 CLI/pi RPC 生命周期与事件。生产壳不暴露。
  agentTraceList?(): Promise<AgentTraceEvent[]>;
  agentTraceClear?(): Promise<void>;
  onAgentTrace?(cb: (event: AgentTraceEvent) => void): () => void;
  openAgentTraceWindow?(): Promise<void>;
  onPtyData(cb: (id: string, data: string) => void): () => void;
  onPtyExit(cb: (id: string, exitCode: number) => void): () => void;
  // 应用自动更新（electron-updater + GitHub Releases）:主进程检测后推
  // onUpdateState,挂载时用 updateGetState 补拉;download 下载安装包,
  // install 重启安装。可选（旧壳/web 端没有）。
  updateGetState?(): Promise<UpdateState>;
  updateCheck?(): Promise<UpdateState>;
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
  // 闪记（个人工作区）：可选能力,web 端无此桥、旧壳无此方法时收件箱/浮层入口降级隐藏。
  notesList?(projectId?: string): Promise<NoteMeta[]>;
  notesAdd?(input: NoteInput): Promise<NoteMeta>;
  notesUpdate?(id: string, patch: Partial<NoteInput> & { status?: NoteStatus; conversationIds?: string[]; docPaths?: string[] }): Promise<NoteMeta | null>;
  notesDelete?(id: string): Promise<void>;
  onNotesChanged?(cb: (list: NoteMeta[]) => void): () => void;
  // 内置 skill 元数据（深化注入 ce-ideate / 生成 plan 注入 ce-plan）。可选:web/旧壳无此
  // 能力 → 深化入口降级 toast。第一阶段读内置 resources/skills,第二阶段叠加 userData/skills。
  skillGet?(name: string): Promise<SkillMeta | null>;
  skillsList?(): Promise<SkillMeta[]>;
  // 插件管理（U3）:按 piSkills 配置扫描多根 → PluginSkill[];打开/创建范围根（白名单校验）。
  // 可选:web/旧壳无此能力 → 插件管理器降级空态。
  piSkillsList?(args: {
    globalRoots: string[];
    userGlobalRoots?: string[];
    workspaceEnabled: boolean;
    workspaceDir?: string;
  }): Promise<PluginSkill[]>;
  openSkillDir?(args: { dir: string; allowedRoots: string[] }): Promise<{ ok: boolean; error?: string }>;
  // 在选定根下新建 skill（写 <dir>/<name>/SKILL.md）。白名单 + 名称校验,返回结果。
  createSkill?(args: {
    dir: string;
    name: string;
    description: string;
    body: string;
    allowedRoots: string[];
  }): Promise<{ ok: boolean; error?: string; dir?: string }>;
  // 扩展市场（U4）:把 pi 当扩展安装运行时。可选:web/旧壳无此能力 → 扩展管理器降级空态。
  // piExtList 返回已装包的本地路径集（存在性,core 与 store 溯源/启用按 path 对账）;
  // piExtInstall 安装并定位落盘 path;piExtRemove 卸载。装≠启用——启用集/信任在 core store。
  piExtList?(): Promise<string[]>;
  piExtInstall?(args: { sourceRef: string }): Promise<PiExtInstallResult>;
  piExtRemove?(args: { sourceRef: string }): Promise<{ ok: boolean; error?: string }>;
}
