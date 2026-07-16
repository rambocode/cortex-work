// Slides Workspace 专用 UI store(zustand,views 层)。
// 设计约束:
//  - deck 数据(manifest)的事实来源是主进程 deck.json,本 store 只保存「最近一次
//    IPC 返回的 manifest 快照 + 纯 UI 态(zoom/冲突提示)」,绝不复制进自由画布 projection;
//  - 所有写操作带 expectedRevision(= 当前快照 revision),revision_conflict 时自动
//    reload 最新 manifest 并挂冲突提示,由 UI 提供「刷新」确认;
//  - bridge/workspaceRoot 经 setup() 注入(views 不直接触碰 window.desktopAPI)。
import { create } from 'zustand'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import type {
  SlidesDeckIpcResult,
  SlidesExportFormat,
  SlidesExportResult
} from '@cortex-work/core/desktop/slides-ipc-types'
import type { SlidesDeckManifest, SlidesError } from '@cortex-work/core/design/slides/slides-types'

export type SlidesZoom = 'fit' | '50' | '75' | '100'

/** setup() 注入的运行环境(bridge + 工作区根);module 级持有,切 deck 时整体替换。 */
type SlidesContext = {
  bridge: DesktopBridge
  workspaceRoot: string
  deckId: string
}

let ctx: SlidesContext | null = null

export interface SlidesUiState {
  deckId: string | null
  manifest: SlidesDeckManifest | null
  loading: boolean
  /** 互斥的写操作进行中(增删/排序/保存);UI 据此禁用按钮防连点。 */
  mutating: boolean
  /** deck 级不可恢复错误(损坏/不存在);页面显示破损态。 */
  deckError: SlidesError | null
  /** 单次操作失败的瞬时错误(toast 语义,下一次成功自动清)。 */
  actionError: string | null
  /** revision 冲突:manifest 已被别处更新并已自动刷新,提示用户确认。 */
  conflictNotice: boolean
  /** deck.json 曾从 tmp 恢复(提示一次)。 */
  recoveredNotice: boolean
  zoom: SlidesZoom

  setup(context: { bridge: DesktopBridge; workspaceRoot: string; deckId: string; title: string }): Promise<void>
  refresh(): Promise<void>
  insertSlide(afterSlotId?: string): Promise<void>
  duplicateSlide(slotId: string): Promise<void>
  deleteSlide(slotId: string): Promise<void>
  reorderSlides(orderedSlotIds: string[]): Promise<void>
  setActiveSlide(slotId: string): Promise<void>
  saveEditedHtml(slotId: string, html: string): Promise<boolean>
  exportDeck(format: SlidesExportFormat): Promise<SlidesExportResult>
  setZoom(zoom: SlidesZoom): void
  clearConflict(): void
  clearActionError(): void
  /** 外部推来的最新 manifest(如 Agent 回合结束的刷新);仅在 deck 匹配时采纳。 */
  applyManifest(manifest: SlidesDeckManifest): void
  reset(): void
}

// 统一处理 deck 变更类 IPC 结果:成功换快照;revision_conflict 自动刷新 + 冲突提示;
// 其他失败挂 actionError。返回是否成功。
async function absorbDeckResult(
  set: (partial: Partial<SlidesUiState>) => void,
  refresh: () => Promise<void>,
  result: SlidesDeckIpcResult | undefined
): Promise<boolean> {
  if (!result) {
    set({ mutating: false, actionError: '桌面端能力不可用' })
    return false
  }
  if (result.ok) {
    set({ manifest: result.manifest, mutating: false, actionError: null })
    return true
  }
  if (result.error.code === 'revision_conflict') {
    await refresh()
    set({ mutating: false, conflictNotice: true })
    return false
  }
  set({ mutating: false, actionError: result.error.message })
  return false
}

