import { BrowserWindow, ipcMain } from "electron";
import { join } from "path";
import { existsSync } from "fs";
import { is } from "@electron-toolkit/utils";

let win: BrowserWindow | null = null;

function agentTraceHtml(): string {
  const flat = join(__dirname, "../renderer/agent-trace.html");
  const nested = join(__dirname, "../renderer/src/agent-trace.html");
  return existsSync(flat) ? flat : nested;
}

function create(): BrowserWindow {
  win = new BrowserWindow({
    width: 920,
    height: 680,
    minWidth: 720,
    minHeight: 460,
    title: "Cortex Agent Trace",
    titleBarStyle: "default",
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#cfcbc1",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/agent-trace.html`);
  } else {
    void win.loadFile(agentTraceHtml());
  }
  win.on("closed", () => {
    win = null;
  });
  return win;
}

export function showAgentTraceWindow(): void {
  const w = win && !win.isDestroyed() ? win : create();
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

export function getAgentTraceWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function destroyAgentTraceWindow(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

export function registerAgentTraceWindowHandlers({ devMode }: { devMode: boolean }): void {
  ipcMain.handle("agent-trace-window:show", () => {
    if (!devMode) throw new Error("Agent trace 仅在开发环境可用");
    showAgentTraceWindow();
  });
}
