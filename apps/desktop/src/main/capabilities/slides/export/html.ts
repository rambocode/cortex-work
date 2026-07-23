// Slides HTML 导出:生成自包含 presenter(单文件)。
//
// 安全契约:presenter 面向「发出去给别人打开」的场景,因此必须彻底剥离宿主痕迹 ——
//  - 不含 Cortex preload / 编辑 bridge / 宿主消息协议(页面以 srcdoc 隔离,且导出前
//    已剥离 data-cortex-selected / contenteditable 等编辑态残留);
//  - 不含任何内部文件绝对路径(页面 HTML 内联,资源须已是 data URI 或相对路径 ——
//    远程/未内联资源在检查阶段已给出 warning)。
//
// 播放能力:左右键 / Space / Home / End / 全屏 / 页码 / 打印 / 声明式动画
// (转场 + 元素入场 + PPT 式分步;运行时在 present/presenter-runtime.ts)。
import {
  sortedSlidesSlots,
  type SlidesAnimationStyle,
  type SlidesSlot
} from "@cortex-work/core/design/slides/slides-types";
import {
  PRESENTER_CSS,
  buildPresenterScript,
  type PresenterSlideAnimation
} from "../present/presenter-runtime";

/** presenter 单页数据(HTML 已是完整文档字符串)。 */
export interface PresenterSlide {
  title: string;
  html: string;
  /** 演讲者备注(Markdown 原文);presenter 用 N 键切换显示,PDF/PNG 忽略。 */
  notes?: string;
  /** 声明式动画注解(来自 deck.json);静态导出路径(PDF/PNG/PPTX)忽略。 */
  animation?: PresenterSlideAnimation;
}

// 导出供演示模式专用页(present/speaker-html.ts)复用同一份 HTML 转义,避免重复实现漂移。
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * 每页 iframe 的 sandbox:两个 flag 缺一不可,均由真实 printToPDF 实测确定 ——
 *  - 缺 `allow-scripts`:页面合同允许的受限内联脚本被禁,canvas/图表页导出成空白
 *    (实测 04-complex 的柱状图整块丢失);
 *  - 缺 `allow-same-origin`:frame 变成跨进程 OOPIF,打印时 printBackground 不生效,
 *    页面背景渐变整片丢失(实测同页背景变纯白)。
 *
 * 两者同给意味着 frame 可自行摘掉 sandbox,故这里**不指望**它做源隔离;它的实际价值是
 * 强制页面合同的禁令:未列入的 allow-popups / allow-downloads / allow-top-navigation /
 * allow-forms / allow-modals 依旧被拦住 —— 即弹窗、下载、顶层跳转、表单提交全部无效。
 * 真正的隔离由「presenter/打印文档均为本地文件、无 preload、无宿主 bridge」保证。
 */
const SLIDE_FRAME_SANDBOX = "allow-scripts allow-same-origin";

// 每页以 <iframe srcdoc> 承载:既保持页面自身的 CSS 隔离(slide HTML 各自带全局样式,
// 直接拼进同一文档会互相污染),又不需要外部文件。srcdoc 内容做 HTML 属性转义。
// .slide-inner 是转场动画的作用层:figure 承担 fit 缩放(inline transform),转场
// class 打在 inner 上才不会与缩放互相覆盖(inline style 优先级高于 class)。
function slideFrame(slide: PresenterSlide, index: number): string {
  // 备注以 data 属性随页携带(纯文本,转义后不可能逃逸出属性)。
  const notesAttr = slide.notes?.trim() ? ` data-notes="${escapeHtml(slide.notes)}"` : "";
  return `<figure class="slide" data-index="${index}" aria-label="${escapeHtml(slide.title)}"${notesAttr}>
  <div class="slide-inner"><iframe title="${escapeHtml(slide.title)}" sandbox="${SLIDE_FRAME_SANDBOX}" srcdoc="${escapeHtml(slide.html)}"></iframe></div>
</figure>`;
}

/** 生成自包含 presenter HTML(单文件,可直接双击播放)。animationStyle 缺省 none = 静态。 */
export function buildPresenterHtml(options: {
  title: string;
  slides: PresenterSlide[];
  animationStyle?: SlidesAnimationStyle;
}): string {
  const title = options.title.trim() || "演示文稿";
  const script = buildPresenterScript({
    animationStyle: options.animationStyle ?? "none",
    slides: options.slides.map((s) => s.animation ?? null),
    hasElementMarkers: options.slides.map((s) => s.html.includes("data-cortex-id"))
  });
  return [
    "<!doctype html>",
    '<html lang="zh-Hans">',
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${escapeHtml(title)}</title>`,
    `  <style>${PRESENTER_CSS}</style>`,
    "</head>",
    "<body>",
    '  <main id="stage">',
    ...options.slides.map((slide, index) => `    ${slideFrame(slide, index)}`),
    "  </main>",
    '  <aside id="notes" aria-label="演讲者备注"></aside>',
    '  <nav id="bar">',
    '    <button id="prev" title="上一页" aria-label="上一页">‹</button>',
    '    <span id="counter">1 / 1</span>',
    '    <button id="next" title="下一页" aria-label="下一页">›</button>',
    '    <button id="notesBtn" title="演讲者备注(N)" aria-label="演讲者备注">☰</button>',
    '    <button id="full" title="全屏(F)" aria-label="全屏">⛶</button>',
    '    <button id="print" title="打印" aria-label="打印">⎙</button>',
    "  </nav>",
    `  <script>${script}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * 组合 PDF 用的打印文档:每页固定 1280×720px、page-break-after,交
 * printToPDF(preferCSSPageSize) 一次导出 —— 不逐页打印再拼接。
 */
export function buildPrintableHtml(options: { title: string; slides: PresenterSlide[] }): string {
  const title = options.title.trim() || "演示文稿";
  const css = `
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .page { width: 1280px; height: 720px; overflow: hidden; page-break-after: always; break-after: page; }
    .page:last-child { page-break-after: auto; break-after: auto; }
    .page iframe { width: 1280px; height: 720px; border: 0; display: block; }
    @page { size: 1280px 720px; margin: 0; }
  `;
  return [
    "<!doctype html>",
    '<html lang="zh-Hans">',
    "<head>",
    '  <meta charset="utf-8" />',
    `  <title>${escapeHtml(title)}</title>`,
    `  <style>${css}</style>`,
    "</head>",
    "<body>",
    ...options.slides.map(
      (slide) =>
        `  <section class="page"><iframe sandbox="${SLIDE_FRAME_SANDBOX}" srcdoc="${escapeHtml(slide.html)}"></iframe></section>`,
    ),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** PNG 导出文件名:按 deck 顺序补零 + 安全化标题(slide-01-封面.png)。 */
export function pngFileNameFor(slot: SlidesSlot, index: number, total: number): string {
  const width = Math.max(2, String(total).length);
  const seq = String(index + 1).padStart(width, "0");
  // 文件名安全化:去掉路径分隔符与控制字符,限长,避免奇异标题写坏文件系统。
  const safeTitle = slot.title
    .replace(/[/\\:*?"<>|]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 40);
  return safeTitle ? `slide-${seq}-${safeTitle}.png` : `slide-${seq}.png`;
}

/** 按 manifest 顺序取出 presenter 用的 slot 列表(仅已生成页)。 */
export function presenterSlots(slides: readonly SlidesSlot[]): SlidesSlot[] {
  return sortedSlidesSlots(slides).filter((s) => s.status === "ready");
}
