// Spotlight 浮动框 IPC:接收 bar 的发起意图,隐藏浮动框 + 唤起主窗口 + 把 intent
// 接力给主窗口（暖窗口走 live 事件;冷启动/加载中走 pending,主窗口 mount 时 consume）。

import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import { hideSpotlight, resizeSpotlight } from "../spotlight";
import type { SpotlightIntent } from "./types";

let pending: SpotlightIntent | null = null;

export function registerSpotlightHandlers(opts: {
  showMainWindow: () => void;
  getMainWindow: () => BrowserWindow | null;
}): void {
  ipcMain.handle("spotlight:submit", (_e, intent: SpotlightIntent) => {
    hideSpotlight();
    const existing = opts.getMainWindow();
    const warm = !!existing && !existing.isDestroyed() && !existing.webContents.isLoading();
    opts.showMainWindow();
    const win = opts.getMainWindow();
    if (warm && win && !win.isDestroyed()) {
      win.webContents.send("spotlight:intent", intent);
    } else {
      // 冷启动/加载中:主窗口 mount 时 consumePending 兜底（避免在 listener 注册前发丢）。
      pending = intent;
    }
  });
  ipcMain.handle("spotlight:consumePending", () => {
    const i = pending;
    pending = null;
    return i;
  });
  ipcMain.on("spotlight:resize", (_e, height: number) => resizeSpotlight(height));
  ipcMain.on("spotlight:hide", () => hideSpotlight());
}
