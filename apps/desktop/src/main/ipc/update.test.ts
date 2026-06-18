import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  updaterEvents: new Map<string, (...args: unknown[]) => unknown>(),
  checkForUpdates: vi.fn(async () => undefined),
  downloadUpdate: vi.fn(async () => undefined),
  quitAndInstall: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  powerMonitor: { on: vi.fn() },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: (event: string, fn: (...args: unknown[]) => unknown) => h.updaterEvents.set(event, fn),
    checkForUpdates: h.checkForUpdates,
    downloadUpdate: h.downloadUpdate,
    quitAndInstall: h.quitAndInstall,
  },
}));

import { registerUpdateHandlers } from "./update";

beforeEach(() => {
  h.handlers.clear();
  h.updaterEvents.clear();
  h.checkForUpdates.mockClear();
  h.downloadUpdate.mockClear();
  h.quitAndInstall.mockClear();
});

describe("registerUpdateHandlers", () => {
  it("update:install 先进入真实退出态,再调用 quitAndInstall", () => {
    const beforeInstall = vi.fn();
    registerUpdateHandlers({ beforeInstall });

    const install = h.handlers.get("update:install");
    expect(install).toBeTruthy();

    install!();

    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(h.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(beforeInstall.mock.invocationCallOrder[0]).toBeLessThan(h.quitAndInstall.mock.invocationCallOrder[0]!);
  });
});
