import { execFile } from "node:child_process";
import { app, BrowserWindow, ipcMain } from "electron";
import { resolveAgentBrowserBinary } from "../capabilities/agent-browser/locate";
import {
  AgentBrowserRuntime,
  type AgentBrowserCommandRunner,
  type AgentBrowserRuntimeStatus,
} from "../capabilities/agent-browser/runtime";

const runAgentBrowser: AgentBrowserCommandRunner = (binary, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(binary, args, { signal, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        // doctor 在发现 Chrome 缺失时以 1 退出，但 JSON stdout 正是安装决策依据。
        if (args[0] === "doctor" && stdout.trim()) {
          resolve({ stdout, stderr });
          return;
        }
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

function broadcast(status: AgentBrowserRuntimeStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("agent-browser:status", status);
  }
}

const runtime = new AgentBrowserRuntime(
  () =>
    resolveAgentBrowserBinary({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      platform: process.platform,
      arch: process.arch,
    }),
  runAgentBrowser,
  broadcast,
);

export function syncAgentBrowserRuntime(enabled: boolean): void {
  void runtime.ensure(enabled);
}

export function registerAgentBrowserHandlers(): void {
  ipcMain.handle("agent-browser:status", () => runtime.getStatus());
  ipcMain.handle("agent-browser:retry", async () => {
    await runtime.ensure(true, true);
    return runtime.getStatus();
  });
}
