// CORTEX-PATCH file — Electron 宿主桥。
// Cortex Desktop 的 webview 注入 window.cortexSlidesHost 后:
//   1. 每次文档变更 debounce 后把整份 .bento.html(serializeAuto,含加密态)推给宿主落盘,
//      取代浏览器端 File System Access 保存;
//   2. 每次选区/切页变化把当前页 + 元素选区快照推给宿主,右栏「演示助手」据此显示引用,
//      让用户说「修改当前页」或「把它换成折线图」时 agent 都能准确定位;
//   3. 读取宿主身份名,作为评论作者的默认值。
// 浏览器/非宿主环境下本模块完全无副作用。
import { serializeAuto } from '../save'
import type { Store } from '../store'
import type { SlideElement } from '../model'

/** 注入的宿主契约(与 views/design/slides/bento-stage-bridge.ts 的 shim 对齐)。 */
export interface CortexSlidesHost {
  save(html: string): Promise<unknown> | unknown
  /** 当前页 + 选区快照 JSON;无元素选区时 items 为空。宿主侧做校验与截断。 */
  selectionChanged?(payload: string | null): unknown
  /** 宿主当前身份名,给评论作者名兜底。 */
  authorName?: string
}

/** 变更到落盘的静默窗:编辑操作常成串出现(拖拽、连续打字),600ms 合并成一次写。 */
const SAVE_DEBOUNCE_MS = 600

export function cortexHost(): CortexSlidesHost | null {
  const host = (window as unknown as { cortexSlidesHost?: CortexSlidesHost }).cortexSlidesHost
  return host && typeof host.save === 'function' ? host : null
}

// --- 宿主热应用闸门 -----------------------------------------------------------
//
// 宿主把 AI 改稿的新文档热塞进 webview(见 apply-doc.ts)时,replaceDoc 会触发
// store 的 'doc' 事件。若不拦,这份**刚从磁盘读进来**的文档会立刻被原样回写一遍:
// 多一次 revision、多一次 deckChanged 广播、多一条版本快照,还会和主进程的乐观锁
// 打成回环。计数式而非布尔式,是为了容忍嵌套/重入(未来若有批量应用)。
let applyDepth = 0
/** 由 initCortexHostBridge 注册:清掉 debounce timer 与 pending 补写标记。 */
let cancelPendingSave: (() => void) | null = null

/** 进入热应用:此后到 endHostApply 之前的所有文档变更都不回写宿主。 */
export function beginHostApply(): void {
  applyDepth += 1
  // 这一次清理是**load-bearing** 的:热应用前可能还压着用户上一笔编辑的 debounce。
  // 让它落盘等于用旧稿盖掉刚拿到的 AI 新稿 —— 那笔编辑的找回途径是 ⌘Z(replaceDoc
  // 走 checkpoint)与版本历史,不是这条已经过期的写。
  cancelPendingSave?.()
}

/** 退出热应用。顺手再清一次,兜住应用过程中被派生监听器排上的写。 */
export function endHostApply(): void {
  if (applyDepth > 0) applyDepth -= 1
  if (applyDepth === 0) cancelPendingSave?.()
}

/**
 * 订阅 Store 的 doc 事件,把编辑产物持续回写宿主。
 * 串行化:上一次 save 未完成时只置 pending 标记,完成后若期间又有变更则立刻补一轮,
 * 保证磁盘最终状态与编辑器一致且不会并发写同一文件。
 */
export function initCortexHostBridge(store: Store): void {
  let timer = 0
  let saving = false
  let dirtyAgain = false

  const flush = async (): Promise<void> => {
    // host 惰性解析:宿主经 executeJavaScript 注入 cortexSlidesHost,时机可能晚于
    // bento boot(dom-ready 与模块解压竞速)——订阅常驻,flush 时才决定走不走宿主。
    const host = cortexHost()
    if (!host) return
    if (saving) {
      dirtyAgain = true
      return
    }
    saving = true
    try {
      const html = await serializeAuto(store.doc)
      await host.save(html)
    } catch (err) {
      // 落盘失败不打断编辑;下一次变更会再次尝试。
      console.warn('[cortex-host] save failed:', err)
    } finally {
      saving = false
      if (dirtyAgain) {
        dirtyAgain = false
        void flush()
      }
    }
  }

  cancelPendingSave = () => {
    clearTimeout(timer)
    timer = 0
    dirtyAgain = false
  }

  store.on('doc', () => {
    if (applyDepth > 0) return // 宿主热应用期间的变更来自磁盘,不需要也不能回写
    clearTimeout(timer)
    timer = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
  })

  // 页面卸载(webview 重载/关闭)前尽力冲刷未落盘的变更;异步写不保证完成,
  // 但 pagehide 时机比 beforeunload 更可靠,且宿主侧还有 AI 写盘兜底。
  window.addEventListener('pagehide', () => {
    if (timer) {
      clearTimeout(timer)
      void flush()
    }
  })

  initSelectionBridge(store)
}

/** 元素的人类可读短标签:文本取正文、图表取类型、媒体取形态,其余留空。
 *  只为让右栏 chip 与 prompt 里的引用「看得出是哪个」,不是元素内容的完整转写
 *  —— 真正的细节由 agent 自己调 get_deck_state 取。截断在宿主侧统一做。 */
function elementLabel(el: SlideElement): string | undefined {
  switch (el.type) {
    case 'text':
      // html 里可能有内联标签,剥成纯文本再交给宿主。
      return el.html?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || undefined
    case 'shape':
      return el.shape
    case 'media':
      return el.kind
    case 'table':
      return `${el.rows?.length ?? 0}×${el.columns?.length ?? 0}`
    default:
      return undefined
  }
}

/**
 * 把选区变化持续推给宿主。
 *
 * 同时订阅 'selection' 与 'current':切页会清空选区,但若只听 'selection',
 * 「切到别的页」这件事本身不会通知宿主,右栏引用就会停在上一页的元素上。
 * 选区是纯运行时态,推送不触发保存、不进 #bento-doc。
 */
function initSelectionBridge(store: Store): void {
  const push = (): void => {
    const host = cortexHost()
    if (!host?.selectionChanged) return
    const elements = store.selectedElements
    const slide = store.slide
    try {
      host.selectionChanged(
        JSON.stringify({
          slideIndex: store.currentIndex,
          slideId: slide.id,
          slideName: slide.name,
          items: elements.map((el) => ({
            id: el.id,
            type: el.type,
            x: Math.round(el.x),
            y: Math.round(el.y),
            w: Math.round(el.w),
            h: Math.round(el.h),
            label: elementLabel(el),
          })),
        }),
      )
    } catch {
      // 序列化失败(异常元素)不该拖垮编辑器:本轮放弃推送,下一次选区变化再试。
    }
  }
  // 宿主 shim 与 vendor boot 存在先后竞态：两边谁后就绪，谁负责触发一次首次握手。
  const hostWindow = window as unknown as { __cortexPushDeckContext?: () => void }
  hostWindow.__cortexPushDeckContext = push
  store.on('selection', push)
  store.on('current', push)
  push()
}
