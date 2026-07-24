// CORTEX-PATCH file — Electron 宿主保存桥。
// Cortex Desktop 的 webview 经 preload 注入 window.cortexSlidesHost 后,编辑器的
// 每次文档变更都在 debounce 后把整份 .bento.html(serializeAuto,含加密态)推给宿主
// 落盘,取代浏览器端 File System Access 保存;浏览器/非宿主环境下本模块完全无副作用。
import { serializeAuto } from '../save'
import type { Store } from '../store'

/** preload 注入的宿主保存契约(与 apps/desktop preload 的 cortexSlidesHost 对齐)。 */
export interface CortexSlidesHost {
  save(html: string): Promise<unknown> | unknown
}

/** 变更到落盘的静默窗:编辑操作常成串出现(拖拽、连续打字),600ms 合并成一次写。 */
const SAVE_DEBOUNCE_MS = 600

export function cortexHost(): CortexSlidesHost | null {
  const host = (window as unknown as { cortexSlidesHost?: CortexSlidesHost }).cortexSlidesHost
  return host && typeof host.save === 'function' ? host : null
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

  store.on('doc', () => {
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
}
