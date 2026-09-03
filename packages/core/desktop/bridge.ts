// DesktopBridge — 个人工作区的桌面端能力接口。由 app 壳（Electron renderer）
// 用 window.desktopAPI.personal 实现并经 CoreProvider 注入；web 端为 null。
// core/views 永不直接触碰 window.desktopAPI 或 node API（见 docs/floder.md）。

import type {
  CustomProviderDefinition,
  CustomProviderValidation,
  GatewayBuildRequest,
  GatewayBuildResult,
  GatewayCompleteRequest,
  GatewayCompleteResult,
  GatewayDiscoverRequest,
  GatewayDiscoverResult,
  GatewayStreamEvent,
  ProviderAuthEvent,
  ProviderAuthSnapshot,
  ProviderCatalogResult,
  ProviderConnectionTestEvent,
  ProviderConnectionTestResult,
} from "./provider-catalog";
import type {
  AgentKind,
  RunEventEnvelope,
  SyncInvalidateScope,
  ConversationArtifactCreateRequest,
  ConversationArtifactRef,
  ConversationArtifactResult,
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
  OrchestrateStartRequest,
  RoleConfig,
  RoundtableStartRequest,
  CliStreamEvent,
  ContentSearchResult,
  DerivedAgentMeta,
  CronValidation,
  DesktopBehavior,
  EditorInfo,
  GitBranchesResult,
  GitChangesResult,
  GitCommit,
  DocSaveRequest,
  DocSaveResult,
  GitDiffAllResult,
  GitInfoResult,
  GitOpResult,
  ImageReadResult,
  ImageSaveRequest,
  ImageSaveResult,
  NoteInput,
  NoteMeta,
  NoteStatus,
  NotificationRecord,
  ArchivedTask,
  TaskAttachment,
  TaskInput,
  TaskMeta,
  TaskProject,
  TaskProjectKind,
  TaskProjectMode,
  TaskProjectStatus,
  ProjectStage,
  StageTemplate,
  Member,
  OpenAiCompleteRequest,
  QueryUnderstandIpcRequest,
  QueryUnderstandIpcResponse,
  PersistedState,
  VoiceSettings,
  PiOpenRequest,
  PiOpenResult,
  PiSessionEvent,
  PiUiRequest,
  PiUiResponsePayload,
  PluginSkill,
  PluginListResult,
  MarketplaceListResult,
  PiExtInstallResult,
  PromptNode,
  PushResult,
  PushTarget,
  SkillMeta,
  SpotlightIntent,
  TaskDelegateIntent,
  PtySpawnRequest,
  PtySpawnResult,
  ReadFileResult,
  ReadFileBinaryResult,
  StatFileResult,
  WriteFileBinaryResult,
  WritingSaveImagePayload,
  TrimSessionRequest,
  TtsListVoicesRequest,
  TtsSynthesizeRequest,
  EdgeTtsSynthesizeRequest,
  TaskFilesResult,
  TtsStreamEvent,
  TtsVoiceOption,
  AppInfo,
  UpdateState,
  ReplyPermissionKind,
  ReplyPermissionState,
  ReplyChannelVerifyResult,
  ReplyDataSummary,
  ReplyDebugEntry,
  ReplyRelearnResult,
  ReplySyncSnapshot,
  PetStateSnapshot,
  VoiceAssistantFeed,
  VoiceAssistantSnapshot,
  WakeWordSettings,
  VoiceAssistantCommand,
  VoiceAssistantControlAction,
  VoiceAssistantIntentResult,
  PushSettings,
  AgentBrowserRuntimeStatus,
  KnowledgeBaseSettings,
  ComputerUsePermissionKind,
  ComputerUseStatus,
  KnowledgeDocResult,
} from "./types";
import type { PetdexCacheStats, PetdexManifestResult, PetdexSpriteRef } from "./petdex-types";
import type { ImChannel, ImChannelInput, ImChannelStatus, ImPlatformSpec, ImWechatLogin, ImWechatQrCode } from "./im-types";
// 写作检索(U4）IPC 契约类型(与 apps/desktop/src/main/ipc/writing-retrieval-types.ts 镜像）。
import type { WritingRetrievalRequest, WritingRetrievalResult } from "./writing-retrieval-types";
// 写作左栏文稿元信息(时间 + 概要）IPC 契约(与 apps/desktop/src/main/ipc/writing-doc-meta-types.ts 镜像）。
import type { WritingDocMetaRequest, WritingDocMetaResult } from "./writing-doc-meta-types";
// 写作信息图(U7）IPC 契约类型(与 apps/desktop/src/main/ipc/writing-infographic-types.ts 镜像）。
import type { WritingInfographicRequest, WritingInfographicResult } from "./writing-infographic-types";
// 写作重型导出(U6）IPC 契约类型(与 apps/desktop/src/main/ipc/writing-export-types.ts 镜像）。
import type {
  WritingExportRequest,
  WritingExportResult,
  WritingCopyRichTextRequest,
  WritingCopyRichTextResult,
} from "./writing-export-types";
// 写作 LLM(U3,续写 + Cmd-K 改写）IPC 契约类型(与 apps/desktop/src/main/ipc/writing-llm-types.ts 镜像）。
import type {
  WritingCompletionRequest,
  WritingCompletionResult,
  WritingDebugLogEntry,
  WritingInlineEditRequest,
  WritingInlineEditResult,
  WritingLlmStatus,
} from "./writing-llm-types";
// 写作 PDF 阅读(U5）IPC 契约类型(与 apps/desktop/src/main/ipc/writing-pdf-types.ts 镜像）。
import type { WritingPdfDataRequest, WritingPdfDataResult } from "./writing-pdf-types";
// AI Slides IPC 契约类型(与 apps/desktop/src/main/ipc/slides-ipc-types.ts 镜像）。
import type {
  BentoCreateDeckRequest,
  BentoDeckIpcResult,
  BentoDeckScopedRequest,
  BentoExportFileResult,
  BentoGetDeckResult,
  BentoSetStageRequest,
  BentoWriteDeckHtmlRequest,
  SlidesDeckChangedEvent,
  SlidesPresentRequest,
  SlidesPresentResult,
} from "./slides-ipc-types";
import type { ChannelId } from "../reply/channels";
import type { MemoryFile, MemoryScope, MemoryState } from "../reply/memory";
// 用户记忆（跨会话/写作/设计共享的持久记忆,与 reply 域的语气记忆独立）IPC 契约类型。
import type {
  DreamStateSummary,
  MemoryDreamResult,
  UserMemoryFile,
  UserMemoryScope,
  UserMemoryState,
} from "../memory/memory";
import type {
  LocalAsrModelStatus,
  LocalAsrModelProgress,
  LocalAsrSourcesResult,
} from "../asr/local-models";
import type {
  StreamingAsrModelStatus,
  StreamingAsrModelProgress,
  StreamingAsrSourcesResult,
} from "../asr/streaming-models";
import type { AsrSettings } from "./media-gen-types";
// 研究引擎桥契约（真源单独成文件,见其头部注释:三处同形约定 + 1200 行上限的理由）。
import type { CortexResearchBridge } from "./research-bridge";
import type { Locale } from "../i18n/locales";
import type { WorkflowDef, WorkflowRun, WorkflowRunEvent } from "./workflow-types";

