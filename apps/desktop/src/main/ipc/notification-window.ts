// 独立通知窗体 IPC:
//  - notification:push(主窗渲染端 → 主进程):转发一条提醒到窗体(主窗失焦时,决策在 App.tsx)。
//  - notification:resize(窗体渲染端 → 主进程):上报实测高度,夹取重定位 / 空栈隐藏。
//  - notification:clear(主窗渲染端 → 主进程):主窗重获焦点时清空外部通知。
// 仿 ipc/notes-overlay.ts。

import { ipcMain } from "electron";
import type { NotificationPayload } from "./types";
import {
  pushNotification,
  resizeNotificationWindow,
  clearNotifications,
  notificationRendererReady,
} from "../notification-window";

export function registerNotificationWindowHandlers(): void {
  ipcMain.on("notification:push", (_e, payload: NotificationPayload) => pushNotification(payload));
  ipcMain.on("notification:resize", (_e, height: number) => resizeNotificationWindow(height));
  ipcMain.on("notification:clear", () => clearNotifications());
  // 窗体渲染端注册完监听后的就绪回执:冲刷 ready 前积压的 payload(防首发丢失,见 notification-window.ts)。
  ipcMain.on("notification:ready", () => notificationRendererReady());
}
