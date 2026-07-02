import { app, autoUpdater as electronAutoUpdater, BrowserWindow, globalShortcut, ipcMain, powerMonitor } from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { runTaskMigration } from "./ipc/tasks-migrate";
import {
  registerIpcHandlers,
  killAllCli,
  killAllAsk,
  killAllPiSessions,
  killAllPty,
  closeAllWatchers,
  killAllAutomations,
  killAllOrchestrations,
  killAllRoundtables,
} from "./ipc/register";
import { installBrowserWebviewGuards } from "./browser/webviewGuards";
import { configureBrowserPartition } from "./browser/partition";
import { ensureMigrated } from "./paths";
import { initScheduler, rescheduleAll, stopScheduler } from "./automation/scheduler";
import { tasksStore, tasksReminderScheduler, isTasksReminderOptInEnabled } from "./ipc/tasks";
import { startMcpHost, stopMcpHost } from "./capabilities/mcp-host/server";
import { registerBrowserTools } from "./capabilities/browser/tools";
import { startDocExtractHost, stopDocExtractHost } from "./capabilities/doc-extract/mcp";
import { startMediaGenHost, stopMediaGenHost } from "./capabilities/media-gen/server";
import { startLoopWorkflowsHost, stopLoopWorkflowsHost } from "./capabilities/loop-workflows/server";
import { startDelegateHost, stopDelegateHost, killAllDelegates } from "./capabilities/delegate/server";
import { initWorkflowRuntime, killAllWorkflows } from "./workflow/index";
import { loadWorkflows, markOrphanRunsKilled } from "./workflow/store";
import { initWorkflowScheduler } from "./workflow/scheduler";
import { createTray, destroyTray } from "./automation/tray";
import { toggleSpotlight, destroySpotlight, getSpotlightWindow } from "./spotlight";
import { registerSpotlightHandlers } from "./ipc/spotlight";
import { registerProjectsDelegateRelay } from "./projects-window";
import { toggleNotesOverlay, destroyNotesOverlay, getNotesOverlayWindow } from "./notes-overlay";
import { registerNotesOverlayHandlers } from "./ipc/notes-overlay";
import { destroyNotificationWindow, clearNotifications } from "./notification-window";
import { registerNotificationWindowHandlers } from "./ipc/notification-window";
import {
  destroyAgentTraceWindow,
  getAgentTraceWindow,
  registerAgentTraceWindowHandlers,
} from "./agent-trace-window";
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
import { installGlobalCrashGuards } from "./crash-guards";
import { installAppMenu } from "./app-menu";
import { createLogger } from "./log";

const log = createLogger("main");

