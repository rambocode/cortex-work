import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { registerIpcHandlers, killAllCli, killAllPty, closeAllWatchers } from "./ipc/register";

const appIconPath = join(__dirname, "../../assets/cortex-desktop-logo-minimal.png");

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
  const mainWindow = new BrowserWindow({
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

  mainWindow.on("ready-to-show", () => mainWindow.show());

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// Synchronous app info for the preload bridge.
ipcMain.on("app:get-info", (event) => {
  event.returnValue = { version: app.getVersion(), os: normalizedOS() };
});

app.whenReady().then(() => {
  electronApp.setAppUserModelId("ai.cortex.work");
  if (process.platform === "darwin" && app.dock) app.dock.setIcon(appIconPath);
  app.on("browser-window-created", (_, window) => optimizer.watchWindowShortcuts(window));

  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  killAllCli();
  killAllPty();
  closeAllWatchers();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  killAllCli();
  killAllPty();
  closeAllWatchers();
});
