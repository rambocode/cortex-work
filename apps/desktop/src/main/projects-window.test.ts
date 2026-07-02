import { beforeEach, describe, expect, it, vi } from "vitest";

// electron / paths mock：让窗口单例逻辑脱离真实 BrowserWindow / screen / 文件系统可测。
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  // ipcMain.on 通道（委派意图中继用）：event 首参在真实 electron 里是 IpcMainEvent，测试传 {}。
  onHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  restore: vi.fn(),
  destroy: vi.fn(),
  on: vi.fn(),
  isDestroyed: vi.fn(() => false),
  isMinimized: vi.fn(() => false),
  getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1000, height: 700 })),
  isFullScreen: vi.fn(() => false),
}));

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(
    class BrowserWindow {
      loadURL = h.loadURL;
      loadFile = h.loadFile;
      show = h.show;
      focus = h.focus;
      restore = h.restore;
      destroy = h.destroy;
      on = h.on;
      isDestroyed = h.isDestroyed;
      isMinimized = h.isMinimized;
      getNormalBounds = h.getNormalBounds;
      isFullScreen = h.isFullScreen;
    },
  ),
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => unknown) => h.onHandlers.set(channel, fn),
  },
  screen: {
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
  },
}));

vi.mock("@electron-toolkit/utils", () => ({ is: { dev: true } }));

// 避免依赖真实用户目录：bounds 文件读不到（首开路径），走默认居中。
vi.mock("./paths", () => ({ cortexHome: () => "/tmp/__cortex_test_nonexistent__" }));

import { BrowserWindow } from "electron";
import {
  destroyProjectsWindow,
  registerProjectsWindowHandlers,
  registerProjectsDelegateRelay,
} from "./projects-window";

beforeEach(() => {
  h.handlers.clear();
  h.onHandlers.clear();
  h.loadURL.mockClear();
  h.loadFile.mockClear();
  h.show.mockClear();
  h.focus.mockClear();
  h.restore.mockClear();
  h.destroy.mockClear();
  h.on.mockClear();
  h.isDestroyed.mockReturnValue(false);
  h.isMinimized.mockReturnValue(false);
  vi.mocked(BrowserWindow).mockClear();
  destroyProjectsWindow();
});

describe("registerProjectsWindowHandlers", () => {
  it("首次 open 创建窗口并 show + focus", () => {
    registerProjectsWindowHandlers();
    h.handlers.get("projects-window:open")?.({});
    expect(vi.mocked(BrowserWindow)).toHaveBeenCalledTimes(1);
    expect(h.show).toHaveBeenCalledTimes(1);
    expect(h.focus).toHaveBeenCalledTimes(1);
  });

  it("单例：连续两次 open 只创建一个实例，第二次走 restore/focus 复用", () => {
    registerProjectsWindowHandlers();
    h.handlers.get("projects-window:open")?.({});
    // 第二次调用时窗口已最小化 → 触发 restore。
    h.isMinimized.mockReturnValue(true);
    h.handlers.get("projects-window:open")?.({});
    expect(vi.mocked(BrowserWindow)).toHaveBeenCalledTimes(1);
    expect(h.show).toHaveBeenCalledTimes(2);
    expect(h.focus).toHaveBeenCalledTimes(2);
    expect(h.restore).toHaveBeenCalledTimes(1);
  });

  it("标题栏照主窗：hiddenInset + trafficLightPosition，保留 mac 红绿灯", () => {
    registerProjectsWindowHandlers();
    h.handlers.get("projects-window:open")?.({});
    const options = vi.mocked(BrowserWindow).mock.calls[0]?.[0] as
      | { titleBarStyle?: string; trafficLightPosition?: unknown }
      | undefined;
    expect(options?.titleBarStyle).toBe("hiddenInset");
    expect(options).toHaveProperty("trafficLightPosition");
  });
});

describe("registerProjectsDelegateRelay（委派意图中继，KTD10）", () => {
  it("收到项目窗口意图 → 显式唤起主窗口(showMainWindow)并转发给主窗口 renderer", () => {
    const showMainWindow = vi.fn();
    const send = vi.fn();
    // 显式定位的 mainWindow（不用 getAllWindows()[0]）。
    const mainWindow = { isDestroyed: () => false, webContents: { send } } as never;
    registerProjectsDelegateRelay({ showMainWindow, getMainWindow: () => mainWindow });

    h.onHandlers.get("task-delegate:intent")?.({}, { taskId: "t9" });

    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("task-delegate:intent", { taskId: "t9" });
  });

  it("主窗口不存在（已销毁/未建）时唤起但不转发（不抛错）", () => {
    const showMainWindow = vi.fn();
    registerProjectsDelegateRelay({ showMainWindow, getMainWindow: () => null });

    expect(() => h.onHandlers.get("task-delegate:intent")?.({}, { taskId: "t9" })).not.toThrow();
    expect(showMainWindow).toHaveBeenCalledTimes(1);
  });
});
