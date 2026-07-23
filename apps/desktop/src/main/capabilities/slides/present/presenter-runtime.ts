// Presenter 动画运行时:从 export/html.ts 拆出的播放器 CSS/JS 构造(文件行数红线所迫,
// 也让「转场/入场/分步状态机」有独立的演进空间)。
//
// 架构(与实现计划一致):
//  - 声明式动画数据存 deck.json,经 buildPresenterHtml 以 JSON config 内嵌进 presenter;
//    slot HTML 本身永远是「终态全可见」,静态导出(PPTX/PDF/PNG)不受任何影响。
//  - 父页驱动编排:每页 iframe 为 sandbox="allow-scripts allow-same-origin"(srcdoc 继承
//    宿主 origin),父页可直接操作 contentDocument —— 注入入场样式表、给元素打隐藏
//    class、按计划播放,无需 postMessage 握手,step 状态天然集中在父页一处。
//  - 无显式 entrances 的页面走默认编排启发式(core slides-heuristics,经 toString 注入;
//    依赖函数按参数显式传递,防打包器重命名令自由引用失联)。
//  - hash 契约扩展为 `#页.步`(1 基页号):`#3` = 第 3 页自动入场;`#3.2` = 第 3 页
//    已推进到 step 2;`#3.all` = 第 3 页全显不播动画(回退/跳页语义)。speaker 页用
//    parseInt 解析天然只取页号,无需升级。双屏模式主进程是唯一翻页权威,broadcast
//    本格式;单屏模式本运行时自持状态机并把状态写回 hash(书签/刷新可恢复)。
//  - 降级:全局风格 none → 完全关闭入场与转场(硬切,零回归);低端探测
//    (hardwareConcurrency<=4)→ 3D 转场按 TRANSITION_FALLBACK 降为 2D。
//    刻意不读 prefers-reduced-motion:macOS「减弱动态效果」开启时它恒为 true,
//    会把用户显式选择的演示动画静默吞掉(实测)。
import {
  ENTRANCE_PRESETS,
  STYLE_DEFAULT_TRANSITION,
  STYLE_DURATION_SCALE,
  TRANSITIONS,
  TRANSITION_FALLBACK,
  buildEntranceStylesheet,
  buildTransitionStylesheet,
  defaultHeuristicEntranceDurationMs
} from "@cortex-work/core/design/slides/slides-animation";
import {
  collectSlideEntranceDescriptors,
  inferElementRole,
  planDefaultEntrances
} from "@cortex-work/core/design/slides/slides-heuristics";
import type {
  SlidesAnimationStyle,
  SlidesSlotAnimation
} from "@cortex-work/core/design/slides/slides-types";

/** 播放器每页动画配置(内嵌 JSON;数组下标与 .slide DOM 顺序一致)。 */
export type PresenterSlideAnimation = Pick<SlidesSlotAnimation, "transition" | "entrances">;

/**
 * 播放器父页 CSS。相对旧版的关键改动:白底卡片视觉从 .slide(figure)下沉到
 * .slide-inner —— figure 只负责定位与 fit 缩放(inline transform),转场 class 作用在
 * inner 上,才能与缩放共存(inline style 优先级高于 class,直接作用 figure 会互相覆盖);
 * 且转场期间出入两页同显,figure 透明后出页淡出才能露出下面的入页。
 */
export const PRESENTER_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0b0d12; color: #e6e8ee;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
  #stage { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
  .slide { position: absolute; margin: 0; width: 1280px; height: 720px; transform-origin: center center;
    background: transparent; display: none; }
  .slide.active { display: block; }
  .slide-inner { width: 1280px; height: 720px; background: #fff;
    box-shadow: 0 8px 40px rgba(0,0,0,0.5); }
  .slide iframe { width: 1280px; height: 720px; border: 0; display: block; }
  ${buildTransitionStylesheet()}
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
    .slide { display: block !important; position: static; page-break-after: always;
      transform: none !important; }
    .slide-inner { box-shadow: none; }
  }
