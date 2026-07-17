// 演示窗口测试:注入假 BrowserWindow,覆盖「临时文件落盘 + hash 起始页 + 全屏参数 +
// Esc 关窗 + closed 清理临时目录 + 重复打开先销毁旧窗」的完整生命周期。
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// vi.mock 工厂会被提升到文件顶部,假窗口类必须在 vi.hoisted 里定义才能被工厂引用。
const { fakeWindows, FakeBrowserWindow } = vi.hoisted(() => {
  type HoistedListener = (...args: unknown[]) => void;
  // 假窗口:记录构造参数与 loadFile 入参;close/destroy 都会触发 closed(与 Electron 一致)。
  class FakeBrowserWindow {
    options: Record<string, unknown>;
    loadFileArgs: [string, { hash?: string } | undefined] | null = null;
    webContents = {
      listeners: new Map<string, HoistedListener>(),
      on(event: string, fn: HoistedListener) {
        this.listeners.set(event, fn);
      },
    };
    private listeners = new Map<string, HoistedListener[]>();
    private destroyed = false;
    shown = false;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      fakeWindows.push(this);
    }
    on(event: string, fn: HoistedListener): void {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    }
    once(event: string, fn: HoistedListener): void {
      this.on(event, fn);
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.listeners.get(event) ?? []) fn(...args);
    }
    show(): void {
      this.shown = true;
    }
    close(): void {
      this.destroyed = true;
      this.emit("closed");
    }
    destroy(): void {
      this.destroyed = true;
      this.emit("closed");
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    async loadFile(file: string, opts?: { hash?: string }): Promise<void> {
      this.loadFileArgs = [file, opts];
    }
  }
  const fakeWindows: FakeBrowserWindow[] = [];
  return { fakeWindows, FakeBrowserWindow };
});

vi.mock("electron", () => ({
  BrowserWindow: FakeBrowserWindow,
  app: { getPath: () => tmpdir() },
}));
vi.mock("./log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { destroyPresenterWindow, getPresenterWindow, openPresenterWindow } from "./presenter-window";

const SLIDES = [
  { title: "开场", html: "<!doctype html><html><body>P1</body></html>", notes: "讲稿一" },
  { title: "论证", html: "<!doctype html><html><body>P2</body></html>" },
  { title: "收尾", html: "<!doctype html><html><body>P3</body></html>" },
];

// 临时目录清理是 fire-and-forget 的异步 rm,轮询等它完成。
async function waitGone(path: string): Promise<void> {
  for (let i = 0; i < 50 && existsSync(path); i++) await new Promise((r) => setTimeout(r, 10));
}

afterEach(() => {
  destroyPresenterWindow();
  fakeWindows.length = 0;
});

describe("openPresenterWindow", () => {
  it("写出自包含演示 HTML,loadFile 带 1 基 hash,窗口为全屏无桥接", async () => {
    await openPresenterWindow({ title: "季度汇报", slides: SLIDES, startIndex: 2 });
    const win = fakeWindows[0]!;
    expect(win.options.fullscreen).toBe(true);
    // 纯静态 HTML:开沙箱、无 preload,不暴露任何桌面能力。
    expect(win.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true });
    expect((win.options.webPreferences as Record<string, unknown>).preload).toBeUndefined();

    const [file, opts] = win.loadFileArgs!;
    expect(opts?.hash).toBe("3");
    const html = readFileSync(file, "utf8");
    // presenter 运行时特征(页码计数器)+ 全部页内容都内嵌。
    expect(html).toContain('id="counter"');
    expect(html).toContain("P1");
    expect(html).toContain("P3");
    // ready-to-show 后才展示,避免全屏切换白闪。
    expect(win.shown).toBe(false);
    win.emit("ready-to-show");
    expect(win.shown).toBe(true);
  });

  it("Esc 按键经 before-input-event 关闭窗口(不依赖 presenter HTML 自身)", async () => {
    await openPresenterWindow({ title: "T", slides: SLIDES, startIndex: 0 });
    const win = fakeWindows[0]!;
    const onInput = win.webContents.listeners.get("before-input-event");
    expect(onInput).toBeDefined();
    onInput!({}, { type: "keyDown", key: "Escape" });
    expect(win.isDestroyed()).toBe(true);
    expect(getPresenterWindow()).toBeNull();
  });

  it("窗口关闭后清理临时目录", async () => {
    await openPresenterWindow({ title: "T", slides: SLIDES, startIndex: 0 });
    const win = fakeWindows[0]!;
    const dir = dirname(win.loadFileArgs![0]);
    expect(existsSync(dir)).toBe(true);
    win.close();
    await waitGone(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("重复打开先销毁旧窗口(内容可能已变,不复用)", async () => {
    await openPresenterWindow({ title: "T", slides: SLIDES, startIndex: 0 });
    const first = fakeWindows[0]!;
    const firstDir = dirname(first.loadFileArgs![0]);
    await openPresenterWindow({ title: "T", slides: SLIDES, startIndex: 1 });
    expect(first.isDestroyed()).toBe(true);
    await waitGone(firstDir);
    expect(existsSync(firstDir)).toBe(false);
    expect(fakeWindows).toHaveLength(2);
    expect(getPresenterWindow()).not.toBeNull();
    expect(fakeWindows[1]!.loadFileArgs![1]?.hash).toBe("2");
  });
});
