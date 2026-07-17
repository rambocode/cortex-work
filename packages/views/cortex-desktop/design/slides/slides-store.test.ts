// slides-store 单测:用假 bridge 驱动 setup(加载/缺失补建)、写操作乐观锁冲突
// 自动刷新 + 冲突提示、导出结果透传等核心行为。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import type { SlidesDeckManifest } from '@cortex-work/core/design/slides/slides-types'
import { createEmptySlidesDeckManifest } from '@cortex-work/core/design/slides/slides-types'
import { slidesSlideHtmlPath } from '@cortex-work/core/design/slides/slides-paths'
import type { SlidesPipelineRun } from '@cortex-work/core/design/slides/slides-pipeline-types'
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

describe('演讲者备注', () => {
  it('并发 loadNotes 时忽略旧请求回包,不得覆盖最新 slot', async () => {
    let resolveFirst!: (value: { ok: true; markdown: string; slotRevision: number }) => void
    let resolveSecond!: (value: { ok: true; markdown: string; slotRevision: number }) => void
    const bridge = fakeBridge({
      slidesReadNotes: vi.fn(({ slotId }) => new Promise<{ ok: true; markdown: string; slotRevision: number }>((resolve) => {
        if (slotId === 'slot-001') resolveFirst = resolve
        else resolveSecond = resolve
      }))
    })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })

    const first = useSlidesStore.getState().loadNotes('slot-001')
    const second = useSlidesStore.getState().loadNotes('slot-002')

    resolveSecond({ ok: true, markdown: '第二页备注', slotRevision: 1 })
    await second
    resolveFirst({ ok: true, markdown: '第一页旧备注', slotRevision: 1 })
    await first

    expect(useSlidesStore.getState()).toMatchObject({
      notesSlotId: 'slot-002',
      notesMarkdown: '第二页备注',
      notesLoading: false,
      notesDirty: false
    })
  })

  it('打开当前页备注并保存,成功后采纳新 manifest', async () => {
    const read = vi.fn(async () => ({ ok: true as const, markdown: '初稿', slotRevision: 1 }))
    const save = vi.fn(async () => ({ ok: true as const, manifest: manifestWithSlots(4) }))
    const bridge = fakeBridge({ slidesReadNotes: read, slidesSaveNotes: save })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })

    await useSlidesStore.getState().openNotes()
    expect(read).toHaveBeenCalledWith({ workspaceRoot: ROOT, deckId: DECK, slotId: 'slot-001' })
    expect(useSlidesStore.getState().notesMarkdown).toBe('初稿')

    useSlidesStore.getState().setNotesMarkdown('最终讲稿')
    expect(await useSlidesStore.getState().saveNotes()).toBe(true)
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ slotId: 'slot-001', markdown: '最终讲稿', expectedRevision: 3 })
    )
    expect(useSlidesStore.getState()).toMatchObject({ notesDirty: false, notesSaving: false })
    expect(useSlidesStore.getState().manifest?.revision).toBe(4)
  })

  it('保存冲突时刷新 manifest,但保留本地备注草稿', async () => {
    const fresh = manifestWithSlots(9)
    const load = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, manifest: manifestWithSlots(3) })
      .mockResolvedValue({ ok: true as const, manifest: fresh })
    const bridge = fakeBridge({
      slidesLoadDeck: load,
      slidesReadNotes: vi.fn(async () => ({ ok: true as const, markdown: '旧稿', slotRevision: 1 })),
      slidesSaveNotes: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'revision_conflict' as const, message: '冲突' }
      }))
    })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    await useSlidesStore.getState().openNotes()
    useSlidesStore.getState().setNotesMarkdown('不可丢失的本地稿')

    expect(await useSlidesStore.getState().saveNotes()).toBe(false)
    expect(useSlidesStore.getState()).toMatchObject({
      notesMarkdown: '不可丢失的本地稿',
      notesDirty: true,
      notesConflict: true,
      notesSaving: false
    })
    expect(useSlidesStore.getState().manifest?.revision).toBe(9)
  })

  it('切页前保存脏备注,再切换并加载新页备注', async () => {
    const savedManifest = manifestWithSlots(4)
    const activeManifest = manifestWithSlots(5)
    activeManifest.activeSlideId = 'slot-002'
    const calls: string[] = []
    const bridge = fakeBridge({
      slidesReadNotes: vi.fn(async ({ slotId }) => {
        calls.push(`read:${slotId}`)
        return { ok: true as const, markdown: slotId === 'slot-001' ? '第一页' : '第二页', slotRevision: 1 }
      }),
      slidesSaveNotes: vi.fn(async () => {
        calls.push('save')
        return { ok: true as const, manifest: savedManifest }
      }),
      slidesSetActiveSlide: vi.fn(async ({ expectedRevision }) => {
        calls.push(`active:${expectedRevision}`)
        return { ok: true as const, manifest: activeManifest }
      })
    })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    await useSlidesStore.getState().openNotes()
    useSlidesStore.getState().setNotesMarkdown('第一页已编辑')
    await useSlidesStore.getState().setActiveSlide('slot-002')

    expect(calls).toEqual(['read:slot-001', 'save', 'active:4', 'read:slot-002'])
    expect(useSlidesStore.getState()).toMatchObject({ notesSlotId: 'slot-002', notesMarkdown: '第二页' })
  })

  it('保存进行中继续输入时仍保持 dirty,切页不得覆盖新草稿', async () => {
    let resolveSave!: (value: { ok: true; manifest: SlidesDeckManifest }) => void
    const save = vi.fn(() => new Promise<{ ok: true; manifest: SlidesDeckManifest }>((resolve) => {
      resolveSave = resolve
    }))
    const setActive = vi.fn(async () => ({ ok: true as const, manifest: manifestWithSlots(5) }))
    const bridge = fakeBridge({
      slidesReadNotes: vi.fn(async () => ({ ok: true as const, markdown: '初稿', slotRevision: 1 })),
      slidesSaveNotes: save,
      slidesSetActiveSlide: setActive
    })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    await useSlidesStore.getState().openNotes()
    useSlidesStore.getState().setNotesMarkdown('正在保存的版本')
    const switching = useSlidesStore.getState().setActiveSlide('slot-002')
    useSlidesStore.getState().setNotesMarkdown('保存期间的新输入')
    resolveSave({ ok: true, manifest: manifestWithSlots(4) })
    await switching

    expect(setActive).not.toHaveBeenCalled()
    expect(useSlidesStore.getState()).toMatchObject({
      notesSlotId: 'slot-001',
      notesMarkdown: '保存期间的新输入',
      notesDirty: true
    })
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

  it('PPTX 预检成功后打开质量报告,并保留缓存标记之外的分析数据', async () => {
    const analysis = {
      revision: 3,
      slides: [],
      deckReport: {
        slideCount: 0,
        nativeCount: 0,
        rasterCount: 0,
        rasterAreaRatio: 0,
        rasterReasons: [],
        warnings: [],
        quality: 'high' as const,
        nativeKinds: { text: 0, image: 0, table: 0, shape: 0, chart: 0 },
        qualityCounts: { high: 0, mixed: 0, 'raster-heavy': 0 }
      }
    }
    const bridge = fakeBridge({
      slidesAnalyzeExportQuality: vi.fn(async () => ({ ok: true as const, analysis, cached: true }))
    })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    expect(await useSlidesStore.getState().analyzeExportQuality()).toBe(true)
    expect(useSlidesStore.getState()).toMatchObject({
      exportQualityOpen: true,
      analyzingExport: false,
      exportQualityAnalysis: analysis
    })
    useSlidesStore.getState().closeExportQuality()
    expect(useSlidesStore.getState().exportQualityOpen).toBe(false)
  })
})

