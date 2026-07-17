import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import { createEmptySlidesDeckManifest, type SlidesDeckManifest } from '@cortex-work/core/design/slides/slides-types'
import { slidesSlideHtmlPath } from '@cortex-work/core/design/slides/slides-paths'
import { SlidesWorkspace } from './SlidesWorkspace'
import { useSlidesStore } from './slides-store'
import { SlidesNotesPanel } from './SlidesNotesPanel'
import { sendDesignMessage } from '@cortex-work/core/design/run/design-run-manager'
import { buildSlidesTurnPrompt } from '@cortex-work/core/design/slides/slides-prompt'

const NOW = '2026-07-16T00:00:00.000Z'
const ROOT = '/ws'
const DECK = 'decknotes1'

let workspaceBridge: DesktopBridge | null = null

vi.mock('@cortex-work/core/provider', () => ({
  useDesktopBridge: () => workspaceBridge
}))

vi.mock('@cortex-work/core/design/run/design-run-manager', () => ({
  sendDesignMessage: vi.fn()
}))

vi.mock('@cortex-work/core/design/slides/slides-prompt', () => ({
  buildSlidesTurnPrompt: vi.fn(() => 'slides prompt')
}))

vi.mock('@cortex-work/core/design/compat/chat-store', () => ({
  useChatStore: (selector: (state: { busy: boolean }) => boolean) => selector({ busy: false })
}))

vi.mock('./SlidesCheckPanel', () => ({
  SlidesCheckPanel: () => <div data-testid="slides-check-panel-mock" />
}))

vi.mock('./SlidesOutlineDialog', () => ({
  SlidesOutlineDialog: () => <div data-testid="slides-outline-dialog-mock" />
}))

vi.mock('./SlidesStage', () => ({
  SlidesStage: () => <div data-testid="slides-stage-mock" />
}))

vi.mock('./SlidesThumbnailRail', () => ({
  SlidesThumbnailRail: () => <div data-testid="slides-thumbnail-rail-mock" />
}))

vi.mock('./SlidesToolbar', () => ({
  SlidesToolbar: () => <div data-testid="slides-toolbar-mock" />
}))

function manifestWithSlots(revision = 3): SlidesDeckManifest {
  const manifest = createEmptySlidesDeckManifest({ id: DECK, title: '季度汇报', now: NOW })
  manifest.revision = revision
  manifest.status = 'ready'
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
      title: '总结',
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

async function setup(bridge: DesktopBridge): Promise<void> {
  await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: '季度汇报' })
}

