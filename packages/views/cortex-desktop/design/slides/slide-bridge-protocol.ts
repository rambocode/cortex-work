// Slide 编辑 bridge 的宿主侧协议层:消息/命令类型、常量与校验/编译函数。
// 页内注入脚本与传输模型见 slide-edit-bridge.ts(该文件 re-export 本模块,
// 调用方统一从 slide-edit-bridge 导入即可)。
//
// 安全契约:每条页内消息必须带 `__cortexSlides: 1` 与白名单内的 type;任何不合协议
// 的输入(页面伪造的队列内容、未知 type、字段类型错、超大 HTML)一律丢弃 ——
// 绝不按 method name 派发。

/** 协议版本标记:宿主与页内脚本双向校验。 */
export const SLIDE_BRIDGE_PROTOCOL = 1

/** 可编辑标签白名单(纯文本类;结构性容器不开放就地编辑)。 */
export const EDITABLE_TAGS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'SPAN', 'LI', 'TD', 'TH', 'FIGCAPTION', 'BLOCKQUOTE', 'STRONG', 'EM'] as const

/** 宿主 drain 页内队列的表达式(返回 JSON 数组;页内未挂载 bridge 时返回空数组)。 */
export const DRAIN_SLIDE_BRIDGE_SOURCE =
  'window.__cortexSlidesBridge ? window.__cortexSlidesBridge.drain() : []'

/** 宿主 drain 轮询间隔:低于 debounce,保证一次编辑的保存延迟仍在亚秒级。 */
export const BRIDGE_DRAIN_INTERVAL_MS = 250

/** 选区条目的文本摘要上限(供 LLM 定位元素,不必带全文)。 */
export const SELECTION_TEXT_MAX = 120

/** 选区条目上限(异常页面千元素全选也不至于撑爆消息)。 */
export const SELECTION_ITEMS_MAX = 64

/** 一条选区条目:id 已确保存在(缺则页内就地补打)。 */
export type SlideBridgeSelectionItem = {
  elementId: string
  tagName: string
  rect: { x: number; y: number; w: number; h: number }
  /** 元素文本摘要(截断到 SELECTION_TEXT_MAX;无文本为空串)。 */
  text: string
}

/** 页内 → 宿主 的消息(只有这些 type 会被处理)。 */
export type SlideBridgeInboundMessage =
  | { __cortexSlides: 1; type: 'ready' }
  | { __cortexSlides: 1; type: 'selection-changed'; items: SlideBridgeSelectionItem[] }
  | { __cortexSlides: 1; type: 'html-changed'; html: string }
  | { __cortexSlides: 1; type: 'history-changed'; canUndo: boolean; canRedo: boolean }

/** 宿主 → 页内 的命令(经 executeJavaScript 调用页内 API)。 */
export type SlideBridgeCommand =
  | { type: 'set-edit-mode'; enabled: boolean }
  | { type: 'format'; command: 'bold' | 'italic' | 'underline' }
  | { type: 'font-size'; px: number }
  /** 字号增减(工具栏 A-/A+):按各选中元素当前 computed 字号步进。 */
  | { type: 'font-step'; delta: number }
  | { type: 'color'; hex: string }
  | { type: 'align'; value: 'left' | 'center' | 'right' }
  /** 元素对齐(需多选):把各选中元素的边/中线对齐到选区包围盒,区别于 align 的 text-align。 */
  | { type: 'align-elements'; value: 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom' }
  /** 插入图片(粘贴管线的落点):dataUrl 仅接受 base64 位图;width/height 为画布内展示尺寸。 */
  | { type: 'insert-image'; dataUrl: string; width: number; height: number }
  /** 层级调整:相对与所选重叠的元素调 z-index(up/down 一层,front/back 置顶/置底)。 */
  | { type: 'z-order'; value: 'up' | 'down' | 'front' | 'back' }
  | { type: 'delete-selected' }
  | { type: 'focus-element'; elementId: string }
  | { type: 'clear-selection' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'flush' }

/** 单页 HTML 上限(与主进程 MAX_SLIDE_HTML_BYTES 一致;超限宿主直接拒绝,不发 IPC)。 */
export const MAX_EDITED_HTML_BYTES = 2 * 1024 * 1024

/** 文本编辑保存 debounce。 */
export const EDIT_SAVE_DEBOUNCE_MS = 500

// 校验一条选区条目;非法返回 null,文本超限截断(不整条丢弃)。
function parseSelectionItem(raw: unknown): SlideBridgeSelectionItem | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const rect = item.rect as Record<string, unknown> | undefined
  if (typeof item.elementId !== 'string' || !item.elementId) return null
  if (typeof item.tagName !== 'string') return null
  if (
    !rect ||
    typeof rect.x !== 'number' ||
    typeof rect.y !== 'number' ||
    typeof rect.w !== 'number' ||
    typeof rect.h !== 'number'
  ) {
    return null
  }
  const text = typeof item.text === 'string' ? item.text.slice(0, SELECTION_TEXT_MAX) : ''
  return {
    elementId: item.elementId,
    tagName: item.tagName,
    rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    text
  }
}

/**
 * 校验并归一化一条来自 slide 页面的消息。任何不合协议的输入(缺标记、未知 type、
 * 字段类型错、HTML 超限)一律返回 null —— 调用方据此静默丢弃。
 */
export function parseSlideBridgeMessage(raw: unknown): SlideBridgeInboundMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const msg = raw as Record<string, unknown>
  if (msg.__cortexSlides !== SLIDE_BRIDGE_PROTOCOL) return null
  switch (msg.type) {
    case 'ready':
      return { __cortexSlides: 1, type: 'ready' }
    case 'selection-changed': {
      if (!Array.isArray(msg.items)) return null
      const items: SlideBridgeSelectionItem[] = []
      for (const raw of msg.items.slice(0, SELECTION_ITEMS_MAX)) {
        const item = parseSelectionItem(raw)
        // 单条非法只丢该条,不整包丢弃(空数组本身就是「取消选择」的合法语义)。
        if (item) items.push(item)
      }
      return { __cortexSlides: 1, type: 'selection-changed', items }
    }
    case 'html-changed': {
      if (typeof msg.html !== 'string' || !msg.html) return null
      // 超大 HTML 直接丢弃:恶意/异常页面不得撑爆 IPC 与磁盘。
      if (msg.html.length > MAX_EDITED_HTML_BYTES) return null
      return { __cortexSlides: 1, type: 'html-changed', html: msg.html }
    }
    case 'history-changed':
      return { __cortexSlides: 1, type: 'history-changed', canUndo: msg.canUndo === true, canRedo: msg.canRedo === true }
    default:
      return null
  }
}

/** 把宿主命令编译成页内可执行的表达式(经 webview.executeJavaScript 下发)。 */
export function compileSlideBridgeCommand(command: SlideBridgeCommand): string {
  return `window.__cortexSlidesBridge && window.__cortexSlidesBridge.exec(${JSON.stringify(command)})`
}

/** 校验并归一化一次 drain 的结果:逐条过协议校验,不合法项静默丢弃。 */
export function parseSlideBridgeDrain(raw: unknown): SlideBridgeInboundMessage[] {
  if (!Array.isArray(raw)) return []
  const messages: SlideBridgeInboundMessage[] = []
  for (const item of raw) {
    const parsed = parseSlideBridgeMessage(item)
    if (parsed) messages.push(parsed)
  }
  return messages
}
