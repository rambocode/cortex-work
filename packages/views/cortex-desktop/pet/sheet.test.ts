// 尾部透明帧探测的单测。
//
// 这条逻辑存在的理由是一个实测事实:petdex sprite **每行的有效帧数并不相同**——
// 8×9 的图里行 3(waving)只有 4 帧、行 4(jumping)只有 5 帧,其余格子完全透明。
// 照固定的 6 帧播,replying(落行 3)每轮会有两帧画的是空白,表现为「agent 回复时
// 宠物偶尔不见了」。故这里用真实的帧分布做断言,别把它简化成「每行都一样」。

import { afterEach, describe, expect, it, vi } from "vitest";
import { __clearSheetCache, measureRowFrames } from "./sheet";

const COLS = 8;
const ROWS = 9;
const CELL_W = 192;
const CELL_H = 208;
/** 与 sheet.ts 的 PROBE 保持一致(每格缩绘成 4×4 像素判空)。 */
const PROBE = 4;

/** 实测分布:行 0/6/7/8 六帧、行 1/2/5 八帧、行 3 四帧、行 4 五帧。 */
const REAL_FRAMES = [6, 8, 8, 4, 5, 8, 6, 6, 6];

/** 按给定的每行帧数造一张缩绘后的 alpha 位图(有内容=255,透明=0)。 */
function fakePixels(framesPerRow: readonly number[]): Uint8ClampedArray {
  const w = COLS * PROBE;
  const h = ROWS * PROBE;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const solid = col < (framesPerRow[row] ?? 0);
      for (let y = 0; y < PROBE; y += 1) {
        for (let x = 0; x < PROBE; x += 1) {
          data[((row * PROBE + y) * w + (col * PROBE + x)) * 4 + 3] = solid ? 255 : 0;
        }
      }
    }
  }
  return data;
}

/** 把 canvas 2D 换成能回放指定像素的假 ctx(setup.ts 的全局桩没有 getImageData)。 */
function stubCanvas(data: Uint8ClampedArray | null): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return {
      drawImage: () => {},
      getImageData: () => {
        if (!data) throw new Error("画布被污染"); // 模拟 SecurityError
        return { data };
      },
    } as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement["getContext"]);
}

function fakeImage(): HTMLImageElement {
  const img = new Image();
  Object.defineProperty(img, "naturalWidth", { value: COLS * CELL_W });
  Object.defineProperty(img, "naturalHeight", { value: ROWS * CELL_H });
  return img;
}

afterEach(() => {
  vi.restoreAllMocks();
  __clearSheetCache();
});

describe("measureRowFrames", () => {
  it("量出每行的有效帧数——行 3 是 4 帧,不是想当然的 6", () => {
    stubCanvas(fakePixels(REAL_FRAMES));
    expect(measureRowFrames("a.webp", fakeImage(), CELL_W, CELL_H)).toEqual(REAL_FRAMES);
  });

  it("只截尾部空格子,中间的空帧不算结束", () => {
    const withHole = [...REAL_FRAMES];
    const pixels = fakePixels(withHole);
    // 把行 0 的第 3 格挖空:有效帧数仍应是 6(以最后一个非空格子为准)
    for (let y = 0; y < PROBE; y += 1)
      for (let x = 0; x < PROBE; x += 1)
        pixels[((0 * PROBE + y) * COLS * PROBE + (2 * PROBE + x)) * 4 + 3] = 0;
    stubCanvas(pixels);
    expect(measureRowFrames("hole.webp", fakeImage(), CELL_W, CELL_H)?.[0]).toBe(6);
  });

  it("整行全透明也至少留一帧,不返回 0(否则取模会除零)", () => {
    stubCanvas(fakePixels([0, ...REAL_FRAMES.slice(1)]));
    expect(measureRowFrames("empty.webp", fakeImage(), CELL_W, CELL_H)?.[0]).toBe(1);
  });

  it("读不到像素时返回 null,由调用方退回固定帧数", () => {
    stubCanvas(null);
    expect(measureRowFrames("tainted.webp", fakeImage(), CELL_W, CELL_H)).toBeNull();
  });

  it("同一张图只量一次(按 url 缓存)", () => {
    stubCanvas(fakePixels(REAL_FRAMES));
    const img = fakeImage();
    const first = measureRowFrames("cached.webp", img, CELL_W, CELL_H);
    stubCanvas(null); // 第二次即使读不到像素,也应命中缓存而不是回退 null
    expect(measureRowFrames("cached.webp", img, CELL_W, CELL_H)).toBe(first);
  });
});
