// bento slides 前端 store 测试:setup 补建、快照应用、gate 批准、autosave 落盘转发。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import { buildStarterBentoDoc } from '@cortex-work/core/design/slides/bento/bento-doc-schema'
import { useBentoSlidesStore } from './bento-slides-store'
import { parseBentoSaveDrain } from './bento-stage-bridge'

const starterJson = JSON.stringify(buildStarterBentoDoc('测试稿'))

function makeBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    slidesBentoGetDeck: vi.fn().mockResolvedValue({ ok: true, json: starterJson, revision: 3, stage: 'draft', outline: null }),
    slidesBentoCreateDeck: vi.fn().mockResolvedValue({ ok: true, revision: 0 }),
    slidesBentoWriteDeckHtml: vi.fn().mockResolvedValue({ ok: true, revision: 4 }),
    slidesBentoSetStage: vi.fn().mockResolvedValue({ ok: true, revision: 3 }),
    slidesBentoExportFile: vi.fn().mockResolvedValue({ ok: true, path: '/tmp/a.bento.html' }),
    ...overrides
  } as unknown as DesktopBridge
}

beforeEach(() => {
  useBentoSlidesStore.getState().reset()
})

describe('setup', () => {
  it('读取成功即应用快照(doc/revision/stage)', async () => {
    const bridge = makeBridge()
    await useBentoSlidesStore.getState().setup({ bridge, workspaceRoot: '/ws', deckId: 'deck1', title: '测试稿' })
    const s = useBentoSlidesStore.getState()
    expect(s.doc?.title).toBe('测试稿')
    expect(s.revision).toBe(3)
    expect(s.stage).toBe('draft')
    expect(s.deckError).toBeNull()
  })

  it('not_found 时自动补建再读', async () => {
    const getDeck = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'not_found', message: 'x' } })
      .mockResolvedValueOnce({ ok: true, json: starterJson, revision: 0, stage: 'draft', outline: null })
    const bridge = makeBridge({ slidesBentoGetDeck: getDeck } as Partial<DesktopBridge>)
    await useBentoSlidesStore.getState().setup({ bridge, workspaceRoot: '/ws', deckId: 'deck1', title: '测试稿' })
    expect((bridge.slidesBentoCreateDeck as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({
      workspaceRoot: '/ws',
      deckId: 'deck1',
      title: '测试稿'
    })
    expect(useBentoSlidesStore.getState().doc?.title).toBe('测试稿')
  })

  it('桥缺失能力时降级为可读错误', async () => {
    await useBentoSlidesStore
      .getState()
      .setup({ bridge: {} as DesktopBridge, workspaceRoot: '/ws', deckId: 'deck1', title: 'x' })
    expect(useBentoSlidesStore.getState().deckError?.code).toBe('io_error')
  })
})

describe('approveOutline', () => {
  it('批准 → stage 推进 outline-approved 且关面板', async () => {
    const bridge = makeBridge()
    await useBentoSlidesStore.getState().setup({ bridge, workspaceRoot: '/ws', deckId: 'deck1', title: 'x' })
    useBentoSlidesStore.getState().openOutlineDialog()
    const ok = await useBentoSlidesStore.getState().approveOutline({ version: 1, summary: '', items: [] })
    expect(ok).toBe(true)
    expect(useBentoSlidesStore.getState().stage).toBe('outline-approved')
    expect(useBentoSlidesStore.getState().outlineDialogOpen).toBe(false)
    expect(bridge.slidesBentoSetStage).toHaveBeenCalledWith({
      workspaceRoot: '/ws',
      deckId: 'deck1',
      stage: 'outline-approved'
    })
  })
})

describe('editor context', () => {
  it('原子保存当前页与元素选区，reset 时一并清空', () => {
    const setEditorContext = useBentoSlidesStore.getState().setEditorContext
    expect(typeof setEditorContext).toBe('function')
    setEditorContext(
      { slideIndex: 2, slideId: 's3', slideName: '第三页' },
      {
        slideIndex: 2,
        slideId: 's3',
        slideName: '第三页',
        items: [{ id: 'title', type: 'text' }]
      }
    )
    expect(useBentoSlidesStore.getState().currentPage?.slideId).toBe('s3')
    expect(useBentoSlidesStore.getState().selection?.items[0]?.id).toBe('title')

    useBentoSlidesStore.getState().reset()
    expect(useBentoSlidesStore.getState().currentPage).toBeNull()
    expect(useBentoSlidesStore.getState().selection).toBeNull()
  })
})

describe('saveEditedDeckHtml', () => {
  it('成功 → revision 前进;失败 → 错误浮出且返回 ok:false', async () => {
    const bridge = makeBridge()
    await useBentoSlidesStore.getState().setup({ bridge, workspaceRoot: '/ws', deckId: 'deck1', title: 'x' })
    expect(await useBentoSlidesStore.getState().saveEditedDeckHtml('<html>…</html>')).toMatchObject({
      ok: true,
      revision: 4
    })
    expect(useBentoSlidesStore.getState().revision).toBe(4)

    const failing = makeBridge({
      slidesBentoWriteDeckHtml: vi.fn().mockResolvedValue({ ok: false, error: { code: 'io_error', message: '磁盘满' } })
    } as Partial<DesktopBridge>)
    await useBentoSlidesStore.getState().setup({ bridge: failing, workspaceRoot: '/ws', deckId: 'deck1', title: 'x' })
    expect(await useBentoSlidesStore.getState().saveEditedDeckHtml('<html>…</html>')).toMatchObject({ ok: false })
    expect(useBentoSlidesStore.getState().deckError?.message).toBe('磁盘满')
  })

  it('把 baseRevision 一并传给主进程(弱乐观锁的输入)', async () => {
    const write = vi.fn().mockResolvedValue({ ok: true, revision: 9 })
    const bridge = makeBridge({ slidesBentoWriteDeckHtml: write } as Partial<DesktopBridge>)
    await useBentoSlidesStore.getState().setup({ bridge, workspaceRoot: '/ws', deckId: 'deck1', title: 'x' })
    await useBentoSlidesStore.getState().saveEditedDeckHtml('<html>…</html>', 8)
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ baseRevision: 8 }))
  })

  // revision_conflict 不是失败,是竞态的正常出口:webview 持的是过期稿(AI 刚写过盘)。
  // 弹一条红色错误只会让用户以为「存不进去了」,正确处理是丢弃这份 HTML 并刷新到最新稿。
  it('revision_conflict → stale:true 且不置 deckError', async () => {
    const bridge = makeBridge({
      slidesBentoWriteDeckHtml: vi
        .fn()
        .mockResolvedValue({ ok: false, error: { code: 'revision_conflict', message: '磁盘已到 rev 5' } })
    } as Partial<DesktopBridge>)
    await useBentoSlidesStore.getState().setup({ bridge, workspaceRoot: '/ws', deckId: 'deck1', title: 'x' })
    const res = await useBentoSlidesStore.getState().saveEditedDeckHtml('<html>…</html>', 3)
    expect(res).toMatchObject({ ok: false, stale: true })
    expect(useBentoSlidesStore.getState().deckError).toBeNull()
  })
})

describe('parseBentoSaveDrain', () => {
  it('只认非空字符串', () => {
    expect(parseBentoSaveDrain('<html>x</html>')).toBe('<html>x</html>')
    expect(parseBentoSaveDrain(null)).toBeNull()
    expect(parseBentoSaveDrain(undefined)).toBeNull()
    expect(parseBentoSaveDrain('')).toBeNull()
    expect(parseBentoSaveDrain(42)).toBeNull()
  })
})
