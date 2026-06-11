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

export function registerIpcHandlers(): void {
  registerFsHandlers();
  registerStoreHandlers();
  registerCliHandlers();
  registerChatHandlers();
  registerTimelineHandlers();
  registerPushHandlers();
  registerLlmHandlers();
  registerPtyHandlers();
  registerUsageHandlers();
  registerAgentProjectsHandlers();
}

export { killAllCli } from "./cli";
export { killAllPty } from "./pty";
