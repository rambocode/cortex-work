// slides 回合 prompt 合同测试(bento 化):合同为整份 BentoDoc 读写、
// 提纲 gate 表述一致、静态前缀在前(prompt 缓存)、无旧 slot 体系残留。
// prompt 文案统一英文(用户要求);用户原话按原语言透传。
import { describe, expect, it } from 'vitest'
import { buildSlidesTurnPrompt } from './slides-prompt'

describe('buildSlidesTurnPrompt(bento 合同)', () => {
  it('总是给出 bento 文档合同:格式/工具/乐观锁/画布', () => {
    const p = buildSlidesTurnPrompt({ text: '做个季度汇报' })
    expect(p).toContain('bento/slides')
    expect(p).toContain('get_deck_state')
    expect(p).toContain('set_deck_doc')
    expect(p).toContain('expected_revision')
    expect(p).toContain('1280')
    expect(p).toContain('720')
    expect(p).toContain('ECharts')
    expect(p).toContain('morph')
    expect(p).toContain('stateOf')
    expect(p).toContain('add_asset')
  })

  it('不含旧 slot 体系的任何指令(place_slide_html/模板/动画工具/检查)', () => {
    const p = buildSlidesTurnPrompt({ text: 'x', stage: 'ready' })
    for (const legacy of [
      'place_slide_html',
      'replace_slide_text',
      'apply_template',
      'set_deck_animation_style',
      'set_slide_animation',
      'check_slide',
      'data-cortex-id',
      'data-cortex-chart-spec'
    ]) {
      expect(p).not.toContain(legacy)
    }
  })

  it('prompt 文案为英文(不含中文指令文案;用户原话除外)', () => {
    const p = buildSlidesTurnPrompt({ text: 'quarterly review' })
    expect(/[一-鿿]/.test(p)).toBe(false)
  })

  it('draft:先主题+提纲,明确禁止批准前生成全篇', () => {
    const p = buildSlidesTurnPrompt({ text: 'x', stage: 'draft' })
    expect(p).toContain('propose_outline')
    expect(p).toContain('approval')
  })

  it('outline-approved:一次 set_deck_doc 产出完整文档', () => {
    const p = buildSlidesTurnPrompt({ text: 'x', stage: 'outline-approved' })
    expect(p).toContain('ONE set_deck_doc')
    expect(p).toContain('COMPLETE')
  })

  it('ready:整份读改写,未提及内容保持原样', () => {
    const p = buildSlidesTurnPrompt({ text: 'x', stage: 'ready' })
    expect(p).toContain('only')
    expect(p).toContain('full document')
  })

  it('用户原话固定在末尾(静态前缀在前,命中 prompt 缓存)', () => {
    const p = buildSlidesTurnPrompt({ text: '原话在此', stage: 'ready' })
    expect(p.endsWith('User request:\n原话在此')).toBe(true)
    // 两次构造的静态前缀逐字节一致。
    const q = buildSlidesTurnPrompt({ text: '换一句', stage: 'ready' })
    expect(p.slice(0, p.indexOf('User request:'))).toBe(q.slice(0, q.indexOf('User request:')))
  })
})
