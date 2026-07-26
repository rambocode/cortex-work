import { describe, expect, it } from 'vitest'
import {
  formatSlidesDeckActivity,
  matchesSlidesDeckChange,
  slidesDeckActivityBlockId
} from './slides-deck-activity'
import type { SlidesDeckChangedEvent } from '../../desktop/slides-ipc-types'

const base: SlidesDeckChangedEvent = {
  workspaceRoot: '/Users/me/Documents/cortex/design',
  deckId: 'deckabc1',
  revision: 72,
  source: 'agent',
  slideIds: ['slide-3'],
  pages: [3],
  slideCount: 13,
  at: '2026-07-26T00:00:00.000Z'
}

const ev = (over: Partial<SlidesDeckChangedEvent> = {}): SlidesDeckChangedEvent => ({ ...base, ...over })

describe('matchesSlidesDeckChange', () => {
  const target = { workspaceRoot: '/Users/me/Documents/cortex/design', deckId: 'deckabc1' }

  it('同 workspaceRoot + 同 deckId → 命中', () => {
    expect(matchesSlidesDeckChange(ev(), target)).toBe(true)
  })

  it('deckId 不同 → 不命中(绝不把 A 稿的事件用到 B 稿上)', () => {
    expect(matchesSlidesDeckChange(ev({ deckId: 'other123' }), target)).toBe(false)
  })

  it('尾部斜杠差异被归一化', () => {
    expect(matchesSlidesDeckChange(ev({ workspaceRoot: '/Users/me/Documents/cortex/design/' }), target)).toBe(true)
  })

  // 主进程会对 workspaceRoot 做 realpath(/var → /private/var 之类),渲染端拿的是原始路径。
  // 宁可靠后缀多匹配一次(代价只是多刷一次),也不要因为前缀不同而漏掉真实变更。
  it('一方是另一方的路径后缀(realpath 前缀差异)→ 命中', () => {
    expect(
      matchesSlidesDeckChange(ev({ workspaceRoot: '/private/Users/me/Documents/cortex/design' }), target)
    ).toBe(true)
  })

  it('完全无关的路径 → 不命中', () => {
    expect(matchesSlidesDeckChange(ev({ workspaceRoot: '/tmp/elsewhere' }), target)).toBe(false)
  })

  it('空 deckId / 空 workspaceRoot → 不命中(未就绪的舞台不该接事件)', () => {
    expect(matchesSlidesDeckChange(ev(), { workspaceRoot: '', deckId: 'deckabc1' })).toBe(false)
    expect(matchesSlidesDeckChange(ev(), { workspaceRoot: target.workspaceRoot, deckId: '' })).toBe(false)
  })
})

describe('slidesDeckActivityBlockId', () => {
  it('同 deck 同 revision → 同一个 id(重复广播只留一条时间线条目)', () => {
    expect(slidesDeckActivityBlockId(ev())).toBe(slidesDeckActivityBlockId(ev()))
  })

  it('revision 不同 → id 不同', () => {
    expect(slidesDeckActivityBlockId(ev())).not.toBe(slidesDeckActivityBlockId(ev({ revision: 73 })))
  })

  it('deck 不同 → id 不同', () => {
    expect(slidesDeckActivityBlockId(ev())).not.toBe(slidesDeckActivityBlockId(ev({ deckId: 'other123' })))
  })
})

describe('formatSlidesDeckActivity', () => {
  it('单页改写', () => {
    expect(formatSlidesDeckActivity(ev())).toBe('已更新 第3页 · rev 72')
  })

  it('多页不连续 → 逐个列出', () => {
    expect(formatSlidesDeckActivity(ev({ slideIds: ['a', 'b'], pages: [3, 7] }))).toBe('已更新 第3、7页 · rev 72')
  })

  it('连续页码折叠成区间', () => {
    expect(formatSlidesDeckActivity(ev({ pages: [1, 2, 3, 4] }))).toBe('已更新 第1–4页 · rev 72')
  })

  it('连续与离散混排', () => {
    expect(formatSlidesDeckActivity(ev({ pages: [1, 2, 3, 7, 9, 10] }))).toBe('已更新 第1–3、7、9–10页 · rev 72')
  })

  it('页码段过多时折尾,避免撑破一行', () => {
    expect(formatSlidesDeckActivity(ev({ pages: [1, 3, 5, 7, 9, 11, 13] }))).toBe(
      '已更新 第1、3、5、7、9页等 7 页 · rev 72'
    )
  })

  it('pages 为空(整份写入)→ 报全篇页数', () => {
    expect(formatSlidesDeckActivity(ev({ slideIds: [], pages: [] }))).toBe('已重写全篇 13 页 · rev 72')
  })

  it('整份写入但页数未知 → 不报页数', () => {
    expect(formatSlidesDeckActivity(ev({ slideIds: [], pages: [], slideCount: 0 }))).toBe('已重写演示文稿 · rev 72')
  })

  // 编辑器自己的 autosave 不该刷时间线:那是用户自己的操作,写一条「已更新」只会造成噪音。
  it("source 非 agent → null", () => {
    expect(formatSlidesDeckActivity(ev({ source: 'editor' }))).toBeNull()
    expect(formatSlidesDeckActivity(ev({ source: 'runtime' }))).toBeNull()
  })

  it('页码乱序/重复时先排序去重', () => {
    expect(formatSlidesDeckActivity(ev({ pages: [7, 3, 3] }))).toBe('已更新 第3、7页 · rev 72')
  })
})
