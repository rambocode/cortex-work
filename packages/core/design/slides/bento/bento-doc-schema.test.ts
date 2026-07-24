// bento-doc-schema 的单测:结构性校验(宽松 passthrough,细节由 bento 运行时兜底)。
import { describe, expect, it } from 'vitest'
import { buildStarterBentoDoc, parseBentoDoc } from './bento-doc-schema'

const valid = {
  format: 'bento/slides',
  version: 1,
  title: 'Demo',
  size: { width: 1280, height: 720 },
  theme: { background: '#0b0d12', color: '#f5f7fa', accent: '#3b82d8', fontFamily: 'sans-serif' },
  slides: [
    {
      id: 's1',
      background: '#0b0d12',
      transition: 'fade',
      elements: [
        { id: 't1', type: 'text', x: 96, y: 96, w: 600, h: 120, rotation: 0, opacity: 1, html: 'Hello', fontSize: 48, fontFamily: 'sans-serif', fontWeight: 700, color: '#fff', align: 'left', valign: 'top', lineHeight: 1.2 },
        { id: 'c1', type: 'chart', x: 96, y: 300, w: 500, h: 300, rotation: 0, opacity: 1, option: { series: [{ type: 'bar', data: [1, 2] }] } },
      ],
      notes: '开场',
    },
  ],
}

describe('parseBentoDoc', () => {
  it('合法文档通过并保留未知字段(passthrough,兼容上游 schema 演进)', () => {
    const input = { ...valid, futureField: { x: 1 }, slides: [{ ...valid.slides[0], stateOf: undefined }] }
    const res = parseBentoDoc(input)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect((res.doc as Record<string, unknown>).futureField).toEqual({ x: 1 })
      expect(res.doc.slides[0]?.elements).toHaveLength(2)
    }
  })

  it('format 不对 → 拒绝', () => {
    const res = parseBentoDoc({ ...valid, format: 'bento/docs' })
    expect(res.ok).toBe(false)
  })

  it('slides 为空数组 → 拒绝(bento parseDoc 同样要求非空)', () => {
    expect(parseBentoDoc({ ...valid, slides: [] }).ok).toBe(false)
  })

  it('元素坐标非数值 → 拒绝并在错误信息里给出路径', () => {
    const bad = structuredClone(valid) as Record<string, any>
    bad.slides[0].elements[0].x = 'left'
    const res = parseBentoDoc(bad)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('slides[0]')
  })

  it('未知元素类型 → 拒绝(AI 拼错字段静默失败是 bento 红线,这里前置拦截)', () => {
    const bad = structuredClone(valid) as Record<string, any>
    bad.slides[0].elements.push({ id: 'x', type: 'video-embed', x: 0, y: 0, w: 1, h: 1 })
    expect(parseBentoDoc(bad).ok).toBe(false)
  })

  it('slide 缺 notes 时默认为空串(AI 常省略)', () => {
    const loose = structuredClone(valid) as Record<string, any>
    delete loose.slides[0].notes
    const res = parseBentoDoc(loose)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.doc.slides[0]?.notes).toBe('')
  })

  it('非对象输入 → 拒绝且不抛异常', () => {
    expect(parseBentoDoc('{}').ok).toBe(false)
    expect(parseBentoDoc(null).ok).toBe(false)
  })
})

describe('buildStarterBentoDoc', () => {
  it('产出可通过 parseBentoDoc 的单页起始文档,标题透传', () => {
    const doc = buildStarterBentoDoc('我的演示')
    const res = parseBentoDoc(doc)
    expect(res.ok).toBe(true)
    expect(doc.title).toBe('我的演示')
    expect(doc.slides).toHaveLength(1)
    expect(doc.size).toEqual({ width: 1280, height: 720 })
  })
})
