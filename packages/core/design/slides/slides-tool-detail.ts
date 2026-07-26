/**
 * cortex-slides 工具芯片的一行详情(纯函数)。
 *
 * 为什么优先读工具**输出**而不是入参:页码与 revision 都由主进程算好后随结果回传
 * (见 capabilities/slides/tools.ts 的 replacedPages / slideCount / nextExpectedRevision)。
 * 渲染端拿不到文档全文,靠入参只能数出「几页」,数不出「第几页」。
 * 输出还没到(工具仍在 running)时退回入参给个粗粒度,芯片不至于空着。
 */

/** 与 slides-deck-activity 的页码折叠保持同一手法(连续段折叠、乱序去重)。 */
function formatPages(pages: unknown): string {
  if (!Array.isArray(pages)) return ''
  const sorted = [...new Set(pages.filter((p): p is number => Number.isInteger(p) && (p as number) > 0))].sort(
    (a, b) => a - b
  )
  if (!sorted.length) return ''
  const segments: string[] = []
  let start = sorted[0]!
  let prev = start
  for (const page of sorted.slice(1)) {
    if (page === prev + 1) {
      prev = page
      continue
    }
    segments.push(start === prev ? `${start}` : `${start}–${prev}`)
    start = page
    prev = page
  }
  segments.push(start === prev ? `${start}` : `${start}–${prev}`)
  return `第${segments.join('、')}页`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown)
    } catch {
      return null
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 数数组长度;provider 可能把嵌套数组整体字符串化,故也接受 JSON 文本。 */
function countArray(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? parsed.length : 0
    } catch {
      return 0
    }
  }
  return 0
}

function revisionSuffix(output: Record<string, unknown> | null): string {
  return typeof output?.revision === 'number' ? `rev ${output.revision}` : ''
}

function joinParts(...parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => !!p).join(' · ')
}

export function formatSlidesToolDetail(tool: string, input?: unknown, output?: unknown): string {
  const inp = asRecord(input)
  const out = asRecord(output)
  // 失败结果优先显示错误码:比「第3页」有用得多(用户要先知道这次没写进去)。
  if (out && out.ok === false && typeof out.code === 'string') return out.code

  switch (tool) {
    case 'set_slides': {
      const pages = formatPages(out?.replacedPages)
      if (pages) return joinParts(pages, revisionSuffix(out))
      if (out) return revisionSuffix(out)
      const count = countArray(inp?.slides)
      return count ? `${count} 页` : ''
    }
    case 'set_deck_doc': {
      if (typeof out?.slideCount === 'number' && out.slideCount > 0) {
        return joinParts(`全篇 ${out.slideCount} 页`, revisionSuffix(out))
      }
      return out ? revisionSuffix(out) : ''
    }
    case 'get_deck_state': {
      const stage = typeof out?.stage === 'string' ? out.stage : ''
      return joinParts(revisionSuffix(out), stage)
    }
    case 'propose_outline': {
      const count = countArray(inp?.items)
      const version = typeof inp?.version === 'number' ? `v${inp.version}` : ''
      return joinParts(count ? `提纲 ${count} 条` : '', version)
    }
    case 'add_asset': {
      if (typeof out?.asset === 'string') return out.asset
      return typeof inp?.file_name === 'string' ? inp.file_name : ''
    }
    case 'add_source': {
      return typeof inp?.title === 'string' ? inp.title : ''
    }
    case 'list_sources': {
      const count = countArray(out?.sources)
      return count ? `${count} 条来源` : ''
    }
    default:
      // 非 slides 工具交回调用方既有的兜底逻辑(file_path / command / server·tool 等)。
      return ''
  }
}
