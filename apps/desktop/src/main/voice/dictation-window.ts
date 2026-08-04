// 系统级听写栏：透明且永不抢焦的独立窗口。录音结束后仍保持目标 app 的输入焦点，
// 才能由 Cortex_Helper 把转写结果安全粘回原光标位置。

import { BrowserWindow, screen } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";

export const DICTATION_BAR_WIDTH = 360;
export const DICTATION_BAR_HEIGHT = 72;
const BOTTOM_GAP = 24;

export interface DictationWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DictationBarState = "idle" | "recording" | "transcribing";

let win: BrowserWindow | null = null;
let shouldStayVisible = false;

/** 计算底部居中的听写栏位置；工作区无法容纳时退到左上角，避免负坐标落到别的屏幕。 */
export function dictationWindowBounds(workArea: { x: number; y: number; width: number; height: number }): DictationWindowBounds {
  if (workArea.width < DICTATION_BAR_WIDTH || workArea.height < DICTATION_BAR_HEIGHT + BOTTOM_GAP) {
    return { x: workArea.x, y: workArea.y, width: DICTATION_BAR_WIDTH, height: DICTATION_BAR_HEIGHT };
  }
  return {
    x: Math.round(workArea.x + (workArea.width - DICTATION_BAR_WIDTH) / 2),
    y: workArea.y + workArea.height - DICTATION_BAR_HEIGHT - BOTTOM_GAP,
    width: DICTATION_BAR_WIDTH,
    height: DICTATION_BAR_HEIGHT,
  };
}

function dictationHtml(): string {
  const flat = join(__dirname, "../renderer/dictation.html");
  const nested = join(__dirname, "../renderer/src/dictation.html");
  return existsSync(flat) ? flat : nested;
}

function createDictationWindow(): BrowserWindow {
  win = new BrowserWindow({
    ...dictationWindowBounds(screen.getPrimaryDisplay().workArea),
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 这是听写正确性的硬约束：抢焦会令最终 paste 写回听写栏而非用户原来的应用。
    focusable: false,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: { preload: join(__dirname, "../preload/index.js"), sandbox: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  if (process.platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/dictation.html`);
  else void win.loadFile(dictationHtml());
  win.on("closed", () => {
    win = null;
  });
  return win;
}

/** 下发听写状态。录音/转写时强制显示；idle 仅在用户选了常驻提醒时显示。 */
export function pushDictationBarState(state: DictationBarState, alwaysVisible: boolean): void {
  shouldStayVisible = alwaysVisible;
  const window = win && !win.isDestroyed() ? win : createDictationWindow();
  const send = (): void => window.webContents.send("dictation:state", state);
  if (window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
  else send();

  if (state !== "idle" || shouldStayVisible) window.showInactive();
  else if (window.isVisible()) window.hide();
}

export function destroyDictationWindow(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
