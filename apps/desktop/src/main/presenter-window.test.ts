// 演示窗口测试(bento 化):注入假 BrowserWindow + 假 screen,覆盖
//  - 单屏:loadFile deck.bento.html + solo hash 起始页 + Esc 关窗 + 重复打开先销毁旧窗;
//  - 双屏:观众/演讲者两窗各自 hash + 定位到各自屏 + 主进程权威翻页广播 goto(实页索引,
//    rail 跳过 stateOf)+ 关一窗连带另一窗;
//  - cortex-presenter://control 回控(advance/jump/end)与 window.open 拒绝。
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// vi.mock 工厂会被提升到文件顶部,假窗口类 + 可变 screen 状态都必须在 vi.hoisted 里定义。
const { fakeWindows, FakeBrowserWindow, screenState } = vi.hoisted(() => {
  type HoistedListener = (...args: unknown[]) => void;
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
      setWindowOpenHandler: vi.fn(),
    };
    private listeners = new Map<string, HoistedListener[]>();
    private destroyed = false;
    shown = false;
    setBounds = vi.fn();
    fullScreen = false;
    setFullScreen = vi.fn((flag: boolean) => {
      this.fullScreen = flag;
    });
    isFullScreen(): boolean {
      return this.fullScreen;
    }
    focus = vi.fn();
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();

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

const DECK_PATH = "/ws/.cortex-design/deck1/deck.bento.html";

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

type FakeWin = InstanceType<typeof FakeBrowserWindow>;

function open(opts: Partial<Parameters<typeof openPresenterWindow>[0]> = {}): Promise<void> {
  return openPresenterWindow({
    title: "T",
    deckHtmlPath: DECK_PATH,
    startIndex: 0,
    railIndices: [0, 1, 2],
    ...opts,
  });
}

/** 取某窗最近一次 goto 广播出的实页索引(未广播返回 null)。 */
function lastGotoIndex(w: FakeWin): number | null {
  const calls = w.webContents.executeJavaScript.mock.calls as Array<[string]>;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const m = /goto\((\d+)\)/.exec(calls[i]![0]);
    if (m) return Number(m[1]);
  }
  return null;
}

afterEach(() => {
  destroyPresenterWindow();
  fakeWindows.length = 0;
  useSingleScreen();
});

describe("openPresenterWindow · 单屏", () => {
  it("loadFile deck.bento.html,solo hash 携带起始实页,全屏、无 preload、沙箱", async () => {
    await open({ startIndex: 1 });
    expect(fakeWindows).toHaveLength(1);
    const w = fakeWindows[0]!;
    expect(w.loadFileArgs?.[0]).toBe(DECK_PATH);
    expect(w.loadFileArgs?.[1]?.hash).toBe("cortex-present-solo.1");
    expect(w.options.fullscreen).toBe(true);
    const prefs = w.options.webPreferences as Record<string, unknown>;
    expect(prefs.sandbox).toBe(true);
    expect(prefs.preload).toBeUndefined();
    // 与编辑器 webview 同一 persist 分区(packages/views slides-webview-partition):
    // 编辑器里设的语言/动效偏好(localStorage,file:// 源)对放映的演讲者视图生效。
    expect(prefs.partition).toBe("persist:cortex-slides");
  });

  it("Esc 关窗;window.open 一律拒绝", async () => {
    await open();
    const w = fakeWindows[0]!;
    expect(w.webContents.setWindowOpenHandler).toHaveBeenCalled();
    w.emitInput("before-input-event", { preventDefault: vi.fn() }, { type: "keyDown", key: "Escape" });
    expect(w.isDestroyed()).toBe(true);
    expect(getPresenterWindow()).toBeNull();
  });

  it("重复打开先销毁旧窗", async () => {
    await open();
    const first = fakeWindows[0]!;
    await open();
    expect(first.isDestroyed()).toBe(true);
    expect(getPresenterWindow()).toBe(fakeWindows[1]);
  });

  it("起始页落在 stateOf 状态页时吸附到最近线性页", async () => {
    // rail = [0,2,4](实页 1、3 为状态页);startIndex 1 → 吸附到实页 2。
    await open({ startIndex: 1, railIndices: [0, 2, 4] });
    expect(fakeWindows[0]!.loadFileArgs?.[1]?.hash).toBe("cortex-present-solo.2");
  });

  it("播放启动时自动关闭 deck 的减少动态效果,无需用户按 M", async () => {
    await open();
    const w = fakeWindows[0]!;
    const didFinishLoad = w.webContents.listeners.get("did-finish-load");
    expect(didFinishLoad).toBeTypeOf("function");

    didFinishLoad?.();

    const script = w.webContents.executeJavaScript.mock.calls.at(-1)?.[0] ?? "";
    expect(script).toContain("localStorage.setItem('bento-reduce-motion', 'off')");
    expect(script).toContain("if (!overlay.classList.contains('reduce-motion')) return");
    expect(script).toContain("location.reload()");
    expect(script).not.toContain("按 M");
  });

  it("cleanupPath(放映换壳临时目录)在关窗后删除;重复开窗也会清掉上一个", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-present-test-"));
    writeFileSync(join(dir, "deck.bento.html"), "x");
    await open({ cleanupPath: dir });
    destroyPresenterWindow();
    await vi.waitFor(() => expect(existsSync(dir)).toBe(false));
  });
});

