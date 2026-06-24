// 个人工作区 IPC 统一注册入口（app.whenReady 后调用一次）。

import { registerFsHandlers } from "./fs";
import { registerStoreHandlers } from "./store";
import { registerNotesHandlers } from "./notes";
import { registerSkillsHandlers } from "./skills";
import { registerPluginHandlers } from "./plugins";
import { registerPiExtensionMarketHandlers } from "./pi-extensions-market";
import { registerCliHandlers } from "./cli";
import { registerAskHandlers } from "./ask";
import { registerPiSessionHandlers } from "./pi-session";
import { registerChatHandlers } from "./chat";
import { registerImageHandlers } from "./image";
import { registerDocHandlers } from "./doc";
import { registerTimelineHandlers } from "./timeline";
import { registerPushHandlers } from "./push";
import { registerLlmHandlers } from "./llm";
import { registerProviderHandlers } from "./provider";
import { registerPtyHandlers } from "./pty";
import { registerAgentProjectsHandlers } from "./agent-projects";
import { registerWatchHandlers } from "./watch";
import { registerUpdateHandlers, type RegisterUpdateHandlersOptions } from "./update";
import { registerEditorHandlers } from "./editors";
import { registerAppHandlers } from "./app";
import { registerAgentTraceHandlers } from "./agent-trace";
import { registerBrowserHandlers } from "./browser";
import { registerAutomationHandlers } from "../automation/ipc";

interface RegisterIpcHandlersOptions {
  update?: RegisterUpdateHandlersOptions;
  agentTraceDevMode?: boolean;
}

export function registerIpcHandlers(options: RegisterIpcHandlersOptions = {}): void {
  registerFsHandlers();
  registerWatchHandlers();
  registerStoreHandlers();
  registerNotesHandlers();
  registerSkillsHandlers();
  registerPluginHandlers();
  registerPiExtensionMarketHandlers();
  registerCliHandlers();
  registerAskHandlers();
  registerPiSessionHandlers();
  registerChatHandlers();
  registerImageHandlers();
  registerDocHandlers();
  registerTimelineHandlers();
  registerPushHandlers();
  registerLlmHandlers();
  registerProviderHandlers();
  registerPtyHandlers();
  registerAgentProjectsHandlers();
  registerUpdateHandlers(options.update);
  registerEditorHandlers();
  registerAppHandlers();
  registerAgentTraceHandlers({ devMode: options.agentTraceDevMode ?? false });
  registerBrowserHandlers();
  registerAutomationHandlers();
}

export { killAllCli } from "./cli";
export { killAllAsk } from "./ask";
export { killAllPiSessions } from "./pi-session";
export { killAllPty } from "./pty";
export { closeAllWatchers } from "./watch";
export { killAllAutomations } from "../automation/runner";
