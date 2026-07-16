// Slides HTML 导出:生成自包含 presenter(单文件)。
//
// 安全契约:presenter 面向「发出去给别人打开」的场景,因此必须彻底剥离宿主痕迹 ——
//  - 不含 Cortex preload / 编辑 bridge / 宿主消息协议(页面以 srcdoc 隔离,且导出前
//    已剥离 data-cortex-selected / contenteditable 等编辑态残留);
//  - 不含任何内部文件绝对路径(页面 HTML 内联,资源须已是 data URI 或相对路径 ——
//    远程/未内联资源在检查阶段已给出 warning)。
//
// 播放能力:左右键 / Space / Home / End / 全屏 / 页码 / 打印。
import { sortedSlidesSlots, type SlidesSlot } from "@cortex-work/core/design/slides/slides-types";

/** presenter 单页数据(HTML 已是完整文档字符串)。 */
export interface PresenterSlide {
  title: string;
  html: string;
  /** 演讲者备注(Markdown 原文);presenter 用 N 键切换显示,PDF/PNG 忽略。 */
  notes?: string;
}

function escapeHtml(value: string): string {
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
function slideFrame(slide: PresenterSlide, index: number): string {
  // 备注以 data 属性随页携带(纯文本,转义后不可能逃逸出属性)。
  const notesAttr = slide.notes?.trim() ? ` data-notes="${escapeHtml(slide.notes)}"` : "";
  return `<figure class="slide" data-index="${index}" aria-label="${escapeHtml(slide.title)}"${notesAttr}>
  <iframe title="${escapeHtml(slide.title)}" sandbox="${SLIDE_FRAME_SANDBOX}" srcdoc="${escapeHtml(slide.html)}"></iframe>
</figure>`;
}

const PRESENTER_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0b0d12; color: #e6e8ee;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
  #stage { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
  .slide { position: absolute; margin: 0; width: 1280px; height: 720px; transform-origin: center center;
    background: #fff; box-shadow: 0 8px 40px rgba(0,0,0,0.5); display: none; }
  .slide.active { display: block; }
  .slide iframe { width: 1280px; height: 720px; border: 0; display: block; }
  #bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: flex; gap: 10px;
    align-items: center; padding: 6px 12px; border-radius: 999px; background: rgba(20,22,30,0.82);
    box-shadow: 0 2px 12px rgba(0,0,0,0.4); opacity: 0; transition: opacity 0.2s; font-size: 13px; }
  #bar:hover, body:hover #bar { opacity: 1; }
  #bar button { background: transparent; border: 0; color: #e6e8ee; cursor: pointer; font-size: 15px;
    padding: 2px 8px; border-radius: 6px; }
  #bar button:hover { background: rgba(255,255,255,0.12); }
  #counter { min-width: 62px; text-align: center; font-variant-numeric: tabular-nums; }
  #notes { position: fixed; right: 0; top: 0; bottom: 0; width: 320px; padding: 18px 16px; overflow-y: auto;
    background: rgba(16,18,24,0.96); border-left: 1px solid rgba(255,255,255,0.08); display: none;
    white-space: pre-wrap; font-size: 13px; line-height: 1.7; color: #cbd2e0; }
  body.notes-open #notes { display: block; }
  #notes:empty::before { content: '本页没有备注'; color: #6b7280; }
  @media print {
    html, body { background: #fff; }
    #bar, #notes { display: none !important; }
    #stage { position: static; }
    .slide { display: block !important; position: static; page-break-after: always; box-shadow: none;
      transform: none !important; }
  }
`;

// presenter 运行时:纯导航逻辑,不与任何宿主通信。
const PRESENTER_JS = `
(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var counter = document.getElementById('counter');
  var notes = document.getElementById('notes');
  var index = 0;

  function fit() {
    var scale = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
    slides.forEach(function (el) { el.style.transform = 'scale(' + scale + ')'; });
  }
  function show(next) {
    index = Math.max(0, Math.min(slides.length - 1, next));
    slides.forEach(function (el, i) { el.classList.toggle('active', i === index); });
    counter.textContent = (index + 1) + ' / ' + slides.length;
    // 备注取自当前页的 data-notes(textContent 赋值:纯文本,不解析 HTML)。
    notes.textContent = slides[index].getAttribute('data-notes') || '';
    location.hash = '#' + (index + 1);
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); show(index + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(index - 1); }
    else if (e.key === 'Home') { e.preventDefault(); show(0); }
    else if (e.key === 'End') { e.preventDefault(); show(slides.length - 1); }
    else if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); }
    else if (e.key === 'n' || e.key === 'N') { document.body.classList.toggle('notes-open'); }
  });
  document.getElementById('prev').addEventListener('click', function () { show(index - 1); });
  document.getElementById('next').addEventListener('click', function () { show(index + 1); });
  document.getElementById('full').addEventListener('click', toggleFullscreen);
  document.getElementById('notesBtn').addEventListener('click', function () {
    document.body.classList.toggle('notes-open');
  });
  document.getElementById('print').addEventListener('click', function () { window.print(); });
  window.addEventListener('resize', fit);
  window.addEventListener('hashchange', function () {
    var n = parseInt(location.hash.slice(1), 10);
    if (!isNaN(n) && n - 1 !== index) show(n - 1);
  });

  fit();
  var initial = parseInt(location.hash.slice(1), 10);
  show(isNaN(initial) ? 0 : initial - 1);
})();
`;

/** 生成自包含 presenter HTML(单文件,可直接双击播放)。 */
export function buildPresenterHtml(options: { title: string; slides: PresenterSlide[] }): string {
  const title = options.title.trim() || "演示文稿";
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
    `  <script>${PRESENTER_JS}</script>`,
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
