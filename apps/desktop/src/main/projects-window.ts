// 「项目管理」独立桌面窗口（第五个二级窗口，与 spotlight / notes / agent-trace / notification 并列）。
// 骨架照抄 agent-trace-window.ts：模块级单例 + closed 置空 + HTML 双路径兜底；标题栏照主窗
// （hiddenInset + trafficLightPosition，见 main/index.ts）。渲染入口 projects-window.tsx 自包
// CoreProvider + toast 宿主，挂载三栏工作台 ProjectsWorkbench。
//
// 跨窗口数据一致完全由 main 的 broadcastTasksChanged() → 各窗口 React Query invalidate 承担，
// 本窗口无需与主窗口直接通信（见计划 KTD3）。
//
// 本单元（U2）只做窗口创建与基础 close→destroy 生命周期；关窗前 flush 未保存草稿的握手由 U7 补。

import { app, BrowserWindow, ipcMain, screen, type IpcMainEvent } from "electron";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { is } from "@electron-toolkit/utils";
import { cortexHome } from "./paths";
import {
  clampProjectsBounds,
  defaultProjectsBounds,
  boundsToPersist,
  PROJECTS_WINDOW_MIN_WIDTH,
  PROJECTS_WINDOW_MIN_HEIGHT,
  type WindowBounds,
} from "./projects-window-geometry";

let win: BrowserWindow | null = null;
// 关窗握手进行中标志：close 拦截后置真，防止握手期间重复发起（destroy 不再触发 close，
// 理论到不了二次 close，此为防御）。create() 复用模块级 win，故建窗时必须复位。
let closing = false;

// 关窗草稿 flush 握手最长等待（R21/KTD6）：renderer 崩溃/卡死/无草稿注册表时也必须关得掉窗，
// 超时即强制销毁。取值略大于渲染端等 mutation 落库的上限，给正常路径留足回执时间。
const FLUSH_TIMEOUT_MS = 2500;

// app 退出中标志：before-quit 后置真。关窗握手会 preventDefault close，若在 app 退出路径上拦截会
// 阻断整个退出流程；故退出时放行关闭，草稿改由 renderer 的 beforeunload 同步兜底（见 projects-window.tsx）。
let appQuitting = false;

// prod 下 html 可能落在 flat(../renderer/projects.html)或 nested(../renderer/src/projects.html)：
// 双路径 existsSync 探测兜底（漏抄会打包后白屏）。仿 agent-trace-window.ts。
function projectsHtml(): string {
  const flat = join(__dirname, "../renderer/projects.html");
  const nested = join(__dirname, "../renderer/src/projects.html");
  return existsSync(flat) ? flat : nested;
}

// 窗口 bounds 用独立小文件持久化（~/.cortex-desktop/projects-window-state.json），main 独占读写。
// 刻意不写入 personal-workspace.json：那是 renderer 全量快照，双窗口下会互相 clobber（见 KTD9）；
// 窗口几何是 main 侧关注点，与业务态解耦。
function boundsStorePath(): string {
  return join(cortexHome(), "projects-window-state.json");
}

function readSavedBounds(): WindowBounds | null {
  try {
    const parsed = JSON.parse(readFileSync(boundsStorePath(), "utf8")) as Partial<WindowBounds>;
    if (
      typeof parsed.x === "number" &&
      typeof parsed.y === "number" &&
      typeof parsed.width === "number" &&
      typeof parsed.height === "number"
    ) {
      return { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height };
    }
  } catch {
    // 首开或文件损坏 → 无持久值，回退默认居中。
  }
  return null;
}

function writeSavedBounds(bounds: WindowBounds): void {
  try {
    writeFileSync(boundsStorePath(), JSON.stringify(bounds), "utf8");
  } catch {
    // 落盘失败不阻断关窗（下次回退默认，无数据安全影响）。
  }
}

// 建窗初始 bounds：有持久值则 clamp 到现存显示器工作区（外接屏断开防离屏），否则默认居中于主屏。
function initialBounds(): WindowBounds {
  const saved = readSavedBounds();
  if (saved) {
    const workAreas = screen.getAllDisplays().map((d) => d.workArea);
    return clampProjectsBounds(saved, workAreas);
  }
  return defaultProjectsBounds(screen.getPrimaryDisplay().workArea);
}