describe("openPresenterWindow · 双屏", () => {
  it("观众/演讲者两窗各自 hash,定位到各自屏", async () => {
    useDualScreen();
    await open({ startIndex: 0 });
    expect(fakeWindows).toHaveLength(2);
    const [audience, speaker] = fakeWindows as [FakeWin, FakeWin];
    expect(audience.loadFileArgs?.[0]).toBe(DECK_PATH);
    expect(audience.loadFileArgs?.[1]?.hash).toBe("cortex-present-audience.0");
    expect(speaker.loadFileArgs?.[1]?.hash).toBe("cortex-present-speaker.0");
    // 观众窗落在外接屏(x=1440),演讲者窗留在主屏。
    expect(audience.options.x).toBe(1440);
    expect(speaker.options.x).toBe(0);
  });

  it("方向键主进程权威翻页:两窗收到同一 goto(实页索引,跳过状态页)", async () => {
    useDualScreen();
    await open({ railIndices: [0, 2, 3] });
    const [audience, speaker] = fakeWindows as [FakeWin, FakeWin];
    const ev = { preventDefault: vi.fn() };
    audience.emitInput("before-input-event", ev, { type: "keyDown", key: "ArrowRight" });
    // rail 位置 0 → 1,实页索引 2(实页 1 是状态页被跳过)。
    expect(lastGotoIndex(audience)).toBe(2);
    expect(lastGotoIndex(speaker)).toBe(2);
    speaker.emitInput("before-input-event", ev, { type: "keyDown", key: "ArrowLeft" });
    expect(lastGotoIndex(audience)).toBe(0);
    audience.emitInput("before-input-event", ev, { type: "keyDown", key: "End" });
    expect(lastGotoIndex(speaker)).toBe(3);
    audience.emitInput("before-input-event", ev, { type: "keyDown", key: "Home" });
    expect(lastGotoIndex(speaker)).toBe(0);
  });

  it("cortex-presenter://control 回控:advance/jump/end", async () => {
    useDualScreen();
    await open({ railIndices: [0, 1, 2] });
    const [audience, speaker] = fakeWindows as [FakeWin, FakeWin];
    const nav = speaker.webContents.listeners.get("will-navigate")!;
    const ev = { preventDefault: vi.fn() };
    nav(ev, "cortex-presenter://control/advance");
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(lastGotoIndex(audience)).toBe(1);
    nav(ev, "cortex-presenter://control/jump?page=3");
    expect(lastGotoIndex(audience)).toBe(2);
    nav(ev, "cortex-presenter://control/end");
    expect(audience.isDestroyed()).toBe(true);
    expect(speaker.isDestroyed()).toBe(true);
  });

  it("非控制协议的导航不拦截", async () => {
    useDualScreen();
    await open();
    const speaker = fakeWindows[1]!;
    const ev = { preventDefault: vi.fn() };
    speaker.webContents.listeners.get("will-navigate")!(ev, "https://example.com");
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it("Esc 全退;关一窗连带另一窗", async () => {
    useDualScreen();
    await open();
    const [audience, speaker] = fakeWindows as [FakeWin, FakeWin];
    const ev = { preventDefault: vi.fn() };
    speaker.emitInput("before-input-event", ev, { type: "keyDown", key: "Escape" });
    expect(audience.isDestroyed()).toBe(true);
    expect(speaker.isDestroyed()).toBe(true);
    expect(getPresenterWindow()).toBeNull();
  });
});
