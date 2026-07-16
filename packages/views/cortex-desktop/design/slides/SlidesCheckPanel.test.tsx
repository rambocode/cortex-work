// 检查面板测试:runCheck 拉取 findings、按 severity 筛选、点击条目定位 slide,
// 以及「检查完成自动定位第一条 blocking」。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import {
  createEmptySlidesDeckManifest,
  type SlidesDeckManifest,
  type SlidesFinding
} from '@cortex-work/core/design/slides/slides-types'
import { slidesSlideHtmlPath } from '@cortex-work/core/design/slides/slides-paths'
import { SlidesCheckPanel } from './SlidesCheckPanel'
import { useSlidesStore } from './slides-store'

const NOW = '2026-07-16T00:00:00.000Z'
const ROOT = '/ws'
const DECK = 'deckchk001'

const FINDINGS: SlidesFinding[] = [
  {
    id: 'slot-002:overflow:0',
    severity: 'blocking',
    slideId: 'slot-002',
    code: 'overflow',
    message: '内容越出 1280×720 画布',
    hint: '收紧布局'
  },
  {
    id: 'slot-001:min-font-size:0',
    severity: 'warning',
    slideId: 'slot-001',
    code: 'min-font-size',
    message: '文字过小(10px < 12px)',
    elementId: 'note'
  }
]

function manifest(): SlidesDeckManifest {
  const m = createEmptySlidesDeckManifest({ id: DECK, title: 'T', now: NOW })
  m.revision = 4
  m.status = 'ready'
  m.slides = ['slot-001', 'slot-002'].map((id, index) => ({
    id,
    order: index,
    title: id,
    htmlPath: slidesSlideHtmlPath(DECK, id),
    revision: 1,
    status: 'ready' as const,
    updatedAt: NOW
  }))
  m.activeSlideId = 'slot-001'
  return m
}

function fakeBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    slidesLoadDeck: vi.fn(async () => ({ ok: true as const, manifest: manifest() })),
    slidesCreateDeck: vi.fn(),
    slidesCheck: vi.fn(async () => ({ ok: true as const, findings: FINDINGS })),
    slidesSetActiveSlide: vi.fn(async () => ({ ok: true as const, manifest: manifest() })),
    ...overrides
  } as unknown as DesktopBridge
}

beforeEach(() => {
  useSlidesStore.getState().reset()
})

afterEach(() => {
  cleanup()
})

describe('SlidesCheckPanel', () => {
  it('未打开时不渲染', async () => {
    await useSlidesStore.getState().setup({ bridge: fakeBridge(), workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    render(<SlidesCheckPanel />)
    expect(screen.queryByTestId('slides-check-panel')).toBeNull()
  })

  it('runCheck 后展示 findings,并自动定位第一条 blocking 所在页', async () => {
    const setActive = vi.fn(async () => ({ ok: true as const, manifest: manifest() }))
    const bridge = fakeBridge({ slidesSetActiveSlide: setActive })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    render(<SlidesCheckPanel />)
    await useSlidesStore.getState().runCheck()

    expect(screen.getByTestId('slides-check-panel')).toBeInTheDocument()
    expect(screen.getByText('内容越出 1280×720 画布')).toBeInTheDocument()
    expect(screen.getByText('文字过小(10px < 12px)')).toBeInTheDocument()
    // 第一条 blocking 在 slot-002 → 自动切页。
    await waitFor(() => expect(setActive).toHaveBeenCalledWith(expect.objectContaining({ slotId: 'slot-002' })))
  })

  it('按 severity 筛选', async () => {
    await useSlidesStore.getState().setup({ bridge: fakeBridge(), workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    render(<SlidesCheckPanel />)
    await useSlidesStore.getState().runCheck()

    fireEvent.click(screen.getByRole('button', { name: '警告' }))
    expect(screen.queryByText('内容越出 1280×720 画布')).toBeNull()
    expect(screen.getByText('文字过小(10px < 12px)')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '阻断' }))
    expect(screen.getByText('内容越出 1280×720 画布')).toBeInTheDocument()
    expect(screen.queryByText('文字过小(10px < 12px)')).toBeNull()
  })

  it('点击 finding 定位对应 slide', async () => {
    const setActive = vi.fn(async () => ({ ok: true as const, manifest: manifest() }))
    await useSlidesStore
      .getState()
      .setup({ bridge: fakeBridge({ slidesSetActiveSlide: setActive }), workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    render(<SlidesCheckPanel />)
    await useSlidesStore.getState().runCheck()
    setActive.mockClear()

    fireEvent.click(screen.getByText('文字过小(10px < 12px)'))
    await waitFor(() => expect(setActive).toHaveBeenCalledWith(expect.objectContaining({ slotId: 'slot-001' })))
  })

  it('无 finding 时显示「没有发现问题」', async () => {
    const bridge = fakeBridge({ slidesCheck: vi.fn(async () => ({ ok: true as const, findings: [] })) })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    render(<SlidesCheckPanel />)
    await useSlidesStore.getState().runCheck()
    expect(screen.getByText('没有发现问题')).toBeInTheDocument()
  })

  it('检查失败挂 actionError', async () => {
    const bridge = fakeBridge({
      slidesCheck: vi.fn(async () => ({ ok: false as const, error: { code: 'io_error' as const, message: '检查炸了' } }))
    })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    await useSlidesStore.getState().runCheck()
    expect(useSlidesStore.getState().actionError).toBe('检查炸了')
  })
})
