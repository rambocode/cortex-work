import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PetSpriteSource } from "@cortex-work/core/desktop/petdex-types";
import { PETDEX_CELL_H, PETDEX_CELL_W } from "@cortex-work/core/pet/grid";
import { fakeCtxOf } from "../../test/setup";
import { PetCanvas } from "./PetCanvas";
import { __clearSheetCache } from "./sheet";

const petdex = (over: Partial<PetSpriteSource> = {}): PetSpriteSource => ({
  origin: "petdex",
  id: "homelander",
  url: "cortex-petdex://sprite/homelander.webp?v=abc",
  cols: 8,
  rows: 9,
  displayName: "Homelander",
  ...over,
});

function canvasOf(container: HTMLElement): HTMLCanvasElement {
  return container.querySelector("canvas.pet-canvas") as HTMLCanvasElement;
}

/** 等到至少画过一帧(图片解码在微任务里完成)。 */
async function firstDraw(canvas: HTMLCanvasElement) {
  await waitFor(() => expect(fakeCtxOf(canvas)?.calls.drawImage.length ?? 0).toBeGreaterThan(0));
  return fakeCtxOf(canvas)!.calls.drawImage.at(-1)!;
}

beforeEach(() => __clearSheetCache());
afterEach(cleanup);

describe("PetCanvas 取帧", () => {
  it("petdex:sy 按解析出的行号算", async () => {
    const { container } = render(<PetCanvas sprite={petdex()} state="thinking" width={110} />);
    const call = await firstDraw(canvasOf(container));
    // thinking → review 行 8;sx = 帧 0
    expect(call[1]).toBe(0);
    expect(call[2]).toBe(8 * PETDEX_CELL_H);
    expect(call[3]).toBe(PETDEX_CELL_W);
    expect(call[4]).toBe(PETDEX_CELL_H);
  });

  // 参考实现硬编码 9 行,这里会算出 sy=1664 越界、画出空白。
  it("8 行 sprite 上 thinking 的 sy 落在图内(1456 而非越界的 1664)", async () => {
    const { container } = render(<PetCanvas sprite={petdex({ rows: 8 })} state="thinking" width={110} />);
    const call = await firstDraw(canvasOf(container));
    expect(call[2]).toBe(7 * PETDEX_CELL_H);
    expect(call[2]).toBeLessThan(8 * PETDEX_CELL_H); // 严格落在图高之内
  });

  it("内置角色恒取第 0 行", async () => {
    const { container } = render(<PetCanvas sprite={null} state="happy" width={110} />);
    const call = await firstDraw(canvasOf(container));
    expect(call[2]).toBe(0);
  });
});

describe("PetCanvas 尺寸", () => {
  it("高度按格子宽高比推算并回报给外层", async () => {
    const sizes: { width: number; height: number }[] = [];
    render(<PetCanvas sprite={petdex()} state="idle" width={110} onSize={(s) => sizes.push(s)} />);
    // petdex 格子 192×208 → 110 × round(110*208/192) = 110×119
    await waitFor(() => expect(sizes.length).toBeGreaterThan(0));
    expect(sizes.at(-1)).toEqual({ width: 110, height: 119 });
  });

  it("内置资产是 110:100 的比例", async () => {
    const sizes: { width: number; height: number }[] = [];
    render(<PetCanvas sprite={null} state="idle" width={110} onSize={(s) => sizes.push(s)} />);
    await waitFor(() => expect(sizes.length).toBeGreaterThan(0));
    expect(sizes.at(-1)).toEqual({ width: 110, height: 100 });
  });

  it("按 DPR 放大位图并把 dpr 传给 setTransform", async () => {
    const original = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    try {
      const { container } = render(<PetCanvas sprite={null} state="idle" width={110} />);
      const canvas = canvasOf(container);
      await firstDraw(canvas);
      expect(canvas.width).toBe(220);
      expect(canvas.height).toBe(200);
      expect(fakeCtxOf(canvas)!.calls.setTransform.at(-1)).toEqual([2, 0, 0, 2, 0, 0]);
    } finally {
      Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: original });
    }
  });
});

describe("PetCanvas 播放", () => {
  it("frozen 只画第 0 帧,不推进", async () => {
    const { container } = render(<PetCanvas sprite={petdex()} state="idle" width={110} frozen />);
    const canvas = canvasOf(container);
    await firstDraw(canvas);
    await new Promise((r) => setTimeout(r, 250));
    // 所有绘制调用的 sx 都应停在第 0 帧
    for (const call of fakeCtxOf(canvas)!.calls.drawImage) expect(call[1]).toBe(0);
  });

  it("非 frozen 会推进到下一帧", async () => {
    const { container } = render(<PetCanvas sprite={petdex()} state="idle" width={110} />);
    const canvas = canvasOf(container);
    await firstDraw(canvas);
    await waitFor(
      () => expect(fakeCtxOf(canvas)!.calls.drawImage.some((c: unknown[]) => c[1] === PETDEX_CELL_W)).toBe(true),
      { timeout: 1500 },
    );
  });

  it("sprite 不可用时不画(渲染空白而不是画坏图)", async () => {
    const { container } = render(<PetCanvas sprite={petdex({ url: null })} state="idle" width={110} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(fakeCtxOf(canvasOf(container))?.calls.drawImage.length ?? 0).toBe(0);
  });
});
