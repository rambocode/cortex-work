// 回归(用户实测,取证结论):deck 文件里带着 bento 自动铸造的在线协作凭据
// (collab.on=true + 指向公共中继的 room + collab.sync 的 CRDT 状态)。
// 每次打开编辑器都会全量重放房间历史并做**元素级并集**合并 —— 于是 AI 改过的页面上
// 新旧内容重叠;而且 deck 内容还会被推给第三方中继。宿主写盘时一律剥离。
import { describe, expect, it } from 'vitest'
import { STRIPPED_DECK_DOC_KEYS, sanitizeDeckDoc } from './sanitize-deck-doc'

const docWithCollab = (): Record<string, unknown> => ({
  format: 'bento/slides',
  version: 1,
  docId: 'doc-1',
  title: 'deck',
  theme: { background: '#fff', accent: '#3b82d8' },
  assets: { 'hero.png': 'data:image/png;base64,AAA' },
  collab: {
    room: 'wss://sync.bento.page/d/wXXXX',
    key: 'k',
    on: true,
    role: 'writer',
    sync: { v: 2, lamport: 98, vv: { a: 63 }, regs: {}, pos: {} }
  },
  slides: [{ id: 's1', elements: [{ id: 'e1', type: 'text', html: 'hi' }], notes: '' }],
  somethingUpstreamAddedLater: { keep: true }
})

describe('sanitizeDeckDoc', () => {
  it('剥离 collab(含嵌套的 collab.sync)', () => {
    const { doc, stripped } = sanitizeDeckDoc(docWithCollab())
    expect(stripped).toEqual(['collab'])
    expect('collab' in doc).toBe(false)
    expect(JSON.stringify(doc)).not.toContain('sync.bento.page')
  })

  // 白名单式:只删 collab。bentoDocSchema 是 passthrough,上游随时会加新字段,
  // 「删掉我不认识的字段」会静默丢掉用户的内容。
  it('除 collab 外逐字段深度相等(含键序)', () => {
    const before = docWithCollab()
    const expected = { ...before }
    delete (expected as { collab?: unknown }).collab
    const { doc } = sanitizeDeckDoc(before)
    expect(JSON.stringify(doc)).toBe(JSON.stringify(expected))
  })

  it('未命中任何 key 时返回同一个对象引用(调用方据此跳过一次无意义写盘)', () => {
    const clean = { format: 'bento/slides', slides: [] }
    const { doc, stripped } = sanitizeDeckDoc(clean)
    expect(doc).toBe(clean)
    expect(stripped).toEqual([])
  })

  it('不改动入参(纯函数)', () => {
    const before = docWithCollab()
    sanitizeDeckDoc(before)
    expect((before as { collab?: unknown }).collab).toBeTruthy()
  })

  it('null / 数组 / 字符串 / 数字输入原样返回且不抛异常', () => {
    for (const input of [null, undefined, [1, 2], 'text', 42]) {
      const { doc, stripped } = sanitizeDeckDoc(input as unknown)
      expect(doc).toBe(input)
      expect(stripped).toEqual([])
    }
  })

  it('剥离清单只有 collab 一项(改动它等于改动产品行为,须显式)', () => {
    expect([...STRIPPED_DECK_DOC_KEYS]).toEqual(['collab'])
  })
})
