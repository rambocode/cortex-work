/**
 * Slides IPC 契约(desktop 主进程侧镜像副本)。与 `packages/core/desktop/slides-ipc-types.ts`
 * 逐字段镜像(除 import 路径),由 desktop 侧契约测试比对运行时常量防漂移。
 *
 * 约定:
 *  - 所有请求带 workspaceRoot + deckId;主进程重新做 realpath/边界/revision 校验,
 *    绝不信任 renderer 传入的任何路径。
 *  - 结果一律结构化 { ok } envelope,错误码取 SlidesErrorCode;用户取消导出用
 *    canceled=true 与失败区分(渲染端静默 vs toast)。
 *  - 导出目标路径只由主进程的系统保存对话框决定,请求里不携带输出路径。
 */
import type {
  SlidesAnimationStyle,
  SlidesDeckManifest,
  SlidesElementAnimation,
  SlidesError,
  SlidesFinding,
  SlidesOutline,
  SlidesTransition
} from "@cortex-work/core/design/slides/slides-types"
import type { SlidesTemplateSummary } from "@cortex-work/core/design/slides/slides-templates"
import type { DeckExportReport, SceneExportReport } from "@cortex-work/core/design/slides/slides-export-quality"
import type { SlidesPipelineRun, SlidesRole } from "@cortex-work/core/design/slides/slides-pipeline-types"

/** IPC 通道名清单(运行时常量,契约测试用)。 */
export const SLIDES_IPC_CHANNELS = [
  'slides:createDeck',
  'slides:loadDeck',
  'slides:renameDeck',
  'slides:listTemplates',
  'slides:applyTemplate',
  'slides:readTemplateReference',
  'slides:approveOutline',
  'slides:readOutlineDraft',
  'slides:reorderSlides',
  'slides:insertSlide',
  'slides:duplicateSlide',
  'slides:deleteSlide',
  'slides:setActiveSlide',
  'slides:saveEditedHtml',
  'slides:readNotes',
  'slides:saveNotes',
  'slides:readSlideHtml',
  'slides:readSnapshot',
  'slides:check',
  'slides:screenshot',
  'slides:analyzeExportQuality',
  'slides:getLatestPipelineRun',
  'slides:getPipelineRun',
  'slides:cancelPipelineRun',
  'slides:acceptPipelineRole',
  'slides:rejectPipelineRole',
  'slides:setAnimationStyle',
  'slides:setSlideAnimation',
  'slides:export',
  'slides:present'
] as const

export type SlidesIpcChannel = (typeof SLIDES_IPC_CHANNELS)[number]

/** 导出格式(运行时常量,契约测试 + 保存对话框过滤器共用)。 */
export const SLIDES_EXPORT_FORMATS = ['pptx', 'pdf', 'png', 'html'] as const
export type SlidesExportFormat = (typeof SLIDES_EXPORT_FORMATS)[number]

// ── 请求 ────────────────────────────────────────────────────────────────────

export type SlidesDeckScopedRequest = {
  workspaceRoot: string
  deckId: string
}

export type SlidesCreateDeckRequest = SlidesDeckScopedRequest & { title: string }

export type SlidesLoadDeckRequest = SlidesDeckScopedRequest

export type SlidesRenameDeckRequest = SlidesDeckScopedRequest & {
  expectedRevision: number
  title: string
}

/** 批准提纲:主进程写正式 outline(approvedAt=now)、按 items 生成空 slots、状态推进。 */
export type SlidesApproveOutlineRequest = SlidesDeckScopedRequest & {
  expectedRevision: number
  /** 用户在确认面板上最终编辑过的提纲(不含 approvedAt,由主进程盖章)。 */
  outline: Omit<SlidesOutline, 'approvedAt'>
}

export type SlidesReorderRequest = SlidesDeckScopedRequest & {
  expectedRevision: number
  /** 新顺序:必须恰好是现有 slot id 的一个排列。 */
  orderedSlotIds: string[]
}

export type SlidesInsertSlideRequest = SlidesDeckScopedRequest & {
  expectedRevision: number
  /** 插入到该 slot 之后;缺省插到末尾。 */
  afterSlotId?: string
  title?: string
}

export type SlidesDuplicateSlideRequest = SlidesDeckScopedRequest & {
  expectedRevision: number
  slotId: string
}

export type SlidesDeleteSlideRequest = SlidesDeckScopedRequest & {
  expectedRevision: number
  slotId: string
}

export type SlidesSetActiveSlideRequest = SlidesDeckScopedRequest & {
  expectedRevision: number
  slotId: string | null
}

export type SlidesSaveEditedHtmlRequest = SlidesDeckScopedRequest & {
  expectedRevision: number
  slotId: string
  html: string
}

/** 设置全局动画风格(写 manifest.animationStyle)。 */
export type SlidesSetAnimationStyleRequest = SlidesDeckScopedRequest & {
  expectedRevision: number
  style: SlidesAnimationStyle
}

/**
 * 设置单页动画注解。transition 为 null 表示清除该页转场(回落全局风格默认);
 * 省略字段 = 保留原值(与 MCP set_slide_animation 语义一致)。
 */
export type SlidesSetSlideAnimationRequest = SlidesDeckScopedRequest & {
  expectedRevision: number
  slotId: string
  transition?: SlidesTransition | null
  entrances?: SlidesElementAnimation[]
}