describe('present(演示模式)', () => {
  it('桥接具备能力时 canPresent=true,present 以 activeSlideId 起播且不占 mutating', async () => {
    const slidesPresent = vi.fn(async () => ({ ok: true as const }))
    const bridge = fakeBridge({ slidesPresent })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    expect(useSlidesStore.getState().canPresent).toBe(true)
    await useSlidesStore.getState().present()
    expect(slidesPresent).toHaveBeenCalledWith({ workspaceRoot: ROOT, deckId: DECK, startSlideId: 'slot-001' })
    // 只读操作:全程不进 mutating 互斥,演示期间编辑器可用。
    expect(useSlidesStore.getState().mutating).toBe(false)
    expect(useSlidesStore.getState().actionError).toBeNull()
  })

  it('桥接无能力:canPresent=false,present 挂可读错误且不抛', async () => {
    const bridge = fakeBridge()
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    expect(useSlidesStore.getState().canPresent).toBe(false)
    await useSlidesStore.getState().present()
    expect(useSlidesStore.getState().actionError).toBe('当前环境不支持演示模式')
  })

  it('主进程返回失败 → actionError 展示错误信息;reset 复位 canPresent', async () => {
    const bridge = fakeBridge({
      slidesPresent: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'not_found' as const, message: '没有可导出的页面' }
      }))
    })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    await useSlidesStore.getState().present()
    expect(useSlidesStore.getState().actionError).toBe('没有可导出的页面')
    useSlidesStore.getState().reset()
    expect(useSlidesStore.getState().canPresent).toBe(false)
  })
})

