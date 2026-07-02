// 「项目管理」独立桌面窗口（第五个二级窗口，与 spotlight / notes / agent-trace / notification 并列）。
// 骨架照抄 agent-trace-window.ts：模块级单例 + closed 置空 + HTML 双路径兜底；标题栏照主窗
// （hiddenInset + trafficLightPosition，见 main/index.ts）。渲染入口 projects-window.tsx 自包
// CoreProvider + toast 宿主，挂载三栏工作台 ProjectsWorkbench。
//
// 跨窗口数据一致完全由 main 的 broadcastTasksChanged() → 各窗口 React Query invalidate 承担，
// 本窗口无需与主窗口直接通信（见计划 KTD3）。
//
// 本单元（U2）只做窗口创建与基础 close→destroy 生命周期；关窗前 flush 未保存草稿的握手由 U7 补。

import { BrowserWindow, ipcMain, screen } from "electron";
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

function create(): BrowserWindow {
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

  // 关窗前持久化正常 bounds（最小化/全屏态跳过，避免异常几何覆盖正常值）。
  // 注意：本单元只做基础 close→destroy；U7 会在此接入草稿 flush 握手。
  win.on("close", () => {
    if (!win || win.isDestroyed()) return;
    const next = boundsToPersist(win.getNormalBounds(), {
      minimized: win.isMinimized(),
      fullscreen: win.isFullScreen(),
    });
    if (next) writeSavedBounds(next);
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
}
