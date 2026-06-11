import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AgentProjectInfo,
  AgentUsage,
  AsrTranscribeRequest,
  AsrTranscribeResponse,
  CliExitEvent,
  CliStartRequest,
  CliStreamEvent,
  PersistedState,
  PromptNode,
  ReadFileResult,
  TtsListVoicesRequest,
  TtsSynthesizeRequest,
  TtsVoiceOption,
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
  readFile: (path: string): Promise<ReadFileResult> => ipcRenderer.invoke("fs:readFile", path),
  writeFile: (path: string, content: string): Promise<void> => ipcRenderer.invoke("fs:writeFile", path, content),
  deleteFile: (path: string): Promise<void> => ipcRenderer.invoke("fs:deleteFile", path),
  createTaskFile: (projectRoot: string, todoId: string, title: string): Promise<string> =>
    ipcRenderer.invoke("fs:createTaskFile", projectRoot, todoId, title),
  validateDir: (path: string): Promise<boolean> => ipcRenderer.invoke("fs:validateDir", path),
  loadState: (): Promise<PersistedState> => ipcRenderer.invoke("store:load"),
  saveState: (state: PersistedState): Promise<void> => ipcRenderer.invoke("store:save", state),
  loadChat: (sessionId: string): Promise<unknown[]> => ipcRenderer.invoke("chat:load", sessionId),
  saveChat: (sessionId: string, messages: unknown[]): Promise<void> =>
    ipcRenderer.invoke("chat:save", sessionId, messages),
  loadTimeline: (projectId: string): Promise<unknown> => ipcRenderer.invoke("timeline:load", projectId),
  saveTimeline: (projectId: string, data: unknown): Promise<void> =>
    ipcRenderer.invoke("timeline:save", projectId, data),
  gitLog: (
    root: string,
    opts?: { sinceTs?: number; max?: number },
  ): Promise<{ ts: number; hash: string; subject: string }[]> => ipcRenderer.invoke("fs:gitLog", root, opts),
  startCli: (req: CliStartRequest): Promise<void> => ipcRenderer.invoke("cli:start", req),
  oneshotCli: (req: { agent?: "claude" | "codex"; cwd?: string; prompt: string; model?: string }): Promise<string> =>
    ipcRenderer.invoke("cli:oneshot", req),
  openaiComplete: (req: { baseUrl: string; apiKey?: string; model: string; prompt: string }): Promise<string> =>
    ipcRenderer.invoke("llm:openaiComplete", req),
  pushReport: (target: unknown, payload: { subject: string; text: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("push:report", target, payload),
  ttsSynthesize: (req: TtsSynthesizeRequest): Promise<ArrayBuffer> => ipcRenderer.invoke("tts:synthesize", req),
  listTtsVoices: (req: TtsListVoicesRequest): Promise<TtsVoiceOption[]> => ipcRenderer.invoke("tts:listVoices", req),
  asrTranscribe: (req: AsrTranscribeRequest): Promise<AsrTranscribeResponse> => ipcRenderer.invoke("asr:transcribe", req),
  killCli: (runId: string): Promise<void> => ipcRenderer.invoke("cli:kill", runId),
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
