// 个人工作区 IPC 统一注册入口（app.whenReady 后调用一次）。

import { registerFsHandlers } from "./fs";
import { registerStoreHandlers } from "./store";
import { registerNotesHandlers } from "./notes";
import { registerSkillsHandlers } from "./skills";
import { registerCliHandlers } from "./cli";
import { registerAskHandlers } from "./ask";
import { registerPiSessionHandlers } from "./pi-session";
import { registerChatHandlers } from "./chat";
import { registerImageHandlers } from "./image";
import { registerTimelineHandlers } from "./timeline";
import { registerPushHandlers } from "./push";
import { registerLlmHandlers } from "./llm";
import { registerProviderHandlers } from "./provider";
import { registerPtyHandlers } from "./pty";
import { registerAgentProjectsHandlers } from "./agent-projects";
import { registerWatchHandlers } from "./watch";
import { registerUpdateHandlers, type RegisterUpdateHandlersOptions } from "./update";
import { registerEditorHandlers } from "./editors";
import { registerAutomationHandlers } from "../automation/ipc";

interface RegisterIpcHandlersOptions {
  update?: RegisterUpdateHandlersOptions;
}

export function registerIpcHandlers(options: RegisterIpcHandlersOptions = {}): void {
  registerFsHandlers();
  registerWatchHandlers();
  registerStoreHandlers();
  registerNotesHandlers();
  registerSkillsHandlers();
  registerCliHandlers();
  registerAskHandlers();
  registerPiSessionHandlers();
  registerChatHandlers();
  registerImageHandlers();
  registerTimelineHandlers();
  registerPushHandlers();
  registerLlmHandlers();
  registerProviderHandlers();
  registerPtyHandlers();
  registerAgentProjectsHandlers();
  registerUpdateHandlers(options.update);
  registerEditorHandlers();
  registerAutomationHandlers();
}

export { killAllCli } from "./cli";
export { killAllAsk } from "./ask";
export { killAllPiSessions } from "./pi-session";
export { killAllPty } from "./pty";
export { closeAllWatchers } from "./watch";
export { killAllAutomations } from "../automation/runner";
