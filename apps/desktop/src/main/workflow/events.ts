// 工作流事件分发：main → 所有存活窗口。
// 对齐 automation/events.ts：窗口可能已关，getAllWindows() 返回 []，
// 事件丢失不影响落盘记录，renderer 重开后用 workflow:list/listRuns 补拉。

import { BrowserWindow } from "electron";
import type { WorkflowDef, WorkflowRunEvent } from "./types";

/**
 * 广播全量工作流列表快照到所有存活窗口（workflow:changed 频道）。
 * 触发时机：create / update / setEnabled / setCallableByAgent / delete 任意 CRUD。
 */
export function broadcastWorkflowChanged(list: WorkflowDef[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("workflow:changed", list);
  }
}

/**
 * 广播单次运行的阶段事件（start / end）到所有存活窗口（workflow:run-event 频道）。
 * 由运行时引擎（U8/U9）在 run 开始与结束时调用；本单元（U3）不触发，仅声明契约。
 */
export function broadcastWorkflowRunEvent(event: WorkflowRunEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("workflow:run-event", event);
  }
}
