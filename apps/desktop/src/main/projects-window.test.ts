import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// electron / paths mock：让窗口单例逻辑脱离真实 BrowserWindow / screen / 文件系统可测。
const h = vi.hoisted(() => {
  // 窗口 webContents（send + 单例引用）：flush 握手回执须校验 e.sender === win.webContents，
  // 故测试里 event.sender 传这同一对象即可命中。
  const webContents = { send: vi.fn() };
  return {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    // ipcMain.on 通道（委派意图中继 + flush 握手回执）：event 首参在真实 electron 里是 IpcMainEvent。
    onHandlers: new Map<string, (...args: unknown[]) => unknown>(),
    // app.on 通道（before-quit）。
    appHandlers: new Map<string, (...args: unknown[]) => unknown>(),
    // window.on 通道（close/closed）：捕获以便测试主动触发 close 走 flush 握手。
    winHandlers: new Map<string, (...args: unknown[]) => unknown>(),
    webContents,
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => h.winHandlers.set(channel, fn)),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1000, height: 700 })),
    isFullScreen: vi.fn(() => false),
  };
});

vi.mock("electron", () => ({
  app: {
    on: (channel: string, fn: (...args: unknown[]) => unknown) => h.appHandlers.set(channel, fn),
  },
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
      webContents = h.webContents;
    },
  ),
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => unknown) => h.onHandlers.set(channel, fn),
    removeListener: (channel: string) => h.onHandlers.delete(channel),
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
  // 先销毁上一个测试遗留的单例窗口，再清 mock —— 否则 destroyProjectsWindow 内部的 win.destroy()
  // 会算进本测试的 destroy 计数（flush 握手用例对 destroy 次数敏感）。
  destroyProjectsWindow();
  h.handlers.clear();
  h.onHandlers.clear();
  h.appHandlers.clear();
  h.winHandlers.clear();
  h.loadURL.mockClear();
  h.loadFile.mockClear();
  h.show.mockClear();
  h.focus.mockClear();
  h.restore.mockClear();
  h.destroy.mockClear();
  h.on.mockClear();
  h.webContents.send.mockClear();
  h.isDestroyed.mockReturnValue(false);
  h.isMinimized.mockReturnValue(false);
  vi.mocked(BrowserWindow).mockClear();
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

