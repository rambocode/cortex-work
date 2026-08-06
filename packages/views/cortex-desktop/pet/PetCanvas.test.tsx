import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * 暂停 Image 的 load 回调(test/setup.ts 默认在微任务里立刻触发),用来制造
 * 「新图还在解码」的中间态。返回的函数恢复原行为并补发期间挂起的 load。
 */
function holdImageLoads(): () => void {
  const pending: HTMLImageElement[] = [];
  const original = Object.getOwnPropertyDescriptor(Image.prototype, "src")!;
  Object.defineProperty(Image.prototype, "src", {
    configurable: true,
    set(this: HTMLImageElement, value: string) {
      this.setAttribute("src", value);
      pending.push(this);
    },
    get(this: HTMLImageElement) {
      return this.getAttribute("src") ?? "";
    },
  });
  return () => {
    Object.defineProperty(Image.prototype, "src", original);
    for (const img of pending.splice(0)) img.dispatchEvent(new Event("load"));
  };
}

beforeEach(() => __clearSheetCache());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks(); // 用例里 spy 过 getContext,不还原会串到后面的用例
});

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

  // 拖着宠物走时改播奔跑行(行 1 朝右 / 行 2 朝左),优先于姿态——被拽着走的时候
  // 「在跑」比「在思考」更该被看见。
  it("moveDir 覆写姿态的行:右→行 1、左→行 2", async () => {
    const right = render(<PetCanvas sprite={petdex()} state="thinking" width={110} moveDir="right" />);
    expect((await firstDraw(canvasOf(right.container)))[2]).toBe(1 * PETDEX_CELL_H);
    cleanup();

    const left = render(<PetCanvas sprite={petdex()} state="thinking" width={110} moveDir="left" />);
    expect((await firstDraw(canvasOf(left.container)))[2]).toBe(2 * PETDEX_CELL_H);
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

  // 实测:8×9 的 petdex sprite 里 waving 行(replying 用的行 3)只有 4 帧,第 5、6 格全透明。
  // 照固定的 6 帧播,每轮会有两帧画的是空白 =「agent 回复时宠物偶尔不见了」。
  it("按探测出的有效帧数循环:行只有 4 帧时不会画到透明的第 5、6 帧", async () => {
    // jsdom 的 Image 不真加载资源,naturalWidth/Height 恒为 0,探测会当「图还没就绪」
    // 直接返回 null。补上真实网格尺寸,才走得到读像素那一步。
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(8 * PETDEX_CELL_W);
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(9 * PETDEX_CELL_H);
    // 只覆盖 getImageData(让探测看到「每行只有前 4 格有内容」),其余仍走 setup.ts 的
    // 假 ctx —— 否则 fakeCtxOf 记录不到绘制调用,断言无从下手。
    const realGetContext = HTMLCanvasElement.prototype.getContext;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
      this: HTMLCanvasElement,
      kind: string,
    ) {
      const ctx = (realGetContext as (k: string) => CanvasRenderingContext2D | null).call(this, kind);
      if (ctx) {
        (ctx as unknown as { getImageData: unknown }).getImageData = (
          _x: number,
          _y: number,
          w: number,
          h: number,
        ) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let py = 0; py < h; py += 1)
            for (let px = 0; px < w; px += 1)
              if (Math.floor(px / 4) < 4) data[(py * w + px) * 4 + 3] = 255; // 每格 4px 宽(PROBE)
          return { data };
        };
      }
      return ctx;
    } as HTMLCanvasElement["getContext"]);

    const { container } = render(<PetCanvas sprite={petdex()} state="replying" width={110} />);
    const canvas = canvasOf(container);
    await firstDraw(canvas);
    // 一轮 6 帧 × 180ms;真跑满一轮才能证明它回绕在第 4 帧而不是第 6 帧
    await waitFor(() => expect(fakeCtxOf(canvas)!.calls.drawImage.length).toBeGreaterThan(6), { timeout: 3000 });

    const sxs = fakeCtxOf(canvas)!.calls.drawImage.map((c: unknown[]) => c[1] as number);
    expect(Math.max(...sxs)).toBe(3 * PETDEX_CELL_W); // 最远只到第 4 帧,不碰透明的第 5、6 帧
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

  // 回归:内置角色**每个动作是一张独立 sheet 且帧数不同**(idle 4 / happy 5 / sleeping 3)。
  // 修复前,切姿态时会拿还没换掉的旧图配新 sheet 的帧数取帧 —— 帧游标走到旧图宽度之外,
  // drawImage 画出一片空白,表现为「宠物短暂消失」;happy 是 oneShot,游标被钳在末帧不回绕,
  // 空白会一直挂到新图 onload。正确行为是新图就绪前一帧都不画,画面冻结在上一帧。
  it("换动作期间新图未就绪则一帧都不画(不拿旧图凑新 sheet 的帧数)", async () => {
    const { container, rerender } = render(<PetCanvas sprite={null} state="idle" width={110} />);
    const canvas = canvasOf(container);
    await firstDraw(canvas);
    const drawnBefore = fakeCtxOf(canvas)!.calls.drawImage.length;

    const release = holdImageLoads();
    try {
      rerender(<PetCanvas sprite={null} state="happy" width={110} />);
      // 跨过 happy 的多个帧间隔(1000/6 ≈ 167ms),确认定时器也没在旧图上推帧。
      await new Promise((r) => setTimeout(r, 400));
      expect(fakeCtxOf(canvas)!.calls.drawImage.length).toBe(drawnBefore);
    } finally {
      release();
    }
    // 新图到位后恢复绘制,且是从第 0 帧起播(一次性动画不能被吃掉开头)。
    await waitFor(() => expect(fakeCtxOf(canvas)!.calls.drawImage.length).toBeGreaterThan(drawnBefore));
    expect(fakeCtxOf(canvas)!.calls.drawImage.at(-1)![1]).toBe(0);
  });

  it("sprite 不可用时不画(渲染空白而不是画坏图)", async () => {
    const { container } = render(<PetCanvas sprite={petdex({ url: null })} state="idle" width={110} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(fakeCtxOf(canvasOf(container))?.calls.drawImage.length ?? 0).toBe(0);
  });
});
