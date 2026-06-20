import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  restore: vi.fn(),
  destroy: vi.fn(),
  on: vi.fn(),
  isDestroyed: vi.fn(() => false),
  isMinimized: vi.fn(() => false),
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
    },
  ),
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn),
  },
}));

vi.mock("@electron-toolkit/utils", () => ({
  is: { dev: true },
}));

import { destroyAgentTraceWindow, registerAgentTraceWindowHandlers } from "./agent-trace-window";

beforeEach(() => {
  h.handlers.clear();
  h.loadURL.mockClear();
  h.loadFile.mockClear();
  h.show.mockClear();
  h.focus.mockClear();
  h.restore.mockClear();
  h.destroy.mockClear();
  h.on.mockClear();
  h.isDestroyed.mockReturnValue(false);
  h.isMinimized.mockReturnValue(false);
  destroyAgentTraceWindow();
});

describe("registerAgentTraceWindowHandlers", () => {
  it("dev 环境打开独立 trace 窗口", () => {
    registerAgentTraceWindowHandlers({ devMode: true });

    h.handlers.get("agent-trace-window:show")?.({});

    expect(h.show).toHaveBeenCalledTimes(1);
    expect(h.focus).toHaveBeenCalledTimes(1);
  });

  it("非 dev 环境拒绝打开 trace 窗口", () => {
    registerAgentTraceWindowHandlers({ devMode: false });

    expect(() => h.handlers.get("agent-trace-window:show")?.({})).toThrow("Agent trace 仅在开发环境可用");
    expect(h.show).not.toHaveBeenCalled();
  });
});
