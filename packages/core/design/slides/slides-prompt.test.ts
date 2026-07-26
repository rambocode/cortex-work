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

  // 改版:ready 阶段改用 set_slides 局部写入。整份 12 页 deck 约 12 万字符(~5.6 万 token),
  // 为改一条折线颜色重发整份会慢到像卡死、且极易被截断导致写入永远落不了盘(用户实测)。
  it('ready:只回发被改的页,并明确禁止重发整份', () => {
    const p = buildSlidesTurnPrompt({ text: 'x', stage: 'ready' })
    expect(p).toContain('set_slides')
    expect(p).toContain('ONLY those slides')
    expect(p).toContain('Do NOT re-emit the whole deck')
  })

  // 分批是两个用户可感知问题的共同解:① 一次十几页极易撞上模型输出上限被截断,写入永远
  // 落不了盘;② 一次写完 = 会话里只有一个芯片、画布只在最后跳一次,过程完全不可见。
  it('ready:要求按 ≤3 页分批,并用返回的 nextExpectedRevision 续写下一批', () => {
    const p = buildSlidesTurnPrompt({ text: 'x', stage: 'ready' })
    expect(p).toContain('at most 3')
    expect(p).toContain('nextExpectedRevision')
  })

  it('合同段也写明分批规则(阶段指令之外的常驻约束)', () => {
    const p = buildSlidesTurnPrompt({ text: 'x', stage: 'draft' })
    expect(p).toContain('BATCH IT')
    expect(p).toContain('at most 3 slides per set_slides call')
  })

  it('合同里两条写入路径的分工写清楚了(局部改 vs 增删重排)', () => {
    const p = buildSlidesTurnPrompt({ text: 'x', stage: 'ready' })
    expect(p).toContain('EDIT an existing deck with set_slides')
    expect(p).toContain('add / delete / reorder slides')
    // 未触及的内容仍要逐字保留 —— 局部写入不能成为「顺手重写别处」的借口
    expect(p).toContain('verbatim')
  })

  it('用户原话固定在末尾(静态前缀在前,命中 prompt 缓存)', () => {
    const p = buildSlidesTurnPrompt({ text: '原话在此', stage: 'ready' })
    expect(p.endsWith('User request:\n原话在此')).toBe(true)
    // 两次构造的静态前缀逐字节一致。
    const q = buildSlidesTurnPrompt({ text: '换一句', stage: 'ready' })
    expect(p.slice(0, p.indexOf('User request:'))).toBe(q.slice(0, q.indexOf('User request:')))
  })
})

describe('buildSlidesTurnPrompt(选区引用)', () => {
  const selection = {
    slideIndex: 2,
    slideId: 's3',
    slideName: 'LLM 发展简史',
    totalCount: 1,
    items: [{ id: 'el_7f2a', type: 'chart', x: 96, y: 120, w: 720, h: 520 }]
  }

  it('带选区时把引用段拼在用户原话之前', () => {
    const p = buildSlidesTurnPrompt({ text: '把它换成折线图', stage: 'ready', selection })
    expect(p).toContain('#el_7f2a')
    expect(p.indexOf('#el_7f2a')).toBeLessThan(p.indexOf('User request:'))
    expect(p.endsWith('User request:\n把它换成折线图')).toBe(true)
  })

  it('不带选区/空选区时不留任何痕迹(与原输出逐字节一致)', () => {
    const base = buildSlidesTurnPrompt({ text: 'x', stage: 'ready' })
    expect(buildSlidesTurnPrompt({ text: 'x', stage: 'ready', selection: null })).toBe(base)
    expect(
      buildSlidesTurnPrompt({ text: 'x', stage: 'ready', selection: { ...selection, items: [] } })
    ).toBe(base)
  })

  it('缓存回归:选区只影响变量尾段,CONTRACT + 阶段指令的静态前缀逐字节不变', () => {
    const withSel = buildSlidesTurnPrompt({ text: 'x', stage: 'ready', selection })
    const without = buildSlidesTurnPrompt({ text: 'x', stage: 'ready' })
    const head = (p: string): string => p.slice(0, p.indexOf('The user has selected') >= 0
      ? p.indexOf('The user has selected')
      : p.indexOf('User request:'))
    expect(head(withSel)).toBe(head(without))
  })

  // 刻意的例外:整体 prompt 文案为英文,但指代词绑定必须同时列中文——
  // 用户会中英混说「把它换成折线图」,不列中文模型容易改错元素(board 侧同一处理)。
  it('指代词绑定段允许出现中文指代词', () => {
    const p = buildSlidesTurnPrompt({ text: 'x', stage: 'ready', selection })
    for (const word of ['this', '这个', '这里', '选中']) {
      expect(p).toContain(word)
    }
  })
})

describe('buildSlidesTurnPrompt(文本附件)', () => {
  it('无 files 与不传参数逐字节一致', () => {
    const base = buildSlidesTurnPrompt({ text: 'x', stage: 'ready' })
    expect(buildSlidesTurnPrompt({ text: 'x', stage: 'ready', files: [] })).toBe(base)
  })

  it('附件段排在选区之后、用户原话之前', () => {
    const selection = {
      slideIndex: 0,
      slideId: 's1',
      totalCount: 1,
      items: [{ id: 'title', type: 'text', x: 96, y: 80, w: 800, h: 100 }]
    }
    const p = buildSlidesTurnPrompt({
      text: '按资料修改',
      stage: 'ready',
      selection,
      files: [{ name: 'brief.md', content: 'Revenue grew 20%.' }]
    })
    expect(p.indexOf('The user has selected')).toBeLessThan(p.indexOf('Attached files'))
    expect(p.indexOf('Attached files')).toBeLessThan(p.indexOf('User request:'))
    expect(p).toContain('brief.md')
    expect(p).toContain('Revenue grew 20%.')
  })

  it('附件只影响变量尾段，静态前缀逐字节不变', () => {
    const withFiles = buildSlidesTurnPrompt({
      text: 'x',
      stage: 'ready',
      files: [{ name: 'brief.md', content: 'hello' }]
    })
    const without = buildSlidesTurnPrompt({ text: 'x', stage: 'ready' })
    expect(withFiles.slice(0, withFiles.indexOf('Attached files'))).toBe(
      without.slice(0, without.indexOf('User request:'))
    )
  })
})
