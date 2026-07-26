// bento 编辑器 webview ↔ 宿主的注入式桥(webview 无 preload)。
// 页内合同:注入脚本挂 window.cortexSlidesHost,vendor 侧 src/cortex/host-bridge.ts 调用它——
//   save(html)          编辑变更 debounce 后推整份 HTML;宿主周期 drain 取走最新一份落盘。
//   selectionChanged(p) 选区/切页变化时推快照 JSON;宿主周期读取,喂给会话面板的引用 chip。
//   authorName          宿主身份,给评论作者名兜底(免去页内再问一次)。
// 注入幂等(重载后由 onWebviewReady 重注)。
//
// 两条通道的语义**刻意不同**:
//   - save 是「待处理事件」→ drain 取后即清,只保留最新一份(编辑器语义是整份覆盖,中间版本无意义)。
//   - selection 是「当前状态」→ 读取不清空,靠单调 seq 判断有无变化;若也做成取后即清,
//     轮询会把状态吃掉,面板上的引用 chip 就会自己闪没。

import type { SlidesSelectionSnapshot } from '@cortex-work/core/design/slides/slides-selection'
import { parseSlidesSelectionSnapshot } from '@cortex-work/core/design/slides/slides-selection'

/** 嵌入注入脚本的字面量转义。JSON.stringify 已覆盖引号/反斜杠/换行;
 *  U+2028/2029 在旧 JS 引擎里是非法的字符串内换行,一并转义以防注入脚本语法错误。 */
function jsLiteral(value: string): string {
  return JSON.stringify(value).replace(
    /[\u2028\u2029]/g,
    (ch) => (ch === '\u2028' ? '\\u2028' : '\\u2029')
  )
}

export type BentoHostShimOptions = {
  /** 宿主当前身份名;省略时页内自行询问作者名。 */
  authorName?: string
}

/**
 * 生成页内 shim 源码(供 webview.executeJavaScript 注入)。
 *
 * 幂等分支很关键:dom-ready 每次都会重注,若像早期实现那样「已存在就直接 return」,
 * authorName 会永远停在首次注入的值;而若无脑重建,又会把已暂存未 drain 的保存与选区状态冲掉。
 * 所以重注时只刷新 authorName,其余状态原样保留。
 */
export function buildBentoHostShimSource(options: BentoHostShimOptions = {}): string {
  const author = options.authorName ? jsLiteral(options.authorName) : 'undefined'
  return `(() => {
  const AUTHOR = ${author}
  // 在线协作硬开关(vendor 的 sync/offline.ts 读这个偏好):第三道闸。
  // 前两道在主进程(写盘剥离 collab)与 vendor(不建 SyncSession);这一道兜住「存量 deck
  // 已带 collab、且 runtime 尚未重建」的窗口期。partition 是 persist: 的,写一次跨重载生效,
  // 所以从第二次 boot 起连 boot 期的 tryJoin 也被挡在门外。
  // 走 window.localStorage 而不是裸 localStorage:页内两者等价,但显式写 window 才能在
  // 「假 window + new Function」的单测桩上被观测到(见 bento-stage-bridge.test.ts 的 runner)。
  try { window.localStorage.setItem('bento-offline', 'on') } catch {}
  if (window.__cortexDrainDeckSave && window.cortexSlidesHost) {
    if (AUTHOR !== undefined) window.cortexSlidesHost.authorName = AUTHOR
    return true
  }
  let pendingSave = null
  let selectionPayload = null
  let selectionSeq = 0
  const host = {
    save: (html) => { pendingSave = String(html); return true },
    selectionChanged: (payload) => {
      selectionPayload = payload === null || payload === undefined ? null : String(payload)
      selectionSeq += 1
      return true
    }
  }
  if (AUTHOR !== undefined) host.authorName = AUTHOR
  window.cortexSlidesHost = host
  window.__cortexDrainDeckSave = () => { const v = pendingSave; pendingSave = null; return v }
  window.__cortexReadDeckSelection = (lastSeq) => {
    if (!selectionSeq || selectionSeq === lastSeq) return null
    return { seq: selectionSeq, payload: selectionPayload }
  }
  return true
})()`
}

/** drain 表达式:有待存 HTML 返回字符串,否则 null。 */
export const DRAIN_BENTO_SAVE_SOURCE = 'window.__cortexDrainDeckSave ? window.__cortexDrainDeckSave() : null'

/**
 * 热应用表达式:把新的文档 JSON 就地换进编辑器(不重载 webview)。
 * 页内实现在 vendor/bento/src/cortex/apply-doc.ts;未注入(旧壳/尚未 boot)时返回 null,
 * 宿主据此回落整页重载 —— 这条回落路径必须保留,否则换壳期间 AI 的改动会看不见。
 */
export function APPLY_BENTO_DOC_SOURCE(json: string, revision: number): string {
  const rev = Number.isFinite(revision) ? Math.floor(revision) : 0
  return `window.__cortexApplyDeckDoc ? window.__cortexApplyDeckDoc(${jsLiteral(json)}, ${rev}) : null`
}

/** 热应用结果归一化:只有页内明确返回 true 才算成功(null/undefined/异常都算失败 → 回落重载)。 */
export function parseBentoApplyResult(raw: unknown): boolean {
  return raw === true
}

/** 选区读取表达式:seq 与宿主已知的一致(或从未推送过)时返回 null,避免每轮搬运整份快照。 */
export function READ_BENTO_SELECTION_SOURCE(lastSeq: number): string {
  const seq = Number.isFinite(lastSeq) ? Math.floor(lastSeq) : 0
  return `window.__cortexReadDeckSelection ? window.__cortexReadDeckSelection(${seq}) : null`
}

/** 宿主 drain 周期(ms):vendor 侧已有 600ms debounce,这里 1s 取走足够跟手。 */
export const BENTO_DRAIN_INTERVAL_MS = 1000

/** 选区轮询周期(ms):引用 chip 要跟手,且未变时表达式直接返回 null,代价可忽略。 */
export const BENTO_SELECTION_POLL_INTERVAL_MS = 300

/** drain 结果归一化:executeJavaScript 可能回 null/undefined/非串,只认非空字符串。 */
export function parseBentoSaveDrain(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

export type BentoSelectionRead = {
  seq: number
  /** 归一化后的选区;页内清空选区时为 null(与「未变化」区分开)。 */
  selection: SlidesSelectionSnapshot | null
}

/**
 * 选区读取结果归一化。返回 null 表示「无变化」——调用方据此原样保留现有选区,
 * 而 `{ seq, selection: null }` 表示「确实变成了空选区」,要清掉面板上的引用。
 */
export function parseBentoSelectionRead(raw: unknown): BentoSelectionRead | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const seq = typeof record.seq === 'number' && Number.isFinite(record.seq) ? record.seq : null
  if (seq === null) return null
  return { seq, selection: parseSlidesSelectionSnapshot(record.payload) }
}