beforeEach(() => {
  useSlidesStore.getState().reset()
  workspaceBridge = null
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SlidesNotesPanel', () => {
  it('可请求 Agent 为当前页生成备注', async () => {
    await setup(
      fakeBridge({
        slidesReadNotes: vi.fn(async () => ({ ok: true as const, markdown: '', slotRevision: 1 }))
      })
    )
    await useSlidesStore.getState().openNotes()
    const onGenerate = vi.fn()

    render(<SlidesNotesPanel onGenerate={onGenerate} />)
    fireEvent.click(screen.getByRole('button', { name: 'AI 生成当前页备注' }))

    expect(onGenerate).toHaveBeenCalledWith(expect.objectContaining({ id: 'slot-001', title: '开场' }))
  })

  it('展示当前页标题、字符数，默认高度 160px，且可在 120-360px 间拖动调整', async () => {
    await setup(
      fakeBridge({
        slidesReadNotes: vi.fn(async () => ({ ok: true as const, markdown: '四字备注', slotRevision: 1 }))
      })
    )
    await useSlidesStore.getState().openNotes()

    render(<SlidesNotesPanel />)
    const panel = screen.getByTestId('slides-notes-panel')
    const handle = screen.getByRole('separator', { name: '调整备注高度' })

    expect(screen.getByText(/开场\s*·\s*4\s*字/)).toBeInTheDocument()
    expect(panel).toHaveStyle({ height: '160px' })

    fireEvent.mouseDown(handle, { clientY: 300 })
    fireEvent.mouseMove(window, { clientY: 0 })
    expect(panel).toHaveStyle({ height: '360px' })
    fireEvent.mouseUp(window)

    fireEvent.mouseDown(handle, { clientY: 300 })
    fireEvent.mouseMove(window, { clientY: 1000 })
    expect(panel).toHaveStyle({ height: '120px' })
    fireEvent.mouseUp(window)
  })

  it('600ms 防抖自动保存,并显示保存中/已保存状态', async () => {
    vi.useFakeTimers()
    let resolveSave: (value: { ok: true; manifest: SlidesDeckManifest }) => void = () => {
      throw new Error('save promise 尚未初始化')
    }
    const slidesSaveNotes = vi.fn(
      () =>
        new Promise<{ ok: true; manifest: SlidesDeckManifest }>((resolve) => {
          resolveSave = resolve
        })
    )
    await setup(
      fakeBridge({
        slidesReadNotes: vi.fn(async () => ({ ok: true as const, markdown: '初稿', slotRevision: 1 })),
        slidesSaveNotes: slidesSaveNotes as unknown as DesktopBridge['slidesSaveNotes']
      })
    )
    await useSlidesStore.getState().openNotes()

    render(<SlidesNotesPanel />)
    const textarea = screen.getByRole('textbox', { name: '演讲者备注 Markdown' })
    fireEvent.change(textarea, { target: { value: '更新后的演讲稿' } })

    await act(async () => {
      vi.advanceTimersByTime(599)
    })
    expect(slidesSaveNotes).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByText('保存中')).toBeInTheDocument()
    await act(async () => {
      resolveSave({ ok: true, manifest: manifestWithSlots(4) })
    })
    expect(screen.getByText('已保存')).toBeInTheDocument()
  })

  it('blur 时立即保存,不等防抖计时结束', async () => {
    const slidesSaveNotes = vi.fn(async () => ({ ok: true as const, manifest: manifestWithSlots(4) }))
    await setup(
      fakeBridge({
        slidesReadNotes: vi.fn(async () => ({ ok: true as const, markdown: '初稿', slotRevision: 1 })),
        slidesSaveNotes
      })
    )
    await useSlidesStore.getState().openNotes()

    render(<SlidesNotesPanel />)
    const textarea = screen.getByRole('textbox', { name: '演讲者备注 Markdown' })
    fireEvent.change(textarea, { target: { value: '失焦即保存' } })
    fireEvent.blur(textarea)

    await waitFor(() => expect(slidesSaveNotes).toHaveBeenCalledOnce(), { timeout: 300 })
  })

  it('textarea 内 Cmd/Ctrl+S 立即保存', async () => {
    const slidesSaveNotes = vi.fn(async () => ({ ok: true as const, manifest: manifestWithSlots(4) }))
    await setup(
      fakeBridge({
        slidesReadNotes: vi.fn(async () => ({ ok: true as const, markdown: '初稿', slotRevision: 1 })),
        slidesSaveNotes
      })
    )
    await useSlidesStore.getState().openNotes()

    render(<SlidesNotesPanel />)
    const textarea = screen.getByRole('textbox', { name: '演讲者备注 Markdown' })

    fireEvent.change(textarea, { target: { value: 'Cmd 保存' } })
    fireEvent.keyDown(textarea, { key: 's', metaKey: true })
    await waitFor(() => expect(slidesSaveNotes).toHaveBeenCalledTimes(1), { timeout: 300 })

    fireEvent.change(textarea, { target: { value: 'Ctrl 保存' } })
    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true })
    await waitFor(() => expect(slidesSaveNotes).toHaveBeenCalledTimes(2), { timeout: 300 })
  })

  it('冲突时保留本地草稿,并提供重试保存与重新加载动作', async () => {
    const slidesReadNotes = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, markdown: '旧稿', slotRevision: 1 })
      .mockResolvedValueOnce({ ok: true as const, markdown: '服务器新版', slotRevision: 2 })
    const slidesLoadDeck = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, manifest: manifestWithSlots(3) })
      .mockResolvedValue({ ok: true as const, manifest: manifestWithSlots(9) })
    const slidesSaveNotes = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'revision_conflict' as const, message: '保存冲突' }
    }))
    await setup(fakeBridge({ slidesLoadDeck, slidesReadNotes, slidesSaveNotes }))
    await useSlidesStore.getState().openNotes()

    render(<SlidesNotesPanel />)
    const textarea = screen.getByRole('textbox', { name: '演讲者备注 Markdown' })
    fireEvent.change(textarea, { target: { value: '不可丢失的本地稿' } })
    await new Promise((resolve) => setTimeout(resolve, 650))

    await waitFor(() => expect(screen.getByText('保存冲突')).toBeInTheDocument())
    expect(textarea).toHaveValue('不可丢失的本地稿')
    expect(screen.getByRole('button', { name: '重试保存' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))

    await waitFor(() =>
      expect(slidesReadNotes).toHaveBeenLastCalledWith({ workspaceRoot: ROOT, deckId: DECK, slotId: 'slot-001' })
    )
    await waitFor(() => expect(textarea).toHaveValue('服务器新版'))
  })

  it('冲突后可重试保存当前本地草稿', async () => {
    const slidesSaveNotes = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'revision_conflict' as const, message: '保存冲突' }
      })
      .mockResolvedValueOnce({ ok: true as const, manifest: manifestWithSlots(10) })
    await setup(
      fakeBridge({
        slidesLoadDeck: vi
          .fn()
          .mockResolvedValueOnce({ ok: true as const, manifest: manifestWithSlots(3) })
          .mockResolvedValue({ ok: true as const, manifest: manifestWithSlots(9) }),
        slidesReadNotes: vi.fn(async () => ({ ok: true as const, markdown: '旧稿', slotRevision: 1 })),
        slidesSaveNotes
      })
    )
    await useSlidesStore.getState().openNotes()

    render(<SlidesNotesPanel />)
    const textarea = screen.getByRole('textbox', { name: '演讲者备注 Markdown' })
    fireEvent.change(textarea, { target: { value: '重试要保留的草稿' } })
    await new Promise((resolve) => setTimeout(resolve, 650))
    await waitFor(() => expect(screen.getByText('保存冲突')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '重试保存' }))

    await waitFor(() => expect(slidesSaveNotes).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText('已保存')).toBeInTheDocument())
  })

  it('关闭按钮走 closeNotes;保存失败时面板继续打开', async () => {
    const slidesSaveNotes = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'io_error' as const, message: '网络异常，保存失败' }
    }))
    await setup(
      fakeBridge({
        slidesReadNotes: vi.fn(async () => ({ ok: true as const, markdown: '初稿', slotRevision: 1 })),
        slidesSaveNotes
      })
    )
    await useSlidesStore.getState().openNotes()

    render(<SlidesNotesPanel />)
    const textarea = screen.getByRole('textbox', { name: '演讲者备注 Markdown' })
    fireEvent.change(textarea, { target: { value: '尚未保存的新稿' } })
    fireEvent.click(screen.getByRole('button', { name: '关闭备注' }))

    await waitFor(() => expect(screen.getByText('网络异常，保存失败')).toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: '演讲者备注 Markdown' })).toBeInTheDocument()
  })

  it('面板卸载前 flush 尚未到防抖时间的本地草稿', async () => {
    const slidesSaveNotes = vi.fn(async () => ({ ok: true as const, manifest: manifestWithSlots(4) }))
    await setup(
      fakeBridge({
        slidesReadNotes: vi.fn(async () => ({ ok: true as const, markdown: '初稿', slotRevision: 1 })),
        slidesSaveNotes
      })
    )
    await useSlidesStore.getState().openNotes()
    const rendered = render(<SlidesNotesPanel />)
    fireEvent.change(screen.getByRole('textbox', { name: '演讲者备注 Markdown' }), {
      target: { value: '卸载前必须保存' }
    })
    rendered.unmount()
    await waitFor(() => expect(slidesSaveNotes).toHaveBeenCalledOnce())
  })
})

