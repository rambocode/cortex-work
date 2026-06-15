import { app, BrowserWindow, globalShortcut, ipcMain, powerMonitor } from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import {
  registerIpcHandlers,
  killAllCli,
  killAllPty,
  closeAllWatchers,
  killAllAutomations,
} from "./ipc/register";
import { ensureMigrated } from "./paths";
import { initScheduler, rescheduleAll, stopScheduler } from "./automation/scheduler";
import { createTray, destroyTray } from "./automation/tray";
import { toggleSpotlight, destroySpotlight, getSpotlightWindow } from "./spotlight";
import { registerSpotlightHandlers } from "./ipc/spotlight";
import { toggleNotesOverlay, destroyNotesOverlay, getNotesOverlayWindow } from "./notes-overlay";
import { registerNotesOverlayHandlers } from "./ipc/notes-overlay";
import { resolveHotkeyRegistration, NOTES_HOTKEY_ACCELERATOR } from "./hotkey";
import { getDesktopBehavior, initDesktopBehavior, registerDesktopHandlers } from "./desktop-behavior";
import { initLogger, patchConsole, registerLogHandlers } from "./logger";

const appIconPath = join(__dirname, "../../assets/cortex-neuron-icon.png");

let mainWindow: BrowserWindow | null = null;
// 真正退出标志:仅托盘「退出」/ before-quit 时置 true。关窗(X)默认只隐藏到后台。
let isQuitting = false;
// 闪记全局热键被占用时的降级提示文案(register 早于建窗,暂存待主窗口就绪后 best-effort 推送)。
let notesHotkeyToast: string | null = null;

function normalizedOS(): "macos" | "windows" | "linux" | "unknown" {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 13 },
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#cfcbc1",
    icon: appIconPath,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  // 启动最小化：不显示主窗口（仅托盘常驻）;否则就绪即显示。
  mainWindow.on("ready-to-show", () => {
    if (!getDesktopBehavior().startMinimized) mainWindow?.show();
  });

  // 关窗：closeToTray 开 → 隐藏到后台（托盘常驻,定时任务继续触发）;关 → 关窗即退出。
  // 真正退出（托盘退出 / before-quit）置 isQuitting,直接放行。
  mainWindow.on("close", (e) => {
    if (isQuitting) return;
    if (getDesktopBehavior().closeToTray) {
      e.preventDefault();
      mainWindow?.hide();
    } else {
      isQuitting = true;
      app.quit();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// 显示主窗口（隐藏则恢复,已销毁则重建）。托盘点击 / 第二实例 / activate 共用。
function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

// 单实例锁:防止多开导致多个调度器重复触发同一定时任务。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());

  // 同步 app 信息给 preload 桥。
  ipcMain.on("app:get-info", (event) => {
    event.returnValue = { version: app.getVersion(), os: normalizedOS() };
  });

  // 闪记热键降级提示:渲染端 mount 后拉取一次性消费(consume-pending,仿 spotlight,
  // 避免 push 早于 listener 注册而丢提示);无降级返回 null。
  ipcMain.handle("notes:consumeHotkeyDegraded", () => {
    const t = notesHotkeyToast;
    notesHotkeyToast = null;
    return t;
  });

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId("ai.cortex.work");
    if (process.platform === "darwin" && app.dock) app.dock.setIcon(appIconPath);
    app.on("browser-window-created", (_, window) => optimizer.watchWindowShortcuts(window));

    // 最前接管 console（幂等,默认启用）,捕获 ensureMigrated 等启动期错误入文件日志;
    // initLogger 稍后读设置再调整开关 + 清理过期。
    patchConsole();
    await ensureMigrated();
    registerIpcHandlers();
    registerDesktopHandlers();
    registerLogHandlers();
    registerSpotlightHandlers({ showMainWindow, getMainWindow: () => mainWindow });
    registerNotesOverlayHandlers();
    // 全局热键唤起闪记浮层(全仓首次用 globalShortcut)。register 返回 false = 被占用 →
    // 不抛错,降级到仅窗口图标入口,并把提示文案在主窗口就绪后 best-effort 推给渲染端 toast。
    const hotkey = resolveHotkeyRegistration(
      globalShortcut.register(NOTES_HOTKEY_ACCELERATOR, toggleNotesOverlay),
    );
    if (hotkey.degraded && hotkey.toast) {
      console.warn(`[notes] 全局热键注册失败: ${hotkey.toast}`);
      notesHotkeyToast = hotkey.toast;
    }
    // 启动恢复桌面行为（登录项 + 供 ready-to-show 读 startMinimized）,须在建窗前。
    await initDesktopBehavior();
    await initLogger();
    // 先建托盘:即使建窗失败也保留后台入口与调度。
    createTray({
      onShow: showMainWindow,
      onQuit: () => {
        isQuitting = true;
        app.quit();
      },
      onToggleSpotlight: toggleSpotlight,
    });
    await initScheduler();
    createWindow();

    app.on("activate", () => {
      // 排除 Spotlight / 闪记浮层:避免「主窗口已关、只剩浮窗」时点 Dock 不重建主窗口。
      const real = BrowserWindow.getAllWindows().filter(
        (w) => w !== getSpotlightWindow() && w !== getNotesOverlayWindow(),
      );
      if (real.length === 0) createWindow();
      else showMainWindow();
    });

    // 休眠唤醒后补漏 + 重建定时器（内存定时器在睡眠期间会漂移/错过）。
    powerMonitor.on("resume", () => {
      void rescheduleAll();
    });
  });

  // 关窗后所有平台都常驻后台（托盘）。清理交互式会话/终端/监听（renderer 已无,
  // 事件无人接收）,但 automation 调度器与 runningAutomations 独立存活,不受影响。
  // 不调用 app.quit()。
  app.on("window-all-closed", () => {
    killAllCli();
    killAllPty();
    closeAllWatchers();
  });

  // 真正退出（托盘退出 / 系统关机）:停调度 + 终止所有自动化进程 + 常规清理。
  app.on("before-quit", () => {
    isQuitting = true;
    stopScheduler();
    killAllAutomations();
    killAllCli();
    killAllPty();
    closeAllWatchers();
    destroyTray();
    destroySpotlight();
    destroyNotesOverlay();
    globalShortcut.unregisterAll();
  });
}
