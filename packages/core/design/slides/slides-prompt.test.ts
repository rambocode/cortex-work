// slides 回合 prompt 合同测试:阶段指令正确、提纲 gate 表述一致、
// 静态前缀在前(prompt 缓存)、不含自由画布流水线的任何指令。
// prompt 文案统一英文(用户要求);用户原话按原语言透传。
import { describe, expect, it } from 'vitest'
import { buildSlidesTurnPrompt } from './slides-prompt'

describe('buildSlidesTurnPrompt', () => {
  it('总是给出 cortex-slides 合同与 1280×720 画布约束', () => {
    const p = buildSlidesTurnPrompt({ text: '做个季度汇报' })
    expect(p).toContain('cortex-slides')
    expect(p).toContain('get_deck_state')
    expect(p).toContain('1280×720')
    expect(p).toContain('data-cortex-id')
    expect(p).toContain('expected_revision')
    expect(p).toContain('data-cortex-chart-spec')
    expect(p).toContain('application/json')
    expect(p).toContain('create_pipeline_run')
    expect(p).toContain('delegate_slides_role')
    expect(p).toContain('wait for user approval')
  })

  it('prompt 文案为英文(不含中文指令文案;用户原话除外)', () => {
    const p = buildSlidesTurnPrompt({ text: 'quarterly review' })
    // 英文合同下不应再出现任何 CJK 字符(用户原话是英文时全文纯英文)。
    expect(/[一-鿿]/.test(p)).toBe(false)
  })

  it('draft:先定主题再提纲,明确禁止批准前写页面', () => {
    const p = buildSlidesTurnPrompt({ text: 'x', stage: 'draft' })
    expect(p).toContain('propose_outline')
    expect(p).toContain('list_templates')
    expect(p).toContain('do not call place_slide_html')
  })

  it('outline-proposed:等待确认,仍不许写页面', () => {
    const p = buildSlidesTurnPrompt({ text: 'x', stage: 'outline-proposed' })
    expect(p).toContain('awaiting user confirmation')
    expect(p).toContain('Do not call place_slide_html')
  })

  it('outline-approved:按 slot 顺序逐页生成', () => {
    const p = buildSlidesTurnPrompt({ text: 'x', stage: 'outline-approved' })
    expect(p).toContain('place_slide_html')
    expect(p).toContain('empty')
  })

  it('ready/error:只改相关页,不动已完成页面', () => {
    expect(buildSlidesTurnPrompt({ text: 'x', stage: 'ready' })).toContain('replace_slide_text')
    expect(buildSlidesTurnPrompt({ text: 'x', stage: 'error' })).toContain(
      'Do not touch slides that already succeeded'
    )
  })

  // 用户实测踩到的坑:slides 稿走了 design 的自由画布流水线,右栏依次跑出
  // 「起草设计规格与页面规划 / 生成设计系统与设计令牌 / 设计品牌 Logo / Design N pages in parallel」。
  // 这里断言的是**流水线的祈使指令**不得出现;合同里「不要生成…设计系统文档」这类禁令是正当的。
  it('绝不下达自由画布流水线的指令', () => {
    const PIPELINE_COMMANDS = [
      '起草设计规格',
      '生成设计系统与设计令牌',
      '设计品牌 Logo',
      'pages in parallel',
      'delegate_task'
    ]
    for (const stage of ['draft', 'outline-proposed', 'outline-approved', 'generating', 'ready', 'error'] as const) {
      const p = buildSlidesTurnPrompt({ text: 'x', stage })
      for (const cmd of PIPELINE_COMMANDS) expect(p, `${stage} 不应含「${cmd}」`).not.toContain(cmd)
    }
  })

  it('明确禁止绕过 cortex-slides 直接改 deck 目录或产出自由画布页面', () => {
    const p = buildSlidesTurnPrompt({ text: 'x' })
    expect(p).toContain('generic file tools (Write/Edit)')
    expect(p).toContain('never produce free-canvas pages')
  })

  it('已应用主题时提示沿用,不另起配色', () => {
    const p = buildSlidesTurnPrompt({ text: 'x', themeName: 'Quiet Axis' })
    expect(p).toContain('"Quiet Axis"')
    expect(p).toContain('do not invent a new one')
  })

  it('合同含声明式动画段:工具名、枚举与「不写入场 CSS」约束', () => {
    const p = buildSlidesTurnPrompt({ text: 'x' })
    expect(p).toContain('set_deck_animation_style')
    expect(p).toContain('set_slide_animation')
    expect(p).toContain('page-flip')
    expect(p).toContain('reveal-clip')
    expect(p).toContain('do NOT write entrance/transition CSS')
    // 动画段属于静态合同前缀,必须位于用户原话之前(prompt 缓存)。
    expect(p.indexOf('set_slide_animation')).toBeLessThan(p.indexOf('User request'))
  })

  it('用户原话在尾部且原样透传(静态前缀在前,便于命中 prompt 缓存)', () => {
    const p = buildSlidesTurnPrompt({ text: '我的独特要求' })
    expect(p.indexOf('cortex-slides')).toBeLessThan(p.indexOf('我的独特要求'))
    expect(p.trimEnd().endsWith('我的独特要求')).toBe(true)
  })

  // 舞台选区:用户点选元素后发话,prompt 需列出 id/标签/文本并限定改动范围。
  it('带选区时列出元素锚点并限定只调整所选', () => {
    const p = buildSlidesTurnPrompt({
      text: '标题换个说法',
      stage: 'ready',
      selection: {
        slotId: 'slot-003',
        slideIndex: 3,
        items: [
          { id: 'edit-1', tag: 'H2', text: '午后的意外惊喜' },
          { id: 'star-lg', tag: 'DIV' }
        ]
      }
    })
    expect(p).toContain('slide 3 (slot: slot-003)')
    expect(p).toContain('<h2 data-cortex-id="edit-1">: "午后的意外惊喜"')
    expect(p).toContain('<div data-cortex-id="star-lg"> (graphic/decorative element, no text)')
    expect(p).toContain('Adjust only these this turn')
    // 选区段在静态合同之后、用户原话之前(prompt 缓存前缀不受影响)。
    expect(p.indexOf('cortex-slides')).toBeLessThan(p.indexOf('slot-003'))
    expect(p.indexOf('slot-003')).toBeLessThan(p.indexOf('标题换个说法'))
  })

  it('空选区不产生选区段', () => {
    const p = buildSlidesTurnPrompt({ text: 'x', selection: { slotId: 'slot-001', items: [] } })
    expect(p).not.toContain('The user selected the following elements')
  })
})
