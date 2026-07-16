// Slides 隐藏窗口渲染层:单页 HTML → 截图 + 页内巡检数据(渲染检查用)。
// 生命周期契约:窗口在 finally 中必定 destroy;加载/字体/巡检任一步超时都会
// 以结构化 timeout 错误收场并销毁窗口,不留孤儿隐藏窗口。
// 依赖注入:窗口经 SlideWindowFactory 创建,单测注入假窗口(卡死/字体永不 ready/
// 截图为空等路径均可模拟),生产用 defaultSlideWindowFactory(真 BrowserWindow)。
import { BrowserWindow, type NativeImage } from "electron";
import { pathToFileURL } from "node:url";
import { createLogger } from "../../log";

const log = createLogger("slides");

/** 单页截图/巡检默认超时(质量门槛:单页截图默认不超过 10 秒)。 */
export const SLIDE_RENDER_TIMEOUT_MS = 10_000;

/** 渲染窗口最小接口(可注入假实现)。 */
export interface SlideRenderWindow {
  loadURL(url: string): Promise<void>;
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(): Promise<NativeImage>;
  insertCSS(css: string): Promise<unknown>;
  destroy(): void;
  isDestroyed(): boolean;
}

export type SlideWindowFactory = () => SlideRenderWindow;

/** 生产窗口工厂:1280×720 隐藏窗口,sandbox,固定白底。 */
export function defaultSlideWindowFactory(): SlideRenderWindow {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    useContentSize: true,
    backgroundColor: "#ffffff",
    webPreferences: { sandbox: true },
  });
  return {
    loadURL: (url) => win.loadURL(url),
    executeJavaScript: (code) => win.webContents.executeJavaScript(code),
    capturePage: () => win.webContents.capturePage(),
    insertCSS: (css) => win.webContents.insertCSS(css),
    destroy: () => {
      if (!win.isDestroyed()) win.destroy();
    },
    isDestroyed: () => win.isDestroyed(),
  };
}

// 等待字体与全部图片 load/error 完成(与 writing-export 同口径)。
const READY_WAIT_SCRIPT = `
  Promise.all([
    document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve(),
    Promise.all(Array.from(document.images).map((img) => {
      if (img.complete) return Promise.resolve();
      return new Promise((res) => {
        img.addEventListener('load', () => res(undefined), { once: true });
        img.addEventListener('error', () => res(undefined), { once: true });
      });
    }))
  ]).then(() => undefined)
`;

/** 页内巡检结果(inspectSlideInPage 返回,JSON 可序列化)。 */
export interface SlideRenderInspection {
  overflowX: boolean;
  overflowY: boolean;
  /** 超出 1280×720 画布或被裁切的可见元素(data-cortex-id 或标签名)。 */
  clipped: Array<{ id: string; x: number; y: number; w: number; h: number }>;
  /** 计算字号 < 12px 且有可见文本的元素。 */
  smallText: Array<{ id: string; fontSizePx: number }>;
  /** 加载失败的图片(complete 但 naturalWidth 为 0,或 error)。 */
  brokenImages: Array<{ id: string; src: string }>;
  /** 页面可见文本总长(文本密度检查)。 */
  visibleTextLength: number;
  /** 是否存在任何可见内容(文本/图片/canvas/svg/有背景的块)。 */
  hasVisibleContent: boolean;
}

