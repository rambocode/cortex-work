import { describe, expect, it, vi, beforeEach } from "vitest";

// watch.ts 生命周期埋点单测:断言 watchDir 启动(debug)、watcher error(warn)、closeAll(debug)
// 经 scoped logger 落点。mock electron / fs.watch / ./fs(assertAllowed)避免真实 IO。
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  unwatch: undefined as ((...args: unknown[]) => unknown) | undefined,
  watch: vi.fn(),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() },
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      if (channel === "fs:unwatchDir") mocks.unwatch = handler;
    }),
  },
}));

vi.mock("fs", () => ({ watch: (...args: unknown[]) => mocks.watch(...args) }));
vi.mock("./fs", () => ({ assertAllowed: vi.fn(async () => undefined) }));
vi.mock("./watch-noise", () => ({ isNoisyChange: () => false }));
vi.mock("../log", () => ({ createLogger: () => mocks.log, isDevEnv: () => true }));

import { registerWatchHandlers, closeAllWatchers } from "./watch";

// 假 FSWatcher:记录 error 监听器以便手动触发,close 可被断言。
function makeFakeWatcher() {
  const listeners = new Map<string, (arg: unknown) => void>();
  return {
    on: vi.fn((evt: string, cb: (arg: unknown) => void) => listeners.set(evt, cb)),
    close: vi.fn(),
    emitError: (err: unknown) => listeners.get("error")?.(err),
  };
}

const fakeSender = { isDestroyed: () => false, send: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  closeAllWatchers(); // 清掉上轮残留
  vi.clearAllMocks();
});

describe("watch 生命周期埋点", () => {
  it("watchDir 启动 → log.debug 记录 id/path", async () => {
    const watcher = makeFakeWatcher();
    mocks.watch.mockReturnValue(watcher);
    registerWatchHandlers();
    const handler = mocks.handlers.get("fs:watchDir")!;
    await handler({ sender: fakeSender }, { id: "w1", path: "/tmp/proj" });

    expect(mocks.log.debug).toHaveBeenCalledWith(expect.stringContaining("watchDir 启动 id=w1"));
  });

  it("watcher error → log.warn 并关闭 watcher", async () => {
    const watcher = makeFakeWatcher();
    mocks.watch.mockReturnValue(watcher);
    registerWatchHandlers();
    const handler = mocks.handlers.get("fs:watchDir")!;
    await handler({ sender: fakeSender }, { id: "w2", path: "/tmp/proj" });

    watcher.emitError(new Error("ENOENT"));
    expect(mocks.log.warn).toHaveBeenCalledWith(expect.stringContaining("watcher error id=w2"));
    expect(watcher.close).toHaveBeenCalled();
  });

  it("closeAllWatchers → log.debug 记录关闭数量", async () => {
    const watcher = makeFakeWatcher();
    mocks.watch.mockReturnValue(watcher);
    registerWatchHandlers();
    const handler = mocks.handlers.get("fs:watchDir")!;
    await handler({ sender: fakeSender }, { id: "w3", path: "/tmp/proj" });

    mocks.log.debug.mockClear();
    closeAllWatchers();
    expect(mocks.log.debug).toHaveBeenCalledWith(expect.stringContaining("closeAllWatchers 关闭 1"));
  });
});
