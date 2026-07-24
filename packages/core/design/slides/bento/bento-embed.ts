// #bento-doc 块的提取/注入纯函数 —— Cortex 与 bento 单文件格式之间唯一的字符串合同。
// 对齐上游 bento save.ts 的 serializeBody:
//   · 文档 JSON 存在 <script type="application/bento+json" id="bento-doc"> 内,明文;
//   · 注入时把 JSON 文本里的每个 `<` 替换为 `<`(JSON 字符串转义,JSON.parse 原样还原),
//     从而正文不可能出现 `</script>` 破坏宿主 HTML;
//   · 空块(全新空壳)表示「无文档」,bento boot 时回落 starter deck。
// 主进程持久层与单测共用;不触碰 DOM,可在任意环境运行。

const BLOCK_RE = /(<script\b[^>]*\bid="bento-doc"[^>]*>)([\s\S]*?)(<\/script>)/

/** 从 .bento.html 提取内嵌文档 JSON 文本;无块或空块返回 null。 */
export function extractBentoDocJson(html: string): string | null {
  const m = BLOCK_RE.exec(html)
  const text = m?.[2]?.trim()
  return text ? text : null
}

/** `<` → `<`:与上游 serializeBody 相同的转义(JSON 内合法,parse 后还原)。 */
function escapeDocJson(json: string): string {
  return json.replace(/</g, '\\u003c')
}

/** HTML 文本转义(仅用于 <title> 内容)。 */
function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 把文档对象注入壳的 #bento-doc 块(覆盖旧内容),并同步 <title>。
 * 壳内无块时返回 null —— 损坏的壳绝不静默产出坏文件,由调用方决定报错方式。
 */
export function injectBentoDoc(shellHtml: string, doc: { title?: unknown }): string | null {
  if (!BLOCK_RE.test(shellHtml)) return null
  const body = escapeDocJson(JSON.stringify(doc))
  let html = shellHtml.replace(BLOCK_RE, (_all, open: string, _old: string, close: string) => `${open}\n${body}\n${close}`)
  const title = typeof doc.title === 'string' && doc.title ? doc.title : null
  if (title) {
    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtmlText(title)} — Bento Slides</title>`)
  }
  return html
}