// 进程级崩溃兜底必须最先安装:历史崩溃为「异步 fs 扫描回调/漂浮 Promise 抛未捕获错误」
// → 主进程整体 SIGTRAP 退出。装在所有初始化之前,确保后续任何未捕获异常/拒绝只记日志、
// 不杀进程(ipcMain.handle 链内的 reject 由 Electron 转发渲染端,不会到这里)。
installGlobalCrashGuards();

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
  // macOS:启用原生侧栏 vibrancy(NSVisualEffectView「sidebar」材质),让左侧菜单栏透出桌面壁纸,
  // 并随壁纸明暗自适应磨砂质感。要让材质透出,窗口背景必须透明(#00000000)——否则不透明底色会盖在
  // vibrancy 之上;非 macOS 保持原不透明底色。CSS 侧由渲染端 <html data-vibrancy="sidebar"> 驱动,
  // 把侧栏背后的背景链一路打透到窗口(见 packages/views/cortex-desktop/cortex-desktop.css §Sidebar vibrancy)。
  // 二者门控条件一致——都仅 macOS;此处不设 transparent:true(那是给镂空/穿透窗用的,会让 vibrancy 失效)。
  const isMacOS = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 520,
    minHeight: 640,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 13 },
    show: false,
    autoHideMenuBar: true,
    backgroundColor: isMacOS ? "#00000000" : "#cfcbc1",
    ...(isMacOS
      ? {
          vibrancy: "sidebar" as const,
          // active:窗口失焦时仍保持磨砂(默认 followWindow 会在失焦时把材质褪为灰色平面),
          // 保证左侧菜单栏在任何焦点状态下都稳定透出壁纸。
          visualEffectState: "active" as const,
        }
      : {}),
    icon: appIconPath,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      // 开启内嵌浏览器 <webview> 能力。webview 的安全靠 installBrowserWebviewGuards()
      // 的三道闸门兜底(强制安全 prefs + 导航/新窗口闸门),见 browser/webviewGuards.ts。
      webviewTag: true,
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
  // 主窗重获焦点 → 清空独立通知窗体(回到应用即不再用外部窗体打扰;应用内 toast 接管)。
  mainWindow.on("focus", () => clearNotifications());

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
    // 内嵌浏览器 <webview> 安全闸门须在任何 webview 可能 attach 之前装好(建窗之前)。
    installBrowserWebviewGuards();
    configureBrowserPartition();
    // 真任务系统 v1→v2 迁移：必须在 registerIpcHandlers（store:load/save/tasks:*）之前 eager+await，
    // 使 renderer 的一切 store 访问都排在迁移之后处理，从根上消除「renderer 首个 save 先于迁移
    // 抹掉源 todos」的竞态（数据安全，见 U3/KTD2）。migratedAt 幂等，已迁移则纯 no-op。
    await runTaskMigration();
    registerIpcHandlers({
      update: { beforeInstall: markRealQuit },
      agentTraceDevMode: is.dev && !!process.env["ELECTRON_RENDERER_URL"],
    });
    registerAgentTraceWindowHandlers({ devMode: is.dev && !!process.env["ELECTRON_RENDERER_URL"] });
    registerDesktopHandlers();
    registerLogHandlers();
    registerSpotlightHandlers({ showMainWindow, getMainWindow: () => mainWindow });
    // 「项目管理」独立窗口 → 主窗口的委派意图中继（KTD10）。lazy getMainWindow：建窗在后（见下方 createWindow）。
    registerProjectsDelegateRelay({ showMainWindow, getMainWindow: () => mainWindow });
    registerNotesOverlayHandlers();
    registerNotificationWindowHandlers();
    // 全局热键唤起闪记浮层(全仓首次用 globalShortcut)。读用户配置的 notesHotkey,
    // 无效或缺失则回退默认 NOTES_HOTKEY_ACCELERATOR。register 返回 false = 被占用 →
    // 不抛错,降级到仅窗口图标入口,并把提示文案在主窗口就绪后 best-effort 推给渲染端 toast。
    const configuredHotkey = (await getPersistedState()).generalSettings?.notesHotkey;
    const startupAccelerator =
      configuredHotkey && isValidAccelerator(configuredHotkey) ? configuredHotkey : NOTES_HOTKEY_ACCELERATOR;
    const hotkey = registerNotesHotkey(startupAccelerator);
    if (hotkey.degraded && hotkey.toast) {
      log.warn(`[notes] 全局热键注册失败: ${hotkey.toast}`);
      notesHotkeyToast = hotkey.toast;
    }
    // 启动恢复桌面行为（登录项 + 供 ready-to-show 读 startMinimized）,须在建窗前。
    await initDesktopBehavior();
    // 日志初始化不得拖垮启动:initLogger 抛错(读设置/清理/electron-log 装配失败)若冒泡,
    // whenReady 续体 reject → 建窗及后续永不执行 → 主窗口永不出现(reliability 评审指出)。
    // console 接管已在更早的 patchConsole() 完成,故此处失败仅丢「读设置/清理」,降级继续。
    try {
      await initLogger();
    } catch (err) {
      console.error("[main] initLogger 失败,降级继续(不阻断建窗)", err);
    }
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
    // 任务提醒调度器（U11）：读初始 opt-in（内部原生通知）+ 当前任务快照建 Cron/补跑错过项。
    // setEnabled 先行（此时快照空，为 no-op），再 sync 真实任务；开机补跑「只补一次」靠 firedAt 闸门。
    {
      const state = await getPersistedState();
      tasksReminderScheduler.setEnabled(isTasksReminderOptInEnabled(state));
      tasksReminderScheduler.sync(await tasksStore.list());
    }
    // 工作流运行时（loop 引擎）：独立于 automation，与之并列。
    // fire-and-forget：调度器初始化快，失败已内部降级，不阻塞建窗。
    const workflowRuntime = initWorkflowRuntime()
    // P1 Fix-2：启动时标记残留的 running run 为 error（崩溃/强退后留下的孤儿 run）。
    // 对齐 automation/scheduler.ts initScheduler 中 markOrphanRunsKilled 的做法。
    markOrphanRunsKilled().catch((err) => {
      log.error('[workflow] markOrphanRunsKilled 失败:', err)
    })
    loadWorkflows().then((workflows) => {
      // P1 Fix-9（去重调度）：只保留一条初始化路径——initWorkflowScheduler 负责 catch-up，
      // sync() 主要负责 webhook server 启停。两者都调用 rescheduleWorkflows/runFn 会导致
      // catch-up 在 initWorkflowScheduler + sync() 内各触发一次（重复 run）。
      // 修：initWorkflowScheduler 做 catch-up + 建 cron job，sync() 只管 webhook server。
      initWorkflowScheduler(workflows, workflowRuntime.runNow)
      workflowRuntime.sync().catch((err) => {
        log.error('[workflow] sync 失败:', err)
      })
    }).catch((err) => {
      log.error('[workflow] loadWorkflows 失败:', err)
    })
    // 浏览器控制 MCP server:随主进程常驻(U2)。工具由 U5 注入;是否注入给 agent 由 U3 按总开关 gate。
    // fire-and-forget:listen 快且失败已内部降级,不阻塞建窗。
    // 注入运行时能力:openPanel 让 agent 的 browser_navigate 在面板未开时打开内置浏览器(经渲染端)。
    void startMcpHost((mcp, toolCtx) =>
      registerBrowserTools(mcp, toolCtx, {
        openPanel: (url) => mainWindow?.webContents.send("browser:open-panel", url),
      }),
    );
    // 文档抽取 MCP host:独立实例(独立 port/token),常驻可用;agent 经 extract_document 按需读附件。
    void startDocExtractHost();
    // 媒体生成 MCP host:独立实例,常驻;四模态全关时注入侧返回 null 不连接,host 仍在后台静默运行(U5)。
    void startMediaGenHost();
    // Loop 工作流 MCP host:独立实例,常驻;无 enabled+callable 工作流时注入侧返回 null（U14）。
    void startLoopWorkflowsHost();
    // 委派 MCP host:独立实例,常驻;本轮无被 @ 协作者时注入侧返回 null。主 agent 经 ask_<id> 自主委派。
    void startDelegateHost();
    // 安装自定义主菜单(去除 macOS View 菜单重复的全屏项),须在建窗前就位。
    installAppMenu();
    createWindow();

    app.on("activate", () => {
      // 排除 Spotlight / 闪记浮层:避免「主窗口已关、只剩浮窗」时点 Dock 不重建主窗口。
      const real = BrowserWindow.getAllWindows().filter(
        (w) => w !== getSpotlightWindow() && w !== getNotesOverlayWindow() && w !== getAgentTraceWindow(),
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
    killAllOrchestrations(); // 编排链路随窗口关闭终止（chat 级进程，不同于 automation）
    killAllRoundtables(); // 圆桌编排随窗口关闭终止
    killAllDelegates(); // 委派编排随窗口关闭终止
  });

  // 真正退出（托盘退出 / 系统关机）:停调度 + 终止所有自动化进程 + 常规清理。
  const onRealQuit = () => {
    if (realQuitCleanupStarted) return;
    realQuitCleanupStarted = true;
    markRealQuit();
    stopScheduler();
    tasksReminderScheduler.stop(); // 停任务提醒 Cron + 释放 powerSaveBlocker
    stopMcpHost();
    stopDocExtractHost();
    stopMediaGenHost();
    stopLoopWorkflowsHost();
    stopDelegateHost();
    killAllAutomations();
    killAllWorkflows();
    killAllOrchestrations(); // 编排链路回收（真正退出时）
    killAllRoundtables(); // 圆桌编排回收
    killAllDelegates(); // 委派编排回收
    killAllCli();
    killAllAsk();
    killAllPiSessions();
    killAllPty();
    closeAllWatchers();
    destroyTray();
    destroySpotlight();
    destroyNotesOverlay();
    destroyAgentTraceWindow();
    destroyNotificationWindow();
    globalShortcut.unregisterAll();
  };
  app.on("before-quit", onRealQuit);
  // 自动更新「重启更新」(autoUpdater.quitAndInstall)会先关窗口再正常退出;
  // 若不提前进入真实退出态,closeToTray 会把窗口关动作拦成 hide,导致安装流程卡住。
  // before-quit-for-update 是 Electron 原生 autoUpdater 事件,不是 app 事件。
  electronAutoUpdater.on("before-quit-for-update", onRealQuit);
}