describe('SlidesWorkspace 集成', () => {
  it('AI 生成当前页备注时发送受 slides 合同约束的指令', async () => {
    workspaceBridge = fakeBridge({
      slidesReadNotes: vi.fn(async () => ({ ok: true as const, markdown: '', slotRevision: 1 }))
    })
    render(<SlidesWorkspace workspaceRoot={ROOT} documentId={DECK} documentTitle="季度汇报" />)

    await waitFor(() => expect(screen.getByTestId('slides-stage-mock')).toBeInTheDocument())
    await useSlidesStore.getState().openNotes()
    fireEvent.click(await screen.findByRole('button', { name: 'AI 生成当前页备注' }))

    expect(buildSlidesTurnPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('slot-001')
      })
    )
    expect(sendDesignMessage).toHaveBeenCalledWith('slides prompt', 'agent', {
      displayText: 'AI 生成当前页备注'
    })
  })

  it('非输入焦点按 N 切换备注面板', async () => {
    workspaceBridge = fakeBridge({
      slidesReadNotes: vi.fn(async () => ({ ok: true as const, markdown: '快捷键备注', slotRevision: 1 }))
    })
    render(<SlidesWorkspace workspaceRoot={ROOT} documentId={DECK} documentTitle="季度汇报" />)

    await waitFor(() => expect(screen.getByTestId('slides-stage-mock')).toBeInTheDocument())
    fireEvent.keyDown(window, { key: 'n' })
    await waitFor(() => expect(screen.getByRole('textbox', { name: '演讲者备注 Markdown' })).toHaveValue('快捷键备注'))

    fireEvent.keyDown(window, { key: 'N' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '演讲者备注 Markdown' })).toBeNull())
  })

  it('打开备注时在 workspace 底部渲染备注编辑面板', async () => {
    workspaceBridge = fakeBridge()
    render(<SlidesWorkspace workspaceRoot={ROOT} documentId={DECK} documentTitle="季度汇报" />)

    await waitFor(() => expect(screen.getByTestId('slides-stage-mock')).toBeInTheDocument())
    useSlidesStore.setState({
      notesOpen: true,
      notesSlotId: 'slot-001',
      notesMarkdown: '底部备注内容',
      notesLoading: false,
      notesDirty: false,
      notesSaving: false,
      notesError: null,
      notesConflict: false
    })

    await waitFor(() => expect(screen.getByRole('textbox', { name: '演讲者备注 Markdown' })).toHaveValue('底部备注内容'))
  })
})
