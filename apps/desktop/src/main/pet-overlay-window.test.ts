import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FakeBrowserWindow, fakeWindows, cursorPoint } = vi.hoisted(() => {
  type Listener = () => void;

  class FakeBrowserWindow {
    private listeners = new Map<string, Listener[]>();
    private destroyed = false;
    private visible = false;
    webContents = { send: vi.fn() };
    showInactive = vi.fn(() => {
      this.visible = true;
    });
    hide = vi.fn(() => {
      this.visible = false;
    });
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setPosition = vi.fn();
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 260, height: 304 }));
    excludedFromShownWindowsMenu = false;

    constructor(_options: Record<string, unknown>) {
      fakeWindows.push(this);
    }

    on(event: string, listener: Listener): void {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }

    once(event: string, listener: Listener): void {
      this.on(event, listener);
    }

    emit(event: string): void {
      for (const listener of this.listeners.get(event) ?? []) listener();
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    isVisible(): boolean {
      return this.visible;
    }

    destroy(): void {
      this.destroyed = true;
      this.visible = false;
      this.emit("closed");
    }

    loadURL = vi.fn(async () => undefined);
    loadFile = vi.fn(async () => undefined);
  }

  const fakeWindows: FakeBrowserWindow[] = [];
  // 光标全局坐标(测试用例按需改写),主进程轮询悬停时读它。
  const cursorPoint = { x: 0, y: 0 };
  return { FakeBrowserWindow, fakeWindows, cursorPoint };
});

vi.mock("electron", () => ({
  BrowserWindow: FakeBrowserWindow,
  screen: {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } }),
    getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } }),
    getCursorScreenPoint: () => cursorPoint,
  },
}));
vi.mock("@electron-toolkit/utils", () => ({ is: { dev: false } }));
vi.mock("./ipc/pet-store", () => ({
  loadPetPosition: vi.fn(async () => null),
  savePetPosition: vi.fn(),
}));

import {
  destroyPetOverlayWindow,
  ensurePetOverlayWindow,
  setPetOverlayVisibility,
} from "./pet-overlay-window";

describe("pet overlay visibility", () => {
  beforeEach(() => {
    fakeWindows.length = 0;
  });

  afterEach(() => {
    destroyPetOverlayWindow();
  });

  it("内容 ready 但尚未确认宠物启用时保持隐藏，避免透明窗口吞掉底层点击", () => {
    ensurePetOverlayWindow();
    const win = fakeWindows[0]!;

    win.emit("ready-to-show");

    expect(win.showInactive).not.toHaveBeenCalled();
    expect(win.isVisible()).toBe(false);
  });

  it("启用状态可在 ready 前后驱动显示，并在隐藏宠物时隐藏原生窗口", () => {
    ensurePetOverlayWindow();
    const win = fakeWindows[0]!;

    setPetOverlayVisibility(true);
    expect(win.showInactive).not.toHaveBeenCalled();

    win.emit("ready-to-show");
    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.isVisible()).toBe(true);

    setPetOverlayVisibility(false);
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(win.isVisible()).toBe(false);

    setPetOverlayVisibility(true);
    expect(win.showInactive).toHaveBeenCalledTimes(2);
    expect(win.isVisible()).toBe(true);
  });

  it("重复 ensure 不得绕过隐藏状态重新显示空窗口", () => {
    ensurePetOverlayWindow();
    const win = fakeWindows[0]!;
    win.emit("ready-to-show");
    setPetOverlayVisibility(false);

    expect(ensurePetOverlayWindow()).toBe(win);
    expect(win.showInactive).not.toHaveBeenCalled();
  });
});

// 这扇窗口 focusable:false + 整块 app-region:drag,渲染进程收不到任何鼠标移动事件
// (:hover / pointerEnter 永远不触发,实测表现为「右键点一下 ✕ 和缩放手柄才冒出来」),
// 悬停态只能由主进程轮询光标算出来推过去。
describe("pet overlay 悬停探测(主进程轮询光标)", () => {
  beforeEach(() => {
    fakeWindows.length = 0;
    cursorPoint.x = 0;
    cursorPoint.y = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    destroyPetOverlayWindow();
    vi.useRealTimers();
  });

  it("窗口显示后推送窗口内坐标,光标离开窗口推 null", () => {
    ensurePetOverlayWindow();
    const win = fakeWindows[0]!;
    setPetOverlayVisibility(true);
    win.emit("ready-to-show");

    // 窗口 bounds 为 {0,0,260,304}:全局 (40,50) 落在窗口内 → 同名的窗口内坐标
    cursorPoint.x = 40;
    cursorPoint.y = 50;
    vi.advanceTimersByTime(60);
    expect(win.webContents.send).toHaveBeenLastCalledWith("pet:overlay-cursor", { x: 40, y: 50 });

    cursorPoint.x = 900;
    vi.advanceTimersByTime(60);
    expect(win.webContents.send).toHaveBeenLastCalledWith("pet:overlay-cursor", null);
  });

  it("坐标没变时不重复发,免得 60ms 一条的 IPC 噪音", () => {
    ensurePetOverlayWindow();
    const win = fakeWindows[0]!;
    setPetOverlayVisibility(true);
    win.emit("ready-to-show");

    cursorPoint.x = 10;
    cursorPoint.y = 10;
    vi.advanceTimersByTime(60);
    const calls = win.webContents.send.mock.calls.length;
    vi.advanceTimersByTime(300);

    expect(win.webContents.send.mock.calls.length).toBe(calls);
  });

  it("宠物隐藏后停止轮询,并补一条 null 清掉渲染端的悬停态", () => {
    ensurePetOverlayWindow();
    const win = fakeWindows[0]!;
    setPetOverlayVisibility(true);
    win.emit("ready-to-show");
    cursorPoint.x = 10;
    cursorPoint.y = 10;
    vi.advanceTimersByTime(60);

    setPetOverlayVisibility(false);
    expect(win.webContents.send).toHaveBeenLastCalledWith("pet:overlay-cursor", null);

    const calls = win.webContents.send.mock.calls.length;
    cursorPoint.x = 20;
    vi.advanceTimersByTime(600);
    expect(win.webContents.send.mock.calls.length).toBe(calls);
  });
});
