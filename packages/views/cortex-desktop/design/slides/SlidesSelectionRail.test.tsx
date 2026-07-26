// 回归:bento 编辑器内的选区必须在右栏可见(引用 chip),并在发送时进入 slides 回合 prompt。
// 迁移到 bento 后这条链路曾整体缺失(DesignWorkspace 里留有「不再经宿主注入上下文」的注释),
// 用户实测反馈「选中元素 agent 看不见」。
import { describe, expect, it } from 'vitest'
import { buildSlidesTurnPrompt } from '@cortex-work/core/design/slides/slides-prompt'
import {
  parseSlidesSelectionSnapshot,
  slidesSelectionCount,
  slidesSelectionKey
} from '@cortex-work/core/design/slides/slides-selection'
import { buildBentoHostShimSource, parseBentoSelectionRead } from './bento-stage-bridge'

/** 走完整条链路:页内 shim 推快照 → 宿主读取 → 归一化 → 进 prompt。 */
function pipeSelection(payload: unknown): ReturnType<typeof parseBentoSelectionRead> {
  const win: Record<string, unknown> = {}
  const run = (source: string): unknown => new Function('window', `return (${source})`)(win)
  run(buildBentoHostShimSource({ authorName: '我' }))
  ;(win.cortexSlidesHost as { selectionChanged: (p: unknown) => unknown }).selectionChanged(
    typeof payload === 'string' ? payload : JSON.stringify(payload)
  )
  return parseBentoSelectionRead(
    (win.__cortexReadDeckSelection as (seq: number) => unknown)(0)
  )
}

const payload = {
  slideIndex: 2,
  slideId: 's3',
  slideName: 'LLM 发展简史',
  items: [{ id: 'el_7f2a', type: 'chart', x: 96, y: 120, w: 720, h: 520 }]
}

describe('bento 选区 → 会话引用(端到端链路)', () => {
  it('页内推的选区能被宿主原样读出并归一化', () => {
    const read = pipeSelection(payload)
    expect(read?.page).toEqual({
      slideIndex: 2,
      slideId: 's3',
      slideName: 'LLM 发展简史'
    })
    expect(read?.selection?.slideId).toBe('s3')
    expect(read?.selection?.items[0]?.id).toBe('el_7f2a')
    expect(slidesSelectionCount(read?.selection ?? null)).toBe(1)
  })

  it('没有选中元素时仍保留当前页，元素选区保持 null', () => {
    const read = pipeSelection({ ...payload, items: [] })
    expect(read?.page?.slideId).toBe('s3')
    expect(read?.page?.slideIndex).toBe(2)
    expect(read?.selection).toBeNull()
  })

  it('选区进入 prompt,且用户原话仍固定在末尾', () => {
    const selection = pipeSelection(payload)?.selection ?? null
    const prompt = buildSlidesTurnPrompt({ text: '把它换成折线图', stage: 'ready', selection })
    expect(prompt).toContain('#el_7f2a')
    expect(prompt).toContain('LLM 发展简史')
    expect(prompt.endsWith('User request:\n把它换成折线图')).toBe(true)
  })

  it('页内清空选区 → 宿主读到 null(引用 chip 该消失)', () => {
    const win: Record<string, unknown> = {}
    const run = (source: string): unknown => new Function('window', `return (${source})`)(win)
    run(buildBentoHostShimSource({}))
    const host = win.cortexSlidesHost as { selectionChanged: (p: unknown) => unknown }
    host.selectionChanged(JSON.stringify(payload))
    const first = parseBentoSelectionRead((win.__cortexReadDeckSelection as (s: number) => unknown)(0))
    host.selectionChanged(null)
    const cleared = parseBentoSelectionRead(
      (win.__cortexReadDeckSelection as (s: number) => unknown)(first?.seq ?? 0)
    )
    expect(cleared).not.toBeNull()
    expect(cleared?.page).toBeNull()
    expect(cleared?.selection).toBeNull()
  })

  it('脏 payload 不会把垃圾带进 prompt', () => {
    expect(pipeSelection('not json')?.selection).toBeNull()
    expect(pipeSelection({ items: [] })?.selection).toBeNull()
  })
})

describe('「清除引用」的抑制语义', () => {
  it('清除后同一份选区不再注入,但选区本身没被动过', () => {
    const selection = parseSlidesSelectionSnapshot(payload)
    const dismissed = slidesSelectionKey(selection)
    // 容器的判定逻辑:键相同即视为已清除
    const active = slidesSelectionKey(selection) === dismissed ? null : selection
    expect(active).toBeNull()
    expect(buildSlidesTurnPrompt({ text: 'x', stage: 'ready', selection: active })).toBe(
      buildSlidesTurnPrompt({ text: 'x', stage: 'ready' })
    )
    expect(selection).not.toBeNull()
  })

  it('用户改选区后引用自动恢复', () => {
    const dismissed = slidesSelectionKey(parseSlidesSelectionSnapshot(payload))
    const next = parseSlidesSelectionSnapshot({
      ...payload,
      items: [...payload.items, { id: 'el_b', type: 'text' }]
    })
    expect(slidesSelectionKey(next)).not.toBe(dismissed)
  })
})
