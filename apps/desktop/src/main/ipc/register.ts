// 个人工作区 IPC 统一注册入口（app.whenReady 后调用一次）。

import { registerFsHandlers } from "./fs";
import { registerStoreHandlers } from "./store";
import { registerNotesHandlers } from "./notes";
import { registerTasksHandlers, tasksReminderScheduler, isTasksReminderOptInEnabled } from "./tasks";
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
import { registerProjectsWindowHandlers } from "../projects-window";
import { registerBrowserHandlers } from "./browser";
import { registerAutomationHandlers } from "../automation/ipc";
import { registerWorkflowHandlers } from "../workflow/ipc";
import { registerSttHandlers } from "./stt";
import { registerOrchestrateHandlers } from "./orchestrate";
import { installIpcTrace } from "../log/ipc-trace";
import { registerRoleHandlers } from "./roles";
import { registerRoundtableHandlers } from "./roundtable";
import { registerReplyHandlers } from "./reply";
import { registerMemoryHandlers } from "./memory";
import { registerWritingRetrievalHandlers } from "./writing-retrieval";
import { registerWritingInfographicHandlers } from "./writing-infographic";
import { registerWritingExportHandlers } from "./writing-export";
import { registerWritingLlmHandlers } from "./writing-llm";
import { registerWritingPdfHandlers } from "./writing-pdf";
import { registerSlidesHandlers } from "./slides";
import { registerAgentBrowserHandlers, syncAgentBrowserRuntime } from "./agent-browser";

interface RegisterIpcHandlersOptions {
  update?: RegisterUpdateHandlersOptions;
  agentTraceDevMode?: boolean;
}

export function registerIpcHandlers(options: RegisterIpcHandlersOptions = {}): void {
  // 须最先调用：幂等接管 ipcMain.handle，使其后所有 handler 注册都被可观测包裹（U5）。
  installIpcTrace();
  registerFsHandlers();
  registerWatchHandlers();
  // 设置落盘后同步任务提醒 opt-in（pushSettings.internal.enabled 变化 → 调度器建/拆 Cron）。
  registerStoreHandlers((state) => {
    tasksReminderScheduler.setEnabled(isTasksReminderOptInEnabled(state));
    syncAgentBrowserRuntime(state.generalSettings?.agentBrowser?.enabled !== false);
  });
  registerNotesHandlers();
  registerTasksHandlers(); // 真任务系统（替换 doc 聚合 Tasks）
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
  registerProjectsWindowHandlers(); // 「项目管理」独立窗口 open 通道（U2）
  registerBrowserHandlers();
  registerAgentBrowserHandlers();
  registerAutomationHandlers();
  registerWorkflowHandlers(); // 节点式工作流（loop）IPC，紧挨 automation 注册
  registerSttHandlers();
  registerOrchestrateHandlers(); // chat 三段编排调度器（U1）
  registerRoleHandlers(); // 全局角色库 CRUD（圆桌会话）
  registerRoundtableHandlers(); // 圆桌多角色 BFS 编排调度器
  registerReplyHandlers(); // 快捷回复助手 IPC 域（U5 骨架，U7/U9 填实）
  registerMemoryHandlers(); // 用户记忆（跨工作台持久记忆 + 做梦整理）IPC 域
  registerWritingRetrievalHandlers(); // 写作检索(工作区级轻量 RAG）IPC 域（U4）
  registerWritingInfographicHandlers(); // 写作信息图生成(对接 media-gen）IPC 域（U7）
  registerWritingExportHandlers(); // 写作重型导出(DOCX/PDF/PNG/HTML/复制富文本）IPC 域（U6）
  registerWritingLlmHandlers(); // 写作 LLM(ghost text 续写 + Cmd-K 就地改写）IPC 域（U3）
  registerWritingPdfHandlers(); // 写作 PDF 阅读(取原始字节交渲染端 pdfjs 渲染）IPC 域（U5）
  registerSlidesHandlers(); // AI Slides deck(bento 单文件:创建/读取/阶段/保存/另存为/演示)IPC 域
}

export { killAllCli } from "./cli";
export { killAllAsk } from "./ask";
export { killAllPiSessions } from "./pi-session";
export { killAllPty } from "./pty";
export { closeAllWatchers } from "./watch";
export { killAllAutomations } from "../automation/runner";
export { killAllWorkflows } from "../workflow/index";
export { syncAgentBrowserRuntime } from "./agent-browser";
// 编排子进程回收：接入 app 退出钩子（与 killAllCli/killAllHeadlessPrompts 并列）
export { killAllOrchestrations } from "./orchestrate";
export { killAllRoundtables } from "./roundtable";