`;

// 运行时主体:自包含函数,以 (config, planFn, inferFn) 形参接收全部依赖后 toString 注入。
// config 内含入场样式表文本/转场时长表/降级表等纯数据,函数体不引用任何模块符号。
/* eslint-disable */
function presenterRuntime(
  CONFIG: {
    style: string;
    slides: Array<{ transition?: string; entrances?: Array<{ elementId: string; preset: string; step: number; delayMs?: number; durationMs?: number }> } | null>;
    stepSequences: number[][];
    stepDurations: Array<Record<number, number>>;
    defaultTransition: string;
    fallback: Record<string, string>;
    durations: Record<string, number>;
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
  var slides = Array.prototype.slice.call(document.querySelectorAll(".slide")) as HTMLElement[];
  var inners = slides.map(function (el) { return el.querySelector(".slide-inner") as HTMLElement; });
  var frames = slides.map(function (el) { return el.querySelector("iframe") as HTMLIFrameElement; });
  var counter = document.getElementById("counter")!;
  var notes = document.getElementById("notes")!;
  var total = slides.length;
  var index = 0;
  var step = 0;
  var transitioning = false;
  var busyUntil = 0;

  // 动画总开关:只看风格是否为 none。不读 prefers-reduced-motion —— macOS 全局
  // 「减弱动态效果」会让它恒为 true,把用户显式选择的演示动画整体吞掉(实测踩坑:
  // 播放完全无动画)。演示动画是 deck 级的显式选择,关闭途径就是风格选「无动画」。
  var animEnabled = CONFIG.style !== "none";
  // 低端探测:仅降级 3D/高开销转场,入场动画保留(纯 transform/opacity 足够便宜)。
  var lowEnd = (navigator.hardwareConcurrency || 8) <= 4;

  // 每页入场计划(iframe load 后构建):{el,preset,step,delayMs,durationMs}[];null=未就绪。
  type Entry = { el: HTMLElement; preset: string; step: number; delayMs: number; durationMs?: number };
  var plans: Array<Entry[] | null> = slides.map(function () { return null; });
  var stepSequences: number[][] = CONFIG.stepSequences.map(function (steps) { return steps.slice(); });

  function fit(): void {
    var scale = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
    slides.forEach(function (el) { el.style.transform = "scale(" + scale + ")"; });
  }

  function resolveTransition(i: number): string {
    if (!animEnabled) return "none";
    var conf = CONFIG.slides[i];
    var t = (conf && conf.transition) || CONFIG.defaultTransition;
    if (lowEnd) t = CONFIG.fallback[t] || t;
    return t;
  }

  function hideEntry(entry: Entry): void {
    entry.el.setAttribute("data-cortex-anim", entry.preset);
    entry.el.classList.add("cortex-anim-hidden");
  }

  function revealEntry(entry: Entry, animate: boolean): void {
    entry.el.classList.remove("cortex-anim-hidden");
    if (animate) {
      if (entry.durationMs) entry.el.style.animationDuration = entry.durationMs + "ms";
      entry.el.classList.add("cortex-anim-enter-" + entry.preset);
    } else {
      entry.el.classList.remove("cortex-anim-enter-" + entry.preset);
      entry.el.style.animationDuration = "";
    }
  }

  // iframe load 后:注入入场样式表、构建该页入场计划并预隐藏元素。
  // 预隐藏发生在页面尚不可见时(display:none 的 figure 里 iframe 照常加载),不会闪现。
  function prepareSlide(i: number): void {
    if (!animEnabled || plans[i]) return;
    var doc = frames[i] && frames[i].contentDocument;
    if (!doc || !doc.body) return;
    // srcdoc iframe 的初始空文档(about:blank)在真内容加载前 readyState 已是
    // "complete"——对它 prepare 会把 plans[i] 毒化成空计划,真 load 到来时被幂等
    // 守卫跳过(实测踩坑)。只认 about:srcdoc 文档。
    if (doc.URL !== "about:srcdoc") return;
    var styleEl = doc.createElement("style");
    styleEl.setAttribute("data-cortex-anim-css", "1");
    styleEl.textContent = CONFIG.entranceCss;
    (doc.head || doc.body).appendChild(styleEl);

    var entries: Entry[] = [];
    var conf = CONFIG.slides[i];
    if (conf && conf.entrances && conf.entrances.length) {
      // 显式注解:按 data-cortex-id 定位;孤儿注解(元素已删)忽略该条,其余照跑。
      conf.entrances.forEach(function (e) {
        var el = doc!.querySelector('[data-cortex-id="' + CSS.escape(e.elementId) + '"]') as HTMLElement | null;
        if (el) entries.push({ el: el, preset: e.preset, step: e.step, delayMs: e.delayMs || 0, durationMs: e.durationMs });
      });
    } else {
      // 默认启发式:采集器(core collectSlideEntranceDescriptors 注入)负责挑选内容级
      // 元素 —— 含「整页根容器自动下钻到子元素」与 display:none 不可测时的文档序回退;
      // 这里只做计划 → DOM 条目的映射。
      var descriptors = collectFn(doc, 1280, 720);
      var plan = planFn(descriptors, CONFIG.style, 1280, 720, inferFn);
      var byId: Record<string, { el: unknown }> = {};
      descriptors.forEach(function (d) { byId[d.elementId] = d; });
      plan.forEach(function (p) {
        var d = byId[p.elementId];
        if (d) entries.push({ el: d.el as HTMLElement, preset: p.preset, step: p.step, delayMs: p.delayMs || 0, durationMs: p.durationMs });
      });
    }
    entries.forEach(hideEntry);
    plans[i] = entries;
    stepSequences[i] = entries
      .map(function (entry) { return entry.step; })
      .filter(function (entryStep, entryIndex, allSteps) {
        return entryStep > 0 && allSteps.indexOf(entryStep) === entryIndex;
      })
      .sort(function (a, b) { return a - b; });
    // 当前页在 load 完成后才 prepare(初始页时序):立刻按当前 step 状态播放。
    if (i === index) playUpTo(step, true);
  }

  // 播放到 targetStep(含):把 step<=target 且尚未显示的元素揭示;animate 控制是否播入场。
  function playUpTo(targetStep: number, animate: boolean): void {
    var entries = plans[index];
    if (!entries) return;
    entries.forEach(function (entry) {
      if (entry.step > targetStep) return;
      if (!entry.el.classList.contains("cortex-anim-hidden")) return;
      if (animate && entry.delayMs) {
        (function (e) {
          setTimeout(function () { revealEntry(e, true); }, e.delayMs);
        })(entry);
      } else {
        revealEntry(entry, animate);
      }
    });
  }

  // 全显:清 hidden 与入场 class(回退/跳页语义 —— 标准 PPT 行为,不重播动画)。
  function revealAll(i: number): void {
    var entries = plans[i];
    if (!entries) return;
    entries.forEach(function (entry) { revealEntry(entry, false); });
  }

  // 重置某页入场状态(再次正向进入该页时重新播放)。
  function rearm(i: number): void {
    var entries = plans[i];
    if (!entries) return;
    entries.forEach(function (entry) {
      entry.el.classList.remove("cortex-anim-enter-" + entry.preset);
      entry.el.style.animationDuration = "";
      hideEntry(entry);
    });
  }

  function updateHud(): void {
    counter.textContent = index + 1 + " / " + total;
    notes.textContent = slides[index].getAttribute("data-notes") || "";
  }

  function lastStepOf(i: number): number {
    var steps = stepSequences[i] || [];
    return steps.length ? steps[steps.length - 1] : 0;
  }

  var suppressedHash = "";
  function writeHash(mode: string): void {
    // 单屏模式把状态写回 hash(刷新/书签可恢复);写入前记账,hashchange 里跳过自写值。
    var h = "#" + (index + 1) + (mode === "all" ? ".all" : step > 0 ? "." + step : "");
    suppressedHash = h;
    if (location.hash !== h) location.hash = h;
  }

  // 页面切换(含转场)。mode:'auto' = 正向进入,播 step0 入场;'all' = 回退/跳页,全显。
  function transitionTo(next: number, mode: string): void {
    next = Math.max(0, Math.min(total - 1, next));
    if (transitioning) return;
    var prev = index;
    if (next === prev) {
      // 同页仅同步显示状态(hash 驱动的 step 对齐走 applyHash,不经这里)。
      updateHud();
      return;
    }
    var t = resolveTransition(next);
    var spec = t !== "none" ? CONFIG.durations[t] : 0;
    index = next;
    step = mode === "all" ? lastStepOf(next) : 0;
    busyUntil = mode === "auto" ? Date.now() + spec + (CONFIG.stepDurations[next][0] || 0) : 0;
    updateHud();
    writeHash(mode);

    // 目标页在显示前先复位入场状态(元素回到隐藏态),转场结束后再播 —— 除全显模式。
    if (mode === "all") revealAll(next);
    else rearm(next);

    if (!animEnabled || t === "none" || !spec) {
      slides.forEach(function (el, i) { el.classList.toggle("active", i === index); });
      if (mode !== "all") playUpTo(step, true);
      return;
    }

    transitioning = true;
    var outFig = slides[prev];
    var inFig = slides[next];
    var outInner = inners[prev];
    var inInner = inners[next];
    var need3d = t === "page-flip" || t === "cube-rotate";
    // 出入两页同显:出页压在上层(zIndex)淡出/翻走,入页从 prep 态过渡进场。
    outFig.style.zIndex = "2";
    inFig.style.zIndex = "1";
    if (need3d) {
      outFig.classList.add("cortex-trans-stage-3d");
      inFig.classList.add("cortex-trans-stage-3d");
    }
    inInner.classList.add("cortex-trans-prep-" + t);
    inFig.classList.add("active");
    // 强制 reflow,让 prep 初态先生效,再切换到过渡 class。
    void inInner.offsetWidth;
    outInner.classList.add("cortex-trans-out-" + t);
    inInner.classList.remove("cortex-trans-prep-" + t);
    inInner.classList.add("cortex-trans-in-" + t);

    // 收尾用定时器而非 transitionend:多属性过渡会触发多次,且事件可能因降级被吞。
    setTimeout(function () {
      outFig.classList.remove("active", "cortex-trans-stage-3d");
      inFig.classList.remove("cortex-trans-stage-3d");
      outInner.classList.remove("cortex-trans-out-" + t);
      inInner.classList.remove("cortex-trans-in-" + t);
      outFig.style.zIndex = "";
      inFig.style.zIndex = "";
      transitioning = false;
      if (mode !== "all") playUpTo(step, true);
    }, spec + 60);
  }

  // 正向推进:本页还有未播的 step → 播下一档;否则翻下一页。
  function advance(): void {
    if (transitioning || Date.now() < busyUntil) return;
    var nextStep = (stepSequences[index] || []).find(function (candidate) { return candidate > step; });
    if (nextStep !== undefined) {
      step = nextStep;
      busyUntil = Date.now() + (CONFIG.stepDurations[index][nextStep] || 0);
      playUpTo(step, true);
      writeHash("step");
    } else if (index + 1 < total) {
      transitionTo(index + 1, "auto");
    }
  }

  // 回退:一律回上一页并全显(标准 PPT 语义,不逐步撤销入场)。
  function back(): void {
    if (transitioning) return;
    if (index > 0) transitionTo(index - 1, "all");
  }

  function toggleFullscreen(): void {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }

  // hash 契约:`#页[.步|.all]`(1 基页号)。双屏模式主进程经此驱动;单屏模式自写自读。
  function applyHash(): void {
    var raw = location.hash.replace(/^#/, "");
    if (!raw || raw === suppressedHash.replace(/^#/, "")) {
      suppressedHash = "";
      if (raw) return;
    }
    var m = /^(\d+)(?:\.(all|\d+))?$/.exec(raw);
    if (!m) return;
    var page = parseInt(m[1], 10) - 1;
    var token = m[2];
    if (page !== index) {
      transitionTo(page, token === "all" ? "all" : "auto");
      // 正向跳到带步号的状态(观众迟到入场对齐):转场后补齐到目标步。
      if (token && token !== "all") {
        var target = parseInt(token, 10);
        if (target > 0) {
          setTimeout(function () {
            if (index === page && target > step) { step = Math.min(target, lastStepOf(index)); playUpTo(step, false); }
          }, 0);
        }
      }
    } else if (token === "all") {
      step = lastStepOf(index);
      revealAll(index);
    } else if (token) {
      var s = parseInt(token, 10);
      if (!isNaN(s) && s > step) { step = Math.min(s, lastStepOf(index)); playUpTo(step, true); }
    }
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); advance(); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); back(); }
    else if (e.key === "Home") { e.preventDefault(); transitionTo(0, "all"); }
    else if (e.key === "End") { e.preventDefault(); transitionTo(total - 1, "all"); }
    else if (e.key === "f" || e.key === "F") { toggleFullscreen(); }
    else if (e.key === "n" || e.key === "N") { document.body.classList.toggle("notes-open"); }
  });
  document.getElementById("prev")!.addEventListener("click", function () { back(); });
  document.getElementById("next")!.addEventListener("click", function () { advance(); });
  document.getElementById("full")!.addEventListener("click", toggleFullscreen);
  document.getElementById("notesBtn")!.addEventListener("click", function () {
    document.body.classList.toggle("notes-open");
  });
  document.getElementById("print")!.addEventListener("click", function () { window.print(); });
  window.addEventListener("resize", fit);
  window.addEventListener("hashchange", applyHash);

  // iframe 逐页挂 load → prepare(load 已发生的直接补;srcdoc 在 display:none 下照常加载)。
  frames.forEach(function (frame, i) {
    if (!frame) return;
    frame.addEventListener("load", function () { prepareSlide(i); });
    try {
      if (frame.contentDocument && frame.contentDocument.readyState === "complete") prepareSlide(i);
    } catch (_e) { /* 同源保证下不应发生;防御性兜底 */ }
  });

  fit();
  // 初始定位:直接按 hash 定页(无转场动画 —— index 初值即目标页,首页入场仍会播放)。
  var initial = /^#?(\d+)(?:\.(all|\d+))?$/.exec(location.hash.replace(/^#/, ""));
  var startPage = initial ? Math.max(0, Math.min(total - 1, parseInt(initial[1], 10) - 1)) : 0;
  var startAll = !!(initial && initial[2] === "all");
  index = startPage;
  step = 0;
  busyUntil = Date.now() + (CONFIG.stepDurations[index][0] || 0);
  slides.forEach(function (el, i) { el.classList.toggle("active", i === index); });
  updateHud();
  if (startAll) { step = lastStepOf(index); revealAll(index); }
  // 入场播放由该页 iframe 的 prepareSlide 完成(load 后对 i===index 自动 playUpTo)。
}
/* eslint-enable */

