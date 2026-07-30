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
    logger: null,
    on: (event: string, fn: (...args: unknown[]) => unknown) => h.updaterEvents.set(event, fn),
    checkForUpdates: h.checkForUpdates,
    downloadUpdate: h.downloadUpdate,
    quitAndInstall: h.quitAndInstall,
  },
}));

// update.ts 引入了统一日志核心;这里 mock 掉,避免测试环境初始化 electron-log。
vi.mock("../log", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { autoUpdater } from "electron-updater";
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

  it("注册后接通 updater 日志(差量回退全量等关键行可落盘)", () => {
    registerUpdateHandlers();
    expect(autoUpdater.logger).toBeTruthy();
  });
});
