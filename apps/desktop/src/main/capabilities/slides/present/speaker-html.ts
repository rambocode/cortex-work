// Slides 演示模式「演讲者屏(speaker view)」专用页 —— 注意与 export/ 下的 presenter 区别:
//  - export/html.ts 的 presenter 是「发出去给别人打开」的自包含导出产物,面向观众;
//  - 本文件生成的页只在双屏演示时投到演讲者本人的主屏,展示当前页大预览 + 下一页预览 +
//    备注 + 计时/时钟,永不导出、也不对外分发,所以可以带演讲专用的 UI。
//
// 翻页权威在主进程:本页**只被动**监听 hashchange(主进程广播 location.hash 后触发)同步,
// 自身不监听 keydown —— 避免演讲者屏与观众屏各自翻页导致两窗脱同步。
import { escapeHtml, type PresenterSlide } from "../export/html";

// 与 presenter 一致的 iframe sandbox:允许脚本 + 同源(图表/背景渲染需要),其余能力仍被拦。
const SLIDE_FRAME_SANDBOX = "allow-scripts allow-same-origin";

// 当前页大预览(current 池):随页携带 data-notes(纯文本,转义后不逃逸出属性)。
function currentFrame(slide: PresenterSlide, index: number): string {
  const notesAttr = slide.notes?.trim() ? ` data-notes="${escapeHtml(slide.notes)}"` : "";
  return `<figure class="cur-slide" data-index="${index}"${notesAttr}>
  <iframe title="${escapeHtml(slide.title)}" sandbox="${SLIDE_FRAME_SANDBOX}" srcdoc="${escapeHtml(slide.html)}"></iframe>
</figure>`;
}

// 下一页小预览(next 池):比当前页 index 大 1 的那张显示,末页无下一张时露出「演示结束」占位。
function nextFrame(slide: PresenterSlide, index: number): string {
  return `<figure class="next-slide" data-index="${index}">
  <iframe title="${escapeHtml(slide.title)}" sandbox="${SLIDE_FRAME_SANDBOX}" srcdoc="${escapeHtml(slide.html)}"></iframe>
</figure>`;
}