/**
 * 生成 presenter 运行时 <script> 内容。config 为内嵌 JSON(转义 `<` 防 </script> 逃逸);
 * 启发式两函数按参数注入,见 slides-heuristics.ts 的自包含契约。
 */
export function buildPresenterScript(options: {
  animationStyle: SlidesAnimationStyle;
  slides: Array<PresenterSlideAnimation | null | undefined>;
  hasElementMarkers: boolean[];
}): string {
  const durations: Record<string, number> = {};
  for (const [id, spec] of Object.entries(TRANSITIONS)) durations[id] = spec.durationMs;
  const config = {
    style: options.animationStyle,
    slides: options.slides.map((s) => (s ? { transition: s.transition, entrances: s.entrances } : null)),
    stepSequences: options.slides.map((slide) => {
      if (options.animationStyle === "none") return [];
      const steps = slide?.entrances?.map((entry) => entry.step).filter((step) => step > 0) ?? [];
      return [...new Set(steps)].sort((a, b) => a - b);
    }),
    stepDurations: options.slides.map((slide, index) => {
      const durations: Record<number, number> = {};
      if (options.animationStyle === "none") return durations;
      if (!slide?.entrances?.length && options.hasElementMarkers[index]) {
        durations[0] = defaultHeuristicEntranceDurationMs(options.animationStyle);
        return durations;
      }
      for (const entry of slide?.entrances ?? []) {
        const preset = ENTRANCE_PRESETS[entry.preset];
        const duration =
          entry.durationMs ?? Math.round(preset.defaultDurationMs * STYLE_DURATION_SCALE[options.animationStyle]);
        durations[entry.step] = Math.max(durations[entry.step] ?? 0, (entry.delayMs ?? 0) + duration);
      }
      return durations;
    }),
    defaultTransition: STYLE_DEFAULT_TRANSITION[options.animationStyle],
    fallback: TRANSITION_FALLBACK,
    durations,
    entranceCss: buildEntranceStylesheet(options.animationStyle)
  };
  const configJson = JSON.stringify(config).replace(/</g, "\\u003c");
  return `(${presenterRuntime.toString()})(${configJson}, (${planDefaultEntrances.toString()}), (${inferElementRole.toString()}), (${collectSlideEntranceDescriptors.toString()}));`;
}
