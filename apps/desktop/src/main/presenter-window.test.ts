// 演示窗口测试:注入假 BrowserWindow + 假 screen,覆盖
//  - 单屏:临时文件落盘 + hash 起始页 + 全屏参数 + Esc 关窗 + closed 清理 + 重复打开先销毁旧窗
//    + 回归(方向键不广播、不隐藏 #bar、fullscreen 仍 true);
//  - 双屏:两窗(观众 audience.html / 演讲者 speaker.html)+ 定位到各自屏 + 主进程权威翻页广播
//    + Esc 全退 + 关一窗连带另一窗 + 两窗全关后共享 tmpDir 删除。
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// vi.mock 工厂会被提升到文件顶部,假窗口类 + 可变 screen 状态都必须在 vi.hoisted 里定义。
const { fakeWindows, FakeBrowserWindow, screenState } = vi.hoisted(() => {
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
      executeJavaScript: vi.fn((_code: string) => Promise.resolve()),
      insertCSS: vi.fn((_css: string) => Promise.resolve()),
    };
    private listeners = new Map<string, HoistedListener[]>();
    private destroyed = false;
    shown = false;
    setBounds = vi.fn();
    setFullScreen = vi.fn();

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
    emitInput(event: string, ...args: unknown[]): void {
      const fn = this.webContents.listeners.get(event);
      if (fn) fn(...args);
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
  // 可变 screen 状态:默认单屏;双屏用例把 displays 换成两块并设 primaryId。
  const screenState = {
    displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } }] as Array<{
      id: number;
      bounds: { x: number; y: number; width: number; height: number };
    }>,
    primaryId: 1,
  };
  return { fakeWindows, FakeBrowserWindow, screenState };
});

vi.mock("electron", () => ({
  BrowserWindow: FakeBrowserWindow,
  app: { getPath: () => tmpdir() },
  screen: {
    getAllDisplays: () => screenState.displays,
    getPrimaryDisplay: () =>
      screenState.displays.find((d) => d.id === screenState.primaryId) ?? screenState.displays[0],
  },
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

// 单屏 / 双屏显示器配置(双屏:主屏 id=1 笔记本本体,外接屏 id=2 投影)。
const SINGLE_DISPLAY = [{ id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } }];
const DUAL_DISPLAYS = [
  { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } },
  { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 } },
];

function useSingleScreen(): void {
  screenState.displays = SINGLE_DISPLAY.map((d) => ({ ...d, bounds: { ...d.bounds } }));
  screenState.primaryId = 1;
}
function useDualScreen(): void {
  screenState.displays = DUAL_DISPLAYS.map((d) => ({ ...d, bounds: { ...d.bounds } }));
  screenState.primaryId = 1;
}

// 临时目录清理是 fire-and-forget 的异步 rm,轮询等它完成。
async function waitGone(path: string): Promise<void> {
  for (let i = 0; i < 50 && existsSync(path); i++) await new Promise((r) => setTimeout(r, 10));
}

afterEach(() => {
  destroyPresenterWindow();
  fakeWindows.length = 0;
  useSingleScreen(); // 复位为单屏,避免跨用例串台。
});

