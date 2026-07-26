/**
 * bento 编辑器选区快照:类型 + 校验/截断 + prompt 片段(纯函数)。
 *
 * 为什么归一化放在 core 而不是 vendor:webview 内的 bento 只做「薄采集」(读 store.selection
 * 直接 JSON.stringify 推给宿主),而 vendor/bento 没有任何测试基础设施(package.json 只有
 * dev/build)。所以一切可测逻辑——字段校验、条目/文本截断、prompt 措辞——都收在这里。
 *
 * 数据流:vendor/src/cortex/host-bridge.ts → 页内 shim → SlidesStage 轮询 →
 * parseSlidesSelectionSnapshot → bento-slides-store → 会话面板 chip + buildSlidesTurnPrompt。
 * 快照是纯运行时态,不进 #bento-doc、不触发保存。
 */

/** 选区里的单个元素:只留「指针」信息,元素内容由 agent 自行 get_deck_state 取。 */
export type SlidesSelectionItem = {
  /** bento 的文档内稳定元素 id(驱动 morph 配对与选区,见 vendor/bento/src/model.ts)。 */
  id: string
  /** 'text' | 'shape' | 'image' | 'svg' | 'chart' | 'table' | 'media'(不收窄,兼容上游新增类型)。 */
  type: string
  /** 幻灯片坐标系下的位置与尺寸(1280×720 画布);采集不到时整体省略。 */
  x?: number
  y?: number
  w?: number
  h?: number
  /** 短标签(文本摘要/图表类型等),仅用于人类可读定位,不是元素内容的完整转写。 */
  label?: string
}

export type SlidesSelectionSnapshot = {
  /** 0 起的页序号(与 bento store.currentIndex 一致);展示/prompt 里 +1。 */
  slideIndex: number
  slideId: string
  slideName?: string
  items: SlidesSelectionItem[]
  /** 用户实际选中的元素数(截断前);chip 计数用它,免得显示成截断后的数。 */
  totalCount?: number
  /** items 被截断时置位,prompt 会据此告知 agent 还有更多。 */
  truncated?: boolean
}

/** 条目上限:全选整页时避免把几十个元素灌进每一轮 prompt。 */
export const SLIDES_SELECTION_ITEMS_MAX = 24
/** 单条 label / 页名的字符上限(超出以 … 收尾)。 */
export const SLIDES_SELECTION_LABEL_MAX = 60

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 有限数才收:webview 侧可能给出 NaN/Infinity/字符串,绝不能带进 prompt。 */
function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 压平换行 + 收敛空白 + 超长截断——prompt 里的 label 必须是单行短文本。 */
function trimLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > SLIDES_SELECTION_LABEL_MAX
    ? `${flat.slice(0, SLIDES_SELECTION_LABEL_MAX)}…`
    : flat
}

function parseItem(raw: unknown): SlidesSelectionItem | null {
  const record = asRecord(raw)
  if (!record) return null
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const type = typeof record.type === 'string' ? record.type.trim() : ''
  if (!id || !type) return null
  const item: SlidesSelectionItem = { id, type }
  const x = finiteOrUndefined(record.x)
  const y = finiteOrUndefined(record.y)
  const w = finiteOrUndefined(record.w)
  const h = finiteOrUndefined(record.h)
  if (x !== undefined) item.x = x
  if (y !== undefined) item.y = y
  if (w !== undefined) item.w = w
  if (h !== undefined) item.h = h
  const label = trimLabel(record.label)
  if (label !== undefined) item.label = label
  return item
}

/**
 * 把桥回传的原始值(JSON 字符串或已解析对象)归一化为快照;任何不合规输入一律 null。
 * 空选区也返回 null —— 「没选中」与「选区非法」对上层是同一件事:不显示引用、不拼 prompt 段。
 */
export function parseSlidesSelectionSnapshot(raw: unknown): SlidesSelectionSnapshot | null {
  let value: unknown = raw
  if (typeof value === 'string') {
    if (!value.trim()) return null
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  const record = asRecord(value)
  if (!record) return null

  const slideIndex = finiteOrUndefined(record.slideIndex)
  const slideId = typeof record.slideId === 'string' ? record.slideId.trim() : ''
  if (slideIndex === undefined || slideIndex < 0 || !slideId) return null
  if (!Array.isArray(record.items)) return null

  const parsed = record.items
    .map(parseItem)
    .filter((item): item is SlidesSelectionItem => item !== null)
  if (!parsed.length) return null

  const snapshot: SlidesSelectionSnapshot = {
    slideIndex: Math.floor(slideIndex),
    slideId,
    items: parsed.slice(0, SLIDES_SELECTION_ITEMS_MAX),
    totalCount: parsed.length
  }
  const slideName = trimLabel(record.slideName)
  if (slideName !== undefined) snapshot.slideName = slideName
  if (parsed.length > SLIDES_SELECTION_ITEMS_MAX) snapshot.truncated = true
  return snapshot
}

/**
 * 选区身份键:用于「清除引用」的本地抑制。
 *
 * 语义是「用户清掉的是**这一份**选区」——所以键要覆盖页 + 元素集合。用户下次改选区
 * (换页、加选、减选)键就变了,引用自动恢复显示;而单纯的重新渲染/轮询不会改变键,
 * 已清除的引用也就不会闪回来。
 */
export function slidesSelectionKey(snapshot: SlidesSelectionSnapshot | null | undefined): string {
  if (!snapshot) return ''
  return `${snapshot.slideId}:${snapshot.items.map((item) => item.id).join(',')}`
}

/** chip 上显示的选中数:优先 totalCount(截断前的真实数)。 */
export function slidesSelectionCount(snapshot: SlidesSelectionSnapshot | null | undefined): number {
  if (!snapshot) return 0
  return snapshot.totalCount ?? snapshot.items.length
}

function formatItem(item: SlidesSelectionItem): string {
  const geometry =
    item.x !== undefined && item.y !== undefined && item.w !== undefined && item.h !== undefined
      ? `  (x:${item.x} y:${item.y} w:${item.w} h:${item.h})`
      : ''
  const label = item.label ? `  「${item.label}」` : ''
  return `- ${item.type} #${item.id}${geometry}${label}`
}

/**
 * 渲染进 prompt 的选区段(轻量指针版:只给定位信息,不内联元素内容)。
 *
 * 措辞刻意显式绑定中英文指代词——用户会中英混着说「把它换成折线图」/「this one」,
 * 不绑的话模型容易改错元素(board 侧的 formatHtmlElementContextLines 是同一处理)。
 * 空选区返回空串,调用方据此整段跳过。
 */
export function formatSlidesSelectionForPrompt(
  snapshot: SlidesSelectionSnapshot | null | undefined
): string {
  if (!snapshot || !snapshot.items.length) return ''
  const where = snapshot.slideName
    ? `slide ${snapshot.slideIndex + 1} 「${snapshot.slideName}」`
    : `slide ${snapshot.slideIndex + 1}`
  const total = slidesSelectionCount(snapshot)
  const lines = [
    `The user has selected the following elements on ${where}:`,
    ...snapshot.items.map(formatItem)
  ]
  if (snapshot.truncated) {
    lines.push(`(showing ${snapshot.items.length} of ${total} selected elements)`)
  }
  lines.push(
    '',
    'Treat this selection as the binding target for wording like "this", "these", "here",',
    '「这个」, 「这里」, 「选中的」. Apply the request to these elements only, unless the user',
    'clearly asks for something else. Fetch their current definition with get_deck_state before',
    'editing, and keep every other element byte-identical when you write the document back.'
  )
  return lines.join('\n')
}
