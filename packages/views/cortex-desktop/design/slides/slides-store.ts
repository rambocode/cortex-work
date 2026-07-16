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
import type {
  SlidesDeckManifest,
  SlidesError,
  SlidesFinding,
  SlidesOutline
} from '@cortex-work/core/design/slides/slides-types'
import type { SlidesTemplateSummary } from '@cortex-work/core/design/slides/slides-templates'

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
  /** 提纲确认面板:draft 来自 drafts/outline.json(agent propose_outline 写入)。 */
  outlineDialogOpen: boolean
  outlineDraft: SlidesOutline | null
  /** 检查结果面板。findings=null 表示尚未跑过检查。 */
  checkPanelOpen: boolean
  checking: boolean
  findings: SlidesFinding[] | null
  /** 模板选择器:templates=null 表示尚未加载。 */
  templatePickerOpen: boolean
  templates: SlidesTemplateSummary[] | null

  setup(context: { bridge: DesktopBridge; workspaceRoot: string; deckId: string; title: string }): Promise<void>
  openOutlineDialog(): Promise<void>
  closeOutlineDialog(): void
  /** 批准提纲(用户编辑后的最终版);成功返回 true 并采纳新 manifest。 */
  approveOutline(outline: Omit<SlidesOutline, 'approvedAt'>): Promise<boolean>
  /** 运行 deck 检查(静态+渲染,顺带刷新缩略图);完成后打开结果面板并定位第一条 blocking。 */
  runCheck(): Promise<void>
  closeCheckPanel(): void
  /** 打开模板选择器(首次打开时拉取列表)。 */
  openTemplatePicker(): Promise<void>
  closeTemplatePicker(): void
  /** 应用模板到当前 deck(主进程写主题);成功返回 true。 */
  applyTemplate(templateId: string): Promise<boolean>
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
  outlineDialogOpen: false,
  outlineDraft: null,
  checkPanelOpen: false,
  checking: false,
  findings: null,
  templatePickerOpen: false,
  templates: null,

  openTemplatePicker: async () => {
    set({ templatePickerOpen: true })
    if (get().templates || !ctx?.bridge.slidesListTemplates) return
    const result = await ctx.bridge.slidesListTemplates().catch(() => undefined)
    if (result?.ok) set({ templates: result.templates })
    else set({ templates: [], actionError: result && !result.ok ? result.error.message : '读取模板失败' })
  },

  closeTemplatePicker: () => set({ templatePickerOpen: false }),

  applyTemplate: async (templateId) => {
    const { manifest } = get()
    if (!ctx?.bridge.slidesApplyTemplate || !manifest || get().mutating) return false
    set({ mutating: true })
    const result = await ctx.bridge
      .slidesApplyTemplate({
        workspaceRoot: ctx.workspaceRoot,
        deckId: ctx.deckId,
        expectedRevision: manifest.revision,
        templateId
      })
      .catch(() => undefined)
    const ok = await absorbDeckResult(set, get().refresh, result)
    if (ok) set({ templatePickerOpen: false })
    return ok
  },

  runCheck: async () => {
    if (!ctx?.bridge.slidesCheck || get().checking) return
    set({ checking: true, checkPanelOpen: true })
    const result = await ctx.bridge
      .slidesCheck({ workspaceRoot: ctx.workspaceRoot, deckId: ctx.deckId })
      .catch(() => undefined)
    if (!result || !result.ok) {
      set({ checking: false, actionError: result && !result.ok ? result.error.message : '检查失败' })
      return
    }
    set({ checking: false, findings: result.findings })
    // 检查会刷新缩略图(snapshotPath 入册),同步拉一次最新 manifest。
    await get().refresh()
    // 自动定位第一条 blocking finding 所在页。
    const firstBlocking = result.findings.find((f) => f.severity === 'blocking')
    if (firstBlocking) void get().setActiveSlide(firstBlocking.slideId)
  },

  closeCheckPanel: () => set({ checkPanelOpen: false }),

  openOutlineDialog: async () => {
    if (!ctx?.bridge.slidesReadOutlineDraft) return
    const result = await ctx.bridge
      .slidesReadOutlineDraft({ workspaceRoot: ctx.workspaceRoot, deckId: ctx.deckId })
      .catch(() => undefined)
    if (result?.ok) {
      set({ outlineDraft: result.outline, outlineDialogOpen: true })
    } else {
      set({ outlineDraft: null, outlineDialogOpen: true })
    }
  },

  closeOutlineDialog: () => set({ outlineDialogOpen: false }),

  approveOutline: async (outline) => {
    const { manifest } = get()
    if (!ctx?.bridge.slidesApproveOutline || !manifest) return false
    set({ mutating: true })
    const result = await ctx.bridge
      .slidesApproveOutline({
        workspaceRoot: ctx.workspaceRoot,
        deckId: ctx.deckId,
        expectedRevision: manifest.revision,
        outline
      })
      .catch(() => undefined)
    const ok = await absorbDeckResult(set, get().refresh, result)
    if (ok) set({ outlineDialogOpen: false })
    return ok
  },

  setup: async ({ bridge, workspaceRoot, deckId, title }) => {
    ctx = { bridge, workspaceRoot, deckId }
    set({
      deckId,
      manifest: null,
      loading: true,
      deckError: null,
      actionError: null,
      conflictNotice: false,
      recoveredNotice: false,
      outlineDialogOpen: false,
      outlineDraft: null
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
      recoveredNotice: false,
      outlineDialogOpen: false,
      outlineDraft: null,
      templatePickerOpen: false,
      templates: null
    })
  }
}))
