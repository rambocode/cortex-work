/**
 * Slides IPC 契约(desktop 主进程侧镜像副本)。与 `packages/core/desktop/slides-ipc-types.ts`
 * 逐字段镜像(除头注释),由本侧契约测试比对运行时常量防漂移。
 */
import type { SlidesOutline } from '@cortex-work/core/design/slides/slides-types'

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

// ── deck 内容变更推送(main → renderer 单向广播)────────────────────────────────
//
// **刻意不进 SLIDES_IPC_CHANNELS**:那份清单的契约是「等于 ipcMain.handle 的注册面」,
// 推送通道不是 invoke handler,混进去会让契约测试变红。

/** deck 内容变更推送通道名(preload 侧订阅同一个名字)。 */
export const SLIDES_DECK_EVENT_CHANNEL = 'slides:deckChanged'

/** 谁改的:agent = MCP 工具写入;editor = bento 编辑器 autosave;runtime = 主进程维护/工作流写入。 */
export type SlidesDeckChangeSource = 'agent' | 'editor' | 'runtime'

/**
 * 一次 deck 内容变更。渲染端据此判断「要不要把新文档应用进编辑器」以及「时间线上写什么」。
 *
 * 为什么要推送而不是让渲染端轮询:MCP 工具直接写盘,渲染端此前只能靠文件 watcher
 * 搬运整份 HTML(几百 KB~MB 级)做字符串比对,既慢又会撞上 fs:readFile 的截断上限。
 */
export interface SlidesDeckChangedEvent {
  /** 调用方原样传入的工作区根(**不是 realpath**),便于渲染端字符串比对。 */
  workspaceRoot: string
  deckId: string
  /** 写入完成后的新 revision(= deck.meta.json 权威值)。 */
  revision: number
  source: SlidesDeckChangeSource
  /** 本次实际被替换的 slide id(set_slides);整份写入 / 换壳为空数组。 */
  slideIds: string[]
  /** 与 slideIds 顺序对齐的 1 基页码(写入后文档中的位置);无法解析时为空数组。 */
  pages: number[]
  /** 写入后的总页数;解析失败为 0。 */
  slideCount: number
  /** 写入完成时刻 ISO 串;仅供展示,不参与任何判定。 */
  at: string
}

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
  /**
   * 弱乐观锁:webview 内文档所对应的 revision。
   * 省略 = 旧壳/旧渲染端 → 保持 last-writer 旧行为(向后兼容);
   * 提供且不等于磁盘当前 revision → revision_conflict(编辑器持有的是过期稿,不许覆盖)。
   */
  baseRevision?: number
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
  /** 批准时携带用户在确认面板里编辑后的最终提纲,供主进程原子建立生成占位骨架。 */
  outline?: Omit<SlidesOutline, 'approvedAt'>
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