// 页内巡检脚本:函数体自包含,toString 注入(同 POC extractor 惯例)。
/* eslint-disable */
function inspectSlideInPage() {
  var W = 1280;
  var H = 720;
  var clipped: Array<{ id: string; x: number; y: number; w: number; h: number }> = [];
  var smallText: Array<{ id: string; fontSizePx: number }> = [];
  var brokenImages: Array<{ id: string; src: string }> = [];
  var visibleTextLength = 0;
  var hasVisibleContent = false;

  function idOf(el: Element): string {
    return el.getAttribute("data-cortex-id") || el.tagName.toLowerCase();
  }

  var all = document.body ? document.body.querySelectorAll("*") : [];
  for (var i = 0; i < all.length; i++) {
    var el = all[i]!;
    var tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "link" || tag === "meta") continue;
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;

    // 直接文本(不含子元素的部分)。
    var ownText = "";
    for (var c = 0; c < el.childNodes.length; c++) {
      var node = el.childNodes[c]!;
      if (node.nodeType === 3) ownText += (node.textContent || "").trim();
    }
    if (ownText) {
      visibleTextLength += ownText.length;
      hasVisibleContent = true;
      var fontSize = parseFloat(cs.fontSize);
      if (fontSize && fontSize < 12) smallText.push({ id: idOf(el), fontSizePx: Math.round(fontSize * 10) / 10 });
    }
    if (tag === "img") {
      hasVisibleContent = true;
      var img = el as HTMLImageElement;
      if (img.complete && img.naturalWidth === 0) brokenImages.push({ id: idOf(el), src: (img.currentSrc || img.src || "").slice(0, 160) });
    }
    if (tag === "canvas" || tag === "svg" || tag === "video") hasVisibleContent = true;
    var bg = cs.backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") hasVisibleContent = true;

    // 越界/裁切:元素可见部分超出画布(容差 1px)。
    if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) {
      if (clipped.length < 50 && (ownText || tag === "img" || tag === "canvas" || tag === "svg")) {
        clipped.push({
          id: idOf(el),
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
      }
    }
  }

  return {
    overflowX: document.documentElement.scrollWidth > W,
    overflowY: document.documentElement.scrollHeight > H,
    clipped: clipped,
    smallText: smallText.slice(0, 50),
    brokenImages: brokenImages,
    visibleTextLength: visibleTextLength,
    hasVisibleContent: hasVisibleContent,
  };
}
/* eslint-enable */

export const INSPECT_SLIDE_SOURCE = `(${inspectSlideInPage.toString()})()`;

/** 截图空白度:与左上角像素同色的占比(≈1 视为空截图)。 */
export function blankRatio(image: NativeImage): number {
  const size = image.getSize();
  const bmp = image.toBitmap();
  if (!size.width || !size.height || bmp.length < 4) return 1;
  const b = bmp[0]!;
  const g = bmp[1]!;
  const r = bmp[2]!;
  let same = 0;
  const total = size.width * size.height;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (Math.abs(bmp[o]! - b) <= 6 && Math.abs(bmp[o + 1]! - g) <= 6 && Math.abs(bmp[o + 2]! - r) <= 6) same += 1;
  }
  return same / total;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new SlideRenderTimeoutError(what, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (err) => {
        clearTimeout(timer);
        rejectPromise(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** 超时错误(调用侧映射为结构化 { code: 'timeout' })。 */
export class SlideRenderTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`渲染超时(${what},${Math.round(ms / 1000)}s)`);
    this.name = "SlideRenderTimeoutError";
  }
}

export interface RenderSlideResult {
  png: Buffer;
  inspection: SlideRenderInspection;
  /** 截图空白度(0-1);≈1 说明页面渲染为空。 */
  blankRatio: number;
}

/**
 * 渲染单页并采集截图 + 巡检数据。窗口在 finally 中销毁;加载/就绪/巡检/截图
 * 各步共用一个总超时(缺省 10s)。
 */
export async function renderSlideFile(options: {
  htmlAbsPath: string;
  timeoutMs?: number;
  windowFactory?: SlideWindowFactory;
}): Promise<RenderSlideResult> {
  const timeoutMs = options.timeoutMs ?? SLIDE_RENDER_TIMEOUT_MS;
  const factory = options.windowFactory ?? defaultSlideWindowFactory;
  const win = factory();
  const startedAt = Date.now();
  const remaining = (): number => Math.max(500, timeoutMs - (Date.now() - startedAt));
  try {
    await withTimeout(win.loadURL(pathToFileURL(options.htmlAbsPath).href), remaining(), "loadURL");
    await withTimeout(win.executeJavaScript(READY_WAIT_SCRIPT), remaining(), "fonts/images ready");
    const inspection = (await withTimeout(
      win.executeJavaScript(INSPECT_SLIDE_SOURCE),
      remaining(),
      "inspect",
    )) as SlideRenderInspection;
    const image = await withTimeout(win.capturePage(), remaining(), "capturePage");
    const png = image.toPNG();
    return { png, inspection, blankRatio: blankRatio(image) };
  } catch (err) {
    if (!(err instanceof SlideRenderTimeoutError)) {
      log.warn(`renderSlideFile failed: ${String(err)}`);
    }
    throw err;
  } finally {
    // 无论成功/失败/超时,隐藏窗口必销毁。
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* 窗口可能已随 app 关闭销毁 */
    }
  }
}
