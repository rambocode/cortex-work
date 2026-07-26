/**
 * 写盘前把旧文档的评论线程合并回新文档(纯函数)。
 *
 * 为什么需要:`Slide.comments` 是用户的评审数据,随 deck.bento.html 持久化;而 set_deck_doc
 * 是**整份覆盖**,prompt 与工具描述都没提这个字段(它属于编辑器语义,不属于 AI 的创作范围)。
 * 只要模型没把 comments 原样抄回来,用户的评论就会在下一次改稿时静默消失。与其在 prompt 里
 * 加一句"请保留"赌模型自觉,不如在落盘路径上确定性地补回来。
 *
 * 语义:按 `Slide.id` 认领(id 是 required 稳定字符串,页序调换也不会串页)。新文档**显式**
 * 带了 comments 就以新的为准(含空数组 = 主动清空),给 AI 将来真的操作评论留出余地。
 * 页被删除则其评论一并消失;新增页不会被塞评论。
 *
 * 容错:任一侧形状不对就原样返回新文档 —— 这是保险丝而非守门人,拒绝非法文档是 schema 的职责,
 * 绝不能因为合并逻辑看不懂输入就挡住用户的写盘。
 */

function slidesOf(value: unknown): Array<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const slides = (value as Record<string, unknown>).slides
  return Array.isArray(slides) ? (slides as Array<Record<string, unknown>>) : null
}

function slideId(slide: unknown): string | null {
  if (typeof slide !== 'object' || slide === null) return null
  const id = (slide as Record<string, unknown>).id
  return typeof id === 'string' && id ? id : null
}

export function mergeSlideComments<T>(prevDoc: unknown, nextDoc: T): T {
  const prevSlides = slidesOf(prevDoc)
  const nextSlides = slidesOf(nextDoc)
  if (!prevSlides || !nextSlides) return nextDoc

  // 旧评论索引:只收数组形态,脏数据(字符串/对象)直接当作没有。
  const carried = new Map<string, unknown[]>()
  for (const slide of prevSlides) {
    const id = slideId(slide)
    if (!id) continue
    const comments = slide?.comments
    if (Array.isArray(comments) && comments.length) carried.set(id, comments)
  }
  if (!carried.size) return nextDoc

  let changed = false
  const merged = nextSlides.map((slide) => {
    const id = slideId(slide)
    // 'comments' in slide —— 用 in 而非取值判空,才能区分「AI 显式清空」与「AI 压根没提」。
    if (!id || !carried.has(id) || (slide && 'comments' in slide)) return slide
    changed = true
    return { ...slide, comments: carried.get(id) }
  })
  if (!changed) return nextDoc

  return { ...(nextDoc as Record<string, unknown>), slides: merged } as T
}
