// 应用自动更新（electron-updater + GitHub Releases）。
// 主进程持有状态机快照,每次变化广播 "update:state" 给所有窗口;
// renderer 挂载后用 "update:getState" 补拉,避免错过早期推送。
// 更新源在 electron-builder.yml 的 publish 字段配置。

import { app, ipcMain, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { reduceUpdate, type UpdaterEvent } from "./update-state";
import type { UpdateState } from "./types";

// 与 fanbox 相同的检查节奏:启动 6s 后首查,长开会话每 2 小时复查。
const FIRST_CHECK_DELAY_MS = 6_000;
const CHECK_INTERVAL_MS = 2 * 3600_000;

// 更新源是否已真正配置。electron-builder.yml 的 publish.owner 是占位符时,
// checkForUpdates 会对 releases.atom 反复 404,污染日志,故未配置时跳过检查。
// 当前已配真实源 rambocode/cortex-desktop（公开 release 库）,启用自动更新(需远端建好 release 才能检到)。
const UPDATE_FEED_CONFIGURED = true;

let state: UpdateState = { phase: "idle" };

function dispatch(event: UpdaterEvent): void {
  const next = reduceUpdate(state, event);
  if (next === state) return;
  state = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("update:state", state);
  }
}

async function safeCheck(): Promise<void> {
  if (!UPDATE_FEED_CONFIGURED) return; // 更新源未配置,跳过以免反复 404
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    /* 失败已由 error 事件驱动状态机 */
  }
}

export function registerUpdateHandlers(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => dispatch({ type: "checking" }));
  autoUpdater.on("update-available", (info) => dispatch({ type: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => dispatch({ type: "not-available" }));
  autoUpdater.on("download-progress", (p) => dispatch({ type: "progress", percent: p.percent }));
  autoUpdater.on("update-downloaded", (info) => dispatch({ type: "downloaded", version: info.version }));
  autoUpdater.on("error", (err) => dispatch({ type: "error", message: err?.message ?? String(err) }));

  ipcMain.handle("update:getState", () => state);
  ipcMain.handle("update:check", async () => {
    if (app.isPackaged) await safeCheck();
    return state;
  });
  ipcMain.handle("update:download", () => {
    autoUpdater.downloadUpdate().catch(() => {
      /* 失败已由 error 事件驱动状态机 */
    });
  });
  ipcMain.handle("update:install", () => autoUpdater.quitAndInstall());

  // dev（未打包）没有 app-update.yml,electron-updater 无法工作;不自动检查。
  // 更新源未配置时同样跳过定时检查,避免空转与 releases.atom 反复 404。
  if (!app.isPackaged || !UPDATE_FEED_CONFIGURED) return;
  setTimeout(() => void safeCheck(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void safeCheck(), CHECK_INTERVAL_MS);
}
