import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AgentKind,
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
  NoteStatus,
  PersistedState,
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
  SkillMeta,
  SpotlightIntent,
  TtsListVoicesRequest,
  TtsSynthesizeRequest,
  TaskFilesResult,
  DocFileRaw,
  TrimSessionRequest,
  TtsStreamEvent,
  TtsVoiceOption,
  UpdateState,
  NotificationPayload,
  WorkflowDef,
  WorkflowRun,
  WorkflowRunEvent,
} from "../main/ipc/types";
// 方案 A：编排请求类型权威定义留在 orchestrate.ts，此处 type-only 引入（编译期擦除，
// 不引入主进程运行时依赖）。详见 .llms 交接文档 4.4 与 bridge.ts 的 startOrchestration 契约。
import type { OrchestrateStartRequest } from "../main/ipc/orchestrate";
import type { RoundtableStartRequest } from "../main/ipc/types";
import type {
  LocalWhisperModelProgress,
  LocalWhisperModelStatus,
  LocalWhisperSourcesResult,
} from "@cortex-work/core/whisper/models";
import type { Locale } from "@cortex-work/core/i18n/native";

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
  // 会话文件链接定位:ref(相对/裸文件名)→ 项目内真实绝对路径,找不到/越权 → null（不抛错）。
  resolveProjectFile: (root: string, ref: string): Promise<string | null> =>
    ipcRenderer.invoke("fs:resolveProjectFile", root, ref),
  writeFile: (path: string, content: string): Promise<void> => ipcRenderer.invoke("fs:writeFile", path, content),
  deleteFile: (path: string): Promise<void> => ipcRenderer.invoke("fs:deleteFile", path),
  createTaskFile: (projectRoot: string, todoId: string, title: string): Promise<string> =>
    ipcRenderer.invoke("fs:createTaskFile", projectRoot, todoId, title),
  listTaskFiles: (projectRoot: string): Promise<TaskFilesResult> => ipcRenderer.invoke("fs:listTaskFiles", projectRoot),
  listDocs: (projectRoot: string): Promise<DocFileRaw[]> => ipcRenderer.invoke("fs:listDocs", projectRoot),
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
  loadChat: (sessionId: string): Promise<unknown[]> => ipcRenderer.invoke("chat:load", sessionId),
  saveChat: (sessionId: string, messages: unknown[]): Promise<void> =>
    ipcRenderer.invoke("chat:save", sessionId, messages),
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
  setDesktopBehavior: (behavior: {
    openAtLogin: boolean;
    startMinimized: boolean;
    closeToTray: boolean;
  }): Promise<void> => ipcRenderer.invoke("desktop:setBehavior", behavior),
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
  // 渲染端把不落盘的 agent 报错写入主进程文件日志（脱敏由主进程负责）。
  logMessage: (level: "warn" | "error", message: string): Promise<void> =>
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
  // 内置 skill 元数据（深化注入 ce-ideate / 生成 plan 注入 ce-plan）。形状与 DesktopBridge
  // 的可选 skillGet/skillsList 逐字对齐（手工比对,无 satisfies）。
  skillGet: (name: string): Promise<SkillMeta | null> => ipcRenderer.invoke("skills:get", name),
  skillsList: (): Promise<SkillMeta[]> => ipcRenderer.invoke("skills:list"),
  // 插件管理（U3）:扫描多根 / 打开范围根。形状与 DesktopBridge 的可选方法逐字对齐。
  piSkillsList: (args: {
    globalRoots: string[];
    userGlobalRoots?: string[];
    workspaceEnabled: boolean;
    workspaceDir?: string;
    pluginSkillDirs?: string[];
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
  consumeNotesHotkeyDegraded,
};

try {
  contextBridge.exposeInMainWorld("desktopAPI", desktopAPI);
} catch (error) {
  console.error(error);
}

export type DesktopAPI = typeof desktopAPI;