export const useSlidesStore = create<SlidesUiState>((set, get) => ({
  deckId: null,
  manifest: null,
  loading: false,
  mutating: false,
  deckError: null,
  actionError: null,
  conflictNotice: false,
  recoveredNotice: false,
  zoom: 'fit',

  setup: async ({ bridge, workspaceRoot, deckId, title }) => {
    ctx = { bridge, workspaceRoot, deckId }
    set({
      deckId,
      manifest: null,
      loading: true,
      deckError: null,
      actionError: null,
      conflictNotice: false,
      recoveredNotice: false
    })
    if (!bridge.slidesLoadDeck || !bridge.slidesCreateDeck) {
      set({ loading: false, deckError: { code: 'io_error', message: '当前环境不支持演示文稿' } })
      return
    }
    let result = await bridge.slidesLoadDeck({ workspaceRoot, deckId }).catch(() => undefined)
    // deck 目录尚不存在(设计稿刚创建):首次进入时由 UI 侧补建 deck 工作区。
    if (result && !result.ok && result.error.code === 'not_found') {
      result = await bridge.slidesCreateDeck({ workspaceRoot, deckId, title }).catch(() => undefined)
    }
    // setup 竞态防护:异步期间用户已切到别的 deck,丢弃过期结果。
    if (ctx?.deckId !== deckId) return
    if (!result) {
      set({ loading: false, deckError: { code: 'io_error', message: '加载演示文稿失败' } })
      return
    }
    if (!result.ok) {
      set({ loading: false, deckError: result.error })
      return
    }
    set({ manifest: result.manifest, loading: false, recoveredNotice: result.recovered === true })
  },

  refresh: async () => {
    if (!ctx?.bridge.slidesLoadDeck) return
    const { bridge, workspaceRoot, deckId } = ctx
    const result = await bridge.slidesLoadDeck!({ workspaceRoot, deckId }).catch(() => undefined)
    if (ctx?.deckId !== deckId || !result) return
    if (result.ok) set({ manifest: result.manifest, deckError: null })
    else set({ deckError: result.error })
  },

  insertSlide: async (afterSlotId) => {
    const { manifest } = get()
    if (!ctx?.bridge.slidesInsertSlide || !manifest || get().mutating) return
    set({ mutating: true })
    const result = await ctx.bridge
      .slidesInsertSlide({
        workspaceRoot: ctx.workspaceRoot,
        deckId: ctx.deckId,
        expectedRevision: manifest.revision,
        afterSlotId
      })
      .catch(() => undefined)
    await absorbDeckResult(set, get().refresh, result)
  },

  duplicateSlide: async (slotId) => {
    const { manifest } = get()
    if (!ctx?.bridge.slidesDuplicateSlide || !manifest || get().mutating) return
    set({ mutating: true })
    const result = await ctx.bridge
      .slidesDuplicateSlide({
        workspaceRoot: ctx.workspaceRoot,
        deckId: ctx.deckId,
        expectedRevision: manifest.revision,
        slotId
      })
      .catch(() => undefined)
    await absorbDeckResult(set, get().refresh, result)
  },

  deleteSlide: async (slotId) => {
    const { manifest } = get()
    if (!ctx?.bridge.slidesDeleteSlide || !manifest || get().mutating) return
    set({ mutating: true })
    const result = await ctx.bridge
      .slidesDeleteSlide({
        workspaceRoot: ctx.workspaceRoot,
        deckId: ctx.deckId,
        expectedRevision: manifest.revision,
        slotId
      })
      .catch(() => undefined)
    await absorbDeckResult(set, get().refresh, result)
  },

  reorderSlides: async (orderedSlotIds) => {
    const { manifest } = get()
    if (!ctx?.bridge.slidesReorderSlides || !manifest || get().mutating) return
    set({ mutating: true })
    const result = await ctx.bridge
      .slidesReorderSlides({
        workspaceRoot: ctx.workspaceRoot,
        deckId: ctx.deckId,
        expectedRevision: manifest.revision,
        orderedSlotIds
      })
      .catch(() => undefined)
    await absorbDeckResult(set, get().refresh, result)
  },

  setActiveSlide: async (slotId) => {
    const { manifest } = get()
    if (!ctx?.bridge.slidesSetActiveSlide || !manifest) return
    if (manifest.activeSlideId === slotId) return
    // 本地乐观更新(切页是高频操作),失败/冲突再回滚到服务端快照。
    set({ manifest: { ...manifest, activeSlideId: slotId } })
    const result = await ctx.bridge
      .slidesSetActiveSlide({
        workspaceRoot: ctx.workspaceRoot,
        deckId: ctx.deckId,
        expectedRevision: manifest.revision,
        slotId
      })
      .catch(() => undefined)
    if (result?.ok) {
      set({ manifest: result.manifest })
    } else if (result && !result.ok && result.error.code === 'revision_conflict') {
      await get().refresh()
      set({ conflictNotice: true })
    }
  },

  saveEditedHtml: async (slotId, html) => {
    const { manifest } = get()
    if (!ctx?.bridge.slidesSaveEditedHtml || !manifest) return false
    const result = await ctx.bridge
      .slidesSaveEditedHtml({
        workspaceRoot: ctx.workspaceRoot,
        deckId: ctx.deckId,
        expectedRevision: manifest.revision,
        slotId,
        html
      })
      .catch(() => undefined)
    return absorbDeckResult(set, get().refresh, result)
  },

  exportDeck: async (format) => {
    if (!ctx?.bridge.slidesExport) {
      return { ok: false, error: { code: 'io_error', message: '当前环境不支持导出' } }
    }
    const result = await ctx.bridge
      .slidesExport({ workspaceRoot: ctx.workspaceRoot, deckId: ctx.deckId, format })
      .catch(
        (err: unknown): SlidesExportResult => ({
          ok: false,
          error: { code: 'io_error', message: err instanceof Error ? err.message : String(err) }
        })
      )
    if (!result.ok && !result.canceled && result.error) set({ actionError: result.error.message })
    return result
  },

  setZoom: (zoom) => set({ zoom }),
  clearConflict: () => set({ conflictNotice: false }),
  clearActionError: () => set({ actionError: null }),

  applyManifest: (manifest) => {
    if (manifest.id === get().deckId) set({ manifest })
  },

  reset: () => {
    ctx = null
    set({
      deckId: null,
      manifest: null,
      loading: false,
      mutating: false,
      deckError: null,
      actionError: null,
      conflictNotice: false,
      recoveredNotice: false
    })
  }
}))
