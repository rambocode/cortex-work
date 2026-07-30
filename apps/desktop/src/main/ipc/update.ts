// 应用自动更新（electron-updater + GitHub Releases）。
// 主进程持有状态机快照,每次变化广播 "update:state" 给所有窗口;
// renderer 挂载后用 "update:getState" 补拉,避免错过早期推送。
// 更新源在 electron-builder.yml 的 publish 字段配置。

import { app, ipcMain, BrowserWindow, powerMonitor } from "electron";
import { autoUpdater } from "electron-updater";
import { createLogger } from "../log";
import { reduceUpdate, normalizeReleaseNotes, type UpdaterEvent } from "./update-state";
import type { UpdateState } from "./types";

// 近实时更新:启动 6s 后首查,长开会话每 5 分钟复查;激活/唤醒再补查。
const FIRST_CHECK_DELAY_MS = 6_000;
const CHECK_INTERVAL_MS = 5 * 60_000;

// 更新源是否已真正配置。electron-builder.yml 的 publish.owner 是占位符时,
// checkForUpdates 会对 releases.atom 反复 404,污染日志,故未配置时跳过检查。
// 当前已配真实源 rambocode/cortex-work-release（公开 release 库）,启用自动更新(需远端建好 release 才能检到)。
const UPDATE_FEED_CONFIGURED = true;

let state: UpdateState = { phase: "idle" };

export interface RegisterUpdateHandlersOptions {
  beforeInstall?: () => void;
}

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

export function registerUpdateHandlers(options: RegisterUpdateHandlersOptions = {}): void {
  // 用户主导:仅「下载」改为手动(用户在更新弹窗点「下载更新」才 downloadUpdate)。
  // autoInstallOnAppQuit 保留——下载完成后既可点「重启更新」,也会在下次正常退出时静默安装。
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // 接通 electron-updater 内部日志到统一日志管线(scope: updater)。
  // 关键价值:blockmap 差量下载失败时 electron-updater 会静默回退全量
  // ("Cannot download differentially, fallback to full download"),不接日志则完全不可观测。
  autoUpdater.logger = createLogger("updater");

  autoUpdater.on("checking-for-update", () => dispatch({ type: "checking" }));
  // 采集 info.releaseNotes(来自打包写入清单的 markdown)并归一化,供更新弹窗展示。
  autoUpdater.on("update-available", (info) =>
    dispatch({ type: "available", version: info.version, releaseNotes: normalizeReleaseNotes(info.releaseNotes) }),
  );
  autoUpdater.on("update-not-available", () => dispatch({ type: "not-available" }));
  autoUpdater.on("download-progress", (p) => dispatch({ type: "progress", percent: p.percent }));
  autoUpdater.on("update-downloaded", (info) =>
    dispatch({ type: "downloaded", version: info.version, releaseNotes: normalizeReleaseNotes(info.releaseNotes) }),
  );
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
  ipcMain.handle("update:install", () => {
    options.beforeInstall?.();
    autoUpdater.quitAndInstall();
  });

  // dev（未打包）默认没有 app-update.yml,electron-updater 无法工作,跳过定时检查。
  // 更新源未配置时同样跳过,避免空转与 releases.atom 反复 404。
  if (!app.isPackaged || !UPDATE_FEED_CONFIGURED) return;
  setTimeout(() => void safeCheck(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void safeCheck(), CHECK_INTERVAL_MS);
  app.on("activate", () => void safeCheck());
  powerMonitor.on("resume", () => void safeCheck());
}
