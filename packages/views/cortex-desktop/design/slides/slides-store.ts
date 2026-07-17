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
  SlidesExportQualityAnalysis,
  SlidesExportFormat,
  SlidesExportResult,
  SlidesPresentResult
} from '@cortex-work/core/desktop/slides-ipc-types'
import type {
  SlidesDeckManifest,
  SlidesError,
  SlidesFinding,
  SlidesOutline
} from '@cortex-work/core/design/slides/slides-types'
import type { SlidesTemplateSummary } from '@cortex-work/core/design/slides/slides-templates'
import type { SlidesPipelineRun, SlidesRole } from '@cortex-work/core/design/slides/slides-pipeline-types'
import type { SlideBridgeSelectionItem } from './slide-edit-bridge'

export type SlidesZoom = 'fit' | '50' | '75' | '100'

/** 舞台选区(编辑桥 selection-changed 上报;发消息时并入 LLM 回合上下文)。 */
export type SlidesStageSelection = {
  slotId: string
  items: SlideBridgeSelectionItem[]
}

export type SlidesPipelineFinding = SlidesFinding & { source: 'narrative' | 'render' }

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function findingsFromPipelineAction(
  role: SlidesRole,
  action: unknown,
  manifest: SlidesDeckManifest
): SlidesPipelineFinding[] {
  const root = recordOf(action)
  if (!root) return []
  const source = role === 'render-reviewer' ? 'render' : role === 'narrative-reviewer' ? 'narrative' : null
  if (!source) return []
  const raw = source === 'render' ? root.findings : root.slideFindings
  if (!Array.isArray(raw)) return []
  const fallbackSlideId = manifest.activeSlideId ?? manifest.slides[0]?.id
  return raw.flatMap((item, index) => {
    const finding = recordOf(item)
    if (!finding) return []
    const slideId = typeof finding.slideId === 'string' ? finding.slideId : fallbackSlideId
    const message = typeof finding.message === 'string' ? finding.message : null
    const code = typeof finding.code === 'string' ? finding.code : `${source}-review`
    if (!slideId || !message) return []
    const severity = finding.severity === 'blocking' || finding.severity === 'info' ? finding.severity : 'warning'
    return [{
      id: `pipeline:${source}:${slideId}:${code}:${index}`,
      source,
      severity,
      slideId,
      code,
      message,
      elementId: typeof finding.elementId === 'string' ? finding.elementId : undefined,
      hint: typeof finding.hint === 'string' ? finding.hint : undefined
    }]
  })
}

/** setup() 注入的运行环境(bridge + 工作区根);module 级持有,切 deck 时整体替换。 */
type SlidesContext = {
  bridge: DesktopBridge
  workspaceRoot: string
  deckId: string
}

let ctx: SlidesContext | null = null

// 在途缩略图请求(key = `<slotId>@<updatedAt>`):多个组件同帧请求同一张时只发一次 IPC。
const inFlightSnapshots = new Set<string>()

// 编辑保存后的缩略图刷新防抖(每 slot 一个计时器):等编辑停顿再让主进程隐藏窗截图,
// 连续拖拽/打字期间不反复渲染;截图完成后 refresh() 同步 manifest(截图会 bump
// slot.updatedAt),缩略图栏据新 key 重取 data URL —— 这就是「实时缩略图」链路。
const SNAPSHOT_REFRESH_DEBOUNCE_MS = 1200
const snapshotRefreshTimers = new Map<string, number>()
let notesLoadGeneration = 0

