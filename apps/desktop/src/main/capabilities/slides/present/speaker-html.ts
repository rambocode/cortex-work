// Slides 演示模式「演讲者屏(speaker view)」专用页 —— 注意与 export/ 下的 presenter 区别:
//  - export/html.ts 的 presenter 是「发出去给别人打开」的自包含导出产物,面向观众;
//  - 本文件生成的页只在双屏演示时投到演讲者本人的主屏,展示当前页大预览 + 下一页预览 +
//    备注 + 计时/时钟,永不导出、也不对外分发,所以可以带演讲专用的 UI。
//
// 翻页权威在主进程:本页**只被动**监听 hashchange(主进程广播 location.hash 后触发)同步,
// 自身不监听 keydown —— 避免演讲者屏与观众屏各自翻页导致两窗脱同步。
//
// 动画:当前页大预览同样执行入场动画与分步揭示(与观众屏同一份声明式数据/启发式)。
// 为什么:双屏时演讲者主屏若完全静态,演示者会以为「播放没有动画」(用户实测反馈),
// 也无法判断观众屏当前播到哪一步。转场不做(预览池是即时切换,保持轻量)。
// 实现为独立的第二段脚本(speakerEntranceRuntime),不侵入既有 SPEAKER_JS 同步逻辑。
import {
  buildEntranceStylesheet
} from "@cortex-work/core/design/slides/slides-animation";
import {
  collectSlideEntranceDescriptors,
  inferElementRole,
  planDefaultEntrances
} from "@cortex-work/core/design/slides/slides-heuristics";
import type { SlidesAnimationStyle } from "@cortex-work/core/design/slides/slides-types";
import { escapeHtml, type PresenterSlide } from "../export/html";
import type { PresenterSlideAnimation } from "./presenter-runtime";

// 与 presenter 一致的 iframe sandbox:允许脚本 + 同源(图表/背景渲染需要),其余能力仍被拦。
const SLIDE_FRAME_SANDBOX = "allow-scripts allow-same-origin";

// 当前页大预览(current 池):随页携带 data-notes(纯文本,转义后不逃逸出属性)。
function currentFrame(slide: PresenterSlide, index: number, animationEnabled: boolean): string {
  const notesAttr = slide.notes?.trim() ? ` data-notes="${escapeHtml(slide.notes)}"` : "";
  const steps = animationEnabled
    ? [...new Set(slide.animation?.entrances?.map((entry) => entry.step).filter((step) => step > 0) ?? [])]
        .sort((a, b) => a - b)
        .join(",")
    : "";
  return `<figure class="cur-slide" data-index="${index}" data-steps="${steps}"${notesAttr}>
  <iframe title="${escapeHtml(slide.title)}" sandbox="${SLIDE_FRAME_SANDBOX}" srcdoc="${escapeHtml(slide.html)}"></iframe>
</figure>`;
}

// 下一页小预览(next 池):比当前页 index 大 1 的那张显示,末页无下一张时露出「演示结束」占位。
function nextFrame(slide: PresenterSlide, index: number): string {
  return `<figure class="next-slide" data-index="${index}">
  <iframe title="${escapeHtml(slide.title)}" sandbox="${SLIDE_FRAME_SANDBOX}" srcdoc="${escapeHtml(slide.html)}"></iframe>
</figure>`;
}