const SPEAKER_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0b0d12; color: #e6e8ee;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
  body { display: grid; grid-template-rows: auto 1fr auto; height: 100vh; }
  #topbar { display: flex; align-items: center; gap: 16px; padding: 10px 20px;
    border-bottom: 1px solid rgba(255,255,255,0.08); background: rgba(16,18,24,0.9); }
  #deckTitle { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; flex: 1; min-width: 0; }
  #topbar .meta { font-variant-numeric: tabular-nums; font-size: 14px; color: #cbd2e0; }
  #counter { min-width: 70px; text-align: center; }
  #elapsed { min-width: 64px; text-align: center; color: #9aa4b8; }
  #clock { min-width: 58px; text-align: right; color: #9aa4b8; }
  #main { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; padding: 16px; min-height: 0; }
  #currentPane, #rightPane { min-height: 0; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
  .paneLabel { font-size: 12px; letter-spacing: 0.04em; color: #6b7280; text-transform: uppercase; }
  #currentStage, #nextStage { position: relative; flex: 1; min-height: 0; overflow: hidden;
    border-radius: 8px; background: #000; }
  #nextStage { flex: 0 0 auto; height: 200px; }
  .cur-slide, .next-slide { position: absolute; top: 50%; left: 50%; margin: 0;
    width: 1280px; height: 720px; transform-origin: center center; background: #fff; display: none; }
  .cur-slide.active, .next-slide.active { display: block; }
  .cur-slide iframe, .next-slide iframe { width: 1280px; height: 720px; border: 0; display: block;
    pointer-events: none; }
  #nextEnd { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
    color: #6b7280; font-size: 15px; background: #0b0d12; }
  #nextEnd.active { display: flex; }
  #notesPane { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
  #notes { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px; border-radius: 8px;
    background: rgba(16,18,24,0.96); border: 1px solid rgba(255,255,255,0.08);
    white-space: pre-wrap; font-size: 15px; line-height: 1.7; color: #cbd2e0; }
  #notes:empty::before { content: '本页没有备注'; color: #6b7280; }
  #hintbar { padding: 8px 20px; border-top: 1px solid rgba(255,255,255,0.08);
    background: rgba(16,18,24,0.9); font-size: 13px; color: #9aa4b8; text-align: center; }
`;

// 演讲者页运行时:被动同步 + 计时/时钟。翻页由主进程改 location.hash 驱动,本页不监听 keydown。
const SPEAKER_JS = `
(function () {
  var curSlides = Array.prototype.slice.call(document.querySelectorAll('.cur-slide'));
  var nextSlides = Array.prototype.slice.call(document.querySelectorAll('.next-slide'));
  var counter = document.getElementById('counter');
  var notes = document.getElementById('notes');
  var nextEnd = document.getElementById('nextEnd');
  var index = 0;
  var total = curSlides.length;

  // 1280×720 内容按各自容器等比缩放并居中(transform 已 translate(-50%,-50%) 定位到中心)。
  function fitPool(pool, stageId) {
    var stage = document.getElementById(stageId);
    if (!stage) return;
    var scale = Math.min(stage.clientWidth / 1280, stage.clientHeight / 720);
    pool.forEach(function (el) { el.style.transform = 'translate(-50%,-50%) scale(' + scale + ')'; });
  }
  function fit() {
    fitPool(curSlides, 'currentStage');
    fitPool(nextSlides, 'nextStage');
  }
  function show(next) {
    index = Math.max(0, Math.min(total - 1, next));
    curSlides.forEach(function (el, i) { el.classList.toggle('active', i === index); });
    // 下一页 = index+1;末页时无对应张,露出「演示结束」占位。
    var hasNext = index + 1 < total;
    nextSlides.forEach(function (el, i) { el.classList.toggle('active', i === index + 1); });
    nextEnd.classList.toggle('active', !hasNext);
    counter.textContent = (index + 1) + ' / ' + total;
    // 备注取当前页 data-notes(textContent 赋值:纯文本,不解析 HTML)。
    notes.textContent = (curSlides[index] && curSlides[index].getAttribute('data-notes')) || '';
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  // 经过时间:从页面加载起计(演示开始即建演讲者窗),每秒刷 mm:ss。
  var startedAt = Date.now();
  var elapsedEl = document.getElementById('elapsed');
  function tickElapsed() {
    var s = Math.floor((Date.now() - startedAt) / 1000);
    elapsedEl.textContent = pad(Math.floor(s / 60)) + ':' + pad(s % 60);
  }
  var clockEl = document.getElementById('clock');
  function tickClock() {
    var d = new Date();
    clockEl.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  window.addEventListener('resize', fit);
  // 只被动同步:主进程广播 location.hash 后触发,反解 1 基页号。
  window.addEventListener('hashchange', function () {
    var n = parseInt(location.hash.slice(1), 10);
    if (!isNaN(n) && n - 1 !== index) show(n - 1);
  });

  fit();
  tickElapsed();
  tickClock();
  setInterval(tickElapsed, 1000);
  setInterval(tickClock, 1000);
  var initial = parseInt(location.hash.slice(1), 10);
  show(isNaN(initial) ? 0 : initial - 1);
})();
`;

/** 生成演讲者屏页面(自包含单文件,主进程写临时文件后 loadFile 播放)。 */
export function buildSpeakerHtml(options: {
  title: string;
  slides: PresenterSlide[];
  startIndex: number;
}): string {
  const title = options.title.trim() || "演示文稿";
  return [
    "<!doctype html>",
    '<html lang="zh-Hans">',
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${escapeHtml(title)} · 演讲者视图</title>`,
    `  <style>${SPEAKER_CSS}</style>`,
    "</head>",
    "<body>",
    '  <header id="topbar">',
    `    <div id="deckTitle">${escapeHtml(title)}</div>`,
    '    <span id="counter" class="meta">1 / 1</span>',
    '    <span id="elapsed" class="meta" title="已用时间">00:00</span>',
    '    <span id="clock" class="meta" title="当前时间">00:00</span>',
    "  </header>",
    '  <main id="main">',
    '    <section id="currentPane">',
    '      <div class="paneLabel">当前页</div>',
    '      <div id="currentStage">',
    ...options.slides.map((slide, index) => `        ${currentFrame(slide, index)}`),
    "      </div>",
    "    </section>",
    '    <section id="rightPane">',
    '      <div class="paneLabel">下一页</div>',
    '      <div id="nextStage">',
    ...options.slides.map((slide, index) => `        ${nextFrame(slide, index)}`),
    '        <div id="nextEnd">演示结束</div>',
    "      </div>",
    '      <div id="notesPane">',
    '        <div class="paneLabel">演讲者备注</div>',
    '        <div id="notes" aria-label="演讲者备注"></div>',
    "      </div>",
    "    </section>",
    "  </main>",
    '  <footer id="hintbar">← → 翻页 · Esc 结束演示</footer>',
    `  <script>${SPEAKER_JS}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
