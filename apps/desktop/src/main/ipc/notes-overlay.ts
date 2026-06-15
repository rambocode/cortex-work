// 闪记浮层 IPC:resize(实测高度回传 → 夹取重定位)、hide(Esc / 提交后关闭)、
// show(主窗口 composer 图标入口唤起,降级后不依赖热键仍可用)。
// 闪记提交不经此桥(直接走 personal.notesAdd 落盘),故无 submit/consumePending。仿 ipc/spotlight.ts。

import { ipcMain } from "electron";
import { resizeNotesOverlay, hideNotesOverlay, showNotesOverlay } from "../notes-overlay";

export function registerNotesOverlayHandlers(): void {
  ipcMain.on("notes-overlay:resize", (_e, height: number) => resizeNotesOverlay(height));
  ipcMain.on("notes-overlay:hide", () => hideNotesOverlay());
  ipcMain.on("notes-overlay:show", () => showNotesOverlay());
}
