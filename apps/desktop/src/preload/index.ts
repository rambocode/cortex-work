import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
// Provider Catalog / 认证 / Gateway 的跨进程契约（通道名常量 + 类型）。通道名一律走
// PROVIDER_IPC，不再手写字符串——两侧写歪会表现为「invoke 永远挂起且无报错」。
import { PROVIDER_IPC } from "../main/providers/contract";
import type {
  CustomProviderDefinition,
  CustomProviderValidation,
  GatewayCompleteRequest,
  GatewayCompleteResult,
  GatewayStreamEvent,
  ProviderAuthEvent,
  ProviderAuthSnapshot,
  ProviderCatalogResult,
  ProviderConnectionTestResult,
} from "../main/providers/contract";
import type {
  AgentKind,
  ConversationArtifactCreateRequest,
  ConversationArtifactRef,
  ConversationArtifactResult,
  AgentTraceEvent,
  AgentSessionRequest,
  AgentProjectInfo,
  AskFollowupRequest,
  AsrTranscribeRequest,
  AsrTranscribeResponse,
  AsrSettings,
  AutomationInput,
  AutomationMeta,
  AutomationRun,
  AutomationRunEvent,
  CliExitEvent,
  CliStartRequest,
  CliStreamEvent,
  ContentSearchResult,
  DerivedAgentMeta,
  RoleConfig,
  CronValidation,
  DocSaveRequest,
  DocSaveResult,
  EditorInfo,
  ImageReadResult,
  ImageSaveRequest,
  ImageSaveResult,
  GitBranchesResult,
  GitDiffAllResult,
  GitInfoResult,
  GitOpResult,
  NoteInput,
  NoteMeta,
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
  NoteStatus,
  PersistedState,
  PushSettings,
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
  ReadFileResult,
  ReadFileBinaryResult,
  StatFileResult,
  WriteFileBinaryResult,
  WritingSaveImagePayload,
  SkillMeta,
  SpotlightIntent,
  TaskDelegateIntent,
  TtsListVoicesRequest,
  TtsSynthesizeRequest,
  TaskFilesResult,
  TrimSessionRequest,
  TtsStreamEvent,
  TtsVoiceOption,
  UpdateState,
  NotificationPayload,
  WorkflowDef,
  WorkflowRun,
  WorkflowRunEvent,
  ChannelId,
  ReplyPermissionKind,
  ReplyPermissionState,
  ReplyChannelVerifyResult,
  ReplyDataSummary,
  ReplyDebugEntry,
  ReplyRelearnResult,
  ReplySyncSnapshot,
  MemoryScope,
  MemoryFile,
  MemoryState,
  ReplyBubbleState,
  ReplyBubbleAction,
  ReplyBubbleVoiceCommand,
  ReplyBubbleVoiceResult,
  PetStateSnapshot,
  AgentBrowserRuntimeStatus,
  ComputerUsePermissionKind,
  ComputerUseStatus,
  KnowledgeBaseSettings,
  KnowledgeDocResult,
} from "../main/ipc/types";
// 方案 A：编排请求类型权威定义留在 orchestrate.ts，此处 type-only 引入（编译期擦除，
// 不引入主进程运行时依赖）。详见 .llms 交接文档 4.4 与 bridge.ts 的 startOrchestration 契约。
import type { OrchestrateStartRequest } from "../main/ipc/orchestrate";
import type { RoundtableStartRequest } from "../main/ipc/types";
// 写作检索(U4）IPC 契约类型(type-only,编译期擦除;与 core/desktop/writing-retrieval-types.ts 镜像）。
import type {
  WritingRetrievalRequest,
  WritingRetrievalResult,
} from "../main/ipc/writing-retrieval-types";
// 写作信息图(U7）IPC 契约类型(type-only,编译期擦除;与 core/desktop/writing-infographic-types.ts 镜像）。
import type {
  WritingInfographicRequest,
  WritingInfographicResult,
} from "../main/ipc/writing-infographic-types";
// 写作重型导出(U6）IPC 契约类型(type-only,编译期擦除;与 core/desktop/writing-export-types.ts 镜像）。
import type {
  WritingExportRequest,
  WritingExportResult,
  WritingCopyRichTextRequest,
  WritingCopyRichTextResult,
} from "../main/ipc/writing-export-types";
// 写作 LLM(U3,续写 + Cmd-K 改写）IPC 契约类型(type-only,编译期擦除;与 core/desktop/writing-llm-types.ts 镜像）。
import type {
  WritingCompletionRequest,
  WritingCompletionResult,
  WritingDebugLogEntry,
  WritingInlineEditRequest,
  WritingInlineEditResult,
  WritingLlmStatus,
} from "../main/ipc/writing-llm-types";
// 写作 PDF 阅读(U5）IPC 契约类型(type-only,编译期擦除;与 core/desktop/writing-pdf-types.ts 镜像）。
import type {
  WritingPdfDataRequest,
  WritingPdfDataResult,
} from "../main/ipc/writing-pdf-types";
// AI Slides IPC 契约类型(type-only,编译期擦除;与 core/desktop/slides-ipc-types.ts 镜像)。
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
} from "../main/ipc/slides-ipc-types";
import type {
  LocalWhisperModelProgress,
  LocalWhisperModelStatus,
  LocalWhisperSourcesResult,
} from "@cortex-work/core/whisper/models";
import type { Locale } from "@cortex-work/core/i18n/native";
// 用户记忆（跨工作台持久记忆）IPC 契约类型(type-only,编译期擦除;类型真源在 core/memory/memory.ts,
// main 侧 ipc/memory.ts 同样直接引用 core,无需再建镜像)。
import type {
  DreamStateSummary,
  MemoryDreamResult,
  UserMemoryFile,
  UserMemoryScope,
  UserMemoryState,
} from "@cortex-work/core/memory/memory";
// 深度研究（CRE）子桥：8 个 research:* channel + research:event 事件流,单独成文件（见其头部注释）。
import { createResearchBridge } from "./research-bridge";

interface AppInfo {
  version: string;
  os: "macos" | "windows" | "linux" | "unknown";
  devMode?: boolean;
}

interface RuntimeConfig {
  apiUrl?: string;
  authToken?: string;
  workspaceId?: string;
  workspaceSlug?: string;
}

function fetchAppInfo(): AppInfo {
  try {
    const info = ipcRenderer.sendSync("app:get-info") as AppInfo | undefined;
    if (info && typeof info.version === "string") return info;
  } catch {
    // fall through
  }
  return { version: "0.0.0", os: "unknown" };
}

