// 自动化事件分发：main → 所有存活窗口（窗口可能已关,getAllWindows() 返回 []，
// 事件丢失不影响落盘记录,renderer 重开用 automationList/listRuns 补拉）。

import { BrowserWindow } from "electron";
import type { AutomationMeta, AutomationRunEvent } from "../ipc/types";

export function broadcastChanged(list: AutomationMeta[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("automation:changed", list);
  }
}

export function broadcastRunEvent(event: AutomationRunEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("automation:run-event", event);
  }
}