describe('AI Workflow 状态', () => {
  const run: SlidesPipelineRun = {
    schemaVersion: 1,
    id: 'run-review-1',
    deckId: DECK,
    kind: 'review',
    deckRevisionAtStart: 3,
    status: 'awaiting-approval',
    createdAt: NOW,
    updatedAt: '2026-07-16T00:00:05.000Z',
    roles: [
      {
        role: 'narrative-reviewer',
        status: 'awaiting-approval',
        artifactFile: 'narrative-review.json',
        updatedAt: '2026-07-16T00:00:05.000Z'
      }
    ]
  }

  it('打开面板时恢复最近待处理 run,接受后采纳最新 run', async () => {
    const accepted = {
      ...run,
      status: 'completed' as const,
      updatedAt: '2026-07-16T00:00:06.000Z',
      roles: [{ ...run.roles[0]!, status: 'accepted' as const }]
    }
    const bridge = fakeBridge({
      slidesGetLatestPipelineRun: vi.fn(async () => ({ ok: true as const, run })),
      slidesAcceptPipelineRole: vi.fn(async () => ({ ok: true as const, run: accepted }))
    })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    await useSlidesStore.getState().openWorkflow()
    expect(useSlidesStore.getState()).toMatchObject({ workflowOpen: true, pipelineRun: run, pipelineLoading: false })
    expect(await useSlidesStore.getState().acceptPipelineRole('narrative-reviewer')).toBe(true)
    expect(useSlidesStore.getState().pipelineRun?.status).toBe('completed')
    expect(bridge.slidesAcceptPipelineRole).toHaveBeenCalledWith(
      expect.objectContaining({ runId: run.id, expectedUpdatedAt: run.updatedAt, role: 'narrative-reviewer' })
    )
  })
})

// 舞台选区:编辑桥 selection-changed → store;空 items 即清空;reset 一并清。
describe('stageSelection', () => {
  const ITEM = { elementId: 'edit-1', tagName: 'H2', rect: { x: 0, y: 0, w: 10, h: 10 }, text: '标题' }

  beforeEach(() => {
    useSlidesStore.getState().reset()
  })

  it('setStageSelection 记录选区;空 items 置回 null', () => {
    useSlidesStore.getState().setStageSelection('slot-001', [ITEM])
    expect(useSlidesStore.getState().stageSelection).toEqual({ slotId: 'slot-001', items: [ITEM] })
    useSlidesStore.getState().setStageSelection('slot-001', [])
    expect(useSlidesStore.getState().stageSelection).toBeNull()
  })

  it('clearStageSelection 与 reset 都清空选区', () => {
    useSlidesStore.getState().setStageSelection('slot-002', [ITEM])
    useSlidesStore.getState().clearStageSelection()
    expect(useSlidesStore.getState().stageSelection).toBeNull()
    useSlidesStore.getState().setStageSelection('slot-002', [ITEM])
    useSlidesStore.getState().reset()
    expect(useSlidesStore.getState().stageSelection).toBeNull()
  })
})