describe("关窗草稿 flush 握手（R21/KTD6）", () => {
  // 全程假定时器：握手会挂一个 FLUSH_TIMEOUT_MS 的 setTimeout，用假时器隔离，避免真定时器
  // 在后续测试期间触发 finish→destroy 造成跨用例污染；超时用例显式 advance。
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function openWindow() {
    registerProjectsWindowHandlers();
    h.handlers.get("projects-window:open")?.({});
    return h.winHandlers.get("close")!;
  }

  it("close 拦截 → preventDefault + 向 renderer 发 flush-request，未回执前不销毁", () => {
    const close = openWindow();
    const e = { preventDefault: vi.fn() };
    close(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(h.webContents.send).toHaveBeenCalledWith("projects-window:flush-request");
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it("收到 flush-done 回执（来自本窗口 webContents）→ 销毁窗口", () => {
    const close = openWindow();
    close({ preventDefault: vi.fn() });
    // renderer 提交完 pending 草稿并等 mutation 落库后回执。
    h.onHandlers.get("projects-window:flush-done")?.({ sender: h.webContents });
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  it("其它窗口的同名回执不误触发销毁（sender 校验）", () => {
    const close = openWindow();
    close({ preventDefault: vi.fn() });
    h.onHandlers.get("projects-window:flush-done")?.({ sender: { send: vi.fn() } });
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it("超时兜底：renderer 无回执，FLUSH_TIMEOUT_MS 后强制销毁", () => {
    const close = openWindow();
    close({ preventDefault: vi.fn() });
    expect(h.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  it("app 退出路径（before-quit 后）：close 放行、不拦截、不发 flush-request（草稿由 beforeunload 兜底）", () => {
    const close = openWindow();
    h.appHandlers.get("before-quit")?.();
    const e = { preventDefault: vi.fn() };
    close(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(h.webContents.send).not.toHaveBeenCalled();
  });

  it("握手中重新打开窗口 → 取消在途握手，回执/超时不再销毁复用的窗口（KTD6 复开竞态）", () => {
    const close = openWindow();
    close({ preventDefault: vi.fn() }); // 发起握手：win 未销毁，等回执/超时
    // 用户在握手期间重新打开项目窗口 → showProjectsWindow 复用同一 win 并取消在途握手。
    h.handlers.get("projects-window:open")?.({});
    // 复用而非新建（仍是同一 BrowserWindow 实例）。
    expect(vi.mocked(BrowserWindow)).toHaveBeenCalledTimes(1);
    // 取消后：回执监听已摘除（get 返回 undefined → no-op），超时定时器已清，均不再销毁窗口。
    h.onHandlers.get("projects-window:flush-done")?.({ sender: h.webContents });
    vi.advanceTimersByTime(3000);
    expect(h.destroy).not.toHaveBeenCalled();
  });
});

describe("registerProjectsDelegateRelay（委派意图中继，KTD10）", () => {
  // 委派意图由项目管理窗口 renderer 发出，故中继前必须先打开项目窗口——sender 校验依赖其 webContents。
  function openProjects() {
    registerProjectsWindowHandlers();
    h.handlers.get("projects-window:open")?.({});
  }
  // 暖主窗口：未销毁 + 已加载完（isLoading false，listener 已注册），走 live 转发。
  function warmMain(send: (...a: unknown[]) => unknown) {
    return { isDestroyed: () => false, webContents: { send, isLoading: () => false } } as never;
  }
  const consume = () => h.handlers.get("task-delegate:consumePending")?.();

  it("暖主窗口 → 唤起并 live 转发意图，不落 pending", () => {
    openProjects();
    const showMainWindow = vi.fn();
    const send = vi.fn();
    registerProjectsDelegateRelay({ showMainWindow, getMainWindow: () => warmMain(send) });

    h.onHandlers.get("task-delegate:intent")?.({ sender: h.webContents }, { taskId: "t9" });

    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("task-delegate:intent", { taskId: "t9" });
    expect(consume()).toBeNull(); // 暖路径不落 pending
  });

  it("冷/加载中主窗口 → 存 pending，consume 取出后清空（冷窗口丢派发修复）", () => {
    openProjects();
    const showMainWindow = vi.fn();
    const send = vi.fn();
    // 冷窗口：isLoading true → 未 warm，不能 live 发（会在 renderer 注册 listener 前发丢）。
    const mainWindow = { isDestroyed: () => false, webContents: { send, isLoading: () => true } } as never;
    registerProjectsDelegateRelay({ showMainWindow, getMainWindow: () => mainWindow });

    h.onHandlers.get("task-delegate:intent")?.({ sender: h.webContents }, { taskId: "t9" });

    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(consume()).toEqual({ taskId: "t9" }); // 主窗口 mount 时取到
    expect(consume()).toBeNull(); // 取后清空，不重复派发
  });

  it("sender 校验：非项目窗口 webContents 的意图被拒（不唤起/不转发/不落 pending）", () => {
    openProjects();
    const showMainWindow = vi.fn();
    const send = vi.fn();
    registerProjectsDelegateRelay({ showMainWindow, getMainWindow: () => warmMain(send) });

    h.onHandlers.get("task-delegate:intent")?.({ sender: { send: vi.fn() } }, { taskId: "t9" });

    expect(showMainWindow).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(consume()).toBeNull();
  });

  it("taskId 非 string → 拒绝（不唤起/不转发）", () => {
    openProjects();
    const showMainWindow = vi.fn();
    const send = vi.fn();
    registerProjectsDelegateRelay({ showMainWindow, getMainWindow: () => warmMain(send) });

    h.onHandlers.get("task-delegate:intent")?.({ sender: h.webContents }, { taskId: 123 });

    expect(showMainWindow).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("主窗口不存在（getMainWindow null）→ 唤起但走冷路径存 pending，不抛错", () => {
    openProjects();
    const showMainWindow = vi.fn();
    registerProjectsDelegateRelay({ showMainWindow, getMainWindow: () => null });

    expect(() =>
      h.onHandlers.get("task-delegate:intent")?.({ sender: h.webContents }, { taskId: "t9" }),
    ).not.toThrow();
    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(consume()).toEqual({ taskId: "t9" });
  });
});
