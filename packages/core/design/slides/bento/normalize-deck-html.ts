/**
 * 编辑器回写的 deck HTML 落盘前的「换壳规范化」(纯函数)。
 *
 * 为什么存在(用户实测 + 磁盘取证):一份 deck 从 488KB 涨到 1,583,043 字节,里面有 11 个
 * `<style>`、其中 10 个是**完全相同**的 92,449 字节应用 CSS。根因在上游 `save.ts` 的
 * `capturePristine()` —— 它是 `document.cloneNode(true)`,而压缩 runtime 的 loader 在执行
 * main.ts **之前**就把应用 CSS 注入了 `<head>`。于是每一个「发生过保存的世代」都会把这份 CSS
 * 再烙进文件一次,一路逼近 `fs:readFile` 的 2MB 截断线;越线后渲染端预览会彻底不挂载。
 *
 * 为什么「只取 doc 块、重注当前壳」是无损的(逐行核对过上游):编辑器的 `serializeBody` 只改
 * `#bento-doc` 与 `<title>`,壳里没有任何值得保留的运行期状态 —— `injectFonts` 创建的
 * `#bento-fonts` 是在 `capturePristine()` **之后**才插入的,本就不在 pristine 快照里。
 *
 * 边界(每一条都对应一个单测):
 *   · 加密 deck(块里是 `bento/enc` 信封)与任何解析不出对象的块 → **passthrough**,原样保存。
 *     既无法 sanitize 也不该在这里猜结构;宁可不省这几百 KB,也绝不写坏用户的文件。
 *   · 没剥掉任何字段时**用原始 JSON 文本原样重注**,不走 `JSON.stringify` —— 否则缩进/空白被
 *     抹平,每次保存都 churn 出一份无意义的全文件 diff,也让「幂等」不成立。
 *   · runtime 壳自身缺 `#bento-doc` 块 → `bad_shell`,由调用方决定回落原样写入(壳损坏不该
 *     拦住用户保存)。
 *
 * revision 语义:换壳**不改文档内容**,不该 bump revision;只有 `stripped` 非空时才动了内容。
 */

import { extractBentoDocJson, injectBentoDocJson } from './bento-embed'
import { sanitizeDeckDoc } from './sanitize-deck-doc'

export type NormalizeDeckHtmlResult =
  | {
      ok: true
      html: string
      /** `passthrough` 时 `html` 就是传入的那一份(引用相同),调用方无需特殊处理。 */
      mode: 'reshelled' | 'passthrough'
      /** 被 `sanitizeDeckDoc` 剥掉的字段;非空即意味着**文档内容变了**,调用方须 bump revision。 */
      stripped: string[]
    }
  | { ok: false; code: 'no_doc_block' | 'bad_shell'; message: string }

function passthrough(html: string): NormalizeDeckHtmlResult {
  return { ok: true, html, mode: 'passthrough', stripped: [] }
}

export function normalizeDeckHtml(incomingHtml: string, runtimeHtml: string): NormalizeDeckHtmlResult {
  const json = extractBentoDocJson(incomingHtml)
  if (!json) {
    return { ok: false, code: 'no_doc_block', message: '待保存的 HTML 里没有 #bento-doc 块' }
  }

  // 解析只为了「能不能安全地 sanitize / 拿到 title」,解析不出来一律 passthrough 而非报错:
  // 块内容也可能是被截断的、或未来某种我们还不认识的载荷。
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return passthrough(incomingHtml)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return passthrough(incomingHtml)

  const record = parsed as Record<string, unknown>
  if (record.format === 'bento/enc') return passthrough(incomingHtml)

  const { doc, stripped } = sanitizeDeckDoc(record)
  // 未剥离时复用原始文本:extract 已经是转义后的形态,再次注入时 escapeDocJson 是空操作,
  // 因此产物的 doc 块与传入逐字节一致(这正是幂等的来源)。
  const body = stripped.length ? JSON.stringify(doc) : json
  const html = injectBentoDocJson(runtimeHtml, body, doc.title)
  if (html === null) {
    return { ok: false, code: 'bad_shell', message: '当前 runtime 壳里没有 #bento-doc 块' }
  }
  return { ok: true, html, mode: 'reshelled', stripped }
}