describe("openPresenterWindow · 单屏", () => {
  it("写出自包含演示 HTML,loadFile 带 1 基 hash,窗口为全屏无桥接", async () => {
    useSingleScreen();
    await openPresenterWindow({ title: "季度汇报", slides: SLIDES, startIndex: 2 });
    const win = fakeWindows[0]!;
    expect(win.options.fullscreen).toBe(true);
    // 纯静态 HTML:开沙箱、无 preload,不暴露任何桌面能力。
    expect(win.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true });
    expect((win.options.webPreferences as Record<string, unknown>).preload).toBeUndefined();

    const [file, opts] = win.loadFileArgs!;
    expect(opts?.hash).toBe("3");
    expect(file.endsWith("audience.html")).toBe(true);
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

  it("单屏只创建一个窗口,方向键不广播、不隐藏 #bar", async () => {
    useSingleScreen();
    await openPresenterWindow({ title: "T", slides: SLIDES, startIndex: 0 });
    expect(fakeWindows).toHaveLength(1);
    const win = fakeWindows[0]!;
    // 方向键交给 presenter HTML 自带运行时,主进程不广播 location.hash。
    win.emitInput("before-input-event", { preventDefault: vi.fn() }, { type: "keyDown", key: "ArrowRight" });
    expect(win.webContents.executeJavaScript).not.toHaveBeenCalled();
    // 单屏保留可点 #bar,不注入隐藏 CSS。
    expect(win.webContents.insertCSS).not.toHaveBeenCalled();
    expect(win.options.fullscreen).toBe(true);
  });

  it("Esc 按键经 before-input-event 关闭窗口(不依赖 presenter HTML 自身)", async () => {
    useSingleScreen();
    await openPresenterWindow({ title: "T", slides: SLIDES, startIndex: 0 });
    const win = fakeWindows[0]!;
    win.emitInput("before-input-event", {}, { type: "keyDown", key: "Escape" });
    expect(win.isDestroyed()).toBe(true);
    expect(getPresenterWindow()).toBeNull();
  });

  it("窗口关闭后清理临时目录", async () => {
    useSingleScreen();
    await openPresenterWindow({ title: "T", slides: SLIDES, startIndex: 0 });
    const win = fakeWindows[0]!;
    const dir = dirname(win.loadFileArgs![0]);
    expect(existsSync(dir)).toBe(true);
    win.close();
    await waitGone(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("重复打开先销毁旧窗口(内容可能已变,不复用)", async () => {
    useSingleScreen();
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

describe("openPresenterWindow · 双屏", () => {
  it("创建观众窗 + 演讲者窗,分别 loadFile audience.html / speaker.html", async () => {
    useDualScreen();
    await openPresenterWindow({ title: "季度汇报", slides: SLIDES, startIndex: 0 });
    expect(fakeWindows).toHaveLength(2);
    const [audience, speaker] = fakeWindows;
    expect(audience!.loadFileArgs![0].endsWith("audience.html")).toBe(true);
    expect(speaker!.loadFileArgs![0].endsWith("speaker.html")).toBe(true);
    // 共享同一临时目录。
    expect(dirname(audience!.loadFileArgs![0])).toBe(dirname(speaker!.loadFileArgs![0]));
    // 演讲者页内容特征。
    const speakerHtml = readFileSync(speaker!.loadFileArgs![0], "utf8");
    expect(speakerHtml).toContain('id="deckTitle"');
    expect(speakerHtml).toContain('id="elapsed"');
  });

  it("ready-to-show 里各自 setBounds + setFullScreen 到目标屏", async () => {
    useDualScreen();
    await openPresenterWindow({ title: "T", slides: SLIDES, startIndex: 0 });
    const [audience, speaker] = fakeWindows;
    audience!.emit("ready-to-show");
    speaker!.emit("ready-to-show");
    // 观众窗落外接屏(id=2),演讲者窗落主屏(id=1)。
    expect(audience!.setBounds).toHaveBeenCalledWith({ x: 1440, y: 0, width: 1920, height: 1080 });
    expect(speaker!.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1440, height: 900 });
    expect(audience!.setFullScreen).toHaveBeenCalledWith(true);
    expect(speaker!.setFullScreen).toHaveBeenCalledWith(true);
    expect(audience!.shown).toBe(true);
    expect(speaker!.shown).toBe(true);
    expect(audience!.options.fullscreen).toBe(false);
    expect(speaker!.options.fullscreen).toBe(false);
  });

  it("观众窗 dom-ready 隐藏 #bar(避免鼠标点击绕过主进程翻页权威)", async () => {
    useDualScreen();
    await openPresenterWindow({ title: "T", slides: SLIDES, startIndex: 0 });
    const [audience, speaker] = fakeWindows;
    audience!.emitInput("dom-ready"); // dom-ready 注册在 webContents 上,经 webContents 触发。
    expect(audience!.webContents.insertCSS).toHaveBeenCalledWith("#bar{display:none!important}");
    // 演讲者窗不隐藏(它没有 #bar)。
    expect(speaker!.webContents.insertCSS).not.toHaveBeenCalled();
  });

  it("任一窗方向键 → 两窗各收到一次 location.hash 广播,currentIndex 前进", async () => {
    useDualScreen();
    await openPresenterWindow({ title: "T", slides: SLIDES, startIndex: 0 });
    const [audience, speaker] = fakeWindows;
    // 从演讲者窗按下一页 → 两窗都被广播到第 2 页。
    speaker!.emitInput("before-input-event", { preventDefault: vi.fn() }, { type: "keyDown", key: "ArrowRight" });
    expect(audience!.webContents.executeJavaScript).toHaveBeenCalledWith("location.hash='#2'");
    expect(speaker!.webContents.executeJavaScript).toHaveBeenCalledWith("location.hash='#2'");
    // 再按一次 → 第 3 页,证明 currentIndex 已在主进程前进。
    audience!.emitInput("before-input-event", { preventDefault: vi.fn() }, { type: "keyDown", key: "ArrowRight" });
    expect(audience!.webContents.executeJavaScript).toHaveBeenLastCalledWith("location.hash='#3'");
    expect(speaker!.webContents.executeJavaScript).toHaveBeenLastCalledWith("location.hash='#3'");
  });

  it("Esc 全退:关闭全部窗口", async () => {
    useDualScreen();
    await openPresenterWindow({ title: "T", slides: SLIDES, startIndex: 0 });
    const [audience, speaker] = fakeWindows;
    audience!.emitInput("before-input-event", { preventDefault: vi.fn() }, { type: "keyDown", key: "Escape" });
    expect(audience!.isDestroyed()).toBe(true);
    expect(speaker!.isDestroyed()).toBe(true);
    expect(getPresenterWindow()).toBeNull();
  });

  it("关闭任一窗 → 连带销毁另一窗,并在全关后删除共享临时目录", async () => {
    useDualScreen();
    await openPresenterWindow({ title: "T", slides: SLIDES, startIndex: 0 });
    const [audience, speaker] = fakeWindows;
    const dir = dirname(audience!.loadFileArgs![0]);
    expect(existsSync(dir)).toBe(true);
    audience!.close();
    expect(speaker!.isDestroyed()).toBe(true);
    await waitGone(dir);
    expect(existsSync(dir)).toBe(false);
    expect(getPresenterWindow()).toBeNull();
  });
});
