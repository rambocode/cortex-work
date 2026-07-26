/**
 * 按 slide id 做整页替换(纯函数)—— set_deck_doc 之外的「局部写入」基元。
 *
 * 为什么需要:BentoDoc 是整份读写的,而一份 12 页、含图表/表格的 deck,其 JSON 约 124,000
 * 字符(~5.6 万 token)。用户只想改一条折线的颜色时,set_deck_doc 却要求模型把整份重新
 * 吐出来:慢到看起来像卡死,而且极易撞上模型的最大输出上限被截断,写入永远落不了盘
 * (用户实测:agent 说完「我来修复」后就停在「正在生成演示文稿…」)。
 * 单页载荷通常只有整份的 1/25 左右,局部改动因此才可行。
 *
 * 语义刻意收窄为**替换已存在的页**:
 *   - 不能新增页 —— 否则就绕过了「提纲批准后才能出全篇」的 gate;
 *   - 不能删除/重排页 —— 那属于结构性改动,仍走 set_deck_doc,免得局部工具悄悄改变叙事顺序;
 *   - 替换是整页覆盖而非字段合并 —— 合并语义在嵌套 elements 上会产生大量歧义
 *     (数组按下标还是按 id?删除怎么表达?),不如让模型给出完整的一页。
 */

export type SlidePatchResult =
  | { ok: true; doc: Record<string, unknown>; replacedIds: string[] }
  | { ok: false; code: 'invalid_doc' | 'invalid_slides' | 'unknown_slide_id'; message: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function idOf(value: unknown): string | null {
  const record = asRecord(value)
  if (!record) return null
  return typeof record.id === 'string' && record.id ? record.id : null
}

function fail(
  code: 'invalid_doc' | 'invalid_slides' | 'unknown_slide_id',
  message: string
): SlidePatchResult {
  return { ok: false, code, message }
}

export function applySlideReplacements(doc: unknown, slides: unknown): SlidePatchResult {
  // 报错文案面向 Agent(与 prompt 合同同为英文),且每条都说明「下一步该怎么改」,
  // 让模型能自纠而不是重试同样的错。
  const docRecord = asRecord(doc)
  const current = docRecord?.slides
  if (!docRecord || !Array.isArray(current)) {
    return fail('invalid_doc', 'The current deck document is unreadable or has no slides array.')
  }
  if (!Array.isArray(slides) || !slides.length) {
    return fail('invalid_slides', 'slides must be a non-empty array; each item is one COMPLETE BentoDoc slide object.')
  }

  const byId = new Map<string, Record<string, unknown>>()
  for (const slide of slides) {
    const id = idOf(slide)
    if (!id) {
      return fail('invalid_slides', 'Every item must be an object with a non-empty "id" — the id selects which slide to replace.')
    }
    if (byId.has(id)) {
      return fail('invalid_slides', `Duplicate slide id "${id}" in slides — ambiguous which version to apply.`)
    }
    byId.set(id, slide as Record<string, unknown>)
  }

  // 未知 id 一律拒绝:替换工具不负责新增页,静默追加会绕过提纲批准 gate。
  const existing = new Set(current.map((slide) => idOf(slide)).filter((id): id is string => !!id))
  const missing = [...byId.keys()].filter((id) => !existing.has(id))
  if (missing.length) {
    return fail(
      'unknown_slide_id',
      `No such slide id in this deck: ${missing.join(', ')}. ` +
        'Call get_deck_state for the real ids. To add, delete or reorder slides use set_deck_doc instead.'
    )
  }

  const nextSlides = current.map((slide) => {
    const id = idOf(slide)
    return id && byId.has(id) ? byId.get(id)! : slide
  })
  return { ok: true, doc: { ...docRecord, slides: nextSlides }, replacedIds: [...byId.keys()] }
}
