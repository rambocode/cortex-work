// 隐藏窗口渲染层测试:注入假窗口覆盖正常/卡死/字体永不 ready/加载失败/窗口已销毁
// 路径,断言「窗口必被销毁」「超时结构化报错」「空截图可识别」。
import { describe, expect, it, vi } from "vitest";
import type { NativeImage } from "electron";

vi.mock("electron", () => ({
  // render.ts 顶层 import BrowserWindow(仅 defaultSlideWindowFactory 用),测试不触发它。
  BrowserWindow: class {},
}));
vi.mock("../../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import {
  blankRatio,
  renderSlideFile,
  SlideRenderTimeoutError,
  type SlideRenderWindow,
} from "./render";

// 造一张 w×h 的假 NativeImage:fill=每像素 BGRA;spots=末尾若干像素涂黑(模拟内容)。
// 异色像素从尾部起:blankRatio 以左上角像素为背景基准,真实 slide 的左上角恒为背景,
// fixture 必须保持这一前提,否则基准反转、断言测的是别的东西。
function fakeImage(w: number, h: number, fill: [number, number, number], spots = 0): NativeImage {
  const total = w * h;
  const bmp = Buffer.alloc(total * 4);
  for (let i = 0; i < total; i++) {
    bmp[i * 4] = fill[0];
    bmp[i * 4 + 1] = fill[1];
    bmp[i * 4 + 2] = fill[2];
    bmp[i * 4 + 3] = 255;
  }
  for (let i = total - spots; i < total; i++) {
    bmp[i * 4] = 0;
    bmp[i * 4 + 1] = 0;
    bmp[i * 4 + 2] = 0;
  }
  return {
    getSize: () => ({ width: w, height: h }),
    toBitmap: () => bmp,
    toPNG: () => Buffer.from("PNG"),
  } as unknown as NativeImage;
}

const OK_INSPECTION = {
  overflowX: false,
  overflowY: false,
  clipped: [],
  smallText: [],
  brokenImages: [],
  visibleTextLength: 20,
  hasVisibleContent: true,
};

// 假窗口工厂:各步骤行为可注入;记录 destroy 调用。
function makeWindow(
  overrides: Partial<SlideRenderWindow> = {},
): { win: SlideRenderWindow; destroyed: () => boolean } {
  let destroyed = false;
  const win: SlideRenderWindow = {
    loadURL: async () => undefined,
    executeJavaScript: async (code: string) => (code.includes("Promise.all") ? undefined : OK_INSPECTION),
    capturePage: async () => fakeImage(4, 4, [255, 255, 255], 4),
    insertCSS: async () => undefined,
    destroy: () => {
      destroyed = true;
    },
    isDestroyed: () => destroyed,
    ...overrides,
  };
  return { win, destroyed: () => destroyed };
}

const HTML = "/tmp/nonexistent/slide.html";

describe("renderSlideFile", () => {
  it("正常路径:返回 PNG + 巡检 + 空白度,并销毁窗口", async () => {
    const { win, destroyed } = makeWindow();
    const result = await renderSlideFile({ htmlAbsPath: HTML, windowFactory: () => win });
    expect(result.png.toString()).toBe("PNG");
    expect(result.inspection.hasVisibleContent).toBe(true);
    expect(result.blankRatio).toBeCloseTo(0.75, 2);
    expect(destroyed()).toBe(true);
  });

  it("页面卡死(executeJavaScript 永不 resolve)→ 超时错误且窗口被销毁", async () => {
    const { win, destroyed } = makeWindow({
      executeJavaScript: () => new Promise(() => {}),
    });
    await expect(
      renderSlideFile({ htmlAbsPath: HTML, timeoutMs: 600, windowFactory: () => win }),
    ).rejects.toBeInstanceOf(SlideRenderTimeoutError);
    expect(destroyed()).toBe(true);
  });

  it("字体永不 ready → 超时错误(消息含就绪阶段)", async () => {
    const { win } = makeWindow({
      executeJavaScript: (code: string) =>
        code.includes("Promise.all") ? new Promise(() => {}) : Promise.resolve(OK_INSPECTION),
    });
    await expect(
      renderSlideFile({ htmlAbsPath: HTML, timeoutMs: 600, windowFactory: () => win }),
    ).rejects.toThrow(/渲染超时/);
  });

  it("加载失败 → 抛出原始错误且窗口被销毁", async () => {
    const { win, destroyed } = makeWindow({
      loadURL: async () => {
        throw new Error("ERR_FILE_NOT_FOUND");
      },
    });
    await expect(renderSlideFile({ htmlAbsPath: HTML, windowFactory: () => win })).rejects.toThrow(
      "ERR_FILE_NOT_FOUND",
    );
    expect(destroyed()).toBe(true);
  });

  it("窗口在收尾前已被销毁 → finally 不二次 destroy 也不抛", async () => {
    const win: SlideRenderWindow = {
      loadURL: async () => undefined,
      executeJavaScript: async (code: string) => (code.includes("Promise.all") ? undefined : OK_INSPECTION),
      capturePage: async () => fakeImage(2, 2, [255, 255, 255]),
      insertCSS: async () => undefined,
      destroy: () => {
        throw new Error("已销毁窗口不应再 destroy");
      },
      isDestroyed: () => true,
    };
    await expect(renderSlideFile({ htmlAbsPath: HTML, windowFactory: () => win })).resolves.toBeDefined();
  });
});

describe("blankRatio", () => {
  it("纯色截图 ≈ 1;有内容时显著小于 1", () => {
    expect(blankRatio(fakeImage(8, 8, [255, 255, 255]))).toBe(1);
    expect(blankRatio(fakeImage(8, 8, [255, 255, 255], 32))).toBeCloseTo(0.5, 2);
  });
});