// 个人工作区能力桥。形状与 packages/core/desktop/bridge.ts 的 DesktopBridge
// 一一对应（renderer 侧直接作为 bridge 注入 CoreProvider）。
const personal = {
  appInfo: fetchAppInfo(),
  agentBrowserStatus: (): Promise<AgentBrowserRuntimeStatus> => ipcRenderer.invoke("agent-browser:status"),
  agentBrowserRetry: (): Promise<AgentBrowserRuntimeStatus> => ipcRenderer.invoke("agent-browser:retry"),
  onAgentBrowserStatus: (cb: (status: AgentBrowserRuntimeStatus) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, status: AgentBrowserRuntimeStatus) => cb(status);
    ipcRenderer.on("agent-browser:status", listener);
    return () => ipcRenderer.removeListener("agent-browser:status", listener);
  },
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("fs:pickDirectory"),
  scanPromptTree: (root: string): Promise<PromptNode> => ipcRenderer.invoke("fs:scanPromptTree", root),
  scanDirTree: (root: string): Promise<PromptNode> => ipcRenderer.invoke("fs:scanDirTree", root),
  // 内容搜索（右侧「文件」视图 ? 前缀）:逐行子串匹配,返回命中文件 + 命中行。
  searchContent: (root: string, query: string): Promise<ContentSearchResult> =>
    ipcRenderer.invoke("fs:searchContent", root, query),
  gitChanges: (root: string): Promise<{ isRepo: boolean; files: { path: string; rel: string; status: string }[] }> =>
    ipcRenderer.invoke("fs:gitChanges", root),
  gitDiff: (root: string, rel: string): Promise<string> => ipcRenderer.invoke("fs:gitDiff", root, rel),
  // GitBar:分支 + ± 统计 / 整仓 diff
  gitInfo: (root: string): Promise<GitInfoResult> => ipcRenderer.invoke("fs:gitInfo", root),
  gitDiffAll: (root: string): Promise<GitDiffAllResult> => ipcRenderer.invoke("fs:gitDiffAll", root),
  // 无项目会话工作目录:确保 Documents/cortex/<日期> 存在,返回绝对路径
  ensureNoProjectDir: (dayKey: string): Promise<string> => ipcRenderer.invoke("fs:ensureNoProjectDir", dayKey),
  // GitBar 分支:列表 / 新建 / 切换
  gitBranches: (root: string): Promise<GitBranchesResult> => ipcRenderer.invoke("fs:gitBranches", root),
  gitCreateBranch: (root: string, name: string): Promise<GitOpResult> =>
    ipcRenderer.invoke("fs:gitCreateBranch", root, name),
  gitCheckout: (root: string, name: string): Promise<GitOpResult> => ipcRenderer.invoke("fs:gitCheckout", root, name),
  readFile: (path: string): Promise<ReadFileResult> => ipcRenderer.invoke("fs:readFile", path),
  // 表格文件二进制通道(内置表格预览/编辑):base64 传输,读超限降级、写带首次备份+原子替换。
  readFileBinary: (path: string): Promise<ReadFileBinaryResult> => ipcRenderer.invoke("fs:readFileBinary", path),
  writeFileBinary: (path: string, dataBase64: string, opts?: { backup?: boolean }): Promise<WriteFileBinaryResult> =>
    ipcRenderer.invoke("fs:writeFileBinary", path, dataBase64, opts),
  // 轻量 stat:外部变更检测(watch 信号后比对 mtime)。
  statFile: (path: string): Promise<StatFileResult> => ipcRenderer.invoke("fs:statFile", path),
  // 会话文件链接定位:ref(相对/裸文件名)→ 项目内真实绝对路径,找不到/越权 → null（不抛错）。
  resolveProjectFile: (root: string, ref: string): Promise<string | null> =>
    ipcRenderer.invoke("fs:resolveProjectFile", root, ref),
  writeFile: (path: string, content: string): Promise<void> => ipcRenderer.invoke("fs:writeFile", path, content),
  deleteFile: (path: string): Promise<void> => ipcRenderer.invoke("fs:deleteFile", path),
  // 设计工作台:建目录 / 递归删除条目 / 默认设计根(与 DesktopBridge 同名方法对齐)。
  mkdir: (path: string): Promise<void> => ipcRenderer.invoke("fs:mkdir", path),
  deleteEntry: (path: string): Promise<void> => ipcRenderer.invoke("fs:deleteEntry", path),
  designWorkspaceRoot: (): Promise<string> => ipcRenderer.invoke("fs:designWorkspaceRoot"),
  // 无项目会话归档根(Documents/cortex,调用即建目录):右栏「文件」无项目会话时的回退根。
  documentsCortexRoot: (): Promise<string> => ipcRenderer.invoke("fs:documentsCortexRoot"),
  // 写作工作区:默认根(确保存在)/ 重命名条目(同目录重名预检,不覆盖)。
  writingWorkspaceRoot: (): Promise<string> => ipcRenderer.invoke("fs:writingWorkspaceRoot"),
  // 写作粘贴/生成图片落盘(U1):返回落盘绝对路径,渲染端换算相对链接。
  writingSaveImage: (payload: WritingSaveImagePayload): Promise<string> =>
    ipcRenderer.invoke("fs:writingSaveImage", payload),
  renameEntry: (from: string, to: string): Promise<void> => ipcRenderer.invoke("fs:renameEntry", from, to),
  // ── 写作检索(U4，工作区级轻量 RAG）─────────────────────────────────────
  // writingRetrieve：按空间根查询 top-k 片段(主进程按 root 维护内存索引);
  // writingRetrievalInvalidate：watch dirChanged 时失效索引,下次检索重建(fire-and-forget)。
  writingRetrieve: (req: WritingRetrievalRequest): Promise<WritingRetrievalResult> =>
    ipcRenderer.invoke("writing:retrieve", req),
  writingRetrievalInvalidate: (root: string): void =>
    ipcRenderer.send("writing:retrievalInvalidate", root),
  // ── 写作信息图(U7，对接 media-gen）─────────────────────────────────────
  // writingInfographic：选区文本 → 生成 PNG → 落 <spaceRoot>/img/,返回落盘绝对路径(渲染端换算相对链接);
  // writingInfographicAvailable：media-gen 图片模态是否已配置,未配置渲染端隐藏入口。
  writingInfographic: (req: WritingInfographicRequest): Promise<WritingInfographicResult> =>
    ipcRenderer.invoke("writing:infographic", req),
  writingInfographicAvailable: (): Promise<boolean> => ipcRenderer.invoke("writing:infographicAvailable"),
  // ── 写作重型导出(U6，DOCX/PDF/PNG/HTML/复制富文本）───────────────────────
  // writingExport：当前文档 → 主进程同源渲染 → 弹保存框落盘(取消/失败回结构化结果,不抛);
  // writingCopyRichText：把文档渲染成富文本写入系统剪贴板(html + text 双写)。
  writingExport: (req: WritingExportRequest): Promise<WritingExportResult> =>
    ipcRenderer.invoke("writing:export", req),
  writingCopyRichText: (req: WritingCopyRichTextRequest): Promise<WritingCopyRichTextResult> =>
    ipcRenderer.invoke("writing:copyRichText", req),
  // ── 写作 LLM(U3,ghost text 续写 + Cmd-K 就地改写）─────────────────────────
  // writingLlmStatus：探测配置态(未配置渲染端隐藏入口);writingComplete：续写;writingInlineEdit：改写。
  writingLlmStatus: (): Promise<WritingLlmStatus> => ipcRenderer.invoke("writing:llmStatus"),
  writingComplete: (req: WritingCompletionRequest): Promise<WritingCompletionResult> =>
    ipcRenderer.invoke("writing:complete", req),
  writingInlineEdit: (req: WritingInlineEditRequest): Promise<WritingInlineEditResult> =>
    ipcRenderer.invoke("writing:edit", req),
  // 写作日志:查看最近续写/改写调用 / 清空(设置里排障)。
  writingDebugLog: (): Promise<WritingDebugLogEntry[]> => ipcRenderer.invoke("writing:debugLog"),
  writingDebugLogClear: (): Promise<void> => ipcRenderer.invoke("writing:debugLogClear"),
  // ── 写作 PDF 阅读(U5）──────────────────────────────────────────────────
  // writingReadPdf：读 PDF 原始字节(base64)交渲染端 pdfjs 阅读器渲染;失败给结构化 message,不抛。
  writingReadPdf: (req: WritingPdfDataRequest): Promise<WritingPdfDataResult> =>
    ipcRenderer.invoke("writing:pdfData", req),
  // ── AI Slides(deck 持久化 / 提纲 / 编辑保存 / 检查 / 导出)────────────────
  // 窄面契约:只暴露 slides* invoke,不暴露通用 fs/BrowserWindow/debugger;
  // 请求/结果形状见 main/ipc/slides-ipc-types(与 core/desktop/slides-ipc-types 镜像)。
  slidesBentoCreateDeck: (req: BentoCreateDeckRequest): Promise<BentoDeckIpcResult> =>
    ipcRenderer.invoke("slides:bentoCreateDeck", req),
  slidesBentoGetDeck: (req: BentoDeckScopedRequest): Promise<BentoGetDeckResult> =>
    ipcRenderer.invoke("slides:bentoGetDeck", req),
  slidesBentoSetStage: (req: BentoSetStageRequest): Promise<BentoDeckIpcResult> =>
    ipcRenderer.invoke("slides:bentoSetStage", req),
  slidesBentoWriteDeckHtml: (req: BentoWriteDeckHtmlRequest): Promise<BentoDeckIpcResult> =>
    ipcRenderer.invoke("slides:bentoWriteDeckHtml", req),
  slidesBentoExportFile: (req: BentoDeckScopedRequest): Promise<BentoExportFileResult> =>
    ipcRenderer.invoke("slides:bentoExportFile", req),
  slidesPresent: (req: SlidesPresentRequest): Promise<SlidesPresentResult> => ipcRenderer.invoke("slides:present", req),
  // deck 内容变更推送:主进程写盘后广播,舞台据此把新文档热应用进编辑器(见 SlidesStage)。
  // 必须返回退订函数 —— 否则 reload 会累积 listener(MaxListeners 告警)。
  onSlidesDeckChanged: (cb: (event: SlidesDeckChangedEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: SlidesDeckChangedEvent): void => cb(event);
    ipcRenderer.on("slides:deckChanged", listener);
    return () => ipcRenderer.removeListener("slides:deckChanged", listener);
  },
  createTaskFile: (projectRoot: string, todoId: string, title: string): Promise<string> =>
    ipcRenderer.invoke("fs:createTaskFile", projectRoot, todoId, title),
  listTaskFiles: (projectRoot: string): Promise<TaskFilesResult> => ipcRenderer.invoke("fs:listTaskFiles", projectRoot),
  validateDir: (path: string): Promise<boolean> => ipcRenderer.invoke("fs:validateDir", path),
  fileExists: (path: string): Promise<boolean> => ipcRenderer.invoke("fs:exists", path),
  // 目录实时监听（右栏「文件」视图自动刷新）
  watchDir: (id: string, path: string): Promise<void> => ipcRenderer.invoke("fs:watchDir", { id, path }),
  unwatchDir: (id: string): void => ipcRenderer.send("fs:unwatchDir", { id }),
  onDirChanged: (cb: (id: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { id: string }) => cb(payload.id);
    ipcRenderer.on("fs:dirChanged", listener);
    return () => ipcRenderer.removeListener("fs:dirChanged", listener);
  },
  // 文件预览工具栏:系统打开 / 访达显示
  openPath: (path: string): Promise<void> => ipcRenderer.invoke("shell:openPath", path),
  revealInFolder: (path: string): Promise<void> => ipcRenderer.invoke("shell:revealInFolder", path),
  // Markdown 预览链接:系统默认浏览器打开（主进程校验 http/https）
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("shell:openExternal", url),
  // 内嵌浏览器面板:清除 persist:browser-panel 分区浏览数据
  browserClearData: (): Promise<void> => ipcRenderer.invoke("browser:clearData"),
  // 内嵌浏览器面板:把可视区截图 PNG 字节写入系统剪贴板(主进程校验后 clipboard.writeImage)
  browserCopyImage: (png: Uint8Array): Promise<boolean> => ipcRenderer.invoke("browser:copyImage", png),
  // 授权本地 HTML 路径 → 可内嵌预览的 file:// URL(主进程校验,不合规返回 null)
  browserResolveLocalHtml: (path: string): Promise<string | null> =>
    ipcRenderer.invoke("browser:resolveLocalHtml", path),
  // 项目「Open in」:列出已装编辑器 / 用指定编辑器打开项目目录
  listEditors: (): Promise<EditorInfo[]> => ipcRenderer.invoke("shell:listEditors"),
  openInEditor: (path: string, editorId: string): Promise<void> =>
    ipcRenderer.invoke("shell:openInEditor", path, editorId),
  // 检测 PATH 中已安装的 agent CLI（pi 内置恒可用）
  detectAgents: (): Promise<Record<AgentKind, boolean>> => ipcRenderer.invoke("agents:detect"),
  // M3-A:列出用户 JSON(agents.local.json)派生/覆盖的 agent;reload 改文件后刷新缓存。
  listAgentProfiles: (): Promise<DerivedAgentMeta[]> => ipcRenderer.invoke("agents:profiles"),
  reloadAgentProfiles: (): Promise<DerivedAgentMeta[]> => ipcRenderer.invoke("agents:reloadProfiles"),
  // 圆桌角色库 CRUD + 变更监听（对齐 agent profiles 模式）。
  listRoles: (): Promise<RoleConfig[]> => ipcRenderer.invoke("roles:list"),
  createRole: (payload: { label: string; agent: string; systemPrompt: string; color?: string; avatar?: string }): Promise<RoleConfig> =>
    ipcRenderer.invoke("roles:create", payload),
  updateRole: (id: string, patch: { label?: string; agent?: string; systemPrompt?: string; color?: string; avatar?: string }): Promise<RoleConfig | null> =>
    ipcRenderer.invoke("roles:update", id, patch),
  deleteRole: (id: string): Promise<boolean> => ipcRenderer.invoke("roles:delete", id),
  onRolesChanged: (cb: (roles: RoleConfig[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, roles: RoleConfig[]) => cb(roles);
    ipcRenderer.on("roles:changed", listener);
    return () => ipcRenderer.removeListener("roles:changed", listener);
  },
  loadState: (): Promise<PersistedState> => ipcRenderer.invoke("store:load"),
  saveState: (state: PersistedState): Promise<void> => ipcRenderer.invoke("store:save", state),
  artifactCreate: (
    request: ConversationArtifactCreateRequest,
  ): Promise<ConversationArtifactResult> => ipcRenderer.invoke("artifact:create", request),
  artifactValidate: (
    artifact: ConversationArtifactRef,
  ): Promise<ConversationArtifactResult> => ipcRenderer.invoke("artifact:validate", artifact),
  // pushSettings 窄写通道 + 变更订阅：供不挂全量持久化的窗口（项目管理）安全读写推送开关，
  // 变更由 main 广播到所有窗口保持镜像新鲜（见 main/ipc/store.ts）。
  patchPushSettings: (patch: Partial<PushSettings>): Promise<void> =>
    ipcRenderer.invoke("store:patchPushSettings", patch),
  onPushSettingsChanged: (cb: (push: PushSettings) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, push: PushSettings) => cb(push);
    ipcRenderer.on("store:push-settings-changed", listener);
    return () => ipcRenderer.removeListener("store:push-settings-changed", listener);
  },
  // v2(分支回复)兼容:load 可能返回 v1 数组或 v2 对象;save 的 branchGroups 非空时主进程落 v2。
  loadChat: (sessionId: string): Promise<unknown> => ipcRenderer.invoke("chat:load", sessionId),
  saveChat: (sessionId: string, messages: unknown[], branchGroups?: unknown[]): Promise<void> =>
    ipcRenderer.invoke("chat:save", sessionId, messages, branchGroups),
  deleteChat: (sessionId: string): Promise<void> => ipcRenderer.invoke("chat:delete", sessionId),
  // 聊天图片上传:落盘(二进制 ArrayBuffer 直传)/ 回读为 dataURL(缩略图)。
  imageSave: (req: ImageSaveRequest): Promise<ImageSaveResult> => ipcRenderer.invoke("image:save", req),
  imageRead: (path: string): Promise<ImageReadResult> => ipcRenderer.invoke("image:read", path),
  // agent 产出图片回读为 dataURL(聊天内联渲染);读侧走 assertOpenable 宽松语义 + 硬防护(见 fs.ts)。
  imageReadAny: (path: string): Promise<ImageReadResult> => ipcRenderer.invoke("image:readAny", path),
  // 聊天文档附件落盘(优先 srcPath 路径直拷,避免 50MB ArrayBuffer 过 IPC)。
  docSave: (req: DocSaveRequest): Promise<DocSaveResult> => ipcRenderer.invoke("doc:save", req),
  loadTimeline: (projectId: string): Promise<unknown> => ipcRenderer.invoke("timeline:load", projectId),
  saveTimeline: (projectId: string, data: unknown): Promise<void> =>
    ipcRenderer.invoke("timeline:save", projectId, data),
  gitLog: (
    root: string,
    opts?: { sinceTs?: number; max?: number },
  ): Promise<{ ts: number; hash: string; subject: string }[]> => ipcRenderer.invoke("fs:gitLog", root, opts),
  startCli: (req: CliStartRequest): Promise<void> => ipcRenderer.invoke("cli:start", req),
  oneshotCli: (req: {
    agent?: AgentKind;
    cwd?: string;
    prompt: string;
    model?: string;
    provider?: { id: string; baseUrl: string; apiKey?: string; models: { id: string; name?: string }[] };
  }): Promise<string> => ipcRenderer.invoke("cli:oneshot", req),
  openaiComplete: (req: { baseUrl: string; apiKey?: string; model: string; prompt: string }): Promise<string> =>
    ipcRenderer.invoke("llm:openaiComplete", req),
  probeProvider: (input: {
    baseUrl: string;
    apiKey?: string;
    endpointFormat: "chat_completions" | "responses" | "messages" | "custom";
  }): Promise<{ ok: boolean; models?: string[]; error?: string }> =>
    ipcRenderer.invoke("provider:probe", input),

  // ── Provider Catalog / 认证 / Model Gateway（跨进程契约见 main/providers/contract.ts）──
  // Catalog 只读、不含秘密；认证只回 configured/type/source/error，明文与密文永不过桥；
  // Gateway 是全仓文本补全的唯一出口（业务模块不得再自行拼 Provider URL）。
  providerCatalogGet: (): Promise<ProviderCatalogResult> => ipcRenderer.invoke(PROVIDER_IPC.catalogGet),
  providerAuthStatus: (): Promise<ProviderAuthSnapshot> => ipcRenderer.invoke(PROVIDER_IPC.authStatus),
  providerAuthLogin: (providerId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(PROVIDER_IPC.authLogin, providerId),
  // requestId 对回具体那一问（OAuth 可能连续多问：登录方式 → 回调码）。
  providerAuthRespond: (requestId: string, value: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(PROVIDER_IPC.authRespond, requestId, value),
  providerAuthCancel: (providerId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(PROVIDER_IPC.authCancel, providerId),
  providerAuthLogout: (providerId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(PROVIDER_IPC.authLogout, providerId),
  // 明文 key 只在这一次调用里过桥进主进程加密落盘，之后 renderer 再也读不回来。
  providerAuthSetApiKey: (providerId: string, apiKey: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(PROVIDER_IPC.authSetApiKey, providerId, apiKey),
  providerAuthSetSecrets: (secrets: Record<string, string>): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(PROVIDER_IPC.authSetSecrets, secrets),
  // 用户级「隐藏 Provider」偏好，与认证解耦：防止 shell 里的 ambient key 让选择器涌入几十个 Provider。
  providerAuthSetHidden: (providerIds: string[]): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(PROVIDER_IPC.authSetHidden, providerIds),
  onProviderAuthEvent: (cb: (event: ProviderAuthEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: ProviderAuthEvent) => cb(event);
    ipcRenderer.on(PROVIDER_IPC.authEvent, listener);
    return () => ipcRenderer.removeListener(PROVIDER_IPC.authEvent, listener);
  },
  // 显式连接测试：真发一次最小请求，可能产生少量费用 —— UI 调用前必须提示。
  providerConnectionTest: (providerId: string, modelId?: string): Promise<ProviderConnectionTestResult> =>
    ipcRenderer.invoke(PROVIDER_IPC.connectionTest, providerId, modelId),
  providerCustomList: (): Promise<CustomProviderDefinition[]> => ipcRenderer.invoke(PROVIDER_IPC.customList),
  providerCustomSave: (def: CustomProviderDefinition): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(PROVIDER_IPC.customSave, def),
  providerCustomDelete: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(PROVIDER_IPC.customDelete, id),
  providerCustomValidate: (json: string): Promise<CustomProviderValidation> =>
    ipcRenderer.invoke(PROVIDER_IPC.customValidate, json),
  modelGatewayComplete: (req: GatewayCompleteRequest): Promise<GatewayCompleteResult> =>
    ipcRenderer.invoke(PROVIDER_IPC.gatewayComplete, req),
  // 流式：invoke 只负责发起，事件经 onModelGatewayEvent 按 requestId 分发。
  modelGatewayStream: (req: GatewayCompleteRequest): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(PROVIDER_IPC.gatewayStream, req),
  modelGatewayAbort: (requestId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(PROVIDER_IPC.gatewayAbort, requestId),
  onModelGatewayEvent: (cb: (requestId: string, event: GatewayStreamEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, requestId: string, event: GatewayStreamEvent) => cb(requestId, event);
    ipcRenderer.on(PROVIDER_IPC.gatewayEvent, listener);
    return () => ipcRenderer.removeListener(PROVIDER_IPC.gatewayEvent, listener);
  },
  setDesktopBehavior: (behavior: {
    openAtLogin: boolean;
    startMinimized: boolean;
    closeToTray: boolean;
  }): Promise<void> => ipcRenderer.invoke("desktop:setBehavior", behavior),
  // 渲染端切主题 → 主进程同步 nativeTheme.themeSource(vibrancy 材质/次级窗口外观跟随应用主题)。
  setTheme: (mode: "system" | "light" | "dark"): Promise<void> => ipcRenderer.invoke("app:setTheme", mode),
  // 渲染端切语言 → 主进程广播 + 重建托盘菜单（原生 chrome 镜像主窗口 i18next）。
  setLocale: (locale: Locale): Promise<void> => ipcRenderer.invoke("app:setLocale", locale),
  // 订阅主进程 locale 广播（次级窗口据此同步语言）。
  onLocaleChange: (cb: (locale: Locale) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, locale: Locale) => cb(locale);
    ipcRenderer.on("app:locale", listener);
    return () => ipcRenderer.removeListener("app:locale", listener);
  },
  openLogsDir: (): Promise<void> => ipcRenderer.invoke("logs:open"),
  setLogEnabled: (on: boolean): Promise<void> => ipcRenderer.invoke("logs:setEnabled", on),
  // 渲染端把不落盘的 agent 报错、核心路径埋点写入主进程文件日志（脱敏由主进程负责）。
  // 级别放宽到 debug|info|warn|error；主进程 logLine 已按 level 路由（非法回退 info）。
  logMessage: (level: "debug" | "info" | "warn" | "error", message: string): Promise<void> =>
    ipcRenderer.invoke("logs:write", level, message),
  // 改闪记全局热键:把主进程返回的 HotkeyRegistration 适配成 bridge 契约的 { ok, toast }。
  // ok = registered && !degraded(注册成功且未降级才算生效)。
  setNotesHotkey: async (acc: string): Promise<{ ok: boolean; toast?: string }> => {
    const r = (await ipcRenderer.invoke("notes:setHotkey", acc)) as {
      registered: boolean;
      degraded: boolean;
      toast?: string;
    };
    return { ok: r.registered && !r.degraded, toast: r.toast };
  },
  pushReport: (target: unknown, payload: { subject: string; text: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("push:report", target, payload),
  ttsSynthesize: (req: TtsSynthesizeRequest): Promise<ArrayBuffer> => ipcRenderer.invoke("tts:synthesize", req),
  ttsSynthesizeStream: async (req: TtsSynthesizeRequest, cb: (event: TtsStreamEvent) => void): Promise<void> => {
    const streamId = crypto.randomUUID();
    const listener = (_e: IpcRendererEvent, payload: { streamId: string; event: TtsStreamEvent }) => {
      if (payload.streamId === streamId) cb(payload.event);
    };
    ipcRenderer.on("tts:stream", listener);
    try {
      await ipcRenderer.invoke("tts:synthesizeStream", { ...req, streamId });
    } finally {
      ipcRenderer.removeListener("tts:stream", listener);
    }
  },
  listTtsVoices: (req: TtsListVoicesRequest): Promise<TtsVoiceOption[]> => ipcRenderer.invoke("tts:listVoices", req),
  asrTranscribe: (req: AsrTranscribeRequest): Promise<AsrTranscribeResponse> => ipcRenderer.invoke("asr:transcribe", req),
  killCli: (runId: string): Promise<void> => ipcRenderer.invoke("cli:kill", runId),
  // 三段编排接入：start 走 invoke（等结果）；kill 走 send（fire-and-forget，对齐主进程
  // ipcMain.on("orchestrate:kill")）。事件流复用 onCliEvent/onCliExit（runId=orchestrationRunId）。
  startOrchestration: (req: OrchestrateStartRequest): Promise<void> =>
    ipcRenderer.invoke("orchestrate:start", req),
  killOrchestration: (runId: string): Promise<void> => {
    ipcRenderer.send("orchestrate:kill", runId);
    return Promise.resolve();
  },
  // 圆桌多角色编排（@mention 触发）。事件流复用 onCliEvent/onCliExit（roleId 区分角色）。
  startRoundtable: (req: RoundtableStartRequest): Promise<void> =>
    ipcRenderer.invoke("roundtable:start", req),
  killRoundtable: (runId: string): Promise<void> => {
    ipcRenderer.send("roundtable:kill", runId);
    return Promise.resolve();
  },
  agentSessionExists: (req: AgentSessionRequest): Promise<boolean> =>
    ipcRenderer.invoke("cli:agentSessionExists", req),
  trimAgentSession: (req: TrimSessionRequest): Promise<boolean> => ipcRenderer.invoke("cli:trimSession", req),
  // 分支重新生成:复制会话记忆为新 id 并截断副本(源文件保留,旧分支可续聊)。
  trimSessionIntoCopy: (req: TrimSessionRequest): Promise<{ newSessionId: string } | null> =>
    ipcRenderer.invoke("cli:trimSessionIntoCopy", req),
  onCliEvent: (cb: (runId: string, event: CliStreamEvent, sessionId?: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { runId: string; sessionId?: string; event: CliStreamEvent }) =>
      cb(payload.runId, payload.event, payload.sessionId);
    ipcRenderer.on("cli:event", listener);
    return () => ipcRenderer.removeListener("cli:event", listener);
  },
  onCliExit: (cb: (exit: CliExitEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, exit: CliExitEvent) => cb(exit);
    ipcRenderer.on("cli:exit", listener);
    return () => ipcRenderer.removeListener("cli:exit", listener);
  },
  // ws 传输心跳(U5):codex app-server 长 MCP 工具静默期,主进程定期推此事件让渲染端重置
  // 300s 静默看门狗(否则长工具会被误判超时)。仅活跃信号,不携带内容。
  onCliKeepalive: (cb: (runId: string, sessionId?: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { runId: string; sessionId?: string }) =>
      cb(payload.runId, payload.sessionId);
    ipcRenderer.on("cli:keepalive", listener);
    return () => ipcRenderer.removeListener("cli:keepalive", listener);
  },
  onBrowserOpenPanel: (cb: (url: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, url: string) => cb(url);
    ipcRenderer.on("browser:open-panel", listener);
    return () => ipcRenderer.removeListener("browser:open-panel", listener);
  },
  // ── 历史消息追问的临时流式应答（ask:*）。不落盘/不进 run 注册表,关闭浮层即弃。 ────────
  askFollowupStream: (req: AskFollowupRequest): Promise<void> => ipcRenderer.invoke("ask:start", req),
  onAskFollowupEvent: (cb: (askId: string, event: CliStreamEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { askId: string; event: CliStreamEvent }) =>
      cb(payload.askId, payload.event);
    ipcRenderer.on("ask:event", listener);
    return () => ipcRenderer.removeListener("ask:event", listener);
  },
  cancelFollowup: (askId: string): Promise<void> => ipcRenderer.invoke("ask:cancel", askId),
  // ── pi RPC 长驻会话（pi --mode rpc）。claude/codex 仍走上面的 cli 单发通道。 ────────
  // 一个 UI 会话 = 一个长驻 pi 子进程;命令经 invoke,事件流经 onPiEvent。
  piOpen: (req: PiOpenRequest): Promise<PiOpenResult> => ipcRenderer.invoke("pi:open", req),
  piPrompt: (uiSessionId: string, message: string, runId?: string, imagePaths?: string[]): Promise<unknown> =>
    ipcRenderer.invoke("pi:prompt", uiSessionId, message, runId, imagePaths),
  piSteer: (uiSessionId: string, message: string): Promise<unknown> =>
    ipcRenderer.invoke("pi:steer", uiSessionId, message),
  piFollowUp: (uiSessionId: string, message: string): Promise<unknown> =>
    ipcRenderer.invoke("pi:followUp", uiSessionId, message),
  piAbort: (uiSessionId: string): Promise<unknown> => ipcRenderer.invoke("pi:abort", uiSessionId),
  piFork: (uiSessionId: string, entryId: string): Promise<unknown> =>
    ipcRenderer.invoke("pi:fork", uiSessionId, entryId),
  piGetForkMessages: (uiSessionId: string): Promise<unknown> =>
    ipcRenderer.invoke("pi:getForkMessages", uiSessionId),
  piSetModel: (uiSessionId: string, provider: string, modelId: string): Promise<unknown> =>
    ipcRenderer.invoke("pi:setModel", uiSessionId, provider, modelId),
  piSetThinking: (uiSessionId: string, level: string): Promise<unknown> =>
    ipcRenderer.invoke("pi:setThinking", uiSessionId, level),
  piCompact: (uiSessionId: string, customInstructions?: string): Promise<unknown> =>
    ipcRenderer.invoke("pi:compact", uiSessionId, customInstructions),
  piGetState: (uiSessionId: string): Promise<unknown> => ipcRenderer.invoke("pi:getState", uiSessionId),
  piGetStats: (uiSessionId: string): Promise<unknown> => ipcRenderer.invoke("pi:getStats", uiSessionId),
  piSwitchSession: (uiSessionId: string, sessionPath: string): Promise<unknown> =>
    ipcRenderer.invoke("pi:switchSession", uiSessionId, sessionPath),
  // 分支回复:复制当前 pi 会话文件为分支快照(详见 bridge 契约注释)。
  piSnapshotSession: (uiSessionId: string, branchId: string): Promise<{ path: string } | null> =>
    ipcRenderer.invoke("pi:snapshotSession", uiSessionId, branchId),
  piClose: (uiSessionId: string): Promise<void> => ipcRenderer.invoke("pi:close", uiSessionId),
  onPiEvent: (cb: (uiSessionId: string, event: PiSessionEvent, runId?: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { uiSessionId: string; event: PiSessionEvent; runId?: string }) =>
      cb(payload.uiSessionId, payload.event, payload.runId);
    ipcRenderer.on("pi:event", listener);
    return () => ipcRenderer.removeListener("pi:event", listener);
  },
  // extension UI 请求（pi → host,工具确认弹窗等）。订阅 + 回写应答。
  onPiUiRequest: (cb: (uiSessionId: string, request: PiUiRequest) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { uiSessionId: string; request: PiUiRequest }) =>
      cb(payload.uiSessionId, payload.request);
    ipcRenderer.on("pi:uiRequest", listener);
    return () => ipcRenderer.removeListener("pi:uiRequest", listener);
  },
  piUiResponse: (uiSessionId: string, id: string, payload: PiUiResponsePayload): Promise<void> =>
    ipcRenderer.invoke("pi:uiResponse", uiSessionId, id, payload),
  // 内嵌终端（xterm ↔ node-pty）
  ptySpawn: (req: { id: string; cwd?: string; cols: number; rows: number }): Promise<{ ok: boolean; cwd?: string; error?: string }> =>
    ipcRenderer.invoke("pty:spawn", req),
  ptyInput: (id: string, data: string): void => ipcRenderer.send("pty:input", { id, data }),
  ptyResize: (id: string, cols: number, rows: number): void => ipcRenderer.send("pty:resize", { id, cols, rows }),
  ptyKill: (id: string): void => ipcRenderer.send("pty:kill", { id }),
  ptyCwd: (id: string): Promise<string | null> => ipcRenderer.invoke("pty:cwd", { id }),
  scanAgentProjects: (): Promise<AgentProjectInfo[]> => ipcRenderer.invoke("agents:scanProjects"),
  agentTraceList: (): Promise<AgentTraceEvent[]> => ipcRenderer.invoke("agent-trace:list"),
  agentTraceClear: (): Promise<void> => ipcRenderer.invoke("agent-trace:clear"),
  openAgentTraceWindow: (): Promise<void> => ipcRenderer.invoke("agent-trace-window:show"),
  onAgentTrace: (cb: (event: AgentTraceEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: AgentTraceEvent) => cb(event);
    ipcRenderer.send("agent-trace:subscribe");
    ipcRenderer.on("agent-trace:event", listener);
    return () => {
      ipcRenderer.removeListener("agent-trace:event", listener);
      ipcRenderer.send("agent-trace:unsubscribe");
    };
  },
  onPtyData: (cb: (id: string, data: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { id: string; data: string }) => cb(payload.id, payload.data);
    ipcRenderer.on("pty:data", listener);
    return () => ipcRenderer.removeListener("pty:data", listener);
  },
  onPtyExit: (cb: (id: string, exitCode: number) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { id: string; exitCode: number }) =>
      cb(payload.id, payload.exitCode);
    ipcRenderer.on("pty:exit", listener);
    return () => ipcRenderer.removeListener("pty:exit", listener);
  },
  // 应用自动更新（标题栏「更新」按钮）
  updateGetState: (): Promise<UpdateState> => ipcRenderer.invoke("update:getState"),
  updateCheck: (): Promise<UpdateState> => ipcRenderer.invoke("update:check"),
  updateDownload: (): Promise<void> => ipcRenderer.invoke("update:download"),
  updateInstall: (): Promise<void> => ipcRenderer.invoke("update:install"),
  onUpdateState: (cb: (state: UpdateState) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, state: UpdateState) => cb(state);
    ipcRenderer.on("update:state", listener);
    return () => ipcRenderer.removeListener("update:state", listener);
  },
  // 自动化（定时任务）。main 为 owner,这里只是 IPC 透传 + 事件订阅。
  automationList: (): Promise<AutomationMeta[]> => ipcRenderer.invoke("automation:list"),
  automationCreate: (input: AutomationInput): Promise<AutomationMeta> =>
    ipcRenderer.invoke("automation:create", input),
  automationUpdate: (id: string, patch: Partial<AutomationInput>): Promise<AutomationMeta | null> =>
    ipcRenderer.invoke("automation:update", id, patch),
  automationDelete: (id: string): Promise<void> => ipcRenderer.invoke("automation:delete", id),
  automationSetEnabled: (id: string, enabled: boolean): Promise<AutomationMeta | null> =>
    ipcRenderer.invoke("automation:setEnabled", id, enabled),
  automationRunNow: (id: string): Promise<AutomationRun | null> =>
    ipcRenderer.invoke("automation:runNow", id),
  automationListRuns: (id: string): Promise<AutomationRun[]> =>
    ipcRenderer.invoke("automation:listRuns", id),
  automationDeleteRun: (id: string, runId: string): Promise<void> =>
    ipcRenderer.invoke("automation:deleteRun", id, runId),
  automationValidateCron: (expression: string, timezone?: string): Promise<CronValidation> =>
    ipcRenderer.invoke("automation:validateCron", expression, timezone),
  onAutomationChanged: (cb: (list: AutomationMeta[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, list: AutomationMeta[]) => cb(list);
    ipcRenderer.on("automation:changed", listener);
    return () => ipcRenderer.removeListener("automation:changed", listener);
  },
  onAutomationRunEvent: (cb: (event: AutomationRunEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: AutomationRunEvent) => cb(event);
    ipcRenderer.on("automation:run-event", listener);
    return () => ipcRenderer.removeListener("automation:run-event", listener);
  },
  // Spotlight 浮动框 → 主窗口接力:主窗口订阅发起意图 + mount 时 consume 冷启动 pending。
  onSpotlightIntent: (cb: (intent: SpotlightIntent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, intent: SpotlightIntent) => cb(intent);
    ipcRenderer.on("spotlight:intent", listener);
    return () => ipcRenderer.removeListener("spotlight:intent", listener);
  },
  consumeSpotlightIntent: (): Promise<SpotlightIntent | null> => ipcRenderer.invoke("spotlight:consumePending"),
  // 闪记（个人工作区）。main 为 owner,这里只是 IPC 透传 + 变更事件订阅。
  // 形状与 DesktopBridge 的可选 notes* 方法逐字对齐（手工比对,无 satisfies）。
  notesList: (projectId?: string): Promise<NoteMeta[]> => ipcRenderer.invoke("notes:list", projectId),
  notesAdd: (input: NoteInput): Promise<NoteMeta> => ipcRenderer.invoke("notes:add", input),
  notesUpdate: (
    id: string,
    patch: Partial<NoteInput> & { status?: NoteStatus; conversationIds?: string[]; docPaths?: string[] },
  ): Promise<NoteMeta | null> => ipcRenderer.invoke("notes:update", id, patch),
  notesDelete: (id: string): Promise<void> => ipcRenderer.invoke("notes:delete", id),
  onNotesChanged: (cb: (list: NoteMeta[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, list: NoteMeta[]) => cb(list);
    ipcRenderer.on("notes:changed", listener);
    return () => ipcRenderer.removeListener("notes:changed", listener);
  },
  // 真任务系统（个人工作区）。main 为 owner，IPC 透传 + 变更事件订阅。
  // 形状与 DesktopBridge 的可选 tasks* 逐字对齐（手工比对，无 satisfies）。
  tasksList: (projectId?: string): Promise<TaskMeta[]> => ipcRenderer.invoke("tasks:list", projectId),
  tasksListProjects: (): Promise<TaskProject[]> => ipcRenderer.invoke("tasks:listProjects"),
  tasksAdd: (input: TaskInput): Promise<TaskMeta> => ipcRenderer.invoke("tasks:add", input),
  tasksUpdate: (
    id: string,
    patch: Partial<Omit<TaskMeta, "id" | "createdAt">>,
  ): Promise<TaskMeta | null> => ipcRenderer.invoke("tasks:update", id, patch),
  tasksDelete: (id: string): Promise<void> => ipcRenderer.invoke("tasks:delete", id),
  tasksAddProject: (
    name: string,
    opts?: { parentId?: string; kind?: TaskProjectKind; stages?: ProjectStage[]; note?: string; status?: TaskProjectStatus },
  ): Promise<TaskProject> => ipcRenderer.invoke("tasks:addProject", name, opts),
  tasksUpdateProject: (
    id: string,
    patch: {
      name?: string;
      parentId?: string | null;
      mode?: TaskProjectMode;
      note?: string;
      status?: TaskProjectStatus;
      stages?: ProjectStage[];
    },
  ): Promise<TaskProject | null> => ipcRenderer.invoke("tasks:updateProject", id, patch),
  tasksDeleteProject: (projectId: string): Promise<void> => ipcRenderer.invoke("tasks:deleteProject", projectId),
  tasksArchive: (id: string, summary: string): Promise<boolean> => ipcRenderer.invoke("tasks:archive", id, summary),
  tasksListArchived: (): Promise<ArchivedTask[]> => ipcRenderer.invoke("tasks:listArchived"),
  // 团队成员 / 岗位标签 / 阶段模板（项目管理扩展）。形状与 DesktopBridge 的可选方法逐字对齐。
  membersList: (): Promise<Member[]> => ipcRenderer.invoke("tasks:listMembers"),
  membersAdd: (input: { name: string; role?: string }): Promise<Member> =>
    ipcRenderer.invoke("tasks:addMember", input),
  membersUpdate: (id: string, patch: { name?: string; role?: string }): Promise<Member | null> =>
    ipcRenderer.invoke("tasks:updateMember", id, patch),
  membersDelete: (id: string): Promise<void> => ipcRenderer.invoke("tasks:deleteMember", id),
  jobTypesList: (): Promise<string[] | undefined> => ipcRenderer.invoke("tasks:listJobTypes"),
  jobTypesSet: (next: string[]): Promise<string[]> => ipcRenderer.invoke("tasks:setJobTypes", next),
  stageTemplatesList: (): Promise<StageTemplate[]> => ipcRenderer.invoke("tasks:listStageTemplates"),
  stageTemplatesAdd: (input: { name: string; description?: string; stages: string[] }): Promise<StageTemplate> =>
    ipcRenderer.invoke("tasks:addStageTemplate", input),
  stageTemplatesUpdate: (
    id: string,
    patch: { name?: string; description?: string; stages?: string[] },
  ): Promise<StageTemplate | null> => ipcRenderer.invoke("tasks:updateStageTemplate", id, patch),
  stageTemplatesDelete: (id: string): Promise<void> => ipcRenderer.invoke("tasks:deleteStageTemplate", id),
  // 资源变更轻量订阅：main 只发信号不塞快照，renderer invalidate 后重拉。
  onTaskResourcesChanged: (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on("tasks:resources-changed", listener);
    return () => ipcRenderer.removeListener("tasks:resources-changed", listener);
  },
  // 任务附件（U13）：落盘（优先 srcPath 直拷，避免 50MB ArrayBuffer 过 IPC）返回引用 / 按 path 删除。
  taskDocSave: (
    taskId: string,
    file: { name: string; mimeType: string; srcPath?: string; data?: ArrayBuffer },
  ): Promise<TaskAttachment> => ipcRenderer.invoke("task-doc:save", taskId, file),
  taskDocDelete: (taskId: string, path: string): Promise<void> => ipcRenderer.invoke("task-doc:delete", taskId, path),
  onTasksChanged: (cb: (list: TaskMeta[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, list: TaskMeta[]) => cb(list);
    ipcRenderer.on("tasks:changed", listener);
    return () => ipcRenderer.removeListener("tasks:changed", listener);
  },
  // 委派意图跨窗口中继（KTD10）。形状与 DesktopBridge 的 sendTaskDelegateIntent/onTaskDelegateIntent
  // 逐字对齐（手工比对，无 satisfies）。send：项目管理窗口发送；on：主窗口订阅 main 转发的意图。
  sendTaskDelegateIntent: (intent: TaskDelegateIntent): void =>
    ipcRenderer.send("task-delegate:intent", intent),
  onTaskDelegateIntent: (cb: (intent: TaskDelegateIntent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, intent: TaskDelegateIntent) => cb(intent);
    ipcRenderer.on("task-delegate:intent", listener);
    return () => ipcRenderer.removeListener("task-delegate:intent", listener);
  },
  // 冷窗口兜底：主窗口 mount 时 consume main 暂存的委派意图（形状与 DesktopBridge 逐字对齐）。
  consumeTaskDelegateIntent: (): Promise<TaskDelegateIntent | null> =>
    ipcRenderer.invoke("task-delegate:consumePending"),
  // 内置 skill 元数据（深化注入 ce-ideate / 生成 plan 注入 ce-plan）。形状与 DesktopBridge
  // 的可选 skillGet/skillsList 逐字对齐（手工比对,无 satisfies）。
  skillGet: (name: string): Promise<SkillMeta | null> => ipcRenderer.invoke("skills:get", name),
  builtinSkillGet: (name: string): Promise<SkillMeta | null> =>
    ipcRenderer.invoke("skills:get-builtin", name),
  skillsList: (): Promise<SkillMeta[]> => ipcRenderer.invoke("skills:list"),
  // 插件管理（U3）:扫描多根 / 打开范围根。形状与 DesktopBridge 的可选方法逐字对齐。
  piSkillsList: (args: {
    // Design B(plan 002):按 agent 的扫描根规格(global 含 ~;workspace 为相对子目录)。见 bridge.ts。
    rootSpecs?: { path: string; scope: "global" | "workspace"; origin: "shared" | "agent" }[];
    workspaceDir?: string;
    agent?: AgentKind; // Design B 增量:追加该 agent 自带插件/内置 skill 根
    pluginSkillDirs?: string[];
    // 过渡期 deprecated 扁平入参。
    globalRoots?: string[];
    userGlobalRoots?: string[];
    workspaceEnabled?: boolean;
  }): Promise<PluginSkill[]> => ipcRenderer.invoke("pi-skills:list", args),
  openSkillDir: (args: { dir: string; allowedRoots: string[] }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("pi-skills:open-dir", args),
  createSkill: (args: {
    dir: string;
    name: string;
    description: string;
    body: string;
    allowedRoots: string[];
  }): Promise<{ ok: boolean; error?: string; dir?: string }> => ipcRenderer.invoke("pi-skills:create", args),
  // 扩展市场（U4）:list/install/remove。形状与 DesktopBridge 的可选方法逐字对齐。
  piExtList: (): Promise<string[]> => ipcRenderer.invoke("pi-ext:list"),
  piExtInstall: (args: { sourceRef: string }): Promise<PiExtInstallResult> =>
    ipcRenderer.invoke("pi-ext:install", args),
  piExtRemove: (args: { sourceRef: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("pi-ext:remove", args),
  // 插件市场（第一期，只读）:扫描已装插件 / 读 marketplace.json 索引。形状与 DesktopBridge
  // 的可选方法逐字对齐。
  pluginList: (): Promise<PluginListResult> => ipcRenderer.invoke("plugins:list"),
  marketplaceList: (): Promise<MarketplaceListResult> => ipcRenderer.invoke("marketplace:list"),
  // ── 本地 Whisper 模型管理（U7）────────────────────────────────────────────
  // IPC 通道对应 apps/desktop/src/main/ipc/stt.ts；形状与 DesktopBridge 的
  // listWhisperModels/getWhisperModelStatus/... 逐字对齐（手工比对，无 satisfies）。
  listWhisperModels: (): Promise<LocalWhisperModelStatus[]> =>
    ipcRenderer.invoke("stt:listModels"),
  getWhisperModelStatus: (modelId: string): Promise<LocalWhisperModelStatus> =>
    ipcRenderer.invoke("stt:modelStatus", modelId),
  downloadWhisperModel: (args: {
    modelId: string;
    sourceId?: string;
  }): Promise<{ ok: boolean; message?: string; status?: LocalWhisperModelStatus }> =>
    ipcRenderer.invoke("stt:downloadModel", args),
  cancelWhisperDownload: (
    modelId: string,
  ): Promise<{ ok: boolean; status?: LocalWhisperModelStatus }> =>
    ipcRenderer.invoke("stt:cancelDownload", modelId),
  deleteWhisperModel: (
    modelId: string,
  ): Promise<{ ok: boolean; message?: string; status?: LocalWhisperModelStatus }> =>
    ipcRenderer.invoke("stt:deleteModel", modelId),
  checkWhisperSources: (modelId?: string): Promise<LocalWhisperSourcesResult> =>
    ipcRenderer.invoke("stt:checkSources", modelId),
  // 进度订阅：主进程经 stt:downloadProgress 广播，渲染端转为回调 + 退订（KTD5）。
  onWhisperDownloadProgress: (
    cb: (progress: LocalWhisperModelProgress) => void,
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, progress: LocalWhisperModelProgress) =>
      cb(progress);
    ipcRenderer.on("stt:downloadProgress", listener);
    return () => ipcRenderer.removeListener("stt:downloadProgress", listener);
  },
  // ── U8：统一转写入口（按 AsrSettings.protocol 分发） ──────────────────────
  // 相比旧的 asrTranscribe（走 asr:transcribe，仅在线），
  // transcribeSpeech 统一处理 local-whisper / openai-transcriptions / mimo-asr，
  // 由主进程 stt:transcribe handler 按 protocol 路由。
  transcribeSpeech: (
    req: AsrTranscribeRequest,
    asrSettings: AsrSettings,
  ): Promise<AsrTranscribeResponse> =>
    ipcRenderer.invoke("stt:transcribe", { ...req, asrSettings }),

  // ── 节点式工作流（loop）IPC 透传 ───────────────────────────────────────────
  // 形状与 packages/core/desktop/bridge.ts 的 DesktopBridge workflow* 方法一一对应。
  // 跨进程契约：渲染层只通过 DesktopBridge 调用，永不直接访问 ipcRenderer。
  // 运行时相关方法（runNow/stop/node:run/node:test/approval:resolve/import/export）
  // 在 U8/U9/U14/U15 完整接线前，主进程侧会返回明确错误。

  /** 列出所有工作流定义快照。 */
  workflowList: (): Promise<WorkflowDef[]> =>
    ipcRenderer.invoke("workflow:list"),

  /** 创建工作流（id/时间戳由主进程分配）。 */
  workflowCreate: (input: Partial<WorkflowDef>): Promise<WorkflowDef> =>
    ipcRenderer.invoke("workflow:create", input),

  /** 更新工作流（patch 由 renderer 组装全量，主进程 normalize + 持久化）。 */
  workflowUpdate: (id: string, patch: Partial<WorkflowDef>): Promise<WorkflowDef | null> =>
    ipcRenderer.invoke("workflow:update", id, patch),

  /** 切换启用状态。 */
  workflowSetEnabled: (id: string, enabled: boolean): Promise<WorkflowDef | null> =>
    ipcRenderer.invoke("workflow:setEnabled", id, enabled),

  /** 切换 AI 可调用标记（MCP 侧在 U14 监听此变化刷新工具列表）。 */
  workflowSetCallableByAgent: (id: string, callableByAgent: boolean): Promise<WorkflowDef | null> =>
    ipcRenderer.invoke("workflow:setCallableByAgent", id, callableByAgent),

  /** 删除工作流（含运行历史）。 */
  workflowDelete: (id: string): Promise<void> =>
    ipcRenderer.invoke("workflow:delete", id),

  /** 立即触发一次运行，返回初始 WorkflowRun。P1 AC-003：支持可选 input。 */
  workflowRunNow: (id: string, input?: Record<string, unknown>): Promise<WorkflowRun | null> =>
    ipcRenderer.invoke("workflow:runNow", id, input ?? {}),

  /** 停止正在进行的运行（待 U9 接线）。 */
  workflowStop: (id: string, runId: string): Promise<void> =>
    ipcRenderer.invoke("workflow:stop", id, runId),

  /** 列出工作流的运行历史。 */
  workflowListRuns: (id: string): Promise<WorkflowRun[]> =>
    ipcRenderer.invoke("workflow:listRuns", id),

  /** 删除单条运行记录。 */
  workflowDeleteRun: (id: string, runId: string): Promise<void> =>
    ipcRenderer.invoke("workflow:deleteRun", id, runId),

  /** 从 DSL JSON 导入工作流（待 U15 接线）。 */
  workflowImport: (dsl: unknown): Promise<WorkflowDef> =>
    ipcRenderer.invoke("workflow:import", dsl),

  /** 导出工作流为 DSL JSON（待 U15 接线）。 */
  workflowExport: (id: string): Promise<unknown> =>
    ipcRenderer.invoke("workflow:export", id),

  /** 画布单节点运行（待 U8 接线）。 */
  workflowNodeRun: (workflowId: string, nodeId: string, input: unknown): Promise<unknown> =>
    ipcRenderer.invoke("workflow:node:run", workflowId, nodeId, input),

  /** 配置面板单节点测试（待 U8 接线）。 */
  workflowNodeTest: (workflowId: string, nodeId: string, input: unknown): Promise<unknown> =>
    ipcRenderer.invoke("workflow:node:test", workflowId, nodeId, input),

  /** human-approval 节点 resolve。P0 Fix-1：入参为 token（非 runId），IPC handler 已修正。 */
  workflowResolveApproval: (token: string, decision: "approved" | "rejected"): Promise<void> =>
    ipcRenderer.invoke("workflow:approval:resolve", token, decision),

  /** cron 表达式即时校验（ScheduleEditor 实时反馈，真相以 main 调度为准）。
   * P2 Fix-13：nextRun 为 number（epoch ms），与 automationValidateCron 一致。 */
  workflowValidateCron: (expression: string, timezone?: string): Promise<{ ok: boolean; error?: string; nextRun?: number }> =>
    ipcRenderer.invoke("workflow:validateCron", expression, timezone),

  /** 订阅工作流列表变化（CRUD 后主进程推全量快照，返回退订函数）。 */
  onWorkflowChanged: (cb: (list: WorkflowDef[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, list: WorkflowDef[]) => cb(list);
    ipcRenderer.on("workflow:changed", listener);
    return () => ipcRenderer.removeListener("workflow:changed", listener);
  },

  /** 订阅单次运行阶段事件（start/end，运行时 U8/U9 推送，返回退订函数）。 */
  onWorkflowRunEvent: (cb: (event: WorkflowRunEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: WorkflowRunEvent) => cb(event);
    ipcRenderer.on("workflow:run-event", listener);
    return () => ipcRenderer.removeListener("workflow:run-event", listener);
  },

  // ── 快捷回复助手（reply）IPC 透传 ─────────────────────────────────────────────
  // 形状与 packages/core/desktop/bridge.ts 的 DesktopBridge reply* 方法一一对应。
  // macOS-only；主进程 U5 为骨架（返回安全默认），U7/U9 填实。
  replyGetPermissions: (): Promise<ReplyPermissionState> => ipcRenderer.invoke("reply:getPermissions"),
  replyOpenPermissionSettings: (kind: ReplyPermissionKind): Promise<void> =>
    ipcRenderer.invoke("reply:openPermissionSettings", kind),
  replyVerifyChannel: (channelId: ChannelId, token: string): Promise<ReplyChannelVerifyResult> =>
    ipcRenderer.invoke("reply:verifyChannel", channelId, token),
  replyDisconnectChannel: (channelId: ChannelId): Promise<void> =>
    ipcRenderer.invoke("reply:disconnectChannel", channelId),
  replyGetDebugLog: (): Promise<ReplyDebugEntry[]> => ipcRenderer.invoke("reply:getDebugLog"),
  replyTriggerDraft: (): Promise<void> => ipcRenderer.invoke("reply:triggerDraft"),
  // 数据摘要与清理（~/.cortex-desktop/reply/ 落盘数据，main-owned）。
  replyGetDataSummary: (): Promise<ReplyDataSummary> => ipcRenderer.invoke("reply:getDataSummary"),
  replyClearHistory: (): Promise<void> => ipcRenderer.invoke("reply:clearHistory"),
  replyClearConversationMemory: (): Promise<void> => ipcRenderer.invoke("reply:clearConversationMemory"),
  // 数据文件夹与重新学习（记忆管理工具行）。
  replyOpenDataFolder: (): Promise<void> => ipcRenderer.invoke("reply:openDataFolder"),
  replyRelearn: (): Promise<ReplyRelearnResult> => ipcRenderer.invoke("reply:relearn"),
  // 全局分区记忆（KTD6 修订：main-owned memory.json，设置页经此读写）。
  replyGetMemory: (): Promise<MemoryState> => ipcRenderer.invoke("reply:getMemory"),
  replySetMemoryFile: (scope: MemoryScope, patch: Partial<MemoryFile>): Promise<void> =>
    ipcRenderer.invoke("reply:setMemoryFile", scope, patch),
  replyClearMemory: (kind: "all" | "auto"): Promise<void> => ipcRenderer.invoke("reply:clearMemory", kind),
  replySyncSettings: (snapshot: ReplySyncSnapshot): Promise<void> =>
    ipcRenderer.invoke("reply:syncSettings", snapshot),
  // 订阅 main 记忆变更（KTD6 修订）：蒸馏直写 memory-store 后推全量记忆 → 渲染端刷新缓存。返回退订函数。
  onReplyMemoryChanged: (cb: (memory: MemoryState) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, memory: MemoryState) => cb(memory);
    ipcRenderer.on("reply:memoryChanged", listener);
    return () => ipcRenderer.removeListener("reply:memoryChanged", listener);
  },
  // 订阅 main 的「打开设置到快捷回复分区」指令（气泡「去设置」触发）：壳据此打开设置页并跳转。返回退订函数。
  onReplyOpenSettings: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("reply:openSettings", listener);
    return () => ipcRenderer.removeListener("reply:openSettings", listener);
  },
  // ── 用户记忆（跨工作台持久记忆 + 做梦整理）IPC 透传 ─────────────────────────
  // 形状与 packages/core/desktop/bridge.ts 的 memory* 方法一一对应；真源在 main
  // （~/.cortex-desktop/memory/*.md），渲染端只持只读缓存。
  memoryGet: (): Promise<UserMemoryState> => ipcRenderer.invoke("memory:get"),
  memorySetFile: (scope: UserMemoryScope, patch: Partial<UserMemoryFile>): Promise<void> =>
    ipcRenderer.invoke("memory:setFile", scope, patch),
  memoryClear: (kind: "all" | "auto"): Promise<void> => ipcRenderer.invoke("memory:clear", kind),
  memoryDreamNow: (): Promise<MemoryDreamResult> => ipcRenderer.invoke("memory:dreamNow"),
  memoryGetDreamState: (): Promise<DreamStateSummary> => ipcRenderer.invoke("memory:getDreamState"),
  memoryOpenFolder: (): Promise<void> => ipcRenderer.invoke("memory:openFolder"),
  // 订阅 main 记忆变更（做梦写回后推全量记忆 → 渲染端刷新只读缓存）。返回退订函数。
  onMemoryChanged: (cb: (memory: UserMemoryState) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, memory: UserMemoryState) => cb(memory);
    ipcRenderer.on("memory:changed", listener);
    return () => ipcRenderer.removeListener("memory:changed", listener);
  },
  // ── 桌面宠物脱离主窗体(独立 pet-overlay 窗口)──────────────────────────────
  // 主窗口 PetBridge 用 reportPetState 转发 usePetStore 变化;pet-overlay 窗口用
  // onPetSyncState 订阅镜像 + requestPetSync 应对挂载顺序竞态。位置持久化不走 IPC——
  // overlay 窗口靠原生 app-region 拖拽移动,主进程监听窗口自身 moved 事件直接落盘
  // (见 main/pet-overlay-window.ts),渲染端不需要上报/查询位置。
  reportPetState: (snapshot: PetStateSnapshot): void => ipcRenderer.send("pet:report-state", snapshot),
  requestPetSync: (): void => ipcRenderer.send("pet:request-sync"),
  setPetOverlayVisible: (visible: boolean): void => ipcRenderer.send("pet:set-overlay-visible", visible),
  setPetEnabled: (enabled: boolean): void => ipcRenderer.send("pet:set-enabled", enabled),
  onPetEnabledChange: (cb: (enabled: boolean) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, enabled: boolean) => cb(enabled);
    ipcRenderer.on("pet:enabled-changed", listener);
    return () => ipcRenderer.removeListener("pet:enabled-changed", listener);
  },
  onPetSyncState: (cb: (snapshot: PetStateSnapshot) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, snapshot: PetStateSnapshot) => cb(snapshot);
    ipcRenderer.on("pet:sync-state", listener);
    return () => ipcRenderer.removeListener("pet:sync-state", listener);
  },
  // ── 深度研究引擎（CRE）子域 ────────────────────────────────────────────────
  // 必须挂在 personal 下：渲染端经 CoreProvider 注入的 DesktopBridge 就是这个对象，
  // 挂到 desktopAPI 顶层的话 views 侧的 bridge?.research 永远是 undefined。
  research: createResearchBridge(),
  // ── 公司知识库（远端 MCP server）子域 ──────────────────────────────────────
  // 与 research 同款凭据模式：**明文令牌只在 renderer → main 这一个方向流动**，
  // 反向永远只回「已配置 / 未配置」，桥这层不提供任何读明文的方法。
  knowledge: {
    setCredential: (input: {
      enabled: boolean;
      baseUrl: string;
      token?: string;
    }): Promise<KnowledgeBaseSettings> => ipcRenderer.invoke("knowledge:setCredential", input),
    clearCredential: (): Promise<KnowledgeBaseSettings> =>
      ipcRenderer.invoke("knowledge:clearCredential"),
    // 自检不接受也不回传凭据：main 用已落盘的密文自行解密发起，只回成败与一句人话。
    test: (): Promise<{ ok: boolean; message: string; tools?: string[] }> =>
      ipcRenderer.invoke("knowledge:test"),
    // 取一篇文档正文（会话里点开引用时预览）。走主进程自己的 MCP 通道，不触发 agent 回合。
    readDoc: (input: { sourceId: string; relPath: string }): Promise<KnowledgeDocResult> =>
      ipcRenderer.invoke("knowledge:readDoc", input),
  },
  // ── Computer Use（pi 操作真实桌面 GUI）子域 ────────────────────────────────
  // 只暴露「问状态」与「装一次」；总开关与定位模型是普通设置项，走 generalSettings 持久化。
  computerUse: {
    status: (): Promise<ComputerUseStatus> => ipcRenderer.invoke("computer-use:status"),
    install: (): Promise<ComputerUseStatus> => ipcRenderer.invoke("computer-use:install"),
    // 重新申请授权：清 TCC「已提示过」记录 → 重新弹提示 → 开面板（详见 main/reply/permission-reprompt.ts）。
    repromptPermission: (kind: ComputerUsePermissionKind): Promise<ComputerUseStatus> =>
      ipcRenderer.invoke("computer-use:repromptPermission", kind),
    revealApp: (): Promise<void> => ipcRenderer.invoke("computer-use:revealApp"),
  },
};

// 菜单栏 Spotlight 浮动框窗口专用桥（bar renderer 直接调用,不属于 DesktopBridge）。
const spotlight = {
  submit: (intent: SpotlightIntent): Promise<void> => ipcRenderer.invoke("spotlight:submit", intent),
  resize: (height: number): void => ipcRenderer.send("spotlight:resize", height),
  hide: (): void => ipcRenderer.send("spotlight:hide"),
};

// 闪记浮层窗口专用桥（overlay renderer 直接调用,不属于 DesktopBridge）。
// resize/hide 给浮层 renderer 用;show 给主窗口 composer 图标入口用(降级后仍可用,不依赖热键)。
// 闪记提交直接走 personal.notesAdd 落盘,不经主窗口接力,故无 submit/consumePending。
const notesOverlay = {
  resize: (height: number): void => ipcRenderer.send("notes-overlay:resize", height),
  hide: (): void => ipcRenderer.send("notes-overlay:hide"),
  show: (): void => ipcRenderer.send("notes-overlay:show"),
};

// 闪记全局热键被占用时的一次性降级提示:桌面壳 App.tsx mount 后拉取一次 → pushToast。
// consume-pending(仿 spotlight),避免 push 早于 listener 注册丢提示;无降级返回 null。不属于 DesktopBridge。
const consumeNotesHotkeyDegraded = (): Promise<string | null> =>
  ipcRenderer.invoke("notes:consumeHotkeyDegraded");

// 独立通知窗体桥:
//  - 主窗渲染端用 push/clear(主窗失焦时转发提醒、回前台时清空);
//  - 通知窗体渲染端用 onPush/onClear 接收,resize 上报实测高度。
//  不属于 DesktopBridge(与 notesOverlay/spotlight 同为 desktopAPI 顶层能力)。
const notification = {
  push: (payload: NotificationPayload): void => ipcRenderer.send("notification:push", payload),
  clear: (): void => ipcRenderer.send("notification:clear"),
  resize: (height: number): void => ipcRenderer.send("notification:resize", height),
  // 窗体渲染端注册完 onPush/onClear 监听后调用:主进程冲刷 ready 前积压的通知(防首发丢失)。
  ready: (): void => ipcRenderer.send("notification:ready"),
  onPush: (cb: (payload: NotificationPayload) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: NotificationPayload) => cb(payload);
    ipcRenderer.on("notification:push", listener);
    return () => ipcRenderer.removeListener("notification:push", listener);
  },
  onClear: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("notification:clear", listener);
    return () => ipcRenderer.removeListener("notification:clear", listener);
  },
};

// 「项目管理」独立窗口专用桥（侧栏入口调用，不属于 DesktopBridge；对齐 spotlight/notesOverlay 惯例）。
// open：打开或聚焦项目管理窗口（main 侧单例，见 projects-window.ts）。
const projectsWindow = {
  open: (): Promise<void> => ipcRenderer.invoke("projects-window:open"),
  // 关窗草稿 flush 握手（R21/KTD6）：main 拦截 close → 发 flush-request；renderer 提交 pending
  // 草稿并等 mutation 落库 → flushDone 回执 → main 销毁窗口。title/notes 仅在 blur 落库，销毁
  // renderer 不触发 blur，若不 flush 会静默丢数据。含超时兜底（见 projects-window.ts）避免关不掉窗。
  onFlushRequest: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("projects-window:flush-request", listener);
    return () => ipcRenderer.removeListener("projects-window:flush-request", listener);
  },
  flushDone: (): void => ipcRenderer.send("projects-window:flush-done"),
};

// 候选气泡窗专用桥（U6）：气泡渲染端直接调用，不属于 DesktopBridge（与 notification/spotlight 同为
// desktopAPI 顶层能力）。onState 接收主进程推的可视状态；resize 上报实测高度；action 上行鼠标动作。
// 键盘不走此桥（窗口 focusable:false，键由 helper 吞键 → controller 驱动状态重推）。
const replyBubble = {
  onState: (cb: (state: ReplyBubbleState) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, state: ReplyBubbleState) => cb(state);
    ipcRenderer.on("reply-bubble:state", listener);
    return () => ipcRenderer.removeListener("reply-bubble:state", listener);
  },
  resize: (height: number): void => ipcRenderer.send("reply-bubble:resize", height),
  action: (action: ReplyBubbleAction): void => ipcRenderer.send("reply-bubble:action", action),
  // ── 语音意图录音（U8）──────────────────────────────────────────────────────────
  // onVoice：接收主进程 start/stop 指令（录音只能在渲染端做）；submitVoiceResult：回传转写结果；
  // transcribe：复用统一转写入口（stt:transcribe），使气泡渲染端只依赖 replyBubble 桥。
  onVoice: (cb: (command: ReplyBubbleVoiceCommand) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, command: ReplyBubbleVoiceCommand) => cb(command);
    ipcRenderer.on("reply-bubble:voice", listener);
    return () => ipcRenderer.removeListener("reply-bubble:voice", listener);
  },
  submitVoiceResult: (result: ReplyBubbleVoiceResult): void =>
    ipcRenderer.send("reply-bubble:voice-result", result),
  transcribe: (req: AsrTranscribeRequest, asrSettings: AsrSettings): Promise<AsrTranscribeResponse> =>
    ipcRenderer.invoke("stt:transcribe", { ...req, asrSettings }),
};

const desktopAPI = {
  appInfo: fetchAppInfo(),
  runtimeConfig: {
    apiUrl: process.env.CORTEX_API_URL,
    authToken: process.env.CORTEX_AUTH_TOKEN,
    workspaceId: process.env.CORTEX_WORKSPACE_ID,
    workspaceSlug: process.env.CORTEX_WORKSPACE_SLUG,
  } satisfies RuntimeConfig,
  personal,
  spotlight,
  notesOverlay,
  notification,
  replyBubble,
  projectsWindow,
  consumeNotesHotkeyDegraded,
};

try {
  contextBridge.exposeInMainWorld("desktopAPI", desktopAPI);
} catch (error) {
  console.error(error);
}

export type DesktopAPI = typeof desktopAPI;
