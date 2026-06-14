import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AgentKind,
  AgentProjectInfo,
  AgentUsage,
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
  EditorInfo,
  GitBranchesResult,
  GitDiffAllResult,
  GitInfoResult,
  GitOpResult,
  PersistedState,
  PromptNode,
  ReadFileResult,
  TtsListVoicesRequest,
  TtsSynthesizeRequest,
  TaskFilesResult,
  TrimSessionRequest,
  TtsStreamEvent,
  TtsVoiceOption,
  UpdateState,
} from "../main/ipc/types";

interface AppInfo {
  version: string;
  os: "macos" | "windows" | "linux" | "unknown";
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
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("fs:pickDirectory"),
  scanPromptTree: (root: string): Promise<PromptNode> => ipcRenderer.invoke("fs:scanPromptTree", root),
  scanDirTree: (root: string): Promise<PromptNode> => ipcRenderer.invoke("fs:scanDirTree", root),
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
  writeFile: (path: string, content: string): Promise<void> => ipcRenderer.invoke("fs:writeFile", path, content),
  deleteFile: (path: string): Promise<void> => ipcRenderer.invoke("fs:deleteFile", path),
  createTaskFile: (projectRoot: string, todoId: string, title: string): Promise<string> =>
    ipcRenderer.invoke("fs:createTaskFile", projectRoot, todoId, title),
  listTaskFiles: (projectRoot: string): Promise<TaskFilesResult> => ipcRenderer.invoke("fs:listTaskFiles", projectRoot),
  validateDir: (path: string): Promise<boolean> => ipcRenderer.invoke("fs:validateDir", path),
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
  // 项目「Open in」:列出已装编辑器 / 用指定编辑器打开项目目录
  listEditors: (): Promise<EditorInfo[]> => ipcRenderer.invoke("shell:listEditors"),
  openInEditor: (path: string, editorId: string): Promise<void> =>
    ipcRenderer.invoke("shell:openInEditor", path, editorId),
  // 检测 PATH 中已安装的 agent CLI（pi 内置恒可用）
  detectAgents: (): Promise<Record<AgentKind, boolean>> => ipcRenderer.invoke("agents:detect"),
  loadState: (): Promise<PersistedState> => ipcRenderer.invoke("store:load"),
  saveState: (state: PersistedState): Promise<void> => ipcRenderer.invoke("store:save", state),
  loadChat: (sessionId: string): Promise<unknown[]> => ipcRenderer.invoke("chat:load", sessionId),
  saveChat: (sessionId: string, messages: unknown[]): Promise<void> =>
    ipcRenderer.invoke("chat:save", sessionId, messages),
  deleteChat: (sessionId: string): Promise<void> => ipcRenderer.invoke("chat:delete", sessionId),
  loadTimeline: (projectId: string): Promise<unknown> => ipcRenderer.invoke("timeline:load", projectId),
  saveTimeline: (projectId: string, data: unknown): Promise<void> =>
    ipcRenderer.invoke("timeline:save", projectId, data),
  gitLog: (
    root: string,
    opts?: { sinceTs?: number; max?: number },
  ): Promise<{ ts: number; hash: string; subject: string }[]> => ipcRenderer.invoke("fs:gitLog", root, opts),
  startCli: (req: CliStartRequest): Promise<void> => ipcRenderer.invoke("cli:start", req),
  oneshotCli: (req: { agent?: AgentKind; cwd?: string; prompt: string; model?: string }): Promise<string> =>
    ipcRenderer.invoke("cli:oneshot", req),
  openaiComplete: (req: { baseUrl: string; apiKey?: string; model: string; prompt: string }): Promise<string> =>
    ipcRenderer.invoke("llm:openaiComplete", req),
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
  // 内嵌终端（xterm ↔ node-pty）
  ptySpawn: (req: { id: string; cwd?: string; cols: number; rows: number }): Promise<{ ok: boolean; cwd?: string; error?: string }> =>
    ipcRenderer.invoke("pty:spawn", req),
  ptyInput: (id: string, data: string): void => ipcRenderer.send("pty:input", { id, data }),
  ptyResize: (id: string, cols: number, rows: number): void => ipcRenderer.send("pty:resize", { id, cols, rows }),
  ptyKill: (id: string): void => ipcRenderer.send("pty:kill", { id }),
  ptyCwd: (id: string): Promise<string | null> => ipcRenderer.invoke("pty:cwd", { id }),
  agentUsage: (): Promise<AgentUsage> => ipcRenderer.invoke("usage:agent"),
  scanAgentProjects: (): Promise<AgentProjectInfo[]> => ipcRenderer.invoke("agents:scanProjects"),
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
};

try {
  contextBridge.exposeInMainWorld("desktopAPI", desktopAPI);
} catch (error) {
  console.error(error);
}

export type DesktopAPI = typeof desktopAPI;
