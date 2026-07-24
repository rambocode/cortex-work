// CORTEX-PATCH file — Electron 宿主受控放映模式。
// Cortex Desktop 的演示窗口用 loadFile(deck.bento.html, { hash }) 启动本文件的三种形态:
//   #cortex-present-solo.N      单屏:bento 自带键盘/交互全开(仅不进浏览器全屏,窗口本身已全屏)。
//   #cortex-present-audience.N  双屏观众页:页内键盘/链接全部禁用,翻页只听主进程 goto。
//   #cortex-present-speaker.N   双屏演讲者页:自渲染 notes/当前页/下一页,按钮经
//                               cortex-presenter://control/... 交给主进程(will-navigate 拦截)。
// N 为 0 基起始页,缺省 0。三种形态都暴露 window.cortexPresent = { goto, count } 供主进程
// executeJavaScript 驱动;放映窗不注入 preload,这是页面与主进程唯一的两条通道(注入 JS / 控制 URL)。
import { t } from '../i18n'
import type { BentoDoc } from '../model'
import { injectFonts } from '../fonts'
import { renderSlide } from '../render'
import { startPresentation } from '../present'

type CortexPresentMode = 'solo' | 'audience' | 'speaker'

/** 主进程经 executeJavaScript 调用的受控翻页面。 */
interface CortexPresentApi {
  goto(index: number): void
  count: number
}

function parseModeHash(hash: string): { mode: CortexPresentMode; startIndex: number } | null {
  const m = /^#cortex-present-(solo|audience|speaker)(?:\.(\d+))?$/.exec(hash)
  if (!m) return null
  return { mode: m[1] as CortexPresentMode, startIndex: m[2] ? Number.parseInt(m[2], 10) : 0 }
}

/**
 * 放映窗 boot 分流入口(main.ts 的 bootWith 优先调用)。
 * 命中 cortex 放映 hash 时接管整个页面(不建 Editor),返回 true;否则返回 false 走原有 boot。
 */
export function tryCortexPresentBoot(doc: BentoDoc): boolean {
  const req = parseModeHash(location.hash)
  if (!req) return false
  document.title = `${doc.title} — Bento Slides`
  if (doc.fonts?.length) injectFonts(doc)
  document.getElementById('bento-splash')?.remove()
  const startIndex = Math.max(0, Math.min(req.startIndex, doc.slides.length - 1))
  if (req.mode === 'speaker') bootSpeakerView(doc, startIndex)
  else bootShow(doc, startIndex, req.mode === 'audience')
  return true
}

/** solo/audience:直接进 bento 放映 overlay;audience 关闭页内导航(hostControlled)。 */
function bootShow(doc: BentoDoc, startIndex: number, hostControlled: boolean): void {
  const session = startPresentation(
    doc,
    startIndex,
    () => {
      // 放映退出(solo 模式 Esc 由主进程拦截关窗,这里只兜 touch 划出边界等页内退出路径):
      // 页面已无编辑器可回,交给主进程经 cortex-presenter://control/end 关窗。
      location.href = 'cortex-presenter://control/end'
    },
    { fullscreen: false, hostControlled },
  )
  const api: CortexPresentApi = {
    goto: (index) => session.controls?.goto(index),
    count: doc.slides.length,
  }
  ;(window as unknown as { cortexPresent?: CortexPresentApi }).cortexPresent = api
}

/**
 * 演讲者视图 split 布局几何:给定 .sv-main 主区尺寸与幻灯片宽高比,算出
 * 当前页帧宽 / NEXT 列宽 / NOTES 通栏高度。纯函数以便单测;paint 时把结果
 * 经 CSS 变量下发给 grid,JS 是唯一几何数据源(不再与 CSS 各自硬编码)。
 */
export function speakerLayout(
  mainW: number,
  mainH: number,
  aspect: number,
): { currentWidth: number; nextWidth: number; notesHeight: number } {
  const nextWidth = Math.min(Math.min(340, Math.max(220, mainW * 0.16)), mainW * 0.4)
  const notesHeight = Math.min(200, Math.max(96, mainH * 0.2))
  const cellW = mainW - nextWidth - 20 // grid gap
  const cellH = mainH - notesHeight - 16 // 通栏与上行的间距
  return {
    currentWidth: Math.max(1, Math.min(cellW, cellH * aspect)),
    nextWidth,
    notesHeight,
  }
}

/**
 * 双屏演讲者页:不跑 Reveal,直接用共享渲染器画「当前页 + 下一页 + 备注 + 控制条」。
 * 布局为 split 形态(bento-speaker--split):当前页占满主区、NEXT 在右上、
 * NOTES 底部通栏;样式与上游弹窗版 speaker 视图隔离,互不影响。
 */
