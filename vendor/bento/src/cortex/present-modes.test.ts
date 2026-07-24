// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BentoDoc } from '../model'

vi.mock('../fonts', () => ({ injectFonts: vi.fn() }))
vi.mock('../render', () => ({
  renderSlide: vi.fn(() => {
    const slide = document.createElement('div')
    slide.className = 'bento-slide'
    return slide
  }),
}))

import { speakerLayout, tryCortexPresentBoot } from './present-modes'

const doc = {
  format: 'bento/slides',
  version: 1,
  docId: 'speaker-layout',
  title: 'Speaker layout',
  size: { width: 1280, height: 720 },
  theme: {
    background: '#000000',
    color: '#ffffff',
    accent: '#3b82d8',
    fontFamily: 'sans-serif',
  },
  slides: [
    { id: 'slide-1', background: '#000000', transition: 'fade', elements: [], notes: 'Current notes' },
    { id: 'slide-2', background: '#000000', transition: 'fade', elements: [], notes: 'Next notes' },
  ],
  modified: '2026-07-24T00:00:00.000Z',
} as BentoDoc

const ASPECT = 16 / 9

describe('speakerLayout 几何', () => {
  it('宽屏主区下当前页帧高吃满纵向空间(回归:底部不再大片留白)', () => {
    // 旧布局在 2048×1048 窗口下当前页帧高仅 ~579/914,底部留空 ~40%。
    const { currentWidth } = speakerLayout(1968, 914, ASPECT)
    const frameHeight = currentWidth / ASPECT
    expect(frameHeight).toBeGreaterThanOrEqual(914 * 0.7)
    // 帧也不得超出主区高度(不允许溢出)
    expect(frameHeight).toBeLessThanOrEqual(914)
  })

  it('当前页帧永远 fit 在格子内:宽度不超过格宽,高度不超过格高', () => {
    const layout = speakerLayout(1968, 914, ASPECT)
    const cellW = 1968 - layout.nextWidth - 20
    const cellH = 914 - layout.notesHeight - 16
    expect(layout.currentWidth).toBeLessThanOrEqual(cellW)
    expect(layout.currentWidth / ASPECT).toBeLessThanOrEqual(cellH)
  })

  it('NEXT 列宽与 NOTES 栏高在小主区下落在 clamp 边界内', () => {
    const small = speakerLayout(800, 500, ASPECT)
    expect(small.nextWidth).toBe(220)
    expect(small.notesHeight).toBe(100)
    const big = speakerLayout(4000, 2000, ASPECT)
    expect(big.nextWidth).toBe(340)
    expect(big.notesHeight).toBe(200)
  })

  it('极小主区下 NEXT 列宽不超过主区 40%,保证当前页仍有位置', () => {
    const tiny = speakerLayout(400, 300, ASPECT)
    expect(tiny.nextWidth).toBeLessThanOrEqual(400 * 0.4)
    expect(tiny.currentWidth).toBeGreaterThan(0)
  })
})

describe('Cortex speaker view layout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="bento-splash"></div>'
    window.history.replaceState({}, '', '#cortex-present-speaker.0')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2048 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1048 })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    window.history.replaceState({}, '', '#')
  })

  it('split 布局:NOTES 通栏为 .sv-main 直接子节点,几何经 CSS 变量下发', () => {
    expect(tryCortexPresentBoot(doc)).toBe(true)

    expect(document.body.classList.contains('bento-speaker--split')).toBe(true)
    const main = document.querySelector<HTMLElement>('.sv-main')!
    // 旧布局的 .sv-side 侧栏包裹已移除,NOTES 提升为底部通栏
    expect(main.querySelector(':scope > .sv-side')).toBeNull()
    expect(main.querySelector(':scope > .sv-current')).not.toBeNull()
    expect(main.querySelector(':scope > .sv-next-wrap')).not.toBeNull()
    expect(main.querySelector(':scope > .sv-notes-wrap')).not.toBeNull()
    // 单一几何数据源:列宽/栏高由 JS 计算后写入 CSS 变量
    expect(main.style.getPropertyValue('--sv-next-width')).toMatch(/^\d+(\.\d+)?px$/)
    expect(main.style.getPropertyValue('--sv-notes-height')).toMatch(/^\d+(\.\d+)?px$/)
  })

  it('按视口放大当前页和下一页,并在窗口缩放后自动重算', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    expect(tryCortexPresentBoot(doc)).toBe(true)

    const current = document.querySelector<HTMLElement>('.sv-current .sv-frame')
    const next = document.querySelector<HTMLElement>('.sv-nextbox .sv-frame')
    expect(Number.parseFloat(current?.style.width ?? '0')).toBeGreaterThan(1_200)
    // NEXT 预览收窄为右上角小图(旧布局是通高侧栏,宽度 >480)
    const nextWidth = Number.parseFloat(next?.style.width ?? '0')
    expect(nextWidth).toBeGreaterThanOrEqual(220)
    expect(nextWidth).toBeLessThanOrEqual(340)

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_280 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 })
    window.dispatchEvent(new Event('resize'))

    const resizedCurrent = document.querySelector<HTMLElement>('.sv-current .sv-frame')
    const resizedNext = document.querySelector<HTMLElement>('.sv-nextbox .sv-frame')
    expect(Number.parseFloat(resizedCurrent?.style.width ?? '0')).toBeLessThan(1_000)
    expect(Number.parseFloat(resizedNext?.style.width ?? '0')).toBeLessThan(400)
  })
})
