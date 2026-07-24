// #bento-doc 块的提取/注入纯函数 —— Cortex 与 bento 单文件格式之间唯一的字符串合同。
// 对齐上游 bento save.ts 的 serializeBody:
//   · 文档 JSON 存在 <script type="application/bento+json" id="bento-doc"> 内,明文;
//   · 注入时把 JSON 文本里的每个 `<` 替换为 `<`(JSON 字符串转义,JSON.parse 原样还原),
//     从而正文不可能出现 `</script>` 破坏宿主 HTML;
//   · 空块(全新空壳)表示「无文档」,bento boot 时回落 starter deck。
// 主进程持久层与单测共用;不触碰 DOM,可在任意环境运行。

const BLOCK_RE = /(<script\b[^>]*\bid="bento-doc"[^>]*>)([\s\S]*?)(<\/script>)/
const META_TAG_RE = /<meta\b[^>]*>/gi
const RUNTIME_META_NAME = 'cortex-slides-runtime'

/** 从 .bento.html 提取内嵌文档 JSON 文本;无块或空块返回 null。 */
export function extractBentoDocJson(html: string): string | null {
  const m = BLOCK_RE.exec(html)
  const text = m?.[2]?.trim()
  return text ? text : null
}

/** 读取构建时写入壳的内容标识；用于判断存量 deck 是否需要换成当前 runtime。 */
export function extractBentoRuntimeId(html: string): string | null {
  for (const tag of html.match(META_TAG_RE) ?? []) {
    const attrs = new Map<string, string>()
    for (const match of tag.matchAll(/\b([a-zA-Z][\w:-]*)\s*=\s*(["'])(.*?)\2/g)) {
      attrs.set(match[1]!.toLowerCase(), match[3]!)
    }
    if (attrs.get('name')?.toLowerCase() !== RUNTIME_META_NAME) continue
    return attrs.get('content')?.trim() || null
  }
  return null
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
 * 把原始文档 JSON 注入壳的 #bento-doc 块(覆盖旧内容),保留排版并同步 <title>。
 * 壳内无块时返回 null —— 损坏的壳绝不静默产出坏文件,由调用方决定报错方式。
 */
export function injectBentoDocJson(shellHtml: string, json: string, title?: unknown): string | null {
  if (!BLOCK_RE.test(shellHtml)) return null
  const body = escapeDocJson(json)
  let html = shellHtml.replace(BLOCK_RE, (_all, open: string, _old: string, close: string) => `${open}\n${body}\n${close}`)
  const documentTitle = typeof title === 'string' && title ? title : null
  if (documentTitle) {
    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtmlText(documentTitle)}</title>`)
  }
  return html
}

/** 把文档对象序列化后注入壳。 */
export function injectBentoDoc(shellHtml: string, doc: { title?: unknown }): string | null {
  return injectBentoDocJson(shellHtml, JSON.stringify(doc), doc.title)
}