function bootSpeakerView(doc: BentoDoc, startIndex: number): void {
  let current = startIndex

  // 线性导航跳过 stateOf 状态页(与 present.ts 的 railIndices 同一规则)。
  const isState = (i: number) => !!doc.slides[i]?.stateOf
  const visibleIndex = (i: number) => doc.slides.slice(0, i + 1).filter((s) => !s.stateOf).length
  const visibleTotal = doc.slides.filter((s) => !s.stateOf).length
  const nextVisible = (from: number) => {
    for (let i = from + 1; i < doc.slides.length; i++) if (!isState(i)) return i
    return -1
  }

  document.body.className = 'bento-speaker bento-speaker--split'
  const navBtn = (k: string, glyph: string, label: string) =>
    `<button class="sv-btn" data-nav="${k}" title="${label}" aria-label="${label}">${glyph}</button>`
  document.body.innerHTML =
    `<div class="sv-top">` +
    `<div class="sv-timer" title="${t('Click to reset')}">00:00</div>` +
    `<div class="sv-clock"></div>` +
    `<div class="sv-count"></div>` +
    `<div class="sv-ctrls">` +
    navBtn('first', '⇤', t('First slide')) +
    navBtn('prev', '‹', t('Previous')) +
    navBtn('next', '›', t('Next')) +
    navBtn('last', '⇥', t('Last slide')) +
    navBtn('end', '✕', t('End of deck')) +
    `</div>` +
    `</div>` +
    `<div class="sv-main">` +
    `<div class="sv-current"></div>` +
    `<div class="sv-next-wrap"><div class="sv-label">${t('Next')}</div><div class="sv-nextbox"></div></div>` +
    `<div class="sv-notes-wrap"><div class="sv-label">${t('Notes')}</div><div class="sv-notes"></div></div>` +
    `</div>`

  const frame = (idx: number, w: number): HTMLElement => {
    const box = document.createElement('div')
    box.className = 'sv-frame'
    const scale = w / doc.size.width
    box.style.width = `${w}px`
    box.style.height = `${doc.size.height * scale}px`
    if (idx >= 0) {
      const inner = document.createElement('div')
      inner.style.cssText = `transform:scale(${scale});transform-origin:0 0`
      inner.appendChild(renderSlide(doc.slides[idx], doc, { hidePlaceholders: true }))
      box.appendChild(inner)
    } else {
      box.classList.add('end')
      box.textContent = t('End of deck')
    }
    return box
  }

  const paint = (): void => {
    const main = document.querySelector<HTMLElement>('.sv-main')
    const curBox = document.querySelector<HTMLElement>('.sv-current')!
    const nxtBox = document.querySelector<HTMLElement>('.sv-nextbox')!
    // 主区尺寸优先实测(真实窗口消除魔数漂移);jsdom 等无布局环境回退视口估算。
    const measuredW = main?.clientWidth ?? 0
    const measuredH = main?.clientHeight ?? 0
    const mainW = measuredW > 0 ? measuredW : Math.max(window.innerWidth - 40, 1)
    const mainH = measuredH > 0 ? measuredH : Math.max(window.innerHeight - 92, 1)
    const layout = speakerLayout(mainW, mainH, doc.size.width / doc.size.height)
    main?.style.setProperty('--sv-next-width', `${layout.nextWidth}px`)
    main?.style.setProperty('--sv-notes-height', `${layout.notesHeight}px`)
    curBox.innerHTML = ''
    curBox.appendChild(frame(current, layout.currentWidth))
    nxtBox.innerHTML = ''
    nxtBox.appendChild(frame(nextVisible(current), layout.nextWidth))
    const notes = document.querySelector('.sv-notes')
    if (notes) notes.textContent = doc.slides[current]?.notes || t('— no notes for this slide —')
    const count = document.querySelector('.sv-count')
    if (count) count.textContent = `${visibleIndex(current)} / ${visibleTotal}`
  }

  // 控制按钮统一转发主进程(唯一翻页权威;本页 goto 只被动跟随广播)。
  document.querySelectorAll<HTMLButtonElement>('.sv-btn[data-nav]').forEach((b) => {
    b.addEventListener('click', () => {
      const k = b.dataset.nav
      if (k === 'next') location.href = 'cortex-presenter://control/advance'
      else if (k === 'prev') location.href = 'cortex-presenter://control/back'
      else if (k === 'first') location.href = 'cortex-presenter://control/jump?page=1'
      else if (k === 'last') location.href = `cortex-presenter://control/jump?page=${doc.slides.length}`
      else if (k === 'end') location.href = 'cortex-presenter://control/end'
    })
  })

  // 计时器/时钟(沿用上游 speaker 语义:点计时器归零)。
  let startAt = performance.now()
  document.querySelector('.sv-timer')?.addEventListener('click', () => {
    startAt = performance.now()
  })
  window.setInterval(() => {
    const el = document.querySelector('.sv-timer')
    if (el) {
      const s = Math.floor((performance.now() - startAt) / 1000)
      el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    }
    const clock = document.querySelector('.sv-clock')
    if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }, 1000)

  const api: CortexPresentApi = {
    goto: (index) => {
      current = Math.max(0, Math.min(index, doc.slides.length - 1))
      paint()
    },
    count: doc.slides.length,
  }
  ;(window as unknown as { cortexPresent?: CortexPresentApi }).cortexPresent = api

  let resizeFrame = 0
  window.addEventListener('resize', () => {
    window.cancelAnimationFrame(resizeFrame)
    resizeFrame = window.requestAnimationFrame(paint)
  })
  paint()
}
