// 提纲 schema 测试:合法通过、重复 item id 拒绝、可选字段容缺。
import { describe, expect, it } from 'vitest'
import { slidesOutlineSchema } from './slides-schema'

const valid = {
  version: 1,
  summary: '三页演示',
  items: [
    { id: 'o1', title: '开场', purpose: 'hook', keyPoints: ['a'] },
    { id: 'o2', title: '收尾', purpose: 'cta', keyPoints: [] }
  ]
}

describe('slidesOutlineSchema', () => {
  it('合法提纲通过;audience/goal/approvedAt 可缺省', () => {
    expect(slidesOutlineSchema.safeParse(valid).success).toBe(true)
    expect(
      slidesOutlineSchema.safeParse({ ...valid, audience: '高管', goal: '拿预算', approvedAt: '2026-07-24T00:00:00Z' })
        .success
    ).toBe(true)
  })

  it('重复 item id → 拒绝', () => {
    const dup = { ...valid, items: [...valid.items, { id: 'o1', title: 'x', purpose: 'y', keyPoints: [] }] }
    const res = slidesOutlineSchema.safeParse(dup)
    expect(res.success).toBe(false)
    if (!res.success) expect(res.error.issues[0]?.message).toContain('duplicate outline item id')
  })

  it('缺 version/空标题 → 拒绝', () => {
    expect(slidesOutlineSchema.safeParse({ ...valid, version: undefined }).success).toBe(false)
    expect(
      slidesOutlineSchema.safeParse({ ...valid, items: [{ id: 'o1', title: '', purpose: '', keyPoints: [] }] }).success
    ).toBe(false)
  })
})
