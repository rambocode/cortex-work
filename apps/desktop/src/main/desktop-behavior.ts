// 桌面行为：开机自启 / 启动最小化 / 关闭到托盘。
// 主进程持内存镜像（关窗、ready-to-show 时读）；登录项是系统设置,须在切换时即时调
// setLoginItemSettings（仅 macOS / Windows 支持）。

import { app, ipcMain } from "electron";
import { DEFAULT_GENERAL_SETTINGS, type DesktopBehavior } from "./ipc/types";
import { getPersistedState } from "./ipc/store";

let current: DesktopBehavior = { ...DEFAULT_GENERAL_SETTINGS.desktopBehavior };

export function getDesktopBehavior(): DesktopBehavior {
  return current;
}

function applyLoginItem(b: DesktopBehavior): void {
  if (process.platform === "darwin" || process.platform === "win32") {
    app.setLoginItemSettings({ openAtLogin: b.openAtLogin, openAsHidden: b.startMinimized });
  }
}

// 启动时从持久化状态恢复并应用登录项（main 在 createWindow 前调用,使 ready-to-show 读到值）。
export async function initDesktopBehavior(): Promise<void> {
  const stored = (await getPersistedState()).generalSettings?.desktopBehavior;
  current = { ...DEFAULT_GENERAL_SETTINGS.desktopBehavior, ...stored };
  applyLoginItem(current);
}

export function setDesktopBehavior(b: DesktopBehavior): void {
  current = b;
  applyLoginItem(b);
}

export function registerDesktopHandlers(): void {
  ipcMain.handle("desktop:setBehavior", (_e, b: DesktopBehavior) => setDesktopBehavior(b));
}
