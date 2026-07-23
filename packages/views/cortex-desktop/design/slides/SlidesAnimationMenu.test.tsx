// 动画菜单测试:桥接无动画能力时整体隐藏;有能力时展开菜单,风格三选一触发
// setAnimationStyle(带 expectedRevision),当前页转场点选触发 setSlotTransition,
// 「跟随风格」= 清除页级覆写(transition: null)。
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import { createEmptySlidesDeckManifest, type SlidesDeckManifest } from '@cortex-work/core/design/slides/slides-types'
import { slidesSlideHtmlPath } from '@cortex-work/core/design/slides/slides-paths'
import { SlidesAnimationMenu } from './SlidesAnimationMenu'
import { useSlidesStore } from './slides-store'

const NOW = '2026-07-16T00:00:00.000Z'
const ROOT = '/ws'
const DECK = 'deckanim01'

function manifest(): SlidesDeckManifest {
  const m = createEmptySlidesDeckManifest({ id: DECK, title: 'T', now: NOW })
  m.revision = 5
  m.slides = [
    {
      id: 'slot-001',
      order: 0,
      title: '开场',
      htmlPath: slidesSlideHtmlPath(DECK, 'slot-001'),
      revision: 1,
      status: 'ready',
      updatedAt: NOW,
      animation: { transition: 'zoom' }
    }
  ]
  m.activeSlideId = 'slot-001'
  return m
}

function fakeBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    slidesLoadDeck: vi.fn(async () => ({ ok: true as const, manifest: manifest() })),
    slidesCreateDeck: vi.fn(),
    slidesSetAnimationStyle: vi.fn(async () => ({ ok: true as const, manifest: manifest() })),
    slidesSetSlideAnimation: vi.fn(async () => ({ ok: true as const, manifest: manifest() })),
    ...overrides
  } as unknown as DesktopBridge
}

async function setupStore(bridge: DesktopBridge): Promise<void> {
  await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
}

beforeEach(() => {
  useSlidesStore.getState().reset()
})

afterEach(() => {
  cleanup()
})

describe('SlidesAnimationMenu', () => {
  it('桥接无动画能力时不渲染任何内容', async () => {
    const bridge = fakeBridge({ slidesSetAnimationStyle: undefined, slidesSetSlideAnimation: undefined })
    await setupStore(bridge)
    const { container } = render(<SlidesAnimationMenu />)
    expect(container.firstChild).toBeNull()
  })

  it('点选风格触发 setAnimationStyle(带当前 revision)', async () => {
    const bridge = fakeBridge()
    await setupStore(bridge)
    render(<SlidesAnimationMenu />)
    fireEvent.click(screen.getByTitle('动画设置'))
    fireEvent.click(screen.getByText('活泼'))
    expect(bridge.slidesSetAnimationStyle).toHaveBeenCalledWith({
      workspaceRoot: ROOT,
      deckId: DECK,
      expectedRevision: 5,
      style: 'lively'
    })
  })

  it('当前页转场高亮既有值;点选新转场触发 setSlotTransition', async () => {
    const bridge = fakeBridge()
    await setupStore(bridge)
    render(<SlidesAnimationMenu />)
    fireEvent.click(screen.getByTitle('动画设置'))
    // slot-001 已设 zoom → 「缩放」项 aria-pressed。
    expect(screen.getByText('缩放').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByText('3D 翻页'))
    expect(bridge.slidesSetSlideAnimation).toHaveBeenCalledWith({
      workspaceRoot: ROOT,
      deckId: DECK,
      expectedRevision: 5,
      slotId: 'slot-001',
      transition: 'page-flip'
    })
  })

  it('「跟随风格」清除页级覆写(transition: null)', async () => {
    const bridge = fakeBridge()
    await setupStore(bridge)
    render(<SlidesAnimationMenu />)
    fireEvent.click(screen.getByTitle('动画设置'))
    fireEvent.click(screen.getByText('跟随风格'))
    expect(bridge.slidesSetSlideAnimation).toHaveBeenCalledWith(
      expect.objectContaining({ slotId: 'slot-001', transition: null })
    )
  })
})
