// 回归:改一页不该要求重写整份文档。
// 实测卡死场景:12 页 deck 的整份 JSON 约 124,000 字符(~5.6 万 token),用户只想改
// slide 3 的一条 lineStyle 颜色,set_deck_doc 却要求模型把整份重新吐出来 —— 慢到看起来
// 像卡死,而且极易撞上模型最大输出上限被截断,写入永远落不了盘。
import { describe, expect, it } from 'vitest'
import { applySlideReplacements } from './slide-patch'

const slide = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  background: '#000',
  transition: 'fade',
  elements: [],
  notes: '',
  ...extra
})

const doc = (ids: string[]): Record<string, unknown> => ({
  format: 'bento/slides',
  version: 1,
  docId: 'doc-1',
  title: 'deck',
  size: { width: 1280, height: 720 },
  slides: ids.map((id) => slide(id))
})

describe('applySlideReplacements', () => {
  it('按 id 整页替换,其余页原样保留、顺序不变', () => {
    const res = applySlideReplacements(doc(['s1', 's2', 's3']), [
      slide('s2', { notes: '改过了', elements: [{ id: 'e1' }] })
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const slides = res.doc.slides as Array<Record<string, unknown>>
    expect(slides.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    expect(slides[1]?.notes).toBe('改过了')
    expect(slides[0]).toEqual(slide('s1'))
    expect(res.replacedIds).toEqual(['s2'])
  })

  it('一次可替换多页', () => {
    const res = applySlideReplacements(doc(['s1', 's2', 's3']), [
      slide('s3', { notes: 'C' }),
      slide('s1', { notes: 'A' })
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const slides = res.doc.slides as Array<Record<string, unknown>>
    expect(slides.map((s) => s.notes)).toEqual(['A', '', 'C'])
    expect(res.replacedIds.sort()).toEqual(['s1', 's3'])
  })

  // replacedPages 给「会话里看得见改了第几页」用:AI 只知道 slide id,用户只认页码。
  // 在主进程算好,渲染端就不必再拿整份文档反查。
  it('replacedPages 与 replacedIds 顺序对齐,页码 1 基', () => {
    const res = applySlideReplacements(doc(['s1', 's2', 's3']), [
      slide('s3', { notes: 'C' }),
      slide('s1', { notes: 'A' })
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.replacedIds).toEqual(['s3', 's1'])
    expect(res.replacedPages).toEqual([3, 1])
  })

  it('replacedPages 覆盖首尾页', () => {
    const res = applySlideReplacements(doc(['s1', 's2', 's3']), [slide('s1'), slide('s3')])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.replacedPages).toEqual([1, 3])
  })

  it('文档顶层字段(theme/size/title)完全不受影响', () => {
    const before = { ...doc(['s1']), theme: { background: '#111' } }
    const res = applySlideReplacements(before, [slide('s1', { notes: 'x' })])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.doc.theme).toEqual({ background: '#111' })
    expect(res.doc.title).toBe('deck')
    expect(res.doc.size).toEqual({ width: 1280, height: 720 })
  })

  // 关键守门:替换语义不能被拿来偷偷加页 —— 那会绕过提纲批准 gate。
  it('id 不存在 → unknown_slide_id,并列出缺失 id 供 agent 自纠', () => {
    const res = applySlideReplacements(doc(['s1', 's2']), [slide('s9')])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('unknown_slide_id')
    expect(res.message).toContain('s9')
  })

  it('同一 id 重复出现 → invalid_slides(语义有歧义,不猜)', () => {
    const res = applySlideReplacements(doc(['s1']), [slide('s1', { notes: 'A' }), slide('s1', { notes: 'B' })])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('invalid_slides')
  })

  it('缺 id / 非对象的页 → invalid_slides', () => {
    for (const bad of [[{ notes: 'no id' }], [null], ['nope'], [{ id: '' }]]) {
      const res = applySlideReplacements(doc(['s1']), bad)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('invalid_slides')
    }
  })

  it('空数组 / 非数组 → invalid_slides', () => {
    for (const bad of [[], null, 'x', {}]) {
      const res = applySlideReplacements(doc(['s1']), bad)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('invalid_slides')
    }
  })

  it('当前文档形状不对 → invalid_doc', () => {
    for (const bad of [null, 'x', {}, { slides: 'nope' }]) {
      const res = applySlideReplacements(bad, [slide('s1')])
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('invalid_doc')
    }
  })

  it('不改动入参(纯函数)', () => {
    const before = doc(['s1', 's2'])
    const snapshot = JSON.stringify(before)
    applySlideReplacements(before, [slide('s1', { notes: '改' })])
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('体量对比:替换单页的载荷远小于整份文档', () => {
    const big = doc(Array.from({ length: 12 }, (_, i) => `s${i + 1}`))
    const whole = JSON.stringify(big).length
    const one = JSON.stringify([slide('s3', { notes: 'x' })]).length
    expect(one * 5).toBeLessThan(whole)
  })
})
