// 回归(用户实测):演示文稿改稿一屏只看到一个「MCP」芯片。
// 根因之一是 adapter 不给 toolCallId 时,block id 退化成 `${runId}:${name}` ——
// 同一回合里十几次同名调用全部撞成同一个 block,patchBlock 又会一起改到。
import { describe, expect, it } from 'vitest'
import { createToolBlockIdTracker } from './tool-block-ids'

describe('createToolBlockIdTracker', () => {
  it('adapter 给了 toolCallId 就原样用(端到端稳定配对)', () => {
    const t = createToolBlockIdTracker()
    expect(t.start('run1', 'Read', 'call_1')).toBe('call_1')
    expect(t.end('run1', 'Read', 'call_1')).toBe('call_1')
  })

  it('无 toolCallId 时同名连续三次 start 得到三个不同 id', () => {
    const t = createToolBlockIdTracker()
    const ids = [t.start('run1', 'MCP'), t.start('run1', 'MCP'), t.start('run1', 'MCP')]
    expect(new Set(ids).size).toBe(3)
  })

  it('无 toolCallId 时 end 按 FIFO 与 start 配对', () => {
    const t = createToolBlockIdTracker()
    const first = t.start('run1', 'MCP')
    const second = t.start('run1', 'MCP')
    expect(t.end('run1', 'MCP')).toBe(first)
    expect(t.end('run1', 'MCP')).toBe(second)
  })

  it('不同工具名互不串号', () => {
    const t = createToolBlockIdTracker()
    const mcp = t.start('run1', 'MCP')
    const read = t.start('run1', 'Read')
    expect(t.end('run1', 'Read')).toBe(read)
    expect(t.end('run1', 'MCP')).toBe(mcp)
  })

  it('跨 runId 互不干扰(两个设计回合可能并行)', () => {
    const t = createToolBlockIdTracker()
    const a = t.start('run1', 'MCP')
    const b = t.start('run2', 'MCP')
    expect(a).not.toBe(b)
    expect(t.end('run2', 'MCP')).toBe(b)
    expect(t.end('run1', 'MCP')).toBe(a)
  })

  // 只发完成帧的 adapter:end 找不到配对的 start 时也必须给出一个稳定 id,
  // 否则该次调用在时间线上彻底不显示(patchBlock 对不存在的 id 静默忽略)。
  it('没有配对 start 的 end 也返回稳定 id(同一次调用重复 end 得同一个)', () => {
    const t = createToolBlockIdTracker()
    const first = t.end('run1', 'MCP')
    expect(first).toBeTruthy()
    expect(t.end('run1', 'MCP')).not.toBe(first)
  })

  it('clearRun 后同 runId 重新从头计数,且不影响别的 run', () => {
    const t = createToolBlockIdTracker()
    const a = t.start('run1', 'MCP')
    const other = t.start('run2', 'MCP')
    t.clearRun('run1')
    // 队列已清:此时的 end 不该拿到 clearRun 之前那个 id。
    expect(t.end('run1', 'MCP')).not.toBe(a)
    expect(t.end('run2', 'MCP')).toBe(other)
  })

  it('id 里带上 runId 与工具名,便于排查(不做严格格式契约)', () => {
    const t = createToolBlockIdTracker()
    expect(t.start('slides:deck1:r_x', 'mcp__cortex-slides__set_slides')).toContain('set_slides')
  })
})
