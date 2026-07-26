// 回归:用户的评论线程绝不能被 AI 的整份改稿静默抹掉。
// set_deck_doc 是全量覆盖,而 prompt 与工具描述都没提 comments 字段 —— 只能在写盘前
// 确定性地按 slide id 合并回来,不依赖模型自觉。
import { describe, expect, it } from 'vitest'
import { mergeSlideComments } from './merge-comments'

const comment = (id: string): Record<string, unknown> => ({
  id,
  author: '我',
  text: `第 ${id} 条`,
  at: '2026-07-26T00:00:00.000Z'
})

const slide = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  background: '#000',
  transition: 'fade',
  elements: [],
  notes: '',
  ...extra
})

const doc = (slides: Array<Record<string, unknown>>): Record<string, unknown> => ({
  format: 'bento/slides',
  version: 1,
  docId: 'doc-1',
  title: 'deck',
  size: { width: 1280, height: 720 },
  slides
})

describe('mergeSlideComments', () => {
  it('新 doc 丢了 comments 时按 slide id 恢复', () => {
    const prev = doc([slide('s1', { comments: [comment('c1')] }), slide('s2')])
    const next = doc([slide('s1', { elements: [{ id: 'e1' }] }), slide('s2')])

    const merged = mergeSlideComments(prev, next) as ReturnType<typeof doc>
    const slides = merged.slides as Array<Record<string, unknown>>
    expect(slides[0]?.comments).toEqual([comment('c1')])
    // AI 的实际改动必须原样保留
    expect(slides[0]?.elements).toEqual([{ id: 'e1' }])
    expect(slides[1]).not.toHaveProperty('comments')
  })

  it('页序调换后仍按 id 认领,不会串页', () => {
    const prev = doc([slide('s1', { comments: [comment('c1')] }), slide('s2', { comments: [comment('c2')] })])
    const next = doc([slide('s2'), slide('s1')])

    const slides = (mergeSlideComments(prev, next) as ReturnType<typeof doc>).slides as Array<
      Record<string, unknown>
    >
    expect(slides[0]?.id).toBe('s2')
    expect(slides[0]?.comments).toEqual([comment('c2')])
    expect(slides[1]?.comments).toEqual([comment('c1')])
  })

  it('新 doc 显式带 comments 时以新的为准(留出 AI 将来真的操作评论的余地)', () => {
    const prev = doc([slide('s1', { comments: [comment('c1')] })])
    const next = doc([slide('s1', { comments: [comment('c9')] })])

    const slides = (mergeSlideComments(prev, next) as ReturnType<typeof doc>).slides as Array<
      Record<string, unknown>
    >
    expect(slides[0]?.comments).toEqual([comment('c9')])
  })

  it('新 doc 显式给空数组 = 主动清空,不复活旧评论', () => {
    const prev = doc([slide('s1', { comments: [comment('c1')] })])
    const next = doc([slide('s1', { comments: [] })])

    const slides = (mergeSlideComments(prev, next) as ReturnType<typeof doc>).slides as Array<
      Record<string, unknown>
    >
    expect(slides[0]?.comments).toEqual([])
  })

  it('slide 被删除时其评论一并消失(不凭空造回该页)', () => {
    const prev = doc([slide('s1', { comments: [comment('c1')] }), slide('s2', { comments: [comment('c2')] })])
    const next = doc([slide('s2')])

    const slides = (mergeSlideComments(prev, next) as ReturnType<typeof doc>).slides as Array<
      Record<string, unknown>
    >
    expect(slides).toHaveLength(1)
    expect(slides[0]?.id).toBe('s2')
    expect(slides[0]?.comments).toEqual([comment('c2')])
  })

  it('新增页不会被塞进评论', () => {
    const prev = doc([slide('s1', { comments: [comment('c1')] })])
    const next = doc([slide('s1'), slide('s-new')])

    const slides = (mergeSlideComments(prev, next) as ReturnType<typeof doc>).slides as Array<
      Record<string, unknown>
    >
    expect(slides[1]).not.toHaveProperty('comments')
  })

  it('不改动入参(纯函数)', () => {
    const prev = doc([slide('s1', { comments: [comment('c1')] })])
    const next = doc([slide('s1')])
    const nextSnapshot = JSON.stringify(next)

    mergeSlideComments(prev, next)
    expect(JSON.stringify(next)).toBe(nextSnapshot)
  })

  it('旧 doc 缺失/形状不对时原样返回新 doc,绝不因此挡住写盘', () => {
    const next = doc([slide('s1')])
    for (const prev of [null, undefined, 'garbage', 42, {}, { slides: 'nope' }]) {
      expect(mergeSlideComments(prev, next)).toBe(next)
    }
  })

  it('新 doc 形状不对时原样返回,交给后续 schema 校验去拒绝', () => {
    const prev = doc([slide('s1', { comments: [comment('c1')] })])
    for (const next of [null, 'garbage', { slides: 'nope' }]) {
      expect(mergeSlideComments(prev, next)).toBe(next)
    }
  })

  it('旧评论不是数组时忽略,不把脏数据写回磁盘', () => {
    const prev = doc([slide('s1', { comments: 'oops' })])
    const next = doc([slide('s1')])

    const slides = (mergeSlideComments(prev, next) as ReturnType<typeof doc>).slides as Array<
      Record<string, unknown>
    >
    expect(slides[0]).not.toHaveProperty('comments')
  })

  it('无评论可搬时返回原对象引用,避免无谓的深拷贝', () => {
    const prev = doc([slide('s1')])
    const next = doc([slide('s1')])
    expect(mergeSlideComments(prev, next)).toBe(next)
  })
})
