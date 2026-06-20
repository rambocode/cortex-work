import { app, autoUpdater as electronAutoUpdater, BrowserWindow, globalShortcut, ipcMain, powerMonitor } from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import {
  registerIpcHandlers,
  killAllCli,
  killAllAsk,
  killAllPiSessions,
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
import {
  resolveHotkeyRegistration,
  rebindCandidates,
  resolveRebindChain,
  isValidAccelerator,
  NOTES_HOTKEY_ACCELERATOR,
  NOTES_HOTKEY_INVALID_TOAST,
  type HotkeyRegistration,
} from "./hotkey";
import { getPersistedState } from "./ipc/store";
import { getDesktopBehavior, initDesktopBehavior, registerDesktopHandlers } from "./desktop-behavior";
import { initLogger, patchConsole, registerLogHandlers } from "./logger";
import { getRuntimeAppVersion } from "./app-version";

const appIconPath = join(__dirname, "../../assets/cortex-neuron-icon.png");

let mainWindow: BrowserWindow | null = null;
// 真正退出标志:仅托盘「退出」/ before-quit 时置 true。关窗(X)默认只隐藏到后台。
let isQuitting = false;
let realQuitCleanupStarted = false;
// 闪记全局热键被占用时的降级提示文案(register 早于建窗,暂存待主窗口就绪后 best-effort 推送)。
let notesHotkeyToast: string | null = null;
// 当前已注册的闪记热键 accelerator(精确 unregister 用,避免 unregisterAll 误伤其它全局键)。
// 空串 = 当前无任何已注册绑定。
let currentNotesAccelerator = "";

// 精确解绑当前已注册的闪记热键(若有),并清空 currentNotesAccelerator。
// 仅解绑自己注册的那一个,不调 unregisterAll(避免误伤其它全局键)。
function unregisterNotesHotkey(): void {
  if (!currentNotesAccelerator) return;
  try {
    globalShortcut.unregister(currentNotesAccelerator);
  } catch {
    // 解绑失败忽略(可能本就未注册)。
  }
  currentNotesAccelerator = "";
}

// 注册闪记热键:先精确解绑当前已注册的旧键,再注册新键。仅在 register 成功时
// 更新 currentNotesAccelerator。返回 resolveHotkeyRegistration 归一化结果。
// 注意:不做格式校验(调用方保证 accelerator 合法),也不调 unregisterAll。
function registerNotesHotkey(accelerator: string): HotkeyRegistration {
  unregisterNotesHotkey();
  const ok = globalShortcut.register(accelerator, toggleNotesOverlay);
  if (ok) currentNotesAccelerator = accelerator;
  return resolveHotkeyRegistration(ok);
}

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
      // macOS 兜底:万一进程类型仍残留在 accessory(曾切过),hide 到托盘后 Dock 图标会消失。
      // 显式 dock.show() 拉回 regular,保证「关窗隐藏到托盘、Dock 图标继续保留、可从程序坞点回」。
      if (process.platform === "darwin") void app.dock?.show();
    } else {
      markRealQuit();
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

function markRealQuit(): void {
  isQuitting = true;
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
    event.returnValue = {
      version: getRuntimeAppVersion(),
      os: normalizedOS(),
      devMode: is.dev && !!process.env["ELECTRON_RENDERER_URL"],
    };
  });

  // 闪记热键降级提示:渲染端 mount 后拉取一次性消费(consume-pending,仿 spotlight,
  // 避免 push 早于 listener 注册而丢提示);无降级返回 null。
  ipcMain.handle("notes:consumeHotkeyDegraded", () => {
    const t = notesHotkeyToast;
    notesHotkeyToast = null;
    return t;
  });

  // 渲染端在设置里改闪记热键 → 主进程即时重注册(仿 desktop:setBehavior 的即时通路)。
  // 流程:格式校验 → 构造三级兜底候选链(新键 → 旧键 → 默认键,去重)→ 先精确解绑当前键 →
  // 逐个 register,首个成功即停 → resolveRebindChain 决策。三级全失败则无可用绑定、明确降级。
  // 返回 HotkeyRegistration(preload 适配成 bridge 契约 { ok, toast })。
  ipcMain.handle("notes:setHotkey", (_e, acc: string): HotkeyRegistration => {
    if (!isValidAccelerator(acc)) {
      return { registered: false, degraded: true, toast: NOTES_HOTKEY_INVALID_TOAST };
    }
    const oldAcc = currentNotesAccelerator;
    const candidates = rebindCandidates(acc, oldAcc);
    // 先解绑当前键,再逐个尝试候选;首个 register 成功即停,记录其下标。
    unregisterNotesHotkey();
    let successIdx = -1;
    for (let i = 0; i < candidates.length; i += 1) {
      if (globalShortcut.register(candidates[i]!, toggleNotesOverlay)) {
        currentNotesAccelerator = candidates[i]!;
        successIdx = i;
        break;
      }
    }
    const decision = resolveRebindChain(oldAcc, acc, candidates, successIdx);
    return { registered: decision.registered, degraded: decision.degraded, toast: decision.toast };
  });

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId("ai.cortex.work");
    if (process.platform === "darwin" && app.dock) app.dock.setIcon(appIconPath);
    app.on("browser-window-created", (_, window) => optimizer.watchWindowShortcuts(window));

    // 最前接管 console（幂等,默认启用）,捕获 ensureMigrated 等启动期错误入文件日志;
    // initLogger 稍后读设置再调整开关 + 清理过期。
    patchConsole();
    await ensureMigrated();
    registerIpcHandlers({
      update: { beforeInstall: markRealQuit },
      agentTraceDevMode: is.dev && !!process.env["ELECTRON_RENDERER_URL"],
    });
    registerDesktopHandlers();
    registerLogHandlers();
    registerSpotlightHandlers({ showMainWindow, getMainWindow: () => mainWindow });
    registerNotesOverlayHandlers();
    // 全局热键唤起闪记浮层(全仓首次用 globalShortcut)。读用户配置的 notesHotkey,
    // 无效或缺失则回退默认 NOTES_HOTKEY_ACCELERATOR。register 返回 false = 被占用 →
    // 不抛错,降级到仅窗口图标入口,并把提示文案在主窗口就绪后 best-effort 推给渲染端 toast。
    const configuredHotkey = (await getPersistedState()).generalSettings?.notesHotkey;
    const startupAccelerator =
      configuredHotkey && isValidAccelerator(configuredHotkey) ? configuredHotkey : NOTES_HOTKEY_ACCELERATOR;
    const hotkey = registerNotesHotkey(startupAccelerator);
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
        markRealQuit();
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
    killAllAsk();
    killAllPiSessions();
    killAllPty();
    closeAllWatchers();
  });

  // 真正退出（托盘退出 / 系统关机）:停调度 + 终止所有自动化进程 + 常规清理。
  const onRealQuit = () => {
    if (realQuitCleanupStarted) return;
    realQuitCleanupStarted = true;
    markRealQuit();
    stopScheduler();
    killAllAutomations();
    killAllCli();
    killAllAsk();
    killAllPiSessions();
    killAllPty();
    closeAllWatchers();
    destroyTray();
    destroySpotlight();
    destroyNotesOverlay();
    globalShortcut.unregisterAll();
  };
  app.on("before-quit", onRealQuit);
  // 自动更新「重启更新」(autoUpdater.quitAndInstall)会先关窗口再正常退出;
  // 若不提前进入真实退出态,closeToTray 会把窗口关动作拦成 hide,导致安装流程卡住。
  // before-quit-for-update 是 Electron 原生 autoUpdater 事件,不是 app 事件。
  electronAutoUpdater.on("before-quit-for-update", onRealQuit);
}
