// SlidesStage「预览动画」一次性注入脚本:在 webview 页内(slot HTML 即顶层文档)临时
// 重放当前页的入场编排,播完自动清理,不落盘、不重载 webview、不触碰编辑桥
// (编辑桥的保存是动作驱动,本脚本只加/删临时 class 与 <style>,不产生 html-changed)。
//
// 注入范式与 slide-edit-bridge 相同:自包含函数 .toString() + 依赖按参数显式传入
// (防打包器重命名令自由引用失联,见 core slides-heuristics 的契约)。
// 分步(step≥1)在预览里按固定间隔自动连播 —— 编辑器里没有"点击推进"的语义,
// 预览目标是完整看一遍本页节奏。
import {
  buildEntranceStylesheet,
  ENTRANCE_HIDDEN_CLASS
} from '@cortex-work/core/design/slides/slides-animation'
import {
  collectSlideEntranceDescriptors,
  inferElementRole,
  planDefaultEntrances
} from '@cortex-work/core/design/slides/slides-heuristics'
import type {
  SlidesAnimationStyle,
  SlidesElementAnimation
} from '@cortex-work/core/design/slides/slides-types'

/** 预览分步之间的自动连播间隔(ms)。 */
const PREVIEW_STEP_GAP_MS = 700

/* eslint-disable */
// 页内预览本体:幂等(重复点击先清理上一轮再重播);cleanup 恢复一切临时痕迹。
function slideAnimationPreviewInPage(
  config: {
    style: string
    entrances: Array<{ elementId: string; preset: string; step: number; delayMs?: number; durationMs?: number }> | null
    entranceCss: string
    hiddenClass: string
    stepGapMs: number
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
  var w = window as unknown as { __cortexSlidesAnimPreview?: { cancel: () => void } }
  // 幂等:上一轮未播完就再次点击 → 先彻底清理再重播。
  if (w.__cortexSlidesAnimPreview) w.__cortexSlidesAnimPreview.cancel()

  var timers: number[] = []
  type Entry = { el: HTMLElement; preset: string; step: number; delayMs: number; durationMs?: number; prevDuration: string }
  var entries: Entry[] = []
  var styleEl: HTMLStyleElement | null = null

  function cleanup(): void {
    timers.forEach(function (id) { clearTimeout(id) })
    timers = []
    entries.forEach(function (entry) {
      entry.el.classList.remove(config.hiddenClass, 'cortex-anim-enter-' + entry.preset)
      entry.el.removeAttribute('data-cortex-anim')
      entry.el.style.animationDuration = entry.prevDuration
    })
    entries = []
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
    styleEl = null
    delete w.__cortexSlidesAnimPreview
  }
  w.__cortexSlidesAnimPreview = { cancel: cleanup }

  if (config.style === 'none') { cleanup(); return }

  styleEl = document.createElement('style')
  styleEl.setAttribute('data-cortex-anim-preview', '1')
  styleEl.textContent = config.entranceCss
  document.head.appendChild(styleEl)

  var source = config.entrances
  if (source && source.length) {
    source.forEach(function (e) {
      var el = document.querySelector('[data-cortex-id="' + CSS.escape(e.elementId) + '"]') as HTMLElement | null
      if (el) entries.push({ el: el, preset: e.preset, step: e.step, delayMs: e.delayMs || 0, durationMs: e.durationMs, prevDuration: el.style.animationDuration })
    })
  } else {
    // 与 presenter 相同的默认编排:采集器(core 注入)统一负责根容器下钻与目标挑选。
    var descriptors = collectFn(document, 1280, 720)
    var plan = planFn(descriptors, config.style, 1280, 720, inferFn)
    var byId: Record<string, { el: unknown }> = {}
    descriptors.forEach(function (d) { byId[d.elementId] = d })
    plan.forEach(function (p) {
      var d = byId[p.elementId]
      if (d) {
        var el = d.el as HTMLElement
        entries.push({ el: el, preset: p.preset, step: p.step, delayMs: p.delayMs || 0, durationMs: p.durationMs, prevDuration: el.style.animationDuration })
      }
    })
  }

  if (!entries.length) { cleanup(); return }

  var maxStep = 0
  var maxEnd = 0
  entries.forEach(function (entry) {
    if (entry.step > maxStep) maxStep = entry.step
    entry.el.setAttribute('data-cortex-anim', entry.preset)
    entry.el.classList.add(config.hiddenClass)
  })
  // 强制 reflow:确保隐藏初态先渲染一帧,入场动画才有起点。
  void document.body.offsetWidth

  entries.forEach(function (entry) {
    // 分步自动连播:step k 的起点 = k × stepGap,组内再叠 delayMs 错峰。
    var at = entry.step * config.stepGapMs + entry.delayMs
    var dur = entry.durationMs || 800
    if (at + dur > maxEnd) maxEnd = at + dur
    timers.push(
      window.setTimeout(function () {
        entry.el.classList.remove(config.hiddenClass)
        if (entry.durationMs) entry.el.style.animationDuration = entry.durationMs + 'ms'
        entry.el.classList.add('cortex-anim-enter-' + entry.preset)
      }, at)
    )
  })
  // 播完(最长入场结束后留 300ms 余量)自动恢复原状,页面回到"终态全可见"。
  timers.push(window.setTimeout(cleanup, maxEnd + 300))
}
/* eslint-enable */

/* eslint-disable */
// 计划探针:在 webview 页内跑一遍「采集 + 默认编排」,把计划以 JSON 字符串返回给宿主。
// 用途:把启发式编排「物化」为 deck.json 里的显式 entrances(设定元素动画/按键逐个
// 触发前的第一步)。只读不改 DOM,自包含(依赖按参数注入)。
function entrancePlanProbeInPage(
  config: { style: string },
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
): string {
  var descriptors = collectFn(document, 1280, 720)
  var plan = planFn(descriptors, config.style, 1280, 720, inferFn)
  return JSON.stringify(
    plan.map(function (p) {
      return { elementId: p.elementId, preset: p.preset, step: p.step, delayMs: p.delayMs }
    })
  )
}
/* eslint-enable */

/**
 * 生成计划探针源码(executeScript 后得到计划 JSON 字符串,宿主 JSON.parse)。
 * style 为 none 时按 subtle 探取:物化动作本身就意味着用户想要动画,none 下探空计划没有意义。
 */
export function buildEntrancePlanProbeSource(style: SlidesAnimationStyle): string {
  const planningStyle = style === 'none' ? 'subtle' : style
  const configJson = JSON.stringify({ style: planningStyle }).replace(/</g, '\\u003c')
  return `(${entrancePlanProbeInPage.toString()})(${configJson}, (${planDefaultEntrances.toString()}), (${inferElementRole.toString()}), (${collectSlideEntranceDescriptors.toString()}));`
}

/**
 * 生成可 executeScript 的预览源码。entrances 为该页显式注解(无则传 null,
 * 页内走默认启发式);style 为 deck 全局动画风格。
 */
export function buildSlideAnimationPreviewSource(options: {
  style: SlidesAnimationStyle
  entrances: SlidesElementAnimation[] | null
}): string {
  const config = {
    style: options.style,
    entrances: options.entrances,
    entranceCss: buildEntranceStylesheet(options.style),
    hiddenClass: ENTRANCE_HIDDEN_CLASS,
    stepGapMs: PREVIEW_STEP_GAP_MS
  }
  const configJson = JSON.stringify(config).replace(/</g, '\\u003c')
  return `(${slideAnimationPreviewInPage.toString()})(${configJson}, (${planDefaultEntrances.toString()}), (${inferElementRole.toString()}), (${collectSlideEntranceDescriptors.toString()}));`
}
