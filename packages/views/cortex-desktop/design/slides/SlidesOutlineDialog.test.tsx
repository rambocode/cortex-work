// 提纲确认面板测试(bento 化):草案回填、就地编辑、批准推进 gate 并把编辑后的
// 提纲经 onApproved 交给宿主;关闭只收起面板不动草案。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import { buildStarterBentoDoc } from '@cortex-work/core/design/slides/bento/bento-doc-schema'
import type { SlidesOutline } from '@cortex-work/core/design/slides/slides-types'
import { SlidesOutlineDialog } from './SlidesOutlineDialog'
import { useBentoSlidesStore } from './bento-slides-store'

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

function makeBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    slidesBentoGetDeck: vi.fn(async () => ({
      ok: true as const,
      json: JSON.stringify(buildStarterBentoDoc('T')),
      revision: 5,
      stage: 'outline-proposed' as const,
      outline: draft
    })),
    slidesBentoCreateDeck: vi.fn(),
    slidesBentoSetStage: vi.fn(async () => ({ ok: true as const, revision: 5 })),
    ...overrides
  } as unknown as DesktopBridge
}

beforeEach(() => {
  useBentoSlidesStore.getState().reset()
})

afterEach(() => {
  cleanup()
})

describe('SlidesOutlineDialog', () => {
  it('打开时回填草案;编辑标题后批准,onApproved 收到编辑后的提纲且 gate 推进', async () => {
    const bridge = makeBridge()
    await useBentoSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    useBentoSlidesStore.getState().openOutlineDialog()

    const onApproved = vi.fn()
    render(<SlidesOutlineDialog onApproved={onApproved} />)
    expect(screen.getByDisplayValue('开场')).toBeInTheDocument()
    expect(screen.getByDisplayValue('产品发布方案')).toBeInTheDocument()

    fireEvent.change(screen.getByDisplayValue('开场'), { target: { value: '震撼开场' } })
    fireEvent.click(screen.getByRole('button', { name: '批准并开始生成' }))

    await waitFor(() => expect(onApproved).toHaveBeenCalledOnce())
    const outline = onApproved.mock.calls[0]?.[0] as Omit<SlidesOutline, 'approvedAt'>
    expect(outline.version).toBe(2)
    expect(outline.items[0]!.title).toBe('震撼开场')
    expect(outline.items[0]!.keyPoints).toEqual(['痛点', '愿景'])
    expect(bridge.slidesBentoSetStage).toHaveBeenCalledWith({
      workspaceRoot: ROOT,
      deckId: DECK,
      stage: 'outline-approved',
      outline
    })
    expect(useBentoSlidesStore.getState().stage).toBe('outline-approved')
    expect(useBentoSlidesStore.getState().outlineDialogOpen).toBe(false)
  })

  it('关闭按钮只收起面板,不调用批准', async () => {
    const bridge = makeBridge()
    await useBentoSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    useBentoSlidesStore.getState().openOutlineDialog()

    render(<SlidesOutlineDialog />)
    fireEvent.click(screen.getByRole('button', { name: '关闭(在对话中要求修改)' }))
    expect(useBentoSlidesStore.getState().outlineDialogOpen).toBe(false)
    expect(bridge.slidesBentoSetStage).not.toHaveBeenCalled()
  })

  it('草案缺失时禁用批准并给出提示', async () => {
    const bridge = makeBridge({
      slidesBentoGetDeck: vi.fn(async () => ({
        ok: true as const,
        json: JSON.stringify(buildStarterBentoDoc('T')),
        revision: 5,
        stage: 'outline-proposed' as const,
        outline: null
      }))
    } as Partial<DesktopBridge>)
    await useBentoSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    useBentoSlidesStore.getState().openOutlineDialog()

    render(<SlidesOutlineDialog />)
    expect(screen.getByText('提纲草案不存在或已损坏')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '批准并开始生成' })).toBeDisabled()
  })
})