export interface DesktopBridge {
  appInfo?: AppInfo;
  /** 内置 agent-browser 的 Chrome 运行时状态。 */
  agentBrowserStatus?(): Promise<AgentBrowserRuntimeStatus>;
  /** 重新检查并在缺失时后台安装 Chrome for Testing。 */
  agentBrowserRetry?(): Promise<AgentBrowserRuntimeStatus>;
  /** 订阅主进程的检查/下载状态。 */
  onAgentBrowserStatus?(cb: (status: AgentBrowserRuntimeStatus) => void): () => void;
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
  // git 信息条:分支 + 工作区 ± 统计（含 untracked）/ 整仓 diff。可选（旧壳/web 没有,
  // 无此能力时信息条不渲染）。
  gitInfo?(root: string): Promise<GitInfoResult>;
  gitDiffAll?(root: string): Promise<GitDiffAllResult>;
  // 无项目会话工作目录:确保 Documents/cortex/<dayKey> 存在,返回绝对路径。
  // 可选（web 端为 null;旧壳无此能力时不可创建无项目会话）。
  ensureNoProjectDir?(dayKey: string): Promise<string>;
  // git 分支:列表 / 新建(switch -c) / 切换(dirty 时主进程禁止并回 message)。
  // 可选（旧壳/web 没有,无此能力时分支切换 UI 不渲染）。
  gitBranches?(root: string): Promise<GitBranchesResult>;
  gitCreateBranch?(root: string, name: string): Promise<GitOpResult>;
  gitCheckout?(root: string, name: string): Promise<GitOpResult>;
  readFile(path: string): Promise<ReadFileResult>;
  // 文档/表格二进制通道(内置预览/表格编辑,base64 传输):读超限 truncated 降级；
  // 写带首次备份 + 临时文件原子替换。可选——web/旧壳无 → 对应入口回退系统打开。
  readFileBinary?(path: string): Promise<ReadFileBinaryResult>;
  writeFileBinary?(path: string, dataBase64: string, opts?: { backup?: boolean }): Promise<WriteFileBinaryResult>;
  // 轻量 stat:表格预览的外部变更检测(watch 信号后比对 mtime,避免整文件重读)。
  statFile?(path: string): Promise<StatFileResult>;
  // 会话消息里文件链接的项目内定位:ref(相对路径或裸文件名)→ 真实绝对路径,找不到 → null。
  // 支持 ref 缺目录、真实文件在子目录的情况(yuque 导出表格只列文件名)。
  // 可选（web/旧壳没有 → chatMarkdown 退化为乐观可点击、handleOpenFile 走精确路径)。
  resolveProjectFile?(root: string, ref: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  // 设计工作台(design):建目录 / 递归删除条目(文件或目录)。可选——web/旧壳无 → 对应功能降级。
  mkdir?(path: string): Promise<void>;
  deleteEntry?(path: string): Promise<void>;
  // 设计产物默认根(Documents/cortex/design,调用即建目录);用户未自定义工作目录时的回落值。
  designWorkspaceRoot?(): Promise<string>;
  // 无项目会话归档根(Documents/cortex,调用即建目录):右栏「文件」无项目会话时的回退根,
  // 其子节点即各按日期(YYYY-MM-DD)建的目录及 design/writing。
  // 可选——web/旧壳无 → 无项目时右栏保持空态(无回退)。
  documentsCortexRoot?(): Promise<string>;
  // 写作产物默认根(Documents/cortex/writing,调用即建目录);首次进入写作工作区建默认空间用。
  // 可选——web/旧壳无此能力时写作入口降级隐藏。
  writingWorkspaceRoot?(): Promise<string>;
  // 写作工作区:粘贴/生成图片落盘(U1)。写入 <spaceRoot>/img/pasted-<ts>-<rand>.<ext>,
  // 返回落盘绝对路径,渲染端换算相对当前 md 的链接插入正文。
  // 可选——web/旧壳无此能力时粘贴图片降级(不拦截默认粘贴)。
  writingSaveImage?(payload: WritingSaveImagePayload): Promise<string>;
  // 写作检索(U4，工作区级轻量 RAG）:按空间根查询与用户正文相关的 top-k 片段。
  // 主进程按 root 维护内存索引(md/txt 全量读);查询返回 ok+context(null=无命中,静默不注入)或失败。
  // 可选——web/旧壳无此能力时,助手发送编排跳过检索注入(不阻断发送)。
  writingRetrieve?(req: WritingRetrievalRequest): Promise<WritingRetrievalResult>;
  // 失效某空间根的检索索引(WritingWorkspace 的 watch dirChanged 触发):下次检索重建。fire-and-forget。
  writingRetrievalInvalidate?(root: string): void;
  // 写作左栏文稿列表元信息:一次请求一批文档路径,返回创建/修改时间 + 正文概要(≤50 字)。
  // withExcerpt=false 时只 stat 不读盘(左栏未开「显示概要」)。取不到的路径不在结果里(渲染端降级)。
  // 可选——web/旧壳无此能力时左栏时间/概要与按时间排序整体降级(仍可按名称排序)。
  writingDocMeta?(req: WritingDocMetaRequest): Promise<WritingDocMetaResult>;
  // ── 写作禅模式(对齐 Metion 形态)─────────────────────────────────────────
  // 进入时写作窗口收缩到显示器最佳比例居中,主进程在其后垫一层铺满当前显示器的幕布窗口
  // 显示背景照片、遮住其它程序,并顺带隐藏菜单栏/Dock 与系统红绿灯组。show 传背景照片 id
  // (空串/脏值主进程回落清单首张),兼作切换(幕布已存在则原地换景);hide 销毁幕布并还原。
  // 资产:writingZenAssets 枚举背景/环境音 id;writingZenSoundData 取环境音整文件 base64
  // (渲染端转 blob 循环播放;dev 渲染端 http origin 直连 file:// 会被 webSecurity 拦)。
  // 均可选——web/旧壳无此能力时禅模式退化为「铺满应用窗口 + 无背景音」。
  writingZenBackdropShow?(backgroundId: string): Promise<void>;
  writingZenBackdropHide?(): Promise<void>;
  writingZenAssets?(): Promise<{ backgrounds: string[]; sounds: string[] }>;
  writingZenSoundData?(soundId: string): Promise<string | null>;
  // 禅模式自绘红/黄灯 → 关闭/最小化窗口(系统红绿灯被整组隐藏,Electron 不支持只藏绿灯)。
  // 可选——缺失时渲染端隐藏自绘灯(此时系统红绿灯也未被隐藏,不会失去关闭入口)。
  writingZenWindowControl?(action: "close" | "minimize"): Promise<void>;
  // 禅模式衬线字体(思源宋体 Light,随包 zen 资产)整文件 base64,渲染端 FontFace 注册;
  // 可选——缺失时禅模式回落系统衬线栈(Songti SC 等)。
  writingZenFontData?(): Promise<string | null>;
  // ── 写作信息图(U7,对接 media-gen）───────────────────────────────────────
  // 选区文本 → Kun 信息图提示词 → media-gen 生成 PNG → 落 <spaceRoot>/img/,返回落盘绝对路径。
  // 渲染端据 absolutePath 复用 U1 relativeImageLink 换算相对当前 md 的链接插入。失败给可读 message。
  // 可选——web/旧壳无此能力时信息图入口降级隐藏。
  writingInfographic?(req: WritingInfographicRequest): Promise<WritingInfographicResult>;
  // media-gen 图片模态是否已配置:未配置返回 false → 渲染端隐藏信息图入口(不暴露不可用按钮)。
  writingInfographicAvailable?(): Promise<boolean>;
  // ── 写作重型导出(U6,DOCX/PDF/PNG/HTML/复制富文本）─────────────────────────
  // 当前文档(path + content + format)→ 主进程同源渲染 HTML → 弹系统保存框落盘。
  // 结果:ok(落盘路径)/ canceled=true(用户取消,渲染端静默)/ message(失败,渲染端 toast)。
  // 可选——web/旧壳无此能力时导出菜单对应项降级隐藏。
  writingExport?(req: WritingExportRequest): Promise<WritingExportResult>;
  // 把当前文档渲染成富文本写入系统剪贴板(html + 纯文本双写)。失败给可读 message。
  writingCopyRichText?(req: WritingCopyRichTextRequest): Promise<WritingCopyRichTextResult>;
  // ── 写作 LLM(U3,ghost text 续写 + Cmd-K 就地改写）─────────────────────────
  // writingLlmStatus:探测写作模型配置态(configured/completionEnabled),渲染端据此决定挂载/隐藏入口。
  // writingComplete:打字续写,给前后缀窗口 → 返回可插入文本(ok.completion 可为空串=无续写)。
  // writingInlineEdit:Cmd-K 改写,给前后缀 + 选区原文 + 指令 → 返回替换文本(经既有 beginReview 审阅落盘)。
  // 可选——web/旧壳或未配置时续写/改写入口全降级隐藏(依 writingLlmStatus)。
  writingLlmStatus?(): Promise<WritingLlmStatus>;
  writingComplete?(req: WritingCompletionRequest): Promise<WritingCompletionResult>;
  writingInlineEdit?(req: WritingInlineEditRequest): Promise<WritingInlineEditResult>;
  // 写作日志:最近续写/改写调用记录(设置里排障查看)/ 清空。可选——无能力时设置节的日志卡不显。
  writingDebugLog?(): Promise<WritingDebugLogEntry[]>;
  writingDebugLogClear?(): Promise<void>;
  // ── 写作 PDF 阅读(U5）────────────────────────────────────────────────────
  // 读 PDF 原始字节(base64)交渲染端 pdfjs 阅读器渲染;失败给结构化 message(渲染端展示错误占位)。
  // 可选——web/旧壳无此能力时 .pdf 无法在写作台打开(阅读器降级为不支持提示)。
  writingReadPdf?(req: WritingPdfDataRequest): Promise<WritingPdfDataResult>;
  // ── AI Slides(演示文稿 deck,bento 单文件体系)──────────────────────────
  // deck.bento.html 只经主进程读写(renderer 不直接碰 deck 文件);全部结果结构化
  // { ok } envelope,revision 冲突返回 revision_conflict 由 UI 提示刷新。
  // 可选——web/旧壳无此能力时「演示文稿」创建入口降级隐藏。
  slidesBentoCreateDeck?(req: BentoCreateDeckRequest): Promise<BentoDeckIpcResult>;
  slidesBentoGetDeck?(req: BentoDeckScopedRequest): Promise<BentoGetDeckResult>;
  slidesBentoSetStage?(req: BentoSetStageRequest): Promise<BentoDeckIpcResult>;
  slidesBentoWriteDeckHtml?(req: BentoWriteDeckHtmlRequest): Promise<BentoDeckIpcResult>;
  slidesBentoExportFile?(req: BentoDeckScopedRequest): Promise<BentoExportFileResult>;
  // 演示模式:主进程加载 deck.bento.html 开演示窗(单屏/双屏),startIndex 为实页索引。
  // 可选——web/旧壳无此能力时工具栏「播放」按钮隐藏。
  slidesPresent?(req: SlidesPresentRequest): Promise<SlidesPresentResult>;
  /**
   * 订阅主进程的 deck 内容变更广播(AI 写盘 / 编辑器回写 / 换壳清洗)。
   * **返回退订函数**,调用方卸载时必须调用(与 onDirChanged / research.onEvent 同一约定,
   * 否则 reload 会累积 listener 触发 MaxListeners 告警)。
   * 可选——web/旧壳无此能力时舞台退化为「靠文件 watcher 重载」的旧行为。
   */
  onSlidesDeckChanged?(cb: (event: SlidesDeckChangedEvent) => void): () => void;
  // 写作工作区:重命名文件/目录(同目录重名预检,目标已存在则抛错不覆盖)。
  // 可选——web/旧壳无 → 文件树重命名功能降级隐藏。
  renameEntry?(from: string, to: string): Promise<void>;
  createTaskFile(projectRoot: string, todoId: string, title: string): Promise<string>;
  // Tasks 面板:列出项目 tasks/ 与 tasks/archive/ 顶层 .md（带 mtime）。
  // 可选（旧壳没有;无此能力时面板退化为只显示已登记 todo）。
  listTaskFiles?(projectRoot: string): Promise<TaskFilesResult>;
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
  // M3-A:列出用户 JSON(agents.local.json)派生/覆盖的 agent;reload 改文件后刷新主进程缓存。
  // 可选,无此能力(Web 端 / 旧壳)时 renderer 当作无派生 agent。
  listAgentProfiles?(): Promise<DerivedAgentMeta[]>;
  reloadAgentProfiles?(): Promise<DerivedAgentMeta[]>;
  // 圆桌角色库 CRUD（~/.cortex-desktop/roles.json 持久化）。可选,无此能力(Web 端 / 旧壳)时
  // renderer 当作无自定义角色，仅内置 shortcut 可用。变更后主进程广播 roles:changed。
  listRoles?(): Promise<RoleConfig[]>;
  createRole?(payload: { label: string; agent: string; systemPrompt: string; color?: string; avatar?: string }): Promise<RoleConfig>;
  updateRole?(id: string, patch: { label?: string; agent?: string; systemPrompt?: string; color?: string; avatar?: string }): Promise<RoleConfig | null>;
  deleteRole?(id: string): Promise<boolean>;
  onRolesChanged?(cb: (roles: RoleConfig[]) => void): () => void;
  // Markdown 预览里的链接:用系统默认浏览器打开（仅 http/https）。
  openExternal?(url: string): Promise<void>;
  // 内嵌浏览器面板「清除浏览数据」:清空 persist:browser-panel 分区的 cookie/缓存/storage。
  // 导航/历史/状态走渲染端 webview 元素 API,主进程只需这一条 IPC(见计划 KTD5)。
  browserClearData?(): Promise<void>;
  // 内嵌浏览器面板「截图到剪贴板」:把 webview.capturePage() 的 PNG 字节交主进程写系统剪贴板。
  // contextIsolation+sandbox 下渲染端不能直接用 clipboard,故经此桥(见计划 U3/KTD4)。返回是否成功。
  browserCopyImage?(png: Uint8Array): Promise<boolean>;
  // 把 agent 产出的本地 HTML 路径授权为可内嵌预览的 file:// URL(主进程校验在允许根内/.html/
  // realpath,授权后导航闸门才放行该 file://)。不合规返回 null。
  browserResolveLocalHtml?(path: string): Promise<string | null>;
  // 持久化
  loadState(): Promise<PersistedState>;
  saveState(state: PersistedState): Promise<void>;
  // 会话内设计/Slides 产物：主进程负责选择受信工作区、建索引并校验持久引用。
  artifactCreate?(
    request: ConversationArtifactCreateRequest,
  ): Promise<ConversationArtifactResult>;
  artifactValidate?(artifact: ConversationArtifactRef): Promise<ConversationArtifactResult>;
  // pushSettings 窄写通道：main 在权威态上就地合并后落盘。供不挂全量持久化的窗口
  // （项目管理）写推送开关，绕开陈旧全量快照 clobber。可选（web/旧壳无）。
  patchPushSettings?(patch: Partial<PushSettings>): Promise<void>;
  // pushSettings 变更订阅：main 在内容变化时广播全量 PushSettings 给所有窗口。
  // 各窗口用它保持只读镜像新鲜（usePushSettingsSync）。可选（web/旧壳无 → 空转）。
  onPushSettingsChanged?(cb: (push: PushSettings) => void): () => void;
  // 会话消息持久化（按 sessionId 一文件,内容对桥接层不透明）。
  // 返回 v1 裸消息数组或 v2 对象 {version:2, messages, branchGroups}(分支回复,见 core/personal/branches.ts);
  // 渲染端经 normalizeLoadedChat 归一。branchGroups 非空时主进程落 v2,否则维持 v1 裸数组(回滚安全)。
  loadChat(sessionId: string): Promise<unknown>;
  saveChat(sessionId: string, messages: unknown[], branchGroups?: unknown[]): Promise<void>;
  // 删除会话消息文件（物理删 chats/<id>.json;不存在不报错）
  deleteChat(sessionId: string): Promise<void>;
  // 会话「工作过程」归档(chats/<id>.process.json):每轮的过程流 + 工具调用快照,与正文分文件存,
  // 内容对桥接层不透明(core/personal/process-archive.ts 的 TurnProcessArchive[])。
  // 可选(web/旧壳无 → 历史轮过程不可回看,当前轮仍走瞬态流,功能降级但不报错)。
  loadProcessArchive?(sessionId: string): Promise<unknown>;
  saveProcessArchive?(sessionId: string, turns: unknown[]): Promise<void>;
  // 聊天图片上传:落盘返回绝对路径 / 按路径回读为 dataURL（缩略图）。
  // 可选（web/旧壳无 → composer 图片上传入口降级隐藏）。
  imageSave?(req: ImageSaveRequest): Promise<ImageSaveResult>;
  imageRead?(path: string): Promise<ImageReadResult>;
  // agent 产出的本地图片(项目外绝对路径如 ~/.codex/generated_images,或项目内 .cortex/media/images)
  // 回读为 dataURL 供聊天内联渲染。读侧沿用 openPath 的 assertOpenable 宽松语义 + realpath/拒符号链接/
  // 仅位图扩展名/体积上限硬防护。可选(web/旧壳无 → 内联图片降级为可点击文件链接,走 openPath 打开)。
  imageReadAny?(path: string): Promise<ImageReadResult>;
  // 聊天文档附件落盘:返回绝对路径 + 字节数。内容由 agent 经文档抽取 MCP 工具按需读取,
  // 本桥接不负责抽取。可选（web/旧壳无 → composer 文档上传入口降级隐藏）。
  docSave?(req: DocSaveRequest): Promise<DocSaveResult>;
  // git 提交记录（非 git 仓库返回空数组）
  gitLog(root: string, opts?: { sinceTs?: number; max?: number }): Promise<GitCommit[]>;
  // CLI 流式
  startCli(req: CliStartRequest): Promise<void>;
  // 一次性短任务（生成 session 标题/日报等）,返回纯文本输出。
  // agent 缺省 claude;走各 agent 的 adapter,新接入的 agent 自动支持。
  // 不传 cwd 在中性目录运行,不加载项目上下文。
  // provider 仅 pi 用:挂载选中供应商（生成 extension + 注入 key），日报选 pi 时据此运行。
  // provider 仅 pi 用：只传 providerId，主进程按「Catalog + provider-prefs + 凭据金库」自行解析出
  // endpoint 与密钥（阶段③ 收编）。渲染端不再持有 baseUrl/apiKey —— 旧的拍平形状源自已废弃且
  // 含明文 apiKey 的 providerSettings，§5 清理后它本就取不到值。
  oneshotCli(req: {
    agent?: AgentKind;
    cwd?: string;
    prompt: string;
    model?: string;
    providerId?: string;
    effort?: import("./types").ReasoningEffort;
  }): Promise<string>;
  // OpenAI 兼容端点一次性补全（自定义日报模型;主进程发请求,密钥不出 main）
  openaiComplete(req: OpenAiCompleteRequest): Promise<string>;
  // 检索改写 + 意图分类的一次性小补全（前置检索管线用;5s 超时/低温/限额由主进程写死）。
  // 可选：web/旧壳无此方法 → chat-preflight 降级为不改写、原文进检索。
  queryUnderstand?(req: QueryUnderstandIpcRequest): Promise<QueryUnderstandIpcResponse>;
  // ── Provider Catalog / 认证 / Model Gateway ────────────────────────────────
  // 类型见 ./provider-catalog.ts（主进程侧镜像 apps/desktop/src/main/providers/contract.ts）。
  // 三条红线：① 模型能力来自 Pi 内置目录、对用户只读；② 明文/密文凭据永不过桥，renderer
  // 只拿 configured/type/source/error；③ 文本补全一律走 modelGateway*，业务模块不得自拼 URL。
  // 全部可选（Web 端为 null；旧壳无方法时调用方须走降级分支）。
  providerCatalogGet?(): Promise<ProviderCatalogResult>;
  providerAuthStatus?(): Promise<ProviderAuthSnapshot>;
  providerAuthLogin?(providerId: string): Promise<{ ok: boolean; error?: string }>;
  providerAuthRespond?(requestId: string, value: string): Promise<{ ok: boolean; error?: string }>;
  providerAuthCancel?(providerId: string): Promise<{ ok: boolean; error?: string }>;
  providerAuthLogout?(providerId: string): Promise<{ ok: boolean; error?: string }>;
  providerAuthSetApiKey?(providerId: string, apiKey: string): Promise<{ ok: boolean; error?: string }>;
  providerAuthSetSecrets?(secrets: Record<string, string>): Promise<{ ok: boolean; error?: string }>;
  providerAuthSetHidden?(providerIds: string[]): Promise<{ ok: boolean; error?: string }>;
  // 自建网关/代理端点覆盖；传 undefined 清除覆盖、恢复 pi 内置目录里的官方端点。
  providerAuthSetBaseUrl?(providerId: string, baseUrl: string | undefined): Promise<{ ok: boolean; error?: string }>;
  onProviderAuthEvent?(cb: (event: ProviderAuthEvent) => void): () => void;
  // traceId 由渲染端生成、主进程原样回带，用于把步骤事件对回发起它的那个测试面板；
  // 旧壳没有第三参也不会炸（多余实参被忽略），只是拿不到实时步骤、退化成等最终结果。
  providerConnectionTest?(providerId: string, modelId?: string, traceId?: string): Promise<ProviderConnectionTestResult>;
  // 连接测试的实时步骤流；按 traceId 过滤是订阅方的责任（多行同时测试会串场）。
  onProviderConnectionTestEvent?(cb: (event: ProviderConnectionTestEvent) => void): () => void;
  providerCustomList?(): Promise<CustomProviderDefinition[]>;
  providerCustomSave?(def: CustomProviderDefinition): Promise<{ ok: boolean; error?: string }>;
  providerCustomDelete?(id: string): Promise<{ ok: boolean; error?: string }>;
  providerCustomValidate?(json: string): Promise<CustomProviderValidation>;
  // 聚合网关（new-api / one-api 等 OpenAI 兼容网关）接入向导的两个主进程能力。
  // discover：调网关 `GET /v1/models` 拿 id 列表，并逐 id 过随包 Catalog 解析能力
  //（known/unknown 是显式状态，渲染端不得把 unknown 折算成任何默认值）。
  // build：把「启用哪些模型 + 未识别模型的参照模型」翻译成一份合法的 Pi Provider JSON。
  // 能力字段一律由主进程产出——渲染端没有、也不该有任何生成能力数值的入口。
  providerGatewayDiscover?(req: GatewayDiscoverRequest): Promise<GatewayDiscoverResult>;
  providerGatewayBuild?(req: GatewayBuildRequest): Promise<GatewayBuildResult>;
  modelGatewayComplete?(req: GatewayCompleteRequest): Promise<GatewayCompleteResult>;
  // 流式：返回值是终态汇总（含 text/usage），增量经 onModelGatewayEvent 推回。
  modelGatewayStream?(req: GatewayCompleteRequest): Promise<GatewayCompleteResult>;
  modelGatewayAbort?(requestId: string): Promise<{ ok: boolean }>;
  onModelGatewayEvent?(cb: (requestId: string, event: GatewayStreamEvent) => void): () => void;
  // 桌面行为：renderer 切换开机自启/启动最小化/关闭到托盘时通知主进程立即应用
  //（登录项是系统设置,须即时设置）。可选（web 端为 null）。
  setDesktopBehavior?(behavior: DesktopBehavior): Promise<void>;
  // 渲染端切主题时下发主进程设置 nativeTheme.themeSource:macOS 侧栏 vibrancy 材质与
  // 次级窗口的 prefers-color-scheme 跟随的是窗口外观而非 data-theme,应用主题与系统外观
  // 不一致时(应用暗、系统亮)材质会发白,必须由主进程同步。可选（web 端为 null）。
  setTheme?(mode: "system" | "light" | "dark"): Promise<void>;
  // 渲染端(主窗口 i18next 为权威源)切语言时下发主进程,主进程据此广播给所有窗口 +
  // 重建托盘菜单（原生 chrome 无法用 react-i18next,只能镜像）。可选（web 端为 null）。
  setLocale?(locale: Locale): Promise<void>;
  // 订阅主进程 locale 广播（次级窗口据此与主窗口语言保持一致）。可选;返回退订函数。
  onLocaleChange?(cb: (locale: Locale) => void): () => void;
  // 打开日志目录（系统文件管理器）。可选。
  openLogsDir?(): Promise<void>;
  // 即时下发文件日志开关（本次运行内生效,无需重启）。可选。
  setLogEnabled?(enabled: boolean): Promise<void>;
  // 渲染端把会话内不落盘的 agent 报错/失败信息、核心路径埋点写入主进程文件日志（脱敏由主进程负责）,
  // 保留可排查性。级别 debug|info|warn|error；dev/prod 级别 gating 由 apps/desktop 壳在注入时决定
  //（core 不自判环境）。fire-and-forget,可选（web 端为 null）。
  logMessage?(level: "debug" | "info" | "warn" | "error", message: string): Promise<void>;
  // 渲染端改闪记全局热键 → 主进程即时校验 + 重注册（仿 setDesktopBehavior 的即时通路）。
  // ok=true 表示新键已生效;ok=false 表示格式无效或被占用（已回退旧键,toast 含原因）。可选。
  setNotesHotkey?(accelerator: string): Promise<{ ok: boolean; toast?: string }>;
  // 同步语音聊天 / 听写的三项快捷键。空串解除对应绑定；主进程会原子地恢复上一组注册，
  // 因此任一返回 ok=false 时设置 UI 应回滚完整 pick3，保持显示值与系统实际绑定一致。
  setVoiceHotkeys?(
    hotkeys: Pick<VoiceSettings, "chatHotkey" | "dictationHoldHotkey" | "dictationToggleHotkey">,
  ): Promise<
    Record<"chatHotkey" | "dictationHoldHotkey" | "dictationToggleHotkey", { ok: boolean; toast?: string }>
  >;
  // 日报推送（企微/钉钉 webhook、SMTP 邮件;主进程发请求规避 CORS）
  pushReport(target: PushTarget, payload: { subject: string; text: string }): Promise<PushResult>;
  // TTS：OpenAI 兼容 /v1/audio/speech 合成,返回音频字节（renderer 播放）
  ttsSynthesize(req: TtsSynthesizeRequest): Promise<ArrayBuffer>;
  // Edge 在线 TTS：可选以兼容 web 与旧桌面壳；缺失时由 UI 走系统语音。
  ttsSynthesizeEdge?(req: EdgeTtsSynthesizeRequest): Promise<ArrayBuffer>;
  // TTS：流式合成,主进程边读响应边把音频块推给 renderer。
  ttsSynthesizeStream?(req: TtsSynthesizeRequest, cb: (event: TtsStreamEvent) => void): Promise<void>;
  // 停止播放时中止在途合成流:声音停掉只是表象,不中止 fetch 的话本地 TTS 服务会继续
  // 满负荷生成整段文本并堵塞后续请求(stopSpeaking 经此把取消传导到主进程)。
  ttsCancelStreams?(): Promise<void>;
  // TTS：按模型发现可选音色；端点不支持时返回空数组。
  listTtsVoices(req: TtsListVoicesRequest): Promise<TtsVoiceOption[]>;
  listEdgeTtsVoices?(): Promise<TtsVoiceOption[]>;
  // ASR：OpenAI 兼容 /v1/audio/transcriptions 转写,返回文本。
  asrTranscribe(req: AsrTranscribeRequest): Promise<AsrTranscribeResponse>;
  killCli(runId: string): Promise<void>;
  // ── 主 agent 编排子 agent 三段执行（chat「子 agent 编排」开关）。可选能力（web/旧壳无 → 渲染端
  //    退回单发 startCli，开关 UI 降级隐藏）。事件流复用 onCliEvent/onCliExit（runId=orchestrationRunId，
  //    事件带 stage 字段）；取消走 killOrchestration（不复用 killCli，编排子进程在主进程独立注册表）。 ──
  startOrchestration?(req: OrchestrateStartRequest): Promise<void>;
  killOrchestration?(runId: string): Promise<void>;
  // ── 圆桌多角色 BFS 编排（chat @mention 触发）。可选能力（web 端无 → 降级到 startCli）。
  //    事件流复用 onCliEvent/onCliExit（runId=roundtableRunId，事件带 roleId 字段）；
  //    取消走 killRoundtable（不复用 killCli，圆桌子进程在主进程独立注册表）。 ──
  startRoundtable?(req: RoundtableStartRequest): Promise<void>;
  killRoundtable?(runId: string): Promise<void>;
  // 发送前校验外部 agent 的 resume 会话文件是否仍在本机。可选能力;旧壳缺失时保持原行为。
  agentSessionExists?(req: AgentSessionRequest): Promise<boolean>;
  // 编辑重发:截断 agent CLI 会话记忆(可选能力,旧壳无此方法时退化为带旧记忆 resume)。
  trimAgentSession?(req: TrimSessionRequest): Promise<boolean>;
  // 分支重新生成(claude/codex):复制会话记忆为新 id 并截断副本,源文件保留供旧分支续聊。
  // 失败返回 null(调用方降级为破坏式 trimAgentSession,旧分支转只读)。可选能力。
  trimSessionIntoCopy?(req: TrimSessionRequest): Promise<{ newSessionId: string } | null>;
  // 信封归一 P0:第四参透传信封元数据(v/domain),当前接收侧未消费,供将来按域分发/版本闸门。
  onCliEvent(
    cb: (
      runId: string,
      event: CliStreamEvent,
      sessionId?: string,
      meta?: Pick<RunEventEnvelope, "v" | "domain">,
    ) => void,
  ): () => void;
  onCliExit(cb: (exit: CliExitEvent) => void): () => void;
  // ws 传输心跳(U5,可选能力):codex app-server 长 MCP 工具静默期主进程定期推送,渲染端据此重置
  // 300s 静默看门狗(防误杀)。旧壳/web 端缺失时无此信号,行为退化为仅靠 cli:event 重置(不影响 spawn agent)。
  onCliKeepalive?(cb: (runId: string, sessionId?: string) => void): () => void;
  // 主进程请求打开内置浏览器面板并导航(agent browser_navigate 在面板未开时触发)。回调 (url);返回退订。
  onBrowserOpenPanel?(cb: (url: string) => void): () => void;
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
  // 分支回复:把当前 live 会话文件复制为不可变快照(chat-branches/<sessionId>/<branchId>.jsonl),
  // 旧分支据快照 switchSession 续聊。会话未开/无文件/失败 → null(该分支降级只读)。
  piSnapshotSession?(uiSessionId: string, branchId: string): Promise<{ path: string } | null>;
  // 显式关闭会话（终止子进程,幂等）。
  piClose?(uiSessionId: string): Promise<void>;
  // 归一化事件流（仿 onCliEvent:回调 + 返回退订）。按 uiSessionId 分派;runId 供阶段4 代际守卫。
  onPiEvent?(cb: (uiSessionId: string, event: PiSessionEvent, runId?: string) => void): () => void;
  // extension UI 请求（pi → host,阶段3 工具确认弹窗等）。订阅 + 回写应答。全可选（web/旧壳缺失）。
  onPiUiRequest?(cb: (uiSessionId: string, request: PiUiRequest) => void): () => void;
  // 短生命周期 child/编排段已结束，主进程主动撤销尚在 renderer 队列的 UI 请求。
  onPiUiCancel?(cb: (uiSessionId: string, requestId: string) => void): () => void;
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
  // 删除单条运行记录（运行历史的清理,不影响自动化本身）。
  automationDeleteRun?(automationId: string, runId: string): Promise<void>;
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
  // 信封归一 P1:纯失效通知统一订阅(tasks/task-resources/notes)。scope→invalidate 映射表
  // 见 core/personal/sync-invalidate.ts;新增失效域只扩 SyncInvalidateScope + 映射表一行,
  // 不再新加 on*Changed 桥方法。回调 scope 收窄为联合类型:漂移在编译期暴露。
  onSyncInvalidate?(cb: (scope: SyncInvalidateScope, hint?: string) => void): () => void;
  // 消息中心（侧栏底部铃铛）：可选能力，web/旧壳无 → 铃铛整体隐藏。
  // main 为 owner；渲染端只读 + 标已读/清空，**写入没有对应桥方法**（见 ipc/notification-center.ts
  // 的 recordNotification 注释：消息是主进程事实的存档，渲染端不能伪造）。
  notificationCenterList?(): Promise<NotificationRecord[]>;
  notificationCenterMarkRead?(ids?: string[]): Promise<void>;
  notificationCenterClear?(): Promise<void>;
  onNotificationCenterChanged?(cb: (list: NotificationRecord[]) => void): () => void;
  // 真任务系统（个人工作区，替换 doc 聚合 Tasks）：可选能力，web/旧壳无 → UI 降级隐藏。
  // main 为 owner，与 apps/desktop/src/preload/index.ts 的 tasks* 逐字对齐（手工比对，无 satisfies）。
  tasksList?(projectId?: string): Promise<TaskMeta[]>;
  tasksListProjects?(): Promise<TaskProject[]>;
  tasksAdd?(input: TaskInput): Promise<TaskMeta>;
  tasksUpdate?(id: string, patch: Partial<Omit<TaskMeta, "id" | "createdAt">>): Promise<TaskMeta | null>;
  tasksDelete?(id: string): Promise<void>;
  tasksAddProject?(
    name: string,
    opts?: { parentId?: string; kind?: TaskProjectKind; stages?: ProjectStage[]; note?: string; status?: TaskProjectStatus },
  ): Promise<TaskProject>;
  tasksUpdateProject?(
    id: string,
    patch: {
      name?: string;
      parentId?: string | null;
      mode?: TaskProjectMode;
      note?: string;
      status?: TaskProjectStatus;
      stages?: ProjectStage[];
    },
  ): Promise<TaskProject | null>;
  tasksDeleteProject?(projectId: string): Promise<void>;
  tasksArchive?(id: string, summary: string): Promise<boolean>;
  tasksListArchived?(): Promise<ArchivedTask[]>;
  // 团队成员 / 岗位标签 / 阶段模板（项目管理扩展，参照 IFocus）：可选能力，web/旧壳无 → UI 降级隐藏。
  // 与 apps/desktop/src/preload/index.ts 的同名方法逐字对齐（手工比对，无 satisfies）。
  // 岗位标签 jobTypesList 返回 undefined = 用户从未编辑过（消费端经 resolveJobTypes 取默认表）。
  membersList?(): Promise<Member[]>;
  membersAdd?(input: { name: string; role?: string }): Promise<Member>;
  membersUpdate?(id: string, patch: { name?: string; role?: string }): Promise<Member | null>;
  membersDelete?(id: string): Promise<void>;
  jobTypesList?(): Promise<string[] | undefined>;
  jobTypesSet?(next: string[]): Promise<string[]>;
  stageTemplatesList?(): Promise<StageTemplate[]>;
  stageTemplatesAdd?(input: { name: string; description?: string; stages: string[] }): Promise<StageTemplate>;
  stageTemplatesUpdate?(id: string, patch: { name?: string; description?: string; stages?: string[] }): Promise<StageTemplate | null>;
  stageTemplatesDelete?(id: string): Promise<void>;
  // 任务附件（U13）：复用聊天文档附件闸门落盘（仅文档类型 pdf/docx/xlsx/pptx/csv/txt/md，图片延后），
  // 返回落盘引用（main 写回 TaskMeta.attachments 并广播 tasks:changed）；delete 按 path 删磁盘 + 清引用。
  // 可选能力（web/旧壳无 → TaskAttachments 降级隐藏「添加/移除」，仅只读列出既有附件）。
  taskDocSave?(taskId: string, file: { name: string; mimeType: string; srcPath?: string; data?: ArrayBuffer }): Promise<TaskAttachment>;
  taskDocDelete?(taskId: string, path: string): Promise<void>;
  // 委派意图跨窗口中继（KTD10）：sessions 是 renderer 本地 Zustand、不跨窗口，故「项目管理」
  // 独立窗口委派不能本地起会话——只发意图给 main。main 唤起主窗口并把意图转发过去。
  //  - sendTaskDelegateIntent：项目管理窗口 renderer 调用（发送端）。
  //  - onTaskDelegateIntent：主窗口 renderer 订阅（接收端，解析任务后 createSession+send）。
  // 可选能力（web/旧壳无 → 项目管理窗口不存在，两端都用不到）。
  sendTaskDelegateIntent?(intent: TaskDelegateIntent): void;
  onTaskDelegateIntent?(cb: (intent: TaskDelegateIntent) => void): () => void;
  // 冷窗口兜底（仿 consumeSpotlightIntent）：主窗口被隐藏/冷启动时 live 意图会在 listener 注册前发丢，
  // main 存 pending；主窗口 mount 时先 consume 一次再订阅 live，避免丢派发。
  consumeTaskDelegateIntent?(): Promise<TaskDelegateIntent | null>;
  // 内置 skill 元数据（深化注入 ce-ideate / 生成 plan 注入 ce-plan）。可选:web/旧壳无此
  // 能力 → 深化入口降级 toast。第一阶段读内置 resources/skills,第二阶段叠加 userData/skills。
  skillGet?(name: string): Promise<SkillMeta | null>;
  builtinSkillGet?(name: string): Promise<SkillMeta | null>;
  skillsList?(): Promise<SkillMeta[]>;
  // 插件管理（U3）:按 piSkills 配置扫描多根 → PluginSkill[];打开/创建范围根（白名单校验）。
  // 可选:web/旧壳无此能力 → 插件管理器降级空态。
  piSkillsList?(args: {
    // Design B(plan 002):按会话 agent 解析的扫描根规格(resolveAgentSkillRoots 产出)。
    //   global scope 根含 ~(主进程 expandTilde);workspace scope 根为相对子目录(主进程 join workspaceDir)。
    //   提供 rootSpecs 时,主进程忽略下方 deprecated 扁平入参。
    rootSpecs?: { path: string; scope: "global" | "workspace"; origin: "shared" | "agent" }[];
    workspaceDir?: string;
    // 会话 agent(Design B 增量):主进程据此追加该 agent 自带的插件/内置 skill 根(claude/codex CLI 自带)。
    agent?: AgentKind;
    // U6:已启用插件的 skills 根（绝对路径，scope=global）。主进程 append 进扫描根，与第一方 skill 同链注入。
    pluginSkillDirs?: string[];
    /** @deprecated 过渡期扁平入参(Design B)。未迁移调用点(如 SkillPanel)仍用,消费点切完移除。 */
    globalRoots?: string[];
    /** @deprecated 过渡期扁平入参(Design B)。 */
    userGlobalRoots?: string[];
    /** @deprecated 过渡期扁平入参(Design B)。 */
    workspaceEnabled?: boolean;
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
  // 插件市场（第一期，只读）:扫描 agents 标准已装插件（~/.agents/plugins/plugins/）+ 读
  // marketplace.json 索引。纯只读消费，不写共享目录;启停/信任态在 core store。
  // 可选:web/旧壳无此能力 → 插件面降级空态。安装/升级/删除为后续阶段，本期不提供。
  pluginList?(): Promise<PluginListResult>;
  marketplaceList?(): Promise<MarketplaceListResult>;
  // ── SenseVoiceSmall 本地模型与流式会话。可选:web/旧壳无此能力时 UI 隐藏本地入口。 ──
  /** 列出所有本地 ASR 模型状态（missing/downloading/ready/error）。*/
  listLocalAsrModels?(): Promise<LocalAsrModelStatus[]>;
  /** 查询单个模型状态（含下载进度快照）。*/
  getLocalAsrModelStatus?(modelId: string): Promise<LocalAsrModelStatus>;
  /** 下载指定模型（互斥;进度经 onLocalAsrDownloadProgress 推送）。*/
  downloadLocalAsrModel?(args: { modelId: string; sourceId?: string }): Promise<{ ok: boolean; message?: string; status?: LocalAsrModelStatus }>;
  /** 取消正在进行的下载（幂等）。*/
  cancelLocalAsrDownload?(modelId: string): Promise<{ ok: boolean; status?: LocalAsrModelStatus }>;
  /** 删除已下载的模型文件。*/
  deleteLocalAsrModel?(modelId: string): Promise<{ ok: boolean; message?: string; status?: LocalAsrModelStatus }>;
  /** 检测各下载源对指定模型的可达性。*/
  checkLocalAsrSources?(modelId?: string): Promise<LocalAsrSourcesResult>;
  /** 订阅下载进度推送（仿 onUpdateState；返回退订函数）。*/
  onLocalAsrDownloadProgress?(cb: (progress: LocalAsrModelProgress) => void): () => void;
  // ── 流式 Zipformer 本地模型（sherpa-onnx）。与上面 SenseVoice 一组并列，语义逐条对应。──
  /** 列出所有流式 ASR 模型状态。*/
  listStreamingAsrModels?(): Promise<StreamingAsrModelStatus[]>;
  /** 查询单个流式模型状态（含下载进度快照）。*/
  getStreamingAsrModelStatus?(modelId: string): Promise<StreamingAsrModelStatus>;
  /** 下载流式模型（三件套 + 词表串行下载；进度经 onStreamingAsrDownloadProgress 推送）。*/
  downloadStreamingAsrModel?(args: { modelId: string; sourceId?: string }): Promise<{ ok: boolean; message?: string; status?: StreamingAsrModelStatus }>;
  /** 取消正在进行的流式模型下载（幂等）。*/
  cancelStreamingAsrDownload?(modelId: string): Promise<{ ok: boolean; status?: StreamingAsrModelStatus }>;
  /** 删除已下载的流式模型目录。*/
  deleteStreamingAsrModel?(modelId: string): Promise<{ ok: boolean; message?: string; status?: StreamingAsrModelStatus }>;
  /** 检测各下载源对指定流式模型的可达性。*/
  checkStreamingAsrSources?(modelId?: string): Promise<StreamingAsrSourcesResult>;
  /** 订阅流式模型下载进度（返回退订函数）。*/
  onStreamingAsrDownloadProgress?(cb: (progress: StreamingAsrModelProgress) => void): () => void;
  /**
   * 启动本地实时会话。
   *
   * protocol 决定主进程用哪个引擎：local-zipformer-stream 走 sherpa 流式解码，
   * 其余（含省略）按 SenseVoice 处理。之后的 append/finish/cancel 由主进程按
   * requestId 反查归属，调用方不必重复传。
   */
  startLocalAsrStream?(args: { requestId: string; modelId: string; language: string; protocol?: string }): Promise<void>;
  /** 追加 16kHz/单声道/PCM16LE；主进程校验 requestId、顺序与 30 秒上限。*/
  appendLocalAsrAudio?(requestId: string, audio: ArrayBuffer): Promise<void>;
  /** 结束本地语句并等待一次整句结果。*/
  finishLocalAsrStream?(requestId: string): Promise<AsrTranscribeResponse>;
  /** 幂等取消当前本地语句。*/
  cancelLocalAsrStream?(requestId: string): Promise<void>;
  // 统一转写入口：
  //   local-sensevoice       → 常驻原生 sidecar（本地，无网络）
  //   openai-transcriptions  → OpenAI 兼容 /v1/audio/transcriptions
  //   mimo-asr               → MIMO ASR（同 OpenAI 兼容接口形状）
  transcribeSpeech?(req: AsrTranscribeRequest, asrSettings: AsrSettings): Promise<AsrTranscribeResponse>;
  // 转写文本 LLM 纠错(stt:polish):开关/模型/prompt 全由主进程按 voiceSettings 决定,
  // 失败或未配置模型时原文返回——调用方只需「转写 → 纠错 → 再上屏」串联,无需感知细节。
  polishTranscript?(text: string): Promise<string>;

  // ── 节点式工作流（loop）────────────────────────────────────────────────────
  // 可选能力（web/旧壳无此桥 → UI 据此降级隐藏工作流入口）。
  // 跨进程契约：core/views 只经此接口调用，永不直接触碰 window.desktopAPI 或 Node API。
  // 运行时相关方法（runNow/stop/node:run/node:test/approval:resolve/import/export）
  // 在 U8/U9/U14/U15 完整接线前，主进程侧返回明确错误（渲染层需捕获并提示）。

  /** 列出所有工作流定义快照。 */
  workflowList?(): Promise<WorkflowDef[]>;
  /** 创建工作流（id/时间戳由主进程分配）。 */
  workflowCreate?(input: Partial<WorkflowDef>): Promise<WorkflowDef>;
  /** 更新工作流（patch 由 renderer 组装，主进程 normalize + 持久化）。 */
  workflowUpdate?(id: string, patch: Partial<WorkflowDef>): Promise<WorkflowDef | null>;
  /** 切换启用状态。 */
  workflowSetEnabled?(id: string, enabled: boolean): Promise<WorkflowDef | null>;
  /** 切换 AI 可调用标记（MCP 侧 U14 监听此变化刷新工具列表）。 */
  workflowSetCallableByAgent?(id: string, callableByAgent: boolean): Promise<WorkflowDef | null>;
  /** 删除工作流（含运行历史）。 */
  workflowDelete?(id: string): Promise<void>;
  /** 立即触发一次运行，返回初始 running WorkflowRun。P1 AC-003：支持可选 input 参数。 */
  workflowRunNow?(id: string, input?: Record<string, unknown>): Promise<WorkflowRun | null>;
  /** 停止正在进行的运行（待 U9 接线）。 */
  workflowStop?(id: string, runId: string): Promise<void>;
  /** 列出工作流的运行历史。 */
  workflowListRuns?(id: string): Promise<WorkflowRun[]>;
  /** 删除单条运行记录（不影响工作流 meta）。 */
  workflowDeleteRun?(id: string, runId: string): Promise<void>;
  /** 从 DSL JSON 导入工作流（待 U15 接线）。 */
  workflowImport?(dsl: unknown): Promise<WorkflowDef>;
  /** 导出工作流为 DSL JSON（secret 脱敏由主进程负责，待 U15 接线）。 */
  workflowExport?(id: string): Promise<unknown>;
  /** 画布单节点运行（待 U8 接线）。 */
  workflowNodeRun?(workflowId: string, nodeId: string, input: unknown): Promise<unknown>;
  /** 配置面板单节点测试（待 U8 接线）。 */
  workflowNodeTest?(workflowId: string, nodeId: string, input: unknown): Promise<unknown>;
  /** human-approval 节点 resolve。P0 Fix-1：入参为 approval token（非 runId），
   * token 由 executeHumanApproval 通过 WorkflowRunEvent 广播给 UI。 */
  workflowResolveApproval?(token: string, decision: "approved" | "rejected"): Promise<void>;
  /** cron 表达式即时校验（ScheduleEditor 实时反馈，真相以 main 调度为准）。
   * P2 Fix-13：nextRun 类型与 CronValidation/automationValidateCron 对齐为 number（epoch ms）。 */
  workflowValidateCron?(expression: string, timezone?: string): Promise<{ ok: boolean; error?: string; nextRun?: number }>;
  /** 订阅工作流列表变化（CRUD 后主进程推全量快照；返回退订函数）。 */
  onWorkflowChanged?(cb: (list: WorkflowDef[]) => void): () => void;
  /** 订阅单次运行阶段事件（start/end，运行时 U8/U9 推送；返回退订函数）。 */
  onWorkflowRunEvent?(cb: (event: WorkflowRunEvent) => void): () => void;

  // ── 快捷回复助手（reply）────────────────────────────────────────────────────
  // macOS-only：Web / 非 mac 端这些方法为 undefined，UI 据此隐藏整个设置分区（沿 transcribeSpeech
  // 先例，全部 `?:` 可选）。跨进程契约见 apps/desktop/src/main/ipc/reply.ts（U5 stub，U7/U9 填实）。
  /** 查询五项系统权限状态（accessibility/screen/calendar/mic/speech）。 */
  replyGetPermissions?(): Promise<ReplyPermissionState>;
  /** 打开指定权限的系统设置面板（授权引导）。 */
  replyOpenPermissionSettings?(kind: ReplyPermissionKind): Promise<void>;
  /** 校验渠道凭据：main 发 fetch + safeStorage 加密，成功回带账号身份与密文。 */
  replyVerifyChannel?(channelId: ChannelId, token: string): Promise<ReplyChannelVerifyResult>;
  /** 断开渠道：main 侧清除 safeStorage 密文（store 连接态由渲染端清）。 */
  replyDisconnectChannel?(channelId: ChannelId): Promise<void>;
  /** 拉取内存调试记录（最近 20 条，进程退出即清）。 */
  replyGetDebugLog?(): Promise<ReplyDebugEntry[]>;
  /** 拉取 ~/.cortex-desktop/reply/ 落盘数据摘要（历史/对话记忆条数，设置页展示）。 */
  replyGetDataSummary?(): Promise<ReplyDataSummary>;
  /** 清空回复历史（history.json，数据清理）。 */
  replyClearHistory?(): Promise<void>;
  /** 清空对话级记忆（conversation-memory.json，数据清理）。 */
  replyClearConversationMemory?(): Promise<void>;
  /** 在 Finder 显示 ~/.cortex-desktop/reply/ 数据文件夹（记忆/历史均为本机 JSON）。 */
  replyOpenDataFolder?(): Promise<void>;
  /** 立即重新学习：依据已落盘回复历史重建 im/email 语气要点（源项目 relearn）。 */
  replyRelearn?(): Promise<ReplyRelearnResult>;
  /** 读全局分区记忆（KTD6 修订：main-owned memory.json，含首启从旧分片迁移）。 */
  replyGetMemory?(): Promise<MemoryState>;
  /** 写单分区手写区/自动区（设置页 MemoryManager 编辑）。 */
  replySetMemoryFile?(scope: MemoryScope, patch: Partial<MemoryFile>): Promise<void>;
  /** 清空记忆：all=手写+自动；auto=仅自动学习要点。 */
  replyClearMemory?(kind: "all" | "auto"): Promise<void>;
  /** 手动触发一次起草（兜底 accelerator / 调试入口）。 */
  replyTriggerDraft?(): Promise<void>;
  /** 渲染端把「设置 + 记忆 + 默认 agent」快照推送到 main（供 draft-generator 生成候选）。 */
  replySyncSettings?(snapshot: ReplySyncSnapshot): Promise<void>;
  /**
   * 订阅 main 的记忆变更（KTD6 修订）：蒸馏直写 memory-store 后推全量记忆，渲染端刷新
   * 设置页缓存（持久化真源在 main，渲染端只持只读缓存）。返回退订函数。
   */
  onReplyMemoryChanged?(cb: (memory: MemoryState) => void): () => void;

  // ── 用户记忆（跨工作台持久记忆 + 做梦整理）──────────────────────────────────
  // 真源在 main 侧 ~/.cortex-desktop/memory/*.md（main 唯一写者）;渲染端 useMemoryStore
  // 只持只读缓存。Web/旧壳无这些方法 → 记忆功能整体降级隐藏（全部 `?:` 可选）。
  // 跨进程契约见 apps/desktop/src/main/ipc/memory.ts。
  /** 读全部分区记忆（每次现读 md 文件,Finder 编辑即时生效）。 */
  memoryGet?(): Promise<UserMemoryState>;
  /** 写单分区手写区/自动区（设置页编辑）。 */
  memorySetFile?(scope: UserMemoryScope, patch: Partial<UserMemoryFile>): Promise<void>;
  /** 清空记忆：all=手写+自动；auto=仅做梦自动整理要点。 */
  memoryClear?(kind: "all" | "auto"): Promise<void>;
  /** 手动触发一次做梦整理（单飞,进行中返回 in-flight）。 */
  memoryDreamNow?(): Promise<MemoryDreamResult>;
  /** 读做梦状态摘要（上次整理时间 + 最近历史,设置页展示）。 */
  memoryGetDreamState?(): Promise<DreamStateSummary>;
  /** 在 Finder 显示 ~/.cortex-desktop/memory/ 记忆文件夹。 */
  memoryOpenFolder?(): Promise<void>;
  /** 订阅 main 的记忆变更（做梦写回后推全量记忆,渲染端刷新只读缓存）。返回退订函数。 */
  onMemoryChanged?(cb: (memory: UserMemoryState) => void): () => void;

  // ── 桌面宠物脱离主窗体(独立 overlay 窗口)────────────────────────────────────
  // 宠物渲染从主窗口内嵌 <Pet/> 迁到独立 transparent/alwaysOnTop 的 pet-overlay 窗口
  // (窗口尺寸刚好包住宠物,靠原生 `-webkit-app-region: drag` 让 OS 直接移动窗口本身,
  // 而不是在一个铺满全屏的透明窗口内用 CSS 挪动——后者在多显示器下会被 macOS 裁剪,
  // 宠物拖到第二块屏幕就找不到了,详见 pet-overlay-window.ts 头部注释)。
  // 主窗口(PetBridge 组件)只订阅 usePetStore 转发状态,不再渲染宠物本体;overlay 窗口
  // 镜像收到的状态并原样复用 <Pet windowFollowsPet/> 渲染。位置持久化由主进程监听窗口
  // 自身的 moved 事件完成,不经这条 IPC 契约(渲染端不需要感知/上报位置)。
  /** 主窗口 usePetStore 变化时转发给主进程,再广播给宠物 overlay 窗口。 */
  reportPetState?(snapshot: PetStateSnapshot): void;
  /** overlay 窗口挂载时主动请求一次当前快照(应对"谁先挂载"的时序竞态)。 */
  requestPetSync?(): void;
  /** overlay renderer 按 Pet enabled 状态显示/隐藏对应原生窗口，避免透明空窗吞点击。 */
  setPetOverlayVisible?(visible: boolean): void;
  /** overlay 关闭按钮把 enabled 设置回写主窗口真源。 */
  setPetEnabled?(enabled: boolean): void;
  /** 主窗口订阅 overlay 发起的 enabled 设置变化。 */
  onPetEnabledChange?(cb: (enabled: boolean) => void): () => void;
  /** overlay 右下角缩放手柄把最终尺寸回写主窗口真源(overlay 的 localStorage 与主窗口
   * 不同源,落盘只能由主窗口做;不回写则下一次状态广播会带旧 size 把宠物顶回原大小)。 */
  setPetSize?(size: number): void;
  /** 主窗口订阅 overlay 发起的 size 设置变化。 */
  onPetSizeChange?(cb: (size: number) => void): () => void;
  /** 订阅主进程广播的宠物状态快照(overlay 窗口用)。返回退订函数。 */
  onPetSyncState?(cb: (snapshot: PetStateSnapshot) => void): () => void;
  /** 订阅主进程轮询推来的光标位置(overlay 窗口内 CSS 坐标,null=光标不在窗口内)。
   * overlay 是 focusable:false 的 panel 且整块 app-region:drag,收不到鼠标移动事件,
   * 悬停态只能这么算(详见 apps/desktop/src/main/pet-overlay-window.ts 的注释)。 */
  onPetOverlayCursor?(cb: (point: { x: number; y: number } | null) => void): () => void;
  /** 订阅主进程从窗口 moved 事件里看出来的拖动方向(null=没在动)。原生 app-region 拖拽
   * 不经渲染进程,方向只有主进程看得见;宠物据此播朝向对应的奔跑帧。 */
  onPetOverlayMoveDir?(cb: (dir: "left" | "right" | null) => void): () => void;

  // ── 语音助手(语音球,与宠物共用 pet-overlay 窗口互斥显示)──────────────────
  // 架构与宠物同构:录音/VAD/STT/发送(usePersonalActions().send,带全部能力注入)/TTS
  // 全在主窗口的 headless 控制器(views/personal/voice-assistant/VoiceAssistantController);
  // overlay 只镜像快照渲染语音球并把点击发回。IPC 域 voiceAssistant:*,契约见
  // apps/desktop/src/main/ipc/voice-assistant.ts。整段可选:Web 端 undefined 整体降级。
  /** 激活语音助手：pet-overlay 窗口切 voice 模式(宠物隐藏、窗口变大并强制显示)。 */
  voiceAssistantActivate?(reason: "hotkey" | "pet" | "settings"): Promise<void>;
  /** 退出语音助手：窗口切回 pet 模式,按宠物 enabled 决定显隐。 */
  voiceAssistantDeactivate?(): Promise<void>;
  /** 唤醒词运行状态(设置页展示;识别在独立 kws 隐藏窗口,IPC 域 wakeWord:*)。 */
  wakeWordGetStatus?(): Promise<{ running: boolean; state: string; micPermission: string }>;
  /** 应用唤醒词设置(开 → 拉起常驻 kws 窗口;关 → 销毁)。持久化仍走 voiceSettings。 */
  wakeWordConfigure?(settings: WakeWordSettings): Promise<void>;
  /** 理解已纠错转写中的本地控制意图。失败必须返回 continue_chat，原文由控制器继续发送。 */
  understandVoiceAssistantIntent?(text: string): Promise<VoiceAssistantIntentResult>;
  /** 主窗口控制器上报状态快照(主进程缓存并转发 overlay)。 */
  reportVoiceAssistantState?(snapshot: VoiceAssistantSnapshot): void;
  /** 主窗口控制器上报麦克风电平(30Hz 节流,主进程只转发不缓存)。 */
  reportVoiceAssistantLevel?(level: number): void;
  /** 主窗口上报「其它会话 agent 活动」卡片(节流;null = 隐藏),主进程缓存并转发 overlay。 */
  reportVoiceAssistantFeed?(feed: VoiceAssistantFeed | null): void;
  /** overlay 订阅活动卡片更新。 */
  onVoiceAssistantFeed?(cb: (feed: VoiceAssistantFeed | null) => void): () => void;
  /** 主窗口订阅主进程下发的指令(热键/overlay 点击归一为 command)。返回退订函数。 */
  onVoiceAssistantCommand?(cb: (command: VoiceAssistantCommand) => void): () => void;
  /** overlay 语音球发起控制动作(经主进程转发主窗口;exit 同时走 deactivate 流程)。 */
  voiceAssistantControl?(action: VoiceAssistantControlAction): void;
  /** overlay 订阅窗口模式切换(pet↔voice,主进程 setPetOverlayMode 时即刻推送,
   * 不必等控制器快照——切换瞬间就要把 Pet 换成语音球,反之亦然)。返回退订函数。 */
  onVoiceAssistantMode?(cb: (mode: "pet" | "voice") => void): () => void;
  /** overlay 订阅状态快照广播。返回退订函数。 */
  onVoiceAssistantSyncState?(cb: (snapshot: VoiceAssistantSnapshot) => void): () => void;
  /** overlay 订阅电平流。返回退订函数。 */
  onVoiceAssistantLevel?(cb: (level: number) => void): () => void;
  /** overlay 挂载时主动请求一次快照回放(应对「谁先挂载」的时序竞态,同 requestPetSync)。 */
  requestVoiceAssistantSync?(): void;
  /** 截取激活前冻结的前台窗口(屏幕上下文,chatScreenContext 开时随语音轮附图)。
   * 返回临时 PNG 路径(0600 权限,主进程 10 分钟后清理),null=不可用/未授权。 */
  voiceAssistantCaptureScreen?(): Promise<string | null>;

  // ── 公共宠物图鉴(petdex.dev)────────────────────────────────────────────────
  // 整段可选:Web 端为 undefined,图鉴入口据此降级为「渲染端直连」(petdex 的 CORS 全开,
  // 本仓两端也都没有 CSP,直连可行;Web 没有离线诉求,不需要磁盘缓存)。
  // 桌面端一律走主进程:网络只发生在那边(host 白名单 + 8MB 上限 + 20s 超时,
  // 见 apps/desktop/src/main/ipc/petdex-security.ts),渲染端只拿 cortex-petdex:// URL。
  petdex?: {
    /** 拉取图鉴索引(6 小时本地有效期 + 条件请求)。force 跳过有效期强制刷新。 */
    getManifest(opts?: { force?: boolean }): Promise<PetdexManifestResult>;
    /** 确保某只宠物的 sprite 已在本地,必要时下载。 */
    ensureSprite(slug: string): Promise<PetdexSpriteRef>;
    /** 只查本地、绝不联网。启动恢复选中宠物用——开机不该变成一次强制下载。 */
    peekSprite(slug: string): Promise<PetdexSpriteRef | null>;
    cacheStats(): Promise<PetdexCacheStats>;
    clearCache(): Promise<PetdexCacheStats>;
  };

  // ── 深度研究引擎（CRE）────────────────────────────────────────────────────
  // 整段可选：Web 端与旧壳没有它,侧栏入口与整窗覆盖层据此整体降级隐藏(同本文件全可选约定)。
  // 契约与 IPC channel 见 packages/core/desktop/research-bridge.ts 头部注释;
  // 实现在 apps/desktop/src/preload/research-bridge.ts,挂在 window.desktopAPI.personal.research。
  research?: CortexResearchBridge;

  // ── 公司知识库（远端 MCP server）────────────────────────────────────────────
  // 整段可选：Web 端与旧壳没有它,设置区据此整体降级隐藏(同本文件全可选约定)。
  // 实现在 apps/desktop/src/preload/index.ts,挂在 window.desktopAPI.personal.knowledge。
  //
  // **凭据方向是单向的**：明文令牌只经 setCredential 从 renderer 流向 main（立即 safeStorage
  // 加密落盘）,反向只回 { enabled, baseUrl, hasToken },本桥不提供任何读回明文的方法。
  knowledge?: {
    /** 保存连接配置。token 省略 = 保留已存令牌（用户只改地址时不必重填）。 */
    setCredential(input: {
      enabled: boolean;
      baseUrl: string;
      token?: string;
    }): Promise<KnowledgeBaseSettings>;
    /** 清除已保存的令牌（保留地址与开关）。 */
    clearCredential(): Promise<KnowledgeBaseSettings>;
    /**
     * 连通性自检：按 MCP 协议真跑 initialize + tools/list,回成败、一句人话与工具名清单。
     *
     * `roles` 是「服务端工具名 → 语义角色(search/read/list/ask/write)」的映射结果。
     * UI 判断读写能力**只看它**,不再按固定工具名去猜——接第三方知识库时工具叫什么
     * 由对方决定,写死 kb_write_doc 会把一枚可写令牌永远显示成只读。
     */
    test(): Promise<{
      ok: boolean;
      message: string;
      tools?: string[];
      roles?: { search?: string; read?: string; list?: string; ask?: string; write?: string };
    }>;
    /**
     * 取一篇知识库文档的正文（会话里点开引用时预览）。
     *
     * 走主进程自己的 MCP 通道,**与 agent 会话无关**——用户点一下引用不该触发一次 agent 回合。
     */
    readDoc(input: { sourceId: string; relPath: string }): Promise<KnowledgeDocResult>;
  };

  // ── Computer Use（pi 操作真实桌面 GUI）─────────────────────────────────────────
  // 整段可选：Web 端与非 mac 没有它,设置区据此整体降级隐藏(同本文件全可选约定)。
  // 实现在 apps/desktop/src/preload/index.ts,挂在 window.desktopAPI.personal.computerUse。
  //
  // 这里只有「问状态」和「装一次」——总开关与定位模型是普通设置项,走 generalSettings 持久化,
  // 不占桥的方法。状态必须问主进程:五门控里 swiftc / 两项 TCC 授权 / 落盘 marker 都是 renderer
  // 拿不到的信息。
  computerUse?: {
    /** 环境自检。ready = 此刻真会给 Agent 注入 gui_* 工具;false 时 reason 指明缺什么。 */
    status(): Promise<ComputerUseStatus>;
    /** 手动重试预装（首启联网失败或用户删了包）。自带在途去重,连点只跑一次;回最新状态。 */
    install(): Promise<ComputerUseStatus>;
    /**
     * 重新申请一项系统授权:清掉 TCC 的「已提示过」记录 → 重新弹系统提示 → 打开设置面板。
     *
     * 存在的理由:macOS 每个应用只弹一次授权提示,用户忽略后本应用就再也不会自动出现在
     * 「隐私与安全性」列表里,只开面板会看到空列表、无从下手。回最新状态。
     *
     * ⚠️ 会重置本应用该项授权记录,故调用方应仅在未授权时提供入口并先让用户确认。
     */
    repromptPermission(kind: ComputerUsePermissionKind): Promise<ComputerUseStatus>;
    /** 在 Finder 中显示当前运行的 .app,供用户直接拖进授权列表（reset 不奏效时的兜底）。 */
    revealApp(): Promise<void>;
  };

  // ── 团队工作区应用内登录态（W1）───────────────────────────────────────────────
  // 邮箱验证码登录成功后，壳把完整配置持久化（token 经主进程 safeStorage 加密落盘）；冷启动读回
  // 填充 runtime 配置 → 动态启用真实后端 ApiClient。全部可选（web/旧壳无 → 登录入口降级隐藏，
  // 仅走 env 注入的向后兼容路径）。跨进程契约：IPC 通道 auth:get-config / auth:set-config /
  // auth:clear-config，与 apps/desktop/src/main/ipc/auth-config.ts + preload 三处手工对齐。
  /** 读回持久化登录配置（无配置/解密失败 token → null 或 token 缺失）。 */
  authGetConfig?(): Promise<AuthConfig | null>;
  /** 全量覆盖写入登录配置（登录成功）。 */
  authSetConfig?(cfg: AuthConfig): Promise<void>;
  /** 清除登录配置（登出）。 */
  authClearConfig?(): Promise<void>;
  imListChannels?(): Promise<ImChannel[]>;
  imUpsertChannel?(channel: ImChannelInput): Promise<ImChannel>;
  imDeleteChannel?(id: string): Promise<boolean>;
  imListPlatformSpecs?(): Promise<ImPlatformSpec[]>;
  imListStatuses?(): Promise<ImChannelStatus[]>;
  imWechatQrCode?(): Promise<ImWechatQrCode>;
  imWechatQrStatus?(qrcode: string): Promise<ImWechatLogin>;
}

// 团队工作区登录态（W1）：应用内邮箱验证码登录后持久化的配置。token 为 JWT 明文，仅在
// IPC 边界与内存出现；主进程 safeStorage 加密后落盘（其余明文字段直接落盘）。
// 见 apps/desktop/src/main/ipc/auth-config.ts。
export interface AuthConfig {
  baseUrl: string;
  workspaceId?: string;
  workspaceSlug?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  token?: string;
}