// 发起草稿 flush 握手（R21/KTD6）：向 renderer 发 flush-request，等其提交 pending 草稿并落库后
// 回执（flush-done）→ 销毁；无响应则 FLUSH_TIMEOUT_MS 后强制销毁。仅接受本窗口 webContents 的回执，
// 避免其它窗口的同名事件误触发；settled 保证「回执」与「超时」只生效一次。
function beginFlushHandshake(target: BrowserWindow): void {
  let settled = false;
  const onDone = (e: IpcMainEvent): void => {
    if (!target.isDestroyed() && e.sender === target.webContents) finish();
  };
  // finish 用函数声明（提升）：可在 timer 声明之前被 onDone 引用，实际调用均发生在 timer 初始化之后。
  function finish(): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ipcMain.removeListener("projects-window:flush-done", onDone);
    if (win && !win.isDestroyed()) win.destroy();
  }
  ipcMain.on("projects-window:flush-done", onDone);
  const timer = setTimeout(finish, FLUSH_TIMEOUT_MS);
  if (!target.isDestroyed()) target.webContents.send("projects-window:flush-request");
  else finish();
}

function create(): BrowserWindow {
  closing = false; // 单例复用模块级 win，新建窗口时复位握手标志
  win = new BrowserWindow({
    ...initialBounds(),
    minWidth: PROJECTS_WINDOW_MIN_WIDTH,
    minHeight: PROJECTS_WINDOW_MIN_HEIGHT,
    title: "项目管理",
    // 标题栏照主窗：hiddenInset + 交通灯偏移（工具栏由 U4 自绘并避让 84px 红绿灯）。
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 13 },
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#cfcbc1",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/projects.html`);
  } else {
    void win.loadFile(projectsHtml());
  }

  // close 拦截 → 先持久化 bounds，再发起草稿 flush 握手（拦截默认关闭，等 renderer 回执/超时后销毁）。
  // bounds 持久化：正常 bounds（最小化/全屏态跳过，避免异常几何覆盖正常值），每次 close 幂等执行。
  win.on("close", (e) => {
    if (!win || win.isDestroyed()) return;
    const next = boundsToPersist(win.getNormalBounds(), {
      minimized: win.isMinimized(),
      fullscreen: win.isFullScreen(),
    });
    if (next) writeSavedBounds(next);
    // app 退出路径：不拦截，直接放行关闭（否则 preventDefault 会阻断整个退出）；草稿由 beforeunload 兜底。
    if (appQuitting) return;
    if (closing) return; // 握手已在进行（destroy 不再触发 close）——防御性放行
    closing = true;
    e.preventDefault(); // 拦截默认关闭：先 flush 未保存草稿（R21）再销毁，避免静默丢数据
    beginFlushHandshake(win);
  });
  win.on("closed", () => {
    win = null;
  });
  return win;
}

// 打开（或聚焦）项目管理窗口：单例——已存在则 restore + focus，不再创建第二个实例。
export function showProjectsWindow(): void {
  const w = win && !win.isDestroyed() ? win : create();
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

export function getProjectsWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function destroyProjectsWindow(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

// 侧栏「项目管理」入口经 desktopAPI.projectsWindow.open() 调用（preload 顶层能力）。
export function registerProjectsWindowHandlers(): void {
  ipcMain.handle("projects-window:open", () => {
    showProjectsWindow();
  });
  // app 退出（托盘退出 / Cmd+Q / 更新前退出）会先触发 before-quit，再向各窗口派发 close。
  // 记录退出中标志，使 close 拦截在退出路径上放行（见上方 close handler）。
  app.on("before-quit", () => {
    appQuitting = true;
  });
}

// 委派意图跨窗口中继（KTD10）：项目管理窗口的 sessions 是 renderer 本地 Zustand、不跨窗口，
// 故委派不能在项目窗口本地起会话——项目窗口只发意图（send），main 在此显式定位并唤起主窗口
// （不用 getAllWindows()[0]，避免误命中项目/浮层等其它窗口），再把意图转发给主窗口 renderer 执行。
// 与 registerProjectsWindowHandlers 分开：本函数需要主窗口引用，从 index.ts 传入（仿 spotlight）。
export function registerProjectsDelegateRelay(opts: {
  showMainWindow: () => void;
  getMainWindow: () => BrowserWindow | null;
}): void {
  ipcMain.on("task-delegate:intent", (_e, intent: { taskId: string }) => {
    // 主窗口可能被 close-to-tray 隐藏，先 show()+focus() 唤起（参照 push-on-complete 的窗口唤醒式样）。
    opts.showMainWindow();
    const win = opts.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send("task-delegate:intent", intent);
  });
}
