import { describe, expect, it } from 'vitest'
import {
  SLIDES_SELECTION_ITEMS_MAX,
  SLIDES_SELECTION_LABEL_MAX,
  formatSlidesSelectionForPrompt,
  parseSlidesSelectionSnapshot,
  slidesSelectionCount,
  slidesSelectionKey
} from './slides-selection'

const rawItem = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'el_7f2a',
  type: 'chart',
  x: 96,
  y: 120,
  w: 720,
  h: 520,
  ...over
})

describe('parseSlidesSelectionSnapshot', () => {
  it('接受 webview 传来的 JSON 字符串,归一化为快照', () => {
    const snapshot = parseSlidesSelectionSnapshot(
      JSON.stringify({ slideIndex: 2, slideId: 's3', slideName: 'LLM 发展简史', items: [rawItem()] })
    )
    expect(snapshot).toEqual({
      slideIndex: 2,
      slideId: 's3',
      slideName: 'LLM 发展简史',
      items: [{ id: 'el_7f2a', type: 'chart', x: 96, y: 120, w: 720, h: 520 }],
      totalCount: 1
    })
  })

  it('也接受已解析的对象(executeJavaScript 可能直接回对象)', () => {
    const snapshot = parseSlidesSelectionSnapshot({ slideIndex: 0, slideId: 's1', items: [rawItem()] })
    expect(snapshot?.items).toHaveLength(1)
    expect(snapshot?.slideName).toBeUndefined()
  })

  it('空选区归一化为 null —— 没选中就不该产出引用 chip', () => {
    expect(parseSlidesSelectionSnapshot({ slideIndex: 0, slideId: 's1', items: [] })).toBeNull()
  })

  it('非法输入一律返回 null,绝不把脏数据带进 prompt', () => {
    for (const raw of [null, undefined, '', 'not json', 42, {}, { items: [rawItem()] }, { slideId: 's1' }]) {
      expect(parseSlidesSelectionSnapshot(raw)).toBeNull()
    }
  })

  it('丢弃缺 id / 缺 type 的条目;全部无效则返回 null', () => {
    const snapshot = parseSlidesSelectionSnapshot({
      slideIndex: 0,
      slideId: 's1',
      items: [rawItem(), { type: 'text' }, rawItem({ id: 'el_b', type: '' })]
    })
    expect(snapshot?.items.map((item) => item.id)).toEqual(['el_7f2a'])
    expect(
      parseSlidesSelectionSnapshot({ slideIndex: 0, slideId: 's1', items: [{ type: 'text' }] })
    ).toBeNull()
  })

  it('缺失/非有限的几何值降级为省略,而不是塞 NaN 进 prompt', () => {
    const snapshot = parseSlidesSelectionSnapshot({
      slideIndex: 0,
      slideId: 's1',
      items: [{ id: 'el_a', type: 'text', x: 'oops', y: null, w: Number.NaN, h: Infinity }]
    })
    expect(snapshot?.items[0]).toEqual({ id: 'el_a', type: 'text' })
  })

  it(`条目数截断到 ${SLIDES_SELECTION_ITEMS_MAX} —— 全选整页时 prompt 不至于爆掉`, () => {
    const items = Array.from({ length: SLIDES_SELECTION_ITEMS_MAX + 10 }, (_, i) =>
      rawItem({ id: `el_${i}` })
    )
    const snapshot = parseSlidesSelectionSnapshot({ slideIndex: 0, slideId: 's1', items })
    expect(snapshot?.items).toHaveLength(SLIDES_SELECTION_ITEMS_MAX)
    expect(snapshot?.truncated).toBe(true)
    expect(snapshot?.totalCount).toBe(SLIDES_SELECTION_ITEMS_MAX + 10)
  })

  it('未截断时不带 truncated 标记', () => {
    const snapshot = parseSlidesSelectionSnapshot({ slideIndex: 0, slideId: 's1', items: [rawItem()] })
    expect(snapshot?.truncated).toBeUndefined()
    expect(snapshot?.totalCount).toBe(1)
  })

  it(`label 截断到 ${SLIDES_SELECTION_LABEL_MAX} 字符并压平换行`, () => {
    const snapshot = parseSlidesSelectionSnapshot({
      slideIndex: 0,
      slideId: 's1',
      items: [rawItem({ type: 'text', label: `  第一行\n第二行  ${'字'.repeat(200)}` })]
    })
    const label = snapshot?.items[0]?.label ?? ''
    expect(label.length).toBeLessThanOrEqual(SLIDES_SELECTION_LABEL_MAX + 1)
    expect(label).not.toContain('\n')
    expect(label.startsWith('第一行 第二行')).toBe(true)
    expect(label.endsWith('…')).toBe(true)
  })

  it('空白 label 直接省略', () => {
    const snapshot = parseSlidesSelectionSnapshot({
      slideIndex: 0,
      slideId: 's1',
      items: [rawItem({ label: '   ' })]
    })
    expect(snapshot?.items[0]?.label).toBeUndefined()
  })

  it('slideName 同样做修剪与截断', () => {
    const snapshot = parseSlidesSelectionSnapshot({
      slideIndex: 0,
      slideId: 's1',
      slideName: `  ${'页'.repeat(200)}  `,
      items: [rawItem()]
    })
    expect((snapshot?.slideName ?? '').length).toBeLessThanOrEqual(SLIDES_SELECTION_LABEL_MAX + 1)
  })
})

