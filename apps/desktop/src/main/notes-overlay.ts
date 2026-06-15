// 闪记(Flash Notes)浮层窗口（第三窗口,与 spotlight 并列）。frameless + 透明 + 置顶,复用
// 主窗口同一 preload（window.desktopAPI 可用）。全局热键 / 窗口图标 toggle 唤起,失焦自动隐藏。
// 闪记直接经 window.desktopAPI.personal.notesAdd 落盘,不经主窗口接力(故无 submit/pending,
// 与 spotlight 不同)。骨架照搬 spotlight.ts,几何夹取/定位抽到 notes-overlay-geometry.ts 可单测。

import { BrowserWindow, screen } from "electron";
import { join } from "path";
import { existsSync } from "fs";
import { is } from "@electron-toolkit/utils";
import {
  NOTES_WIDTH,
  NOTES_HEIGHT,
  clampNotesHeight,
  notesOverlayBounds,
} from "./notes-overlay-geometry";

let win: BrowserWindow | null = null;

// prod 下 html 可能落在 flat(../renderer/notes.html)或 nested(../renderer/src/notes.html);
// 双路径 existsSync 探测兜底(漏抄会打包后白屏)。仿 spotlight.ts:17-21。
function notesHtml(): string {
  const flat = join(__dirname, "../renderer/notes.html");
  const nested = join(__dirname, "../renderer/src/notes.html");
  return existsSync(flat) ? flat : nested;
}

function position(w: BrowserWindow, height: number): void {
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  w.setBounds(notesOverlayBounds(workArea, height));
}

function create(): BrowserWindow {
  win = new BrowserWindow({
    width: NOTES_WIDTH,
    height: NOTES_HEIGHT,
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
    void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/notes.html`);
  } else {
    void win.loadFile(notesHtml());
  }
  win.on("blur", () => hideNotesOverlay());
  win.on("closed", () => {
    win = null;
  });
  return win;
}

export function showNotesOverlay(): void {
  const w = win && !win.isDestroyed() ? win : create();
  position(w, NOTES_HEIGHT);
  if (process.platform === "darwin") w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.showInactive();
  w.focus();
}

export function hideNotesOverlay(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

export function toggleNotesOverlay(): void {
  if (win && !win.isDestroyed() && win.isVisible()) hideNotesOverlay();
  else showNotesOverlay();
}

export function resizeNotesOverlay(height: number): void {
  if (!win || win.isDestroyed()) return;
  position(win, clampNotesHeight(height));
}

export function getNotesOverlayWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function destroyNotesOverlay(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
