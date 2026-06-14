// 菜单栏 Spotlight 浮动聊天框窗口（第二窗口）。frameless + 透明 + 置顶,复用主窗口同一
// preload（window.desktopAPI 可用）。左键托盘 toggle 唤起,失焦自动隐藏。发送由
// ipc/spotlight.ts 接力到主窗口。

import { BrowserWindow, screen } from "electron";
import { join } from "path";
import { existsSync } from "fs";
import { is } from "@electron-toolkit/utils";

const BAR_WIDTH = 780;
const BAR_HEIGHT = 124; // 折叠态(单行输入条 + 内边距 + 投影留白);实际高度由 renderer 按内容实测上报
const MAX_HEIGHT = 560; // New Chat 弹层展开上限
const BOTTOM_MARGIN = 120; // 离屏幕底部留白

let win: BrowserWindow | null = null;

function spotlightHtml(): string {
  const flat = join(__dirname, "../renderer/spotlight.html");
  const nested = join(__dirname, "../renderer/src/spotlight.html");
  return existsSync(flat) ? flat : nested;
}

function position(w: BrowserWindow, height: number): void {
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const x = Math.round(workArea.x + (workArea.width - BAR_WIDTH) / 2);
  const y = Math.round(workArea.y + workArea.height - height - BOTTOM_MARGIN);
  w.setBounds({ x, y, width: BAR_WIDTH, height });
}

function create(): BrowserWindow {
  win = new BrowserWindow({
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  if (process.platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/spotlight.html`);
  } else {
    void win.loadFile(spotlightHtml());
  }
  win.on("blur", () => hideSpotlight());
  win.on("closed", () => {
    win = null;
  });
  return win;
}

export function showSpotlight(): void {
  const w = win && !win.isDestroyed() ? win : create();
  position(w, BAR_HEIGHT);
  if (process.platform === "darwin") w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.showInactive();
  w.focus();
}

export function hideSpotlight(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

export function toggleSpotlight(): void {
  if (win && !win.isDestroyed() && win.isVisible()) hideSpotlight();
  else showSpotlight();
}

export function resizeSpotlight(height: number): void {
  if (!win || win.isDestroyed()) return;
  const h = Math.max(BAR_HEIGHT, Math.min(Math.round(height), MAX_HEIGHT));
  position(win, h);
}

export function getSpotlightWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function destroySpotlight(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