describe('slidesSelectionKey', () => {
  const snap = (slideId: string, ids: string[]): Parameters<typeof slidesSelectionKey>[0] => ({
    slideIndex: 0,
    slideId,
    items: ids.map((id) => ({ id, type: 'text' }))
  })

  it('同一份选区键稳定 —— 轮询重复回传不会让已清除的引用闪回来', () => {
    expect(slidesSelectionKey(snap('s1', ['a', 'b']))).toBe(slidesSelectionKey(snap('s1', ['a', 'b'])))
  })

  it('换页 / 加选 / 减选都会换键 —— 用户改了选区就该恢复显示', () => {
    const base = slidesSelectionKey(snap('s1', ['a', 'b']))
    expect(slidesSelectionKey(snap('s2', ['a', 'b']))).not.toBe(base)
    expect(slidesSelectionKey(snap('s1', ['a']))).not.toBe(base)
    expect(slidesSelectionKey(snap('s1', ['a', 'b', 'c']))).not.toBe(base)
  })

  it('空选区键为空串', () => {
    expect(slidesSelectionKey(null)).toBe('')
  })
})

describe('slidesSelectionCount', () => {
  it('优先用 totalCount,让 chip 显示用户真实选中数而非截断后的数', () => {
    expect(slidesSelectionCount(null)).toBe(0)
    expect(
      slidesSelectionCount({ slideIndex: 0, slideId: 's1', items: [], totalCount: 30 })
    ).toBe(30)
  })
})

describe('formatSlidesSelectionForPrompt', () => {
  const base = {
    slideIndex: 2,
    slideId: 's3',
    slideName: 'LLM 发展简史',
    totalCount: 1,
    items: [{ id: 'el_7f2a', type: 'chart', x: 96, y: 120, w: 720, h: 520 }]
  }

  it('用 1 起的页码与页名定位,并给出元素 id / 类型 / 几何', () => {
    const text = formatSlidesSelectionForPrompt(base)
    expect(text).toContain('slide 3')
    expect(text).toContain('LLM 发展简史')
    expect(text).toContain('- chart #el_7f2a')
    expect(text).toContain('(x:96 y:120 w:720 h:520)')
  })

  it('显式绑定指代词,让「把它换成折线图」能落到选中元素上', () => {
    const text = formatSlidesSelectionForPrompt(base)
    expect(text).toContain('get_deck_state')
    expect(text.toLowerCase()).toContain('unless')
    // 中英文指代词都要绑,用户会中英混着说
    for (const word of ['this', 'these', '这个', '这里', '选中']) {
      expect(text).toContain(word)
    }
  })

  it('轻量指针:不内联元素内容,只带短 label 提示', () => {
    const text = formatSlidesSelectionForPrompt({
      ...base,
      items: [{ id: 'el_a', type: 'text', label: '关键里程碑' }]
    })
    expect(text).toContain('- text #el_a')
    expect(text).toContain('关键里程碑')
  })

  it('缺页名时退化为只报页码,不产出空引号', () => {
    const text = formatSlidesSelectionForPrompt({ ...base, slideName: undefined })
    expect(text).toContain('slide 3')
    expect(text).not.toContain('「」')
  })

  it('截断时告知 agent 还有更多选中项(避免它以为只选了这些)', () => {
    const text = formatSlidesSelectionForPrompt({ ...base, truncated: true, totalCount: 40 })
    expect(text).toContain('40')
  })

  it('空选区产出空串,调用方据此不拼接该段', () => {
    expect(formatSlidesSelectionForPrompt(null)).toBe('')
    expect(formatSlidesSelectionForPrompt({ ...base, items: [] })).toBe('')
  })
})