function scheduleSnapshotRefresh(slotId: string, refresh: () => Promise<void>): void {
  if (!ctx?.bridge.slidesScreenshot) return
  const deckId = ctx.deckId
  const prev = snapshotRefreshTimers.get(slotId)
  if (prev) window.clearTimeout(prev)
  const timer = window.setTimeout(() => {
    snapshotRefreshTimers.delete(slotId)
    if (!ctx || ctx.deckId !== deckId || !ctx.bridge.slidesScreenshot) return
    void ctx.bridge
      .slidesScreenshot({ workspaceRoot: ctx.workspaceRoot, deckId, slotId })
      .then(async (result) => {
        if (!result?.ok || !ctx || ctx.deckId !== deckId) return
        await refresh()
      })
      .catch(() => undefined)
  }, SNAPSHOT_REFRESH_DEBOUNCE_MS)
  snapshotRefreshTimers.set(slotId, timer)
}

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
  /**
   * 缩略图 data URL 缓存:**每 slot 只存一份**(key 记录取图时的 `<slotId>@<updatedAt>`)。
   * updatedAt 变化时重取并原地替换 —— 新图未到前保留旧图,缩略图只有「图片」一种
   * 覆盖模式,不会闪回占位空框。
   * 为什么走 IPC 取 data URL:renderer 页非 file:// 源,<img src="file://…"> 会被
   * Chromium 拦掉(实测缩略图全碎)。
   */
  snapshots: Record<string, { key: string; url: string }>
  /** 舞台当前选区(null = 无选中);webview 重载/切页时由 SlidesStage 清空。 */
  stageSelection: SlidesStageSelection | null
  /** 舞台撤销/重做可用态(编辑桥 history-changed 上报,驱动画布工具栏按钮)。 */
  stageHistory: { canUndo: boolean; canRedo: boolean }
  /** 当前页演讲者备注。冲突时保留本地 markdown,由用户选择重试或重新加载。 */
  notesOpen: boolean
  notesSlotId: string | null
  notesMarkdown: string
  notesLoading: boolean
  notesDirty: boolean
  notesSaving: boolean
  notesSavedAt: string | null
  notesError: string | null
  notesConflict: boolean
  exportQualityOpen: boolean
  analyzingExport: boolean
  exportQualityAnalysis: SlidesExportQualityAnalysis | null
  workflowOpen: boolean
  pipelineLoading: boolean
  pipelineRun: SlidesPipelineRun | null
  pipelineFindings: SlidesPipelineFinding[]
  /** 桥接是否具备演示能力(setup 时探测);false 时工具栏「播放」按钮隐藏。 */
  canPresent: boolean

  setup(context: { bridge: DesktopBridge; workspaceRoot: string; deckId: string; title: string }): Promise<void>
  /** 编辑桥选区上报入口:空 items 视为清空。 */
  setStageSelection(slotId: string, items: SlideBridgeSelectionItem[]): void
  clearStageSelection(): void
  setStageHistory(history: { canUndo: boolean; canRedo: boolean }): void
  openNotes(): Promise<void>
  closeNotes(): Promise<boolean>
  loadNotes(slotId: string): Promise<void>
  setNotesMarkdown(markdown: string): void
  saveNotes(): Promise<boolean>
  analyzeExportQuality(): Promise<boolean>
  closeExportQuality(): void
  openWorkflow(): Promise<void>
  closeWorkflow(): void
  refreshPipeline(): Promise<void>
  cancelPipelineRun(): Promise<boolean>
  acceptPipelineRole(role: SlidesRole): Promise<boolean>
  rejectPipelineRole(role: SlidesRole): Promise<boolean>
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
  /** 读取模板参考页 HTML(下拉 hover 预览);无能力/失败返回 null,UI 退化为色板占位。 */
  readTemplateReference(templateId: string, file: string): Promise<string | null>
  /** 按需拉取某页缩略图(已缓存或已在途则不重复请求)。 */
  ensureSnapshot(slotId: string, updatedAt: string): Promise<void>
  refresh(): Promise<void>
  insertSlide(afterSlotId?: string): Promise<void>
  duplicateSlide(slotId: string): Promise<void>
  deleteSlide(slotId: string): Promise<void>
  reorderSlides(orderedSlotIds: string[]): Promise<void>
  setActiveSlide(slotId: string): Promise<void>
  saveEditedHtml(slotId: string, html: string): Promise<boolean>
  exportDeck(format: SlidesExportFormat): Promise<SlidesExportResult>
  /** 演示模式:主进程开全屏窗口从当前选中页播放;只读操作,不占 mutating。 */
  present(): Promise<void>
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
  canPresent: false,
  outlineDialogOpen: false,
  outlineDraft: null,
  checkPanelOpen: false,
  checking: false,
  findings: null,
  templatePickerOpen: false,
  templates: null,
  snapshots: {},
  stageSelection: null,
  stageHistory: { canUndo: false, canRedo: false },
  notesOpen: false,
  notesSlotId: null,
  notesMarkdown: '',
  notesLoading: false,
  notesDirty: false,
  notesSaving: false,
  notesSavedAt: null,
  notesError: null,
  notesConflict: false,
  exportQualityOpen: false,
  analyzingExport: false,
  exportQualityAnalysis: null,
  workflowOpen: false,
  pipelineLoading: false,
  pipelineRun: null,
  pipelineFindings: [],

  setStageSelection: (slotId, items) => {
    set({ stageSelection: items.length ? { slotId, items } : null })
  },

  clearStageSelection: () => {
    if (get().stageSelection) set({ stageSelection: null })
  },

  setStageHistory: (history) => {
    const cur = get().stageHistory
    if (cur.canUndo !== history.canUndo || cur.canRedo !== history.canRedo) set({ stageHistory: history })
  },

  openNotes: async () => {
    const slotId = get().manifest?.activeSlideId
    set({ notesOpen: true })
    if (slotId) await get().loadNotes(slotId)
  },

  closeNotes: async () => {
    if (get().notesDirty && !(await get().saveNotes())) return false
    set({ notesOpen: false })
    return true
  },

  loadNotes: async (slotId) => {
    if (!ctx?.bridge.slidesReadNotes) {
      set({ notesError: '当前环境不支持演讲者备注' })
      return
    }
    const deckId = ctx.deckId
    const requestGeneration = ++notesLoadGeneration
    set({ notesLoading: true, notesError: null, notesConflict: false })
    const result = await ctx.bridge
      .slidesReadNotes({ workspaceRoot: ctx.workspaceRoot, deckId, slotId })
      .catch(() => undefined)
    if (ctx?.deckId !== deckId || requestGeneration !== notesLoadGeneration) return
    if (!result?.ok) {
      set({ notesLoading: false, notesError: result && !result.ok ? result.error.message : '读取备注失败' })
      return
    }
    set({
      notesSlotId: slotId,
      notesMarkdown: result.markdown,
      notesLoading: false,
      notesDirty: false,
      notesSavedAt: null,
      notesError: null,
      notesConflict: false
    })
  },

  setNotesMarkdown: (markdown) => {
    set({ notesMarkdown: markdown, notesDirty: true, notesError: null, notesConflict: false })
  },

  saveNotes: async () => {
    const state = get()
    if (!state.notesDirty) return true
    if (!ctx?.bridge.slidesSaveNotes || !state.manifest || !state.notesSlotId || state.notesSaving) return false
    const deckId = ctx.deckId
    const localMarkdown = state.notesMarkdown
    set({ notesSaving: true, notesError: null })
    const result = await ctx.bridge
      .slidesSaveNotes({
        workspaceRoot: ctx.workspaceRoot,
        deckId,
        slotId: state.notesSlotId,
        markdown: localMarkdown,
        expectedRevision: state.manifest.revision
      })
      .catch(() => undefined)
    if (ctx?.deckId !== deckId) return false
    if (!result) {
      set({ notesSaving: false, notesError: '保存备注失败' })
      return false
    }
    if (result.ok) {
      // 仅当保存期间用户没有继续输入时清 dirty;否则保留更新后的本地草稿。
      const unchanged = get().notesMarkdown === localMarkdown
      set({
        manifest: result.manifest,
        notesSaving: false,
        notesDirty: !unchanged,
        notesSavedAt: unchanged ? new Date().toISOString() : get().notesSavedAt,
        notesError: null,
        notesConflict: false
      })
      return unchanged
    }
    if (result.error.code === 'revision_conflict') {
      await get().refresh()
      set({ notesSaving: false, notesDirty: true, notesConflict: true })
      return false
    }
    set({ notesSaving: false, notesDirty: true, notesError: result.error.message })
    return false
  },

  analyzeExportQuality: async () => {
    if (!ctx?.bridge.slidesAnalyzeExportQuality || get().analyzingExport) {
      if (!ctx?.bridge.slidesAnalyzeExportQuality) set({ actionError: '当前环境不支持 PPTX 可编辑性预检' })
      return false
    }
    set({ analyzingExport: true, actionError: null })
    const result = await ctx.bridge
      .slidesAnalyzeExportQuality({ workspaceRoot: ctx.workspaceRoot, deckId: ctx.deckId })
      .catch(() => undefined)
    if (!result?.ok) {
      set({ analyzingExport: false, actionError: result && !result.ok ? result.error.message : 'PPTX 预检失败' })
      return false
    }
    set({ analyzingExport: false, exportQualityAnalysis: result.analysis, exportQualityOpen: true })
    return true
  },

  closeExportQuality: () => set({ exportQualityOpen: false }),

  openWorkflow: async () => {
    set({ workflowOpen: true, checkPanelOpen: false })
    await get().refreshPipeline()
  },

  closeWorkflow: () => set({ workflowOpen: false }),

  refreshPipeline: async () => {
    if (!ctx || get().pipelineLoading) return
    const { bridge, workspaceRoot, deckId } = ctx
    const active = get().pipelineRun
    const request = active && bridge.slidesGetPipelineRun
      ? bridge.slidesGetPipelineRun({ workspaceRoot, deckId, runId: active.id })
      : bridge.slidesGetLatestPipelineRun?.({ workspaceRoot, deckId })
    if (!request) return
    set({ pipelineLoading: true })
    const result = await request.catch(() => undefined)
    if (ctx?.deckId !== deckId) return
    if (!result?.ok) {
      set({ pipelineLoading: false, actionError: result && !result.ok ? result.error.message : '读取 AI 工作流失败' })
      return
    }
    set({ pipelineLoading: false, pipelineRun: result.run })
  },

  cancelPipelineRun: async () => {
    const run = get().pipelineRun
    if (!ctx?.bridge.slidesCancelPipelineRun || !run || get().pipelineLoading) return false
    set({ pipelineLoading: true })
    const result = await ctx.bridge
      .slidesCancelPipelineRun({
        workspaceRoot: ctx.workspaceRoot,
        deckId: ctx.deckId,
        runId: run.id,
        expectedUpdatedAt: run.updatedAt
      })
      .catch(() => undefined)
    if (!result?.ok) {
      set({ pipelineLoading: false, actionError: result && !result.ok ? result.error.message : '取消工作流失败' })
      return false
    }
    set({ pipelineLoading: false, pipelineRun: result.run })
    return true
  },

  acceptPipelineRole: async (role) => {
    const run = get().pipelineRun
    if (!ctx?.bridge.slidesAcceptPipelineRole || !run || get().pipelineLoading) return false
    set({ pipelineLoading: true })
    const result = await ctx.bridge
      .slidesAcceptPipelineRole({
        workspaceRoot: ctx.workspaceRoot,
        deckId: ctx.deckId,
        runId: run.id,
        expectedUpdatedAt: run.updatedAt,
        role
      })
      .catch(() => undefined)
    if (!result?.ok) {
      set({ pipelineLoading: false, actionError: result && !result.ok ? result.error.message : '接受角色结果失败' })
      return false
    }
    const pipelineFindings = result.action && result.run && get().manifest
      ? findingsFromPipelineAction(role, result.action, get().manifest!)
      : []
    set((state) => ({
      pipelineLoading: false,
      pipelineRun: result.run,
      pipelineFindings: pipelineFindings.length
        ? [...state.pipelineFindings.filter((finding) => finding.source !== pipelineFindings[0]!.source), ...pipelineFindings]
        : state.pipelineFindings
    }))
    if (role === 'notes-writer') await get().refresh()
    return true
  },

  rejectPipelineRole: async (role) => {
    const run = get().pipelineRun
    if (!ctx?.bridge.slidesRejectPipelineRole || !run || get().pipelineLoading) return false
    set({ pipelineLoading: true })
    const result = await ctx.bridge
      .slidesRejectPipelineRole({
        workspaceRoot: ctx.workspaceRoot,
        deckId: ctx.deckId,
        runId: run.id,
        expectedUpdatedAt: run.updatedAt,
        role
      })
      .catch(() => undefined)
    if (!result?.ok) {
      set({ pipelineLoading: false, actionError: result && !result.ok ? result.error.message : '拒绝角色结果失败' })
      return false
    }
    set({ pipelineLoading: false, pipelineRun: result.run })
    return true
  },

  ensureSnapshot: async (slotId, updatedAt) => {
    const key = `${slotId}@${updatedAt}`
    // 该 slot 已持有此 key 的图 → 跳过;持有旧 key → 重取并原地替换(期间旧图继续展示)。
    if (get().snapshots[slotId]?.key === key || inFlightSnapshots.has(key) || !ctx?.bridge.slidesReadSnapshot) return
    inFlightSnapshots.add(key)
    const { workspaceRoot, deckId } = ctx
    const result = await ctx.bridge.slidesReadSnapshot({ workspaceRoot, deckId, slotId }).catch(() => undefined)
    inFlightSnapshots.delete(key)
    // 切 deck 竞态:异步期间已换 deck → 丢弃。读取失败(not_found 等)保留旧图不清空。
    if (ctx?.deckId !== deckId || !result?.ok) return
    set((state) => ({ snapshots: { ...state.snapshots, [slotId]: { key, url: result.dataUrl } } }))
  },

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

  readTemplateReference: async (templateId, file) => {
    if (!ctx?.bridge.slidesReadTemplateReference) return null
    const result = await ctx.bridge.slidesReadTemplateReference({ templateId, file }).catch(() => undefined)
    return result?.ok ? result.html : null
  },

  runCheck: async () => {
    if (!ctx?.bridge.slidesCheck || get().checking) return
    set({ checking: true, checkPanelOpen: true, workflowOpen: false })
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
    notesLoadGeneration += 1
    ctx = { bridge, workspaceRoot, deckId }
    set({
      deckId,
      manifest: null,
      loading: true,
      canPresent: !!bridge.slidesPresent,
      deckError: null,
      actionError: null,
      conflictNotice: false,
      recoveredNotice: false,
      outlineDialogOpen: false,
      outlineDraft: null,
      notesOpen: false,
      notesSlotId: null,
      notesMarkdown: '',
      notesLoading: false,
      notesDirty: false,
      notesSaving: false,
      notesSavedAt: null,
      notesError: null,
      notesConflict: false,
      exportQualityOpen: false,
      analyzingExport: false,
      exportQualityAnalysis: null,
      workflowOpen: false,
      pipelineLoading: false,
      pipelineRun: null,
      pipelineFindings: []
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
    if (get().notesOpen && get().notesDirty && !(await get().saveNotes())) return
    const currentManifest = get().manifest
    if (!currentManifest) return
    // 本地乐观更新(切页是高频操作),失败/冲突再回滚到服务端快照。
    set({ manifest: { ...currentManifest, activeSlideId: slotId } })
    const result = await ctx.bridge
      .slidesSetActiveSlide({
        workspaceRoot: ctx.workspaceRoot,
        deckId: ctx.deckId,
        expectedRevision: currentManifest.revision,
        slotId
      })
      .catch(() => undefined)
    if (result?.ok) {
      set({ manifest: result.manifest })
      if (get().notesOpen) await get().loadNotes(slotId)
    } else if (result && !result.ok && result.error.code === 'revision_conflict') {
      await get().refresh()
      set({ conflictNotice: true })
    }
  },

  saveEditedHtml: async (slotId, html) => {
    if (!ctx?.bridge.slidesSaveEditedHtml || !get().manifest) return false
    const attempt = async (): Promise<SlidesDeckIpcResult | undefined> =>
      ctx!.bridge
        .slidesSaveEditedHtml!({
          workspaceRoot: ctx!.workspaceRoot,
          deckId: ctx!.deckId,
          expectedRevision: get().manifest!.revision,
          slotId,
          html
        })
        .catch(() => undefined)
    let result = await attempt()
    // 系统级 revision 漂移(截图/检查只 bump manifest 元数据,不碰页面 HTML)会让编辑保存
    // 误报冲突:刷新拿最新 revision 后自动重试一次。正在编辑的页面 DOM 就是用户最新意图,
    // 重试覆盖是正确语义;重试仍冲突才走冲突提示(真正的并发改写,如 Agent 同时写同一页)。
    if (result && !result.ok && result.error.code === 'revision_conflict') {
      await get().refresh()
      if (!get().manifest) return false
      result = await attempt()
    }
    const ok = await absorbDeckResult(set, get().refresh, result)
    // 保存成功 → 防抖刷新该页缩略图(左栏实时跟随编辑)。
    if (ok) scheduleSnapshotRefresh(slotId, get().refresh)
    return ok
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

  // 演示是只读操作:不占 mutating 锁,演示窗口打开期间编辑器照常可用。
  present: async () => {
    if (!ctx?.bridge.slidesPresent) {
      set({ actionError: '当前环境不支持演示模式' })
      return
    }
    const startSlideId = get().manifest?.activeSlideId ?? null
    const result = await ctx.bridge
      .slidesPresent({ workspaceRoot: ctx.workspaceRoot, deckId: ctx.deckId, startSlideId })
      .catch(
        (err: unknown): SlidesPresentResult => ({
          ok: false,
          error: { code: 'io_error', message: err instanceof Error ? err.message : String(err) }
        })
      )
    if (!result.ok) set({ actionError: result.error.message })
  },

  setZoom: (zoom) => set({ zoom }),
  clearConflict: () => set({ conflictNotice: false }),
  clearActionError: () => set({ actionError: null }),

  applyManifest: (manifest) => {
    if (manifest.id === get().deckId) set({ manifest })
  },

  reset: () => {
    notesLoadGeneration += 1
    ctx = null
    set({
      deckId: null,
      manifest: null,
      loading: false,
      mutating: false,
      canPresent: false,
      deckError: null,
      actionError: null,
      conflictNotice: false,
      recoveredNotice: false,
      outlineDialogOpen: false,
      outlineDraft: null,
      templatePickerOpen: false,
      templates: null,
      snapshots: {},
      stageSelection: null,
      stageHistory: { canUndo: false, canRedo: false },
      notesOpen: false,
      notesSlotId: null,
      notesMarkdown: '',
      notesLoading: false,
      notesDirty: false,
      notesSaving: false,
      notesSavedAt: null,
      notesError: null,
      notesConflict: false,
      exportQualityOpen: false,
      analyzingExport: false,
      exportQualityAnalysis: null,
      workflowOpen: false,
      pipelineLoading: false,
      pipelineRun: null,
      pipelineFindings: []
    })
  }
}))