// 编辑保存:系统级 revision 漂移(截图/检查 bump)导致的冲突应自动刷新重试一次,
// 不打扰用户;重试仍冲突才挂冲突提示。
describe('saveEditedHtml 冲突自动重试', () => {
  it('revision_conflict → refresh → 带新 revision 重试成功,无冲突提示', async () => {
    const save = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: { code: 'revision_conflict' as const, message: 'x' } })
      .mockResolvedValueOnce({ ok: true as const, manifest: manifestWithSlots(8) })
    // setup 拿到 rev 3;冲突后 refresh 拿到 rev 7 → 重试必须带 7。
    const load = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, manifest: manifestWithSlots(3) })
      .mockResolvedValue({ ok: true as const, manifest: manifestWithSlots(7) })
    const bridge = fakeBridge({ slidesSaveEditedHtml: save, slidesLoadDeck: load })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    const ok = await useSlidesStore.getState().saveEditedHtml('slot-001', '<html>x</html>')
    expect(ok).toBe(true)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[0]![0]).toMatchObject({ expectedRevision: 3 })
    expect(save.mock.calls[1]![0]).toMatchObject({ expectedRevision: 7 })
    expect(useSlidesStore.getState().conflictNotice).toBe(false)
    expect(useSlidesStore.getState().manifest?.revision).toBe(8)
  })

  it('重试仍冲突 → 挂冲突提示停止自动保存', async () => {
    const save = vi.fn(async () => ({ ok: false as const, error: { code: 'revision_conflict' as const, message: 'x' } }))
    const bridge = fakeBridge({ slidesSaveEditedHtml: save })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    const ok = await useSlidesStore.getState().saveEditedHtml('slot-001', '<html>x</html>')
    expect(ok).toBe(false)
    expect(save).toHaveBeenCalledTimes(2)
    expect(useSlidesStore.getState().conflictNotice).toBe(true)
  })

  it('保存成功后防抖触发单页截图并刷新 manifest(实时缩略图链路)', async () => {
    vi.useFakeTimers()
    try {
      const save = vi.fn(async () => ({ ok: true as const, manifest: manifestWithSlots(4) }))
      const screenshot = vi.fn(async () => ({ ok: true as const, snapshotPath: 'p.png' }))
      const load = vi.fn(async () => ({ ok: true as const, manifest: manifestWithSlots(5) }))
      const bridge = fakeBridge({ slidesSaveEditedHtml: save, slidesScreenshot: screenshot, slidesLoadDeck: load })
      await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
      await useSlidesStore.getState().saveEditedHtml('slot-001', '<html>x</html>')
      // 连续保存复位防抖:第二次保存后计时重来,只触发一次截图。
      await useSlidesStore.getState().saveEditedHtml('slot-001', '<html>y</html>')
      expect(screenshot).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1300)
      expect(screenshot).toHaveBeenCalledTimes(1)
      expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ slotId: 'slot-001' }))
    } finally {
      vi.useRealTimers()
    }
  })
})

// 缩略图缓存:每 slot 单份,新 key 原地替换;取图失败保留旧图(只有一种覆盖模式)。
describe('ensureSnapshot 每 slot 单份缓存', () => {
  it('同 key 跳过、新 key 替换、失败保留旧图', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, dataUrl: 'data:image/png;base64,ONE' })
      .mockResolvedValueOnce({ ok: false as const, error: { code: 'not_found' as const, message: 'x' } })
      .mockResolvedValueOnce({ ok: true as const, dataUrl: 'data:image/png;base64,TWO' })
    const bridge = fakeBridge({ slidesReadSnapshot: read })
    await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
    await useSlidesStore.getState().ensureSnapshot('slot-001', 't1')
    expect(useSlidesStore.getState().snapshots['slot-001']).toEqual({ key: 'slot-001@t1', url: 'data:image/png;base64,ONE' })
    // 同 key 不重复取。
    await useSlidesStore.getState().ensureSnapshot('slot-001', 't1')
    expect(read).toHaveBeenCalledTimes(1)
    // 新 key 但读取失败(如截图尚未生成)→ 旧图保留。
    await useSlidesStore.getState().ensureSnapshot('slot-001', 't2')
    expect(useSlidesStore.getState().snapshots['slot-001']!.url).toBe('data:image/png;base64,ONE')
    // 再来新 key 成功 → 原地替换。
    await useSlidesStore.getState().ensureSnapshot('slot-001', 't3')
    expect(useSlidesStore.getState().snapshots['slot-001']).toEqual({ key: 'slot-001@t3', url: 'data:image/png;base64,TWO' })
  })
})

// 舞台历史态:history-changed → 按钮可用态;reset 复位。
describe('stageHistory', () => {
  it('setStageHistory 更新;reset 复位为不可撤销', () => {
    useSlidesStore.getState().setStageHistory({ canUndo: true, canRedo: false })
    expect(useSlidesStore.getState().stageHistory).toEqual({ canUndo: true, canRedo: false })
    useSlidesStore.getState().reset()
    expect(useSlidesStore.getState().stageHistory).toEqual({ canUndo: false, canRedo: false })
  })
})
