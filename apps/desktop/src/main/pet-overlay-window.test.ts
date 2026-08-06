import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FakeBrowserWindow, fakeWindows } = vi.hoisted(() => {
  type Listener = () => void;

  class FakeBrowserWindow {
    private listeners = new Map<string, Listener[]>();
    private destroyed = false;
    private visible = false;
    webContents = {};
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
  return { FakeBrowserWindow, fakeWindows };
});

vi.mock("electron", () => ({
  BrowserWindow: FakeBrowserWindow,
  screen: {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } }),
    getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } }),
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
