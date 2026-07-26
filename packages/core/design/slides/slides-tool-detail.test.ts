import { describe, expect, it } from 'vitest'
import { formatSlidesToolDetail } from './slides-tool-detail'

const json = (v: unknown): string => JSON.stringify(v)

describe('formatSlidesToolDetail', () => {
  it('set_slides 完成:按页码 + revision', () => {
    const out = formatSlidesToolDetail(
      'set_slides',
      { expected_revision: 71, slides: [{ id: 's3' }, { id: 's7' }] },
      json({ ok: true, revision: 72, replacedPages: [3, 7] })
    )
    expect(out).toBe('第3、7页 · rev 72')
  })

  it('set_slides 进行中(只有入参)→ 给个粗粒度页数', () => {
    expect(formatSlidesToolDetail('set_slides', { slides: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] })).toBe('3 页')
  })

  // 有些 provider 会把深层嵌套参数整体字符串化,入参侧也要能数出页数。
  it('set_slides 入参被字符串化时同样能数页数', () => {
    expect(formatSlidesToolDetail('set_slides', { slides: json([{ id: 's1' }, { id: 's2' }]) })).toBe('2 页')
  })

  it('set_slides 失败输出 → 显示错误码', () => {
    const out = formatSlidesToolDetail(
      'set_slides',
      { slides: [{ id: 's1' }] },
      json({ ok: false, code: 'revision_conflict', message: 'revision 冲突' })
    )
    expect(out).toBe('revision_conflict')
  })

  it('set_deck_doc 完成:全篇页数 + revision', () => {
    expect(
      formatSlidesToolDetail('set_deck_doc', { expected_revision: 0 }, json({ ok: true, revision: 1, slideCount: 13 }))
    ).toBe('全篇 13 页 · rev 1')
  })

  it('get_deck_state 完成:revision + stage', () => {
    expect(formatSlidesToolDetail('get_deck_state', {}, json({ ok: true, revision: 72, stage: 'ready' }))).toBe(
      'rev 72 · ready'
    )
  })

  it('propose_outline:提纲条数', () => {
    expect(formatSlidesToolDetail('propose_outline', { version: 2, items: [{}, {}, {}] })).toBe('提纲 3 条 · v2')
  })

  it('add_asset 完成:资产键', () => {
    expect(
      formatSlidesToolDetail('add_asset', { file_name: 'hero.png' }, json({ ok: true, asset: 'asset:hero.png' }))
    ).toBe('asset:hero.png')
  })

  it('add_source:来源标题', () => {
    expect(formatSlidesToolDetail('add_source', { url: 'https://a.com', title: '市场规模报告' })).toBe('市场规模报告')
  })

  it('list_sources 完成:条数', () => {
    expect(formatSlidesToolDetail('list_sources', {}, json({ ok: true, sources: [{}, {}] }))).toBe('2 条来源')
  })

  it('非 slides 工具 → 空串(交回既有兜底逻辑)', () => {
    expect(formatSlidesToolDetail('Read', { file_path: '/a.ts' })).toBe('')
  })

  it('坏 JSON / 非对象入参一律不抛异常', () => {
    expect(formatSlidesToolDetail('set_slides', undefined, '{oops')).toBe('')
    expect(formatSlidesToolDetail('set_slides', 'not json', undefined)).toBe('')
    expect(formatSlidesToolDetail('get_deck_state', null, null)).toBe('')
  })

  it('输出里 pages 为空但有 revision → 仍报 revision', () => {
    expect(formatSlidesToolDetail('set_slides', { slides: [] }, json({ ok: true, revision: 5, replacedPages: [] }))).toBe(
      'rev 5'
    )
  })
})