function pickerFrame(slide: PresenterSlide, index: number): string {
  return `<li class="picker-slide" data-page="${index + 1}">
  <div class="picker-thumb"><iframe title="${escapeHtml(slide.title)}缩略图" loading="lazy" sandbox="${SLIDE_FRAME_SANDBOX}" srcdoc="${escapeHtml(slide.html)}"></iframe></div>
  <button type="button" class="picker-target" data-page="${index + 1}" aria-label="跳转到第 ${index + 1} 页：${escapeHtml(slide.title)}">
    <span class="picker-number">${index + 1}</span><span class="picker-title">${escapeHtml(slide.title)}</span>
  </button>
</li>`;
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
  #controlbar { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 10px 20px;
    border-top: 1px solid rgba(255,255,255,0.08); background: rgba(16,18,24,0.96);
    -webkit-app-region: no-drag; }
  #hintbar { margin-right: 8px; color: #7f8ba3; font-size: 12px; }
  .presenter-control { min-width: 92px; padding: 8px 14px; border: 1px solid rgba(255,255,255,0.12);
    border-radius: 8px; background: rgba(255,255,255,0.06); color: #e6e8ee; font-size: 13px;
    cursor: pointer; -webkit-app-region: no-drag; }
  .presenter-control:hover { background: rgba(255,255,255,0.12); }
  .presenter-control:focus-visible { outline: 2px solid #7aa2ff; outline-offset: 2px; }
  .presenter-control:disabled { cursor: default; opacity: 0.36; }
  #presenterJump { min-width: 110px; font-variant-numeric: tabular-nums; }
  #presenterEnd { margin-left: 18px; color: #ffb4b4; }
  #slidePicker[hidden] { display: none; }
  #slidePicker { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 48px;
    -webkit-app-region: no-drag; }
  #pickerBackdrop { position: absolute; inset: 0; border: 0; background: rgba(0,0,0,0.66); cursor: default; }
  #pickerPanel { position: relative; width: min(920px, 88vw); max-height: min(720px, 82vh); overflow: hidden;
    display: flex; flex-direction: column; border: 1px solid rgba(255,255,255,0.14); border-radius: 14px;
    background: #151821; box-shadow: 0 24px 80px rgba(0,0,0,0.55); }
  #pickerTitle { margin: 0; padding: 16px 20px 12px; font-size: 16px; }
  #pickerGrid { list-style: none; margin: 0; padding: 0 20px 20px; overflow-y: auto;
    display: grid; grid-template-columns: repeat(auto-fill, minmax(184px, 1fr)); gap: 14px; }
  .picker-slide { min-width: 0; overflow: hidden; border: 1px solid rgba(255,255,255,0.1);
    border-radius: 10px; background: rgba(255,255,255,0.04); }
  .picker-slide[aria-current="page"] { border-color: #7aa2ff; box-shadow: 0 0 0 1px #7aa2ff; }
  .picker-thumb { position: relative; width: 100%; aspect-ratio: 16 / 9; overflow: hidden; background: #000; }
  .picker-thumb iframe { position: absolute; inset: 0; width: 1280px; height: 720px; border: 0;
    transform: scale(var(--picker-scale, 0.14)); transform-origin: top left; pointer-events: none; }
  .picker-target { width: 100%; display: flex; align-items: center; gap: 8px; padding: 9px 10px; border: 0;
    background: transparent; color: #e6e8ee; cursor: pointer; text-align: left; }
  .picker-target:hover { background: rgba(255,255,255,0.08); }
  .picker-number { color: #7f8ba3; font-variant-numeric: tabular-nums; }
  .picker-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

// 演讲者页运行时:被动同步 + 计时/时钟。翻页由主进程改 location.hash 驱动,本页不监听 keydown。
const SPEAKER_JS = `
(function () {
  var curSlides = Array.prototype.slice.call(document.querySelectorAll('.cur-slide'));
  var nextSlides = Array.prototype.slice.call(document.querySelectorAll('.next-slide'));
  var counter = document.getElementById('counter');
  var notes = document.getElementById('notes');
  var nextEnd = document.getElementById('nextEnd');
  var prevButton = document.getElementById('presenterPrev');
  var nextButton = document.getElementById('presenterNext');
  var jumpButton = document.getElementById('presenterJump');
  var endButton = document.getElementById('presenterEnd');
  var picker = document.getElementById('slidePicker');
  var index = 0;
  var total = curSlides.length;

  function hashState() {
    var match = /^(\\d+)(?:\\.(all|\\d+))?$/.exec(location.hash.replace(/^#/, ''));
    return { page: match ? parseInt(match[1], 10) - 1 : index, token: match ? match[2] || null : null };
  }

  function sendControl(action, page) {
    var suffix = typeof page === 'number' ? '?page=' + page : '';
    location.href = 'cortex-presenter://control/' + action + suffix;
  }

  function updateControls() {
    var state = hashState();
    var rawSteps = (curSlides[index] && curSlides[index].getAttribute('data-steps')) || '';
    var steps = rawSteps ? rawSteps.split(',').map(function (value) { return parseInt(value, 10); }) : [];
    var currentStep = state.token === 'all' ? Number.MAX_SAFE_INTEGER : parseInt(state.token || '0', 10);
    var hasPendingStep = steps.some(function (value) { return value > currentStep; });
    prevButton.disabled = index === 0;
    nextButton.disabled = index === total - 1 && !hasPendingStep;
    jumpButton.textContent = (index + 1) + ' / ' + total;
    Array.prototype.forEach.call(document.querySelectorAll('.picker-slide'), function (card) {
      if (parseInt(card.getAttribute('data-page'), 10) === index + 1) card.setAttribute('aria-current', 'page');
      else card.removeAttribute('aria-current');
    });
  }

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
    updateControls();
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
  // hash 契约已扩展为 '#页[.步|.all]'(见 presenter-runtime):parseInt 天然只取
  // 页号前缀('3.2'→3),演讲者屏不播元素入场,step 变化同页时 n-1===index 直接忽略。
  window.addEventListener('hashchange', function () {
    var n = parseInt(location.hash.slice(1), 10);
    if (!isNaN(n) && n - 1 !== index) show(n - 1);
    else updateControls();
  });

  prevButton.addEventListener('click', function () { sendControl('back'); });
  nextButton.addEventListener('click', function () { sendControl('advance'); });
  endButton.addEventListener('click', function () { sendControl('end'); });
  jumpButton.addEventListener('click', function () { picker.hidden = !picker.hidden; });
  document.getElementById('pickerBackdrop').addEventListener('click', function () { picker.hidden = true; });
  document.getElementById('pickerGrid').addEventListener('click', function (event) {
    var target = event.target.closest('.picker-target');
    if (!target) return;
    picker.hidden = true;
    sendControl('jump', parseInt(target.getAttribute('data-page'), 10));
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

// 演讲者屏当前页入场运行时:自包含函数,toString 注入(依赖按参数传,防打包器重命名)。
// 与 presenter-runtime 的入场逻辑同源语义但独立精简实现:只作用于 .cur-slide 池,
// 只做入场/分步揭示,不做页间转场;hash 契约同 `#页[.步|.all]`。
/* eslint-disable */
export function speakerEntranceRuntime(
  CONFIG: {
    style: string;
    slides: Array<{ entrances?: Array<{ elementId: string; preset: string; step: number; delayMs?: number; durationMs?: number }> } | null>;
    entranceCss: string;
  },
  planFn: (
    els: Array<{ elementId: string; tag: string; top: number; left: number; area: number; isChart?: boolean }>,
    style: string,
    w: number,
    h: number,
    inferRole: unknown
  ) => Array<{ elementId: string; preset: string; step: number; delayMs?: number; durationMs?: number }>,
  inferFn: unknown,
  collectFn: (
    doc: Document,
    w: number,
    h: number
  ) => Array<{ el: unknown; elementId: string; tag: string; top: number; left: number; area: number; isChart?: boolean }>
): void {
  if (CONFIG.style === "none") return;
  var frames = Array.prototype.slice
    .call(document.querySelectorAll(".cur-slide iframe")) as HTMLIFrameElement[];
  type Entry = {
    el: HTMLElement;
    preset: string;
    step: number;
    delayMs: number;
    durationMs?: number;
  };
  var plans: Array<Entry[] | null> = frames.map(function () { return null; });
  var loaded: boolean[] = frames.map(function () { return false; });
  var page = 0;
  var step = 0;
  var timers: number[] = [];

  // 惰性 prepare:首次切到该页才注入样式并构建计划(预览池 iframe 常年 display:none,
  // rect 不可测,启发式走文档序回退 —— 与观众屏顺序可能有出入,预览可接受)。
  function prepare(i: number): Entry[] | null {
    if (plans[i]) return plans[i];
    var frame = frames[i];
    var doc = frame && frame.contentDocument;
    if (!doc || !doc.body || doc.URL !== "about:srcdoc") return null;
    if (!doc.querySelector("style[data-cortex-anim-css]")) {
      var styleEl = doc.createElement("style");
      styleEl.setAttribute("data-cortex-anim-css", "1");
      styleEl.textContent = CONFIG.entranceCss;
      (doc.head || doc.body).appendChild(styleEl);
    }
    var entries: Entry[] = [];
    var conf = CONFIG.slides[i];
    if (conf && conf.entrances && conf.entrances.length) {
      conf.entrances.forEach(function (e) {
        var el = doc!.querySelector('[data-cortex-id="' + CSS.escape(e.elementId) + '"]') as HTMLElement | null;
        if (el) {
          entries.push({
            el: el,
            preset: e.preset,
            step: e.step,
            delayMs: e.delayMs || 0,
            durationMs: e.durationMs,
          });
        }
      });
    } else {
      // 默认启发式:采集器(core 注入)统一负责根容器下钻与不可测回退,与观众屏同源。
      var usable = collectFn(doc, 1280, 720);
      var plan = planFn(usable, CONFIG.style, 1280, 720, inferFn);
      var byId: Record<string, { el: unknown }> = {};
      usable.forEach(function (d) { byId[d.elementId] = d; });
      plan.forEach(function (p) {
        var d = byId[p.elementId];
        if (d) {
          entries.push({
            el: d.el as HTMLElement,
            preset: p.preset,
            step: p.step,
            delayMs: p.delayMs || 0,
            durationMs: p.durationMs,
          });
        }
      });
    }
    plans[i] = entries;
    return entries;
  }

  function clearTimers(): void {
    timers.forEach(function (id) { clearTimeout(id); });
    timers = [];
  }

  // 复位:全部条目回到隐藏初态(随后 revealUpTo 从头播)。
  function reset(i: number): void {
    var entries = prepare(i);
    if (!entries) return;
    entries.forEach(function (entry) {
      entry.el.classList.remove("cortex-anim-enter-" + entry.preset);
      entry.el.style.animationDuration = "";
      entry.el.setAttribute("data-cortex-anim", entry.preset);
      entry.el.classList.add("cortex-anim-hidden");
    });
    void (frames[i].contentDocument as Document).body.offsetWidth;
  }

  // 增量揭示:只处理「仍隐藏且 step<=target」的条目;已显示的不重播(同页推进不闪)。
  function revealUpTo(i: number, targetStep: number, animate: boolean): void {
    var entries = prepare(i);
    if (!entries) return;
    entries.forEach(function (entry) {
      if (entry.step > targetStep) return;
      if (!entry.el.classList.contains("cortex-anim-hidden")) return;
      if (animate) {
        timers.push(
          window.setTimeout(function () {
            entry.el.style.animationDuration = entry.durationMs ? entry.durationMs + "ms" : "";
            entry.el.classList.remove("cortex-anim-hidden");
            entry.el.classList.add("cortex-anim-enter-" + entry.preset);
          }, entry.delayMs)
        );
      } else {
        entry.el.style.animationDuration = "";
        entry.el.classList.remove("cortex-anim-hidden");
        entry.el.classList.remove("cortex-anim-enter-" + entry.preset);
      }
    });
  }

  function maxStepOf(i: number): number {
    var entries = prepare(i);
    var max = 0;
    if (entries) entries.forEach(function (e) { if (e.step > max) max = e.step; });
    return max;
  }

  function parseHash(): { page: number; token: string | null } | null {
    var m = /^(\d+)(?:\.(all|\d+))?$/.exec(location.hash.replace(/^#/, ""));
    if (!m) return null;
    return { page: parseInt(m[1], 10) - 1, token: m[2] || null };
  }

  function sync(initial: boolean): void {
    var h = parseHash();
    if (!h && !initial) return;
    var targetPage = h ? h.page : 0;
    var token = h ? h.token : null;
    if (targetPage !== page || initial) {
      clearTimers();
      page = targetPage;
      if (token === "all") {
        // 回退/跳页:全显不播(与观众屏语义一致)。
        step = maxStepOf(page);
        revealUpTo(page, step, false);
      } else {
        step = token ? parseInt(token, 10) : 0;
        if (isNaN(step)) step = 0;
        reset(page);
        revealUpTo(page, step, true);
      }
      return;
    }
    // 同页推进:增量揭示新出现的 step。
    if (token === "all") {
      step = maxStepOf(page);
      revealUpTo(page, step, false);
    } else if (token) {
      var s = parseInt(token, 10);
      if (!isNaN(s) && s > step) { step = s; revealUpTo(page, s, true); }
    }
  }

  window.addEventListener("hashchange", function () { sync(false); });
  // 每个当前页 iframe 都可能在 hash 已切换后才完成加载;加载完成时补做当前页同步。
  function markReady(i: number): void {
    var frame = frames[i];
    var doc = frame && frame.contentDocument;
    if (!doc || !doc.body || doc.URL !== "about:srcdoc") return;
    if (loaded[i]) return;
    loaded[i] = true;
    if (i === page) sync(true);
    else prepare(i);
  }
  frames.forEach(function (frame, i) {
    frame.addEventListener("load", function () { markReady(i); });
    try {
      if (frame.contentDocument && frame.contentDocument.URL === "about:srcdoc") markReady(i);
    } catch (_e) { /* 防御 */ }
  });
}
/* eslint-enable */

/** 生成演讲者屏页面(自包含单文件,主进程写临时文件后 loadFile 播放)。 */
export function buildSpeakerHtml(options: {
  title: string;
  slides: PresenterSlide[];
  startIndex: number;
  /** 全局动画风格;缺省 none = 当前页预览静态(零回归)。 */
  animationStyle?: SlidesAnimationStyle;
}): string {
  const title = options.title.trim() || "演示文稿";
  // 当前页入场动画配置(与观众屏同一份声明式数据;`</script>` 逃逸防护同 presenter)。
  const style = options.animationStyle ?? "none";
  const animConfig = JSON.stringify({
    style,
    slides: options.slides.map((s: PresenterSlide & { animation?: PresenterSlideAnimation }) =>
      s.animation ? { entrances: s.animation.entrances } : null,
    ),
    entranceCss: buildEntranceStylesheet(style)
  }).replace(/</g, "\\u003c");
  const animScript = `(${speakerEntranceRuntime.toString()})(${animConfig}, (${planDefaultEntrances.toString()}), (${inferElementRole.toString()}), (${collectSlideEntranceDescriptors.toString()}));`;
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
    ...options.slides.map((slide, index) => `        ${currentFrame(slide, index, style !== "none")}`),
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
    '  <footer id="controlbar" aria-label="演示控制">',
    '    <span id="hintbar">← → 翻页 · Esc 结束演示</span>',
    '    <button id="presenterPrev" class="presenter-control" type="button">← 上一页</button>',
    '    <button id="presenterJump" class="presenter-control" type="button" aria-haspopup="dialog">1 / 1</button>',
    '    <button id="presenterNext" class="presenter-control" type="button">下一步 →</button>',
    '    <button id="presenterEnd" class="presenter-control" type="button">结束演示</button>',
    "  </footer>",
    '  <section id="slidePicker" role="dialog" aria-modal="true" aria-labelledby="pickerTitle" hidden>',
    '    <button id="pickerBackdrop" type="button" aria-label="关闭页面列表"></button>',
    '    <div id="pickerPanel">',
    '      <h2 id="pickerTitle">跳转页面</h2>',
    '      <ol id="pickerGrid">',
    ...options.slides.map((slide, index) => `        ${pickerFrame(slide, index)}`),
    "      </ol>",
    "    </div>",
    "  </section>",
    `  <script>${SPEAKER_JS}</script>`,
    `  <script>${animScript}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
