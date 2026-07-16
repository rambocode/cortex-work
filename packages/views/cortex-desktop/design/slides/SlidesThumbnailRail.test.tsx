// 缩略图栏组件测试:按 manifest order 渲染、active 高亮、状态徽标、
// 复制/删除/新增触发对应 bridge 调用。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import { createEmptySlidesDeckManifest, type SlidesDeckManifest } from '@cortex-work/core/design/slides/slides-types'
import { slidesSlideHtmlPath, slidesSnapshotPath } from '@cortex-work/core/design/slides/slides-paths'
import { SlidesThumbnailRail, slidesSnapshotKey } from './SlidesThumbnailRail'
import { useSlidesStore } from './slides-store'

const NOW = '2026-07-16T00:00:00.000Z'
const ROOT = '/ws'
const DECK = 'deckrail01'

function makeManifest(): SlidesDeckManifest {
  const manifest = createEmptySlidesDeckManifest({ id: DECK, title: 'T', now: NOW })
  manifest.revision = 2
  manifest.slides = [
    // 故意乱序放入,断言渲染按 order 排。
    {
      id: 'slot-002',
      order: 1,
      title: '论证页',
      htmlPath: slidesSlideHtmlPath(DECK, 'slot-002'),
      revision: 0,
      status: 'generating',
      updatedAt: NOW
    },
    {
      id: 'slot-001',
      order: 0,
      title: '开场页',
      htmlPath: slidesSlideHtmlPath(DECK, 'slot-001'),
      snapshotPath: slidesSnapshotPath(DECK, 'slot-001'),
      revision: 1,
      status: 'ready',
      updatedAt: NOW
    },
    {
      id: 'slot-003',
      order: 2,
      title: '失败页',
      htmlPath: slidesSlideHtmlPath(DECK, 'slot-003'),
      revision: 0,
      status: 'error',
      updatedAt: NOW
    }
  ]
  manifest.activeSlideId = 'slot-001'
  return manifest
}

async function setupStore(bridge: DesktopBridge): Promise<void> {
  await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
}

function fakeBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    slidesLoadDeck: vi.fn(async () => ({ ok: true as const, manifest: makeManifest() })),
    slidesCreateDeck: vi.fn(),
    ...overrides
  } as unknown as DesktopBridge
}

beforeEach(() => {
  useSlidesStore.getState().reset()
})

afterEach(() => {
  cleanup()
})

describe('SlidesThumbnailRail', () => {
  it('按 manifest order 渲染缩略图,active 页高亮,状态徽标正确', async () => {
    await setupStore(fakeBridge())
    render(<SlidesThumbnailRail />)
    const items = screen.getAllByTestId(/slides-thumb-/)
    expect(items.map((el) => el.getAttribute('data-testid'))).toEqual([
      'slides-thumb-slot-001',
      'slides-thumb-slot-002',
      'slides-thumb-slot-003'
    ])
    expect(screen.getByTestId('slides-thumb-slot-001').getAttribute('aria-current')).toBe('true')
    expect(screen.getByText('生成中')).toBeInTheDocument()
    expect(screen.getByText('生成失败')).toBeInTheDocument()
  })

  it('点击缩略图切换 active slide', async () => {
    const setActive = vi.fn(async () => ({ ok: true as const, manifest: makeManifest() }))
    await setupStore(fakeBridge({ slidesSetActiveSlide: setActive }))
    render(<SlidesThumbnailRail />)
    fireEvent.click(screen.getByTestId('slides-thumb-slot-002'))
    expect(setActive).toHaveBeenCalledWith(expect.objectContaining({ slotId: 'slot-002' }))
  })

  it('新增/复制/删除触发对应 IPC 调用', async () => {
    const insert = vi.fn(async () => ({ ok: true as const, manifest: makeManifest() }))
    const duplicate = vi.fn(async () => ({ ok: true as const, manifest: makeManifest() }))
    const remove = vi.fn(async () => ({ ok: true as const, manifest: makeManifest() }))
    await setupStore(
      fakeBridge({ slidesInsertSlide: insert, slidesDuplicateSlide: duplicate, slidesDeleteSlide: remove })
    )
    render(<SlidesThumbnailRail />)
    // 写操作互斥(mutating 守卫),每次点击后等 store 空闲再点下一个。
    const idle = () => waitFor(() => expect(useSlidesStore.getState().mutating).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '新增页面' }))
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ afterSlotId: 'slot-003', expectedRevision: 2 }))
    await idle()
    fireEvent.click(screen.getAllByLabelText('复制页面')[0]!)
    expect(duplicate).toHaveBeenCalledWith(expect.objectContaining({ slotId: 'slot-001' }))
    await idle()
    fireEvent.click(screen.getAllByLabelText('删除页面')[1]!)
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ slotId: 'slot-002' }))
    await idle()
  })

  it('slidesSnapshotKey 含 updatedAt(变更即换 key → 自动重取)', () => {
    expect(slidesSnapshotKey({ id: 'slot-001', updatedAt: NOW })).toBe(`slot-001@${NOW}`)
    expect(slidesSnapshotKey({ id: 'slot-001', updatedAt: '2026-07-17T00:00:00.000Z' })).not.toBe(
      slidesSnapshotKey({ id: 'slot-001', updatedAt: NOW })
    )
  })

  // 回归:此前缩略图用 <img src="file://…">,renderer 页非 file:// 源被 Chromium 拦掉 → 全碎图。
  // 现在必须经 slides:readSnapshot 取 data URL。
  it('缩略图经 IPC 取 data URL 渲染,绝不用 file:// 直链', async () => {
    const readSnapshot = vi.fn(async () => ({ ok: true as const, dataUrl: 'data:image/png;base64,AAAA' }))
    await setupStore(fakeBridge({ slidesReadSnapshot: readSnapshot }))
    render(<SlidesThumbnailRail />)
    // 只为 ready + 已入册快照的页拉取(slot-001)。
    await waitFor(() => expect(readSnapshot).toHaveBeenCalledWith(expect.objectContaining({ slotId: 'slot-001' })))
    expect(readSnapshot).toHaveBeenCalledOnce()
    const img = await screen.findByAltText('开场页')
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(document.body.innerHTML).not.toContain('file://')
  })

  it('快照读取失败 → 退化为状态占位,不渲染碎图', async () => {
    const readSnapshot = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'not_found' as const, message: 'x' }
    }))
    await setupStore(fakeBridge({ slidesReadSnapshot: readSnapshot }))
    render(<SlidesThumbnailRail />)
    await waitFor(() => expect(readSnapshot).toHaveBeenCalled())
    expect(screen.queryByAltText('开场页')).toBeNull()
  })
})
