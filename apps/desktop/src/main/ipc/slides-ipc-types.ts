/**
 * Slides IPC 契约(desktop 主进程侧镜像副本)。与 `packages/core/desktop/slides-ipc-types.ts`
 * 逐字段镜像(除头注释),由本侧契约测试比对运行时常量防漂移。
 */

/** IPC 通道名清单(运行时常量,契约测试用)。 */
export const SLIDES_IPC_CHANNELS = [
  'slides:bentoCreateDeck',
  'slides:bentoGetDeck',
  'slides:bentoSetStage',
  'slides:bentoWriteDeckHtml',
  'slides:bentoExportFile',
  'slides:present'
] as const

export type SlidesIpcChannel = (typeof SLIDES_IPC_CHANNELS)[number]

// ── bento 化 deck 契约(单文件 .bento.html 体系;详见 capabilities/slides/bento-workspace)──

export interface BentoDeckScopedRequest {
  workspaceRoot: string
  deckId: string
}

export interface BentoCreateDeckRequest extends BentoDeckScopedRequest {
  title: string
}

/** 编辑器 autosave 整份 HTML 回写(webview 内 bento 编辑器产物)。 */
export interface BentoWriteDeckHtmlRequest extends BentoDeckScopedRequest {
  html: string
}

export interface BentoDeckIpcError {
  code: 'invalid_path' | 'not_found' | 'already_exists' | 'revision_conflict' | 'invalid_doc' | 'too_large' | 'io_error'
  message: string
}

export type BentoDeckIpcResult = { ok: true; revision: number } | { ok: false; error: BentoDeckIpcError }

/** 提纲批准 gate 阶段(存 deck.meta.json sidecar;主进程 bento-workspace 权威)。 */
export type BentoDeckStage = 'draft' | 'outline-proposed' | 'outline-approved' | 'ready'

export interface BentoSetStageRequest extends BentoDeckScopedRequest {
  stage: BentoDeckStage
}

/** 读取 deck:json 为内嵌 #bento-doc 原文(空块 null);渲染端按需 JSON.parse。 */
export type BentoGetDeckResult =
  | { ok: true; json: string | null; revision: number; stage: BentoDeckStage; outline: unknown }
  | { ok: false; error: BentoDeckIpcError }

/** 另存为 .bento.html:目标路径只由主进程保存对话框决定;canceled 与失败区分。 */
export type BentoExportFileResult =
  | { ok: true; path: string }
  | { ok: false; canceled?: boolean; error?: BentoDeckIpcError }

/** 演示模式(bento):主进程加载 deck.bento.html 开演示窗;startIndex 为实页 0 基索引。 */
export type SlidesPresentRequest = BentoDeckScopedRequest & {
  /** 起始实页索引(0 基);缺省 0,越界/落在 stateOf 状态页时吸附到最近线性页。 */
  startIndex?: number
}

/** 演示结果:成功仅表示演示窗口已打开(不回传内容);deck 无可播页 → not_found。 */
export type SlidesPresentResult = { ok: true } | { ok: false; error: BentoDeckIpcError }
