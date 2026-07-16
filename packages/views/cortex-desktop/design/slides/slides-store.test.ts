// slides-store 单测:用假 bridge 驱动 setup(加载/缺失补建)、写操作乐观锁冲突
// 自动刷新 + 冲突提示、导出结果透传等核心行为。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import type { SlidesDeckManifest } from '@cortex-work/core/design/slides/slides-types'
import { createEmptySlidesDeckManifest } from '@cortex-work/core/design/slides/slides-types'
import { slidesSlideHtmlPath } from '@cortex-work/core/design/slides/slides-paths'
import { useSlidesStore } from './slides-store'

const NOW = '2026-07-16T00:00:00.000Z'
const ROOT = '/ws'
const DECK = 'deckstore1'

function manifestWithSlots(revision = 3): SlidesDeckManifest {
  const manifest = createEmptySlidesDeckManifest({ id: DECK, title: 'T', now: NOW })
  manifest.revision = revision
  manifest.slides = [
    {
      id: 'slot-001',
      order: 0,
      title: '开场',
      htmlPath: slidesSlideHtmlPath(DECK, 'slot-001'),
      revision: 1,
      status: 'ready',
      updatedAt: NOW
    },
    {
      id: 'slot-002',
      order: 1,
      title: '结尾',
      htmlPath: slidesSlideHtmlPath(DECK, 'slot-002'),
      revision: 0,
      status: 'empty',
      updatedAt: NOW
    }
  ]
  manifest.activeSlideId = 'slot-001'
  return manifest
}

function fakeBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    slidesLoadDeck: vi.fn(async () => ({ ok: true as const, manifest: manifestWithSlots() })),
    slidesCreateDeck: vi.fn(async () => ({ ok: true as const, manifest: manifestWithSlots(0) })),
    ...overrides
  } as unknown as DesktopBridge
}

beforeEach(() => {
  useSlidesStore.getState().reset()
})

describe('setup', () => {
  it('加载已有 deck 并落快照', async () => {
    const bridge = fakeBridge()
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    const state = useSlidesStore.getState()
    expect(state.loading).toBe(false)
    expect(state.manifest?.slides).toHaveLength(2)
    expect(bridge.slidesCreateDeck).not.toHaveBeenCalled()
  })

  it('deck 不存在时自动补建(not_found → createDeck)', async () => {
    const bridge = fakeBridge({
      slidesLoadDeck: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'not_found' as const, message: 'x' }
      }))
    })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    expect(bridge.slidesCreateDeck).toHaveBeenCalledOnce()
    expect(useSlidesStore.getState().manifest?.revision).toBe(0)
  })

  it('deck 损坏时进入破损态', async () => {
    const bridge = fakeBridge({
      slidesLoadDeck: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'invalid_manifest' as const, message: '坏了' }
      }))
    })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    expect(useSlidesStore.getState().deckError?.code).toBe('invalid_manifest')
  })

  it('bridge 缺 slides 能力时降级为不可用错误', async () => {
    await useSlidesStore
      .getState()
      .setup({ bridge: {} as DesktopBridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    expect(useSlidesStore.getState().deckError?.code).toBe('io_error')
  })
})

describe('写操作与冲突', () => {
  it('insertSlide 成功后采纳新 manifest', async () => {
    const next = manifestWithSlots(4)
    const bridge = fakeBridge({
      slidesInsertSlide: vi.fn(async () => ({ ok: true as const, manifest: next, newSlotId: 'slot-003' }))
    })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    await useSlidesStore.getState().insertSlide()
    expect(bridge.slidesInsertSlide).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 3, deckId: DECK })
    )
    expect(useSlidesStore.getState().manifest?.revision).toBe(4)
  })

  it('revision_conflict 时自动刷新并挂冲突提示', async () => {
    const fresh = manifestWithSlots(9)
    const bridge = fakeBridge({
      slidesLoadDeck: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, manifest: manifestWithSlots(3) })
        .mockResolvedValue({ ok: true, manifest: fresh }),
      slidesDeleteSlide: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'revision_conflict' as const, message: '冲突' }
      }))
    })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    await useSlidesStore.getState().deleteSlide('slot-001')
    const state = useSlidesStore.getState()
    expect(state.conflictNotice).toBe(true)
    expect(state.manifest?.revision).toBe(9)
    expect(state.mutating).toBe(false)
  })

  it('普通失败挂 actionError,不动 manifest', async () => {
    const bridge = fakeBridge({
      slidesReorderSlides: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'io_error' as const, message: '磁盘错误' }
      }))
    })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    await useSlidesStore.getState().reorderSlides(['slot-002', 'slot-001'])
    const state = useSlidesStore.getState()
    expect(state.actionError).toBe('磁盘错误')
    expect(state.manifest?.revision).toBe(3)
  })

  it('setActiveSlide 乐观更新,成功后以服务端快照为准', async () => {
    const next = manifestWithSlots(4)
    next.activeSlideId = 'slot-002'
    const bridge = fakeBridge({
      slidesSetActiveSlide: vi.fn(async () => ({ ok: true as const, manifest: next }))
    })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    const pending = useSlidesStore.getState().setActiveSlide('slot-002')
    // 乐观更新立即可见。
    expect(useSlidesStore.getState().manifest?.activeSlideId).toBe('slot-002')
    await pending
    expect(useSlidesStore.getState().manifest?.revision).toBe(4)
  })
})

describe('exportDeck', () => {
  it('失败(非取消)时挂 actionError;取消时静默', async () => {
    const bridge = fakeBridge({
      slidesExport: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: { code: 'unsupported_format', message: '未启用' } })
        .mockResolvedValueOnce({ ok: false, canceled: true })
    })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    await useSlidesStore.getState().exportDeck('pptx')
    expect(useSlidesStore.getState().actionError).toBe('未启用')
    useSlidesStore.getState().clearActionError()
    await useSlidesStore.getState().exportDeck('pdf')
    expect(useSlidesStore.getState().actionError).toBeNull()
  })
})
