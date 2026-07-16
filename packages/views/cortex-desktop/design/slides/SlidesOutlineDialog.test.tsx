// 提纲确认面板测试:草案回填、就地编辑、批准调用 approveOutline(编辑后内容)并触发
// onApproved;关闭只收起面板不动草案。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import { createEmptySlidesDeckManifest, type SlidesOutline } from '@cortex-work/core/design/slides/slides-types'
import { SlidesOutlineDialog } from './SlidesOutlineDialog'
import { useSlidesStore } from './slides-store'

const NOW = '2026-07-16T00:00:00.000Z'
const ROOT = '/ws'
const DECK = 'deckdlg01'

const draft: SlidesOutline = {
  version: 2,
  summary: '产品发布方案',
  items: [
    { id: 'o1', title: '开场', purpose: 'hook', keyPoints: ['痛点', '愿景'] },
    { id: 'o2', title: '定价', purpose: 'convert', keyPoints: ['三档订阅'] }
  ]
}

function setupStore(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  const manifest = createEmptySlidesDeckManifest({ id: DECK, title: 'T', now: NOW })
  manifest.status = 'outline-proposed'
  manifest.revision = 5
  const bridge = {
    slidesLoadDeck: vi.fn(async () => ({ ok: true as const, manifest })),
    slidesCreateDeck: vi.fn(),
    slidesReadOutlineDraft: vi.fn(async () => ({ ok: true as const, outline: draft })),
    ...overrides
  } as unknown as DesktopBridge
  return bridge
}

beforeEach(() => {
  useSlidesStore.getState().reset()
})

afterEach(() => {
  cleanup()
})

describe('SlidesOutlineDialog', () => {
  it('打开时回填草案;编辑标题后批准,IPC 收到编辑后的提纲', async () => {
    const approve = vi.fn(async () => ({
      ok: true as const,
      manifest: {
        ...createEmptySlidesDeckManifest({ id: DECK, title: 'T', now: NOW }),
        status: 'outline-approved' as const,
        revision: 6
      }
    }))
    const bridge = setupStore({ slidesApproveOutline: approve })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    await useSlidesStore.getState().openOutlineDialog()

    const onApproved = vi.fn()
    render(<SlidesOutlineDialog onApproved={onApproved} />)
    expect(screen.getByDisplayValue('开场')).toBeInTheDocument()
    expect(screen.getByDisplayValue('产品发布方案')).toBeInTheDocument()

    fireEvent.change(screen.getByDisplayValue('开场'), { target: { value: '震撼开场' } })
    fireEvent.click(screen.getByRole('button', { name: '批准并开始生成' }))

    await waitFor(() => expect(approve).toHaveBeenCalledOnce())
    const payload = (approve.mock.calls[0] as unknown[])[0] as {
      expectedRevision: number
      outline: Omit<SlidesOutline, 'approvedAt'>
    }
    expect(payload.expectedRevision).toBe(5)
    expect(payload.outline.version).toBe(2)
    expect(payload.outline.items[0]!.title).toBe('震撼开场')
    expect(payload.outline.items[0]!.keyPoints).toEqual(['痛点', '愿景'])
    await waitFor(() => expect(onApproved).toHaveBeenCalledOnce())
    expect(useSlidesStore.getState().outlineDialogOpen).toBe(false)
  })

  it('关闭按钮只收起面板,不调用批准', async () => {
    const approve = vi.fn()
    const bridge = setupStore({ slidesApproveOutline: approve })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    await useSlidesStore.getState().openOutlineDialog()
    render(<SlidesOutlineDialog />)
    fireEvent.click(screen.getByRole('button', { name: '关闭(在对话中要求修改)' }))
    expect(useSlidesStore.getState().outlineDialogOpen).toBe(false)
    expect(approve).not.toHaveBeenCalled()
  })

  it('草案缺失时禁用批准并给出提示', async () => {
    const bridge = setupStore({
      slidesReadOutlineDraft: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'not_found' as const, message: 'x' }
      }))
    })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    await useSlidesStore.getState().openOutlineDialog()
    render(<SlidesOutlineDialog />)
    expect(screen.getByText('提纲草案不存在或已损坏')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '批准并开始生成' })).toBeDisabled()
  })
})
