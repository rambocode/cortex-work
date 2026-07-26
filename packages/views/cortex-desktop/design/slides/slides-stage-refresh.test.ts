import { describe, expect, it } from 'vitest'
import { mergeDeferredRevision, slidesPageRevisionAlignment, slidesRefreshDecision } from './slides-stage-refresh'

describe('slidesRefreshDecision', () => {
  // 自写回声:编辑器落盘后主进程也会广播 deckChanged,而 webview 内存文档已经是那一版。
  it('ignores echoes of the revision the page already holds', () => {
    expect(slidesRefreshDecision({ eventRevision: 71, pageRevision: 72, busy: false })).toBe('ignore')
    expect(slidesRefreshDecision({ eventRevision: 71, pageRevision: 72, busy: true })).toBe('ignore')
    expect(slidesRefreshDecision({ eventRevision: 72, pageRevision: 72, busy: false })).toBe('ignore')
    expect(slidesRefreshDecision({ eventRevision: 72, pageRevision: 72, busy: true })).toBe('ignore')
  })

  // busy 优先于 refresh:刷新/热应用进行中再插一次会打断上一轮(drain 泵也被互斥)。
  it('defers newer revisions while a refresh or hot apply is in flight', () => {
    expect(slidesRefreshDecision({ eventRevision: 73, pageRevision: 72, busy: true })).toBe('defer')
  })

  it('refreshes when a newer revision lands and nothing is in flight', () => {
    expect(slidesRefreshDecision({ eventRevision: 73, pageRevision: 72, busy: false })).toBe('refresh')
    // R_page 初始哨兵 0:首个磁盘 revision 一律视为更新。
    expect(slidesRefreshDecision({ eventRevision: 1, pageRevision: 0, busy: false })).toBe('refresh')
  })
})

describe('mergeDeferredRevision', () => {
  it('collapses a burst of deferred events into the newest revision', () => {
    expect(mergeDeferredRevision(null, 73)).toBe(73)
    expect(mergeDeferredRevision(73, 75)).toBe(75)
    // 乱序到达时不能把已排队的新版本降级成旧版本。
    expect(mergeDeferredRevision(75, 73)).toBe(75)
    expect(mergeDeferredRevision(75, 75)).toBe(75)
  })
})

// 回归(实现时踩过):R_page 若跟着 store 的 2s 轮询走,会在 webview 尚未应用新内容时
// 先「追平」磁盘,紧随其后的 deckChanged 就被当成自写回声丢弃 —— 画布反而永远不刷新。
describe('slidesPageRevisionAlignment', () => {
  it('首帧读回真实 revision → 对齐并标记完成', () => {
    expect(slidesPageRevisionAlignment({ deckId: 'd1', alignedDeckId: '', storeRevision: 72 })).toEqual({
      pageRevision: 72,
      markAligned: true
    })
  })

  it('revision 还是 0(setup 刚归零)→ 归零继续等,不标记完成', () => {
    expect(slidesPageRevisionAlignment({ deckId: 'd1', alignedDeckId: '', storeRevision: 0 })).toEqual({
      pageRevision: 0,
      markAligned: false
    })
  })

  it('已对齐过 → 一律不动 R_page(轮询刷新不得追平磁盘)', () => {
    expect(slidesPageRevisionAlignment({ deckId: 'd1', alignedDeckId: 'd1', storeRevision: 99 })).toBeNull()
  })

  it('切到另一份 deck → 重新对齐', () => {
    expect(slidesPageRevisionAlignment({ deckId: 'd2', alignedDeckId: 'd1', storeRevision: 5 })).toEqual({
      pageRevision: 5,
      markAligned: true
    })
  })
})
