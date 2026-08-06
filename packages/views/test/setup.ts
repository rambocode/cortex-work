import "@testing-library/jest-dom/vitest";
import { i18nReady } from "@cortex-work/core/i18n";
import { loadAllResourcesForTest } from "@cortex-work/core/i18n/testing";

// 等 i18next 初始化完成,再把全部命名空间资源同步灌入,使组件测试的 t() 首渲染即返回
// 真实 zh 值(规避懒加载异步)。zh 为默认/源,既有断言中文串的测试因此保持绿(R12)。
await i18nReady;
loadAllResourcesForTest();

// ── canvas 2D 桩 ────────────────────────────────────────────────────────────
// jsdom 不实现 canvas 2D(未装可选的 node-canvas),getContext("2d") 返回 null 并打印
// "Not implemented"。宠物的逐帧渲染(PetCanvas)全靠它,不打桩的话相关测试会**静默地
// 什么都画不出来却依然通过**——这是最容易被忽略的一类假绿。
// 这里给一个记录调用的假 ctx,让测试能断言 drawImage 的取帧参数。
type Call = unknown[];
export interface FakeCanvasCtx {
  drawImage: (...args: Call) => void;
  clearRect: (...args: Call) => void;
  setTransform: (...args: Call) => void;
  /** 一律回「整张图都有内容」。宠物的透明尾帧探测(sheet.ts)要读像素,不给它像素就只能
   * 走 catch 分支、退回固定帧数——那样探测这条通路在测试里等于没被跑过。返回全不透明
   * 使探测结论 = 列数,与未探测时的行为一致,既有用例不受影响。 */
  getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray };
  calls: { drawImage: Call[]; clearRect: Call[]; setTransform: Call[] };
}

const ctxByCanvas = new WeakMap<HTMLCanvasElement, FakeCanvasCtx>();

/** 取某个 canvas 元素上记录的绘制调用(测试用)。 */
export function fakeCtxOf(canvas: HTMLCanvasElement): FakeCanvasCtx | undefined {
  return ctxByCanvas.get(canvas);
}

if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement, kind: string) {
    if (kind !== "2d") return null;
    let ctx = ctxByCanvas.get(this);
    if (!ctx) {
      const calls: FakeCanvasCtx["calls"] = { drawImage: [], clearRect: [], setTransform: [] };
      ctx = {
        calls,
        drawImage: (...args: Call) => void calls.drawImage.push(args),
        clearRect: (...args: Call) => void calls.clearRect.push(args),
        setTransform: (...args: Call) => void calls.setTransform.push(args),
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(Math.max(0, w * h * 4)).fill(255),
        }),
      };
      ctxByCanvas.set(this, ctx);
    }
    return ctx as unknown as CanvasRenderingContext2D;
  } as HTMLCanvasElement["getContext"];
}

// jsdom 的 Image 不会真的去加载资源,onload 永不触发 → PetCanvas 拿不到图、一帧都不画。
// 用微任务立刻回调 load,让组件测试能走到 drawImage。
if (typeof Image !== "undefined") {
  Object.defineProperty(Image.prototype, "src", {
    configurable: true,
    set(this: HTMLImageElement, value: string) {
      this.setAttribute("src", value);
      queueMicrotask(() => this.dispatchEvent(new Event("load")));
    },
    get(this: HTMLImageElement) {
      return this.getAttribute("src") ?? "";
    },
  });
}