export type SlidesReadNotesRequest = SlidesDeckScopedRequest & { slotId: string }

export type SlidesSaveNotesRequest = SlidesDeckScopedRequest & {
  expectedRevision: number
  slotId: string
  markdown: string
}

export type SlidesReadSlideHtmlRequest = SlidesDeckScopedRequest & { slotId: string }

/**
 * 读取页面缩略图为 data URL。
 * 为什么不让 renderer 直接 <img src="file://…">:渲染页不是 file:// 源,Chromium 会拦掉
 * file:// 子资源(实测缩略图全是碎图)。故由主进程读盘转 data URL(沿用图片读闸门:
 * 拒符号链接、realpath 根校验、仅位图扩展名、体积上限)。
 */
export type SlidesReadSnapshotRequest = SlidesDeckScopedRequest & { slotId: string }

export type SlidesReadSnapshotResult =
  | { ok: true; dataUrl: string }
  | { ok: false; error: SlidesError }

/** 列出内置模板(与 deck 无关,不需 deckId)。 */
export type SlidesListTemplatesResult =
  | { ok: true; templates: SlidesTemplateSummary[] }
  | { ok: false; error: SlidesError }

/** 用户在 UI 里选模板:主进程把模板主题写进 deck(与 MCP apply_template 同源)。 */
export type SlidesApplyTemplateRequest = SlidesDeckScopedRequest & {
  expectedRevision: number
  templateId: string
}

/**
 * 读取模板参考页 HTML(模板下拉 hover 预览用)。参考页自包含(内联样式、无外链资源),
 * renderer 以沙箱 iframe srcdoc 缩放渲染。file 必须是该模板 template.json 声明的
 * referenceSlides 相对路径之一,主进程校验通过才读盘(不接受任意路径)。
 */
export type SlidesReadTemplateReferenceRequest = {
  templateId: string
  file: string
}

export type SlidesReadTemplateReferenceResult =
  | { ok: true; html: string }
  | { ok: false; error: SlidesError }

/** 读取 drafts/outline.json 提纲草案(确认面板初始值)。 */
export type SlidesReadOutlineDraftRequest = SlidesDeckScopedRequest

export type SlidesReadOutlineDraftResult =
  | { ok: true; outline: SlidesOutline }
  | { ok: false; error: SlidesError }

export type SlidesCheckRequest = SlidesDeckScopedRequest & {
  /** 限定检查的 slot;缺省检查整个 deck。 */
  slotIds?: string[]
}

export type SlidesScreenshotRequest = SlidesDeckScopedRequest & { slotId: string }

export type SlidesExportRequest = SlidesDeckScopedRequest & { format: SlidesExportFormat }

/** 演示模式:主进程开独立全屏窗口播放;从 startSlideId 起播(非 ready 页回退首个 ready 页)。 */
export type SlidesPresentRequest = SlidesDeckScopedRequest & {
  /** 起始页(通常传当前 activeSlideId);缺省或指向非 ready 页时回退首个 ready 页。 */
  startSlideId?: string | null
}

export type SlidesAnalyzeExportQualityRequest = SlidesDeckScopedRequest

export type SlidesGetPipelineRunRequest = SlidesDeckScopedRequest & { runId: string }
export type SlidesCancelPipelineRunRequest = SlidesGetPipelineRunRequest & { expectedUpdatedAt: string }
export type SlidesPipelineRoleDecisionRequest = SlidesCancelPipelineRunRequest & { role: SlidesRole }

export type SlidesPipelineRunResult =
  | { ok: true; run: SlidesPipelineRun | null; action?: unknown }
  | { ok: false; error: SlidesError }

export type SlidesExportQualityAnalysis = {
  revision: number
  slides: Array<{ slotId: string; order: number; report: SceneExportReport }>
  deckReport: DeckExportReport
}

export type SlidesAnalyzeExportQualityResult =
  | { ok: true; analysis: SlidesExportQualityAnalysis; cached?: boolean }
  | { ok: false; error: SlidesError }

// ── 结果 ────────────────────────────────────────────────────────────────────

/** deck 变更类通道的统一结果:成功携带最新 manifest(renderer 以此为准刷新)。 */
export type SlidesDeckIpcResult =
  | { ok: true; manifest: SlidesDeckManifest; recovered?: boolean; newSlotId?: string }
  | { ok: false; error: SlidesError }

export type SlidesReadSlideHtmlResult =
  | { ok: true; html: string }
  | { ok: false; error: SlidesError }

export type SlidesReadNotesResult =
  | { ok: true; markdown: string; slotRevision: number }
  | { ok: false; error: SlidesError }

export type SlidesCheckResult =
  | { ok: true; findings: SlidesFinding[] }
  | { ok: false; error: SlidesError }

export type SlidesScreenshotResult =
  | { ok: true; snapshotPath: string }
  | { ok: false; error: SlidesError }

/** 导出:canceled=true 表示用户在保存对话框取消(渲染端静默,不当作失败)。 */
export type SlidesExportResult =
  | { ok: true; path: string; format: SlidesExportFormat; qualityReport?: DeckExportReport }
  | { ok: false; canceled?: boolean; error?: SlidesError }

/** 演示结果:成功仅表示演示窗口已打开(不回传内容);无 ready 页 → not_found。 */
export type SlidesPresentResult = { ok: true } | { ok: false; error: SlidesError }
