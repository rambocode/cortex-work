// bento 编辑器 webview ↔ 宿主的保存桥(注入式,webview 无 preload)。
// 页内合同:注入脚本挂 window.cortexSlidesHost.save(html)(vendor/bento 的 host-bridge
// 在编辑变更 debounce 后调用它),把整份 HTML 暂存页内;宿主周期性 drain 取走最新一份
// 经 DesktopBridge 落盘。只保留「最新」一份 —— 编辑器语义是整份覆盖,中间版本无意义。
// 注入幂等(重载后由 onWebviewReady 重注)。

/** 页内 shim:cortexSlidesHost.save 暂存 + __cortexDrainDeckSave 取走(取后即清)。 */
export const BENTO_HOST_SHIM_SOURCE = `(() => {
  if (window.__cortexDrainDeckSave) return true
  let pending = null
  window.cortexSlidesHost = { save: (html) => { pending = String(html); return true } }
  window.__cortexDrainDeckSave = () => { const v = pending; pending = null; return v }
  return true
})()`

/** drain 表达式:有待存 HTML 返回字符串,否则 null。 */
export const DRAIN_BENTO_SAVE_SOURCE = 'window.__cortexDrainDeckSave ? window.__cortexDrainDeckSave() : null'

/** 宿主 drain 周期(ms):vendor 侧已有 600ms debounce,这里 1s 取走足够跟手。 */
export const BENTO_DRAIN_INTERVAL_MS = 1000

/** drain 结果归一化:executeJavaScript 可能回 null/undefined/非串,只认非空字符串。 */
export function parseBentoSaveDrain(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}
