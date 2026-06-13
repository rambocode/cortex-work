// 个人工作区 IPC 统一注册入口（app.whenReady 后调用一次）。

import { registerFsHandlers } from "./fs";
import { registerStoreHandlers } from "./store";
import { registerCliHandlers } from "./cli";
import { registerChatHandlers } from "./chat";
import { registerTimelineHandlers } from "./timeline";
import { registerPushHandlers } from "./push";
import { registerLlmHandlers } from "./llm";
import { registerPtyHandlers } from "./pty";
import { registerUsageHandlers } from "./usage";
import { registerAgentProjectsHandlers } from "./agent-projects";
import { registerWatchHandlers } from "./watch";
import { registerUpdateHandlers } from "./update";
import { registerEditorHandlers } from "./editors";
import { registerAutomationHandlers } from "../automation/ipc";

export function registerIpcHandlers(): void {
  registerFsHandlers();
  registerWatchHandlers();
  registerStoreHandlers();
  registerCliHandlers();
  registerChatHandlers();
  registerTimelineHandlers();
  registerPushHandlers();
  registerLlmHandlers();
  registerPtyHandlers();
  registerUsageHandlers();
  registerAgentProjectsHandlers();
  registerUpdateHandlers();
  registerEditorHandlers();
  registerAutomationHandlers();
}

export { killAllCli } from "./cli";
export { killAllPty } from "./pty";
export { closeAllWatchers } from "./watch";
export { killAllAutomations } from "../automation/runner";
