import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoreProvider } from '@cortex-work/core'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import type { SlidesDeckChangedEvent } from '@cortex-work/core/desktop/slides-ipc-types'
import { buildStarterBentoDoc } from '@cortex-work/core/design/slides/bento/bento-doc-schema'
import { useChatStore } from '@cortex-work/core/design/compat/chat-store'
import { useBentoSlidesStore } from './bento-slides-store'

vi.mock('./SlidesStage', () => ({
  SlidesStage: () => <div data-testid="slides-stage" />
}))
vi.mock('./SlidesToolbar', () => ({
  SlidesToolbar: () => <div data-testid="slides-toolbar" />
}))
vi.mock('./SlidesOutlineDialog', () => ({
  SlidesOutlineDialog: () => <div data-testid="slides-outline-dialog" />
}))
vi.mock('./use-slides-deck-activity', () => ({
  useSlidesDeckActivity: () => undefined
}))

import { SlidesWorkspace } from './SlidesWorkspace'

const ROOT = '/ws'
const DECK = 'deck-conversation'
const outline = {
  version: 1,
  summary: '三页产品介绍',
  items: [
    { id: 'o1', title: '产品概览', purpose: '定位', keyPoints: ['价值'] },
    { id: 'o2', title: '核心能力', purpose: '说明', keyPoints: ['功能'] },
    { id: 'o3', title: '下一步', purpose: '行动', keyPoints: ['联系'] }
  ]
}

function deckEvent(): SlidesDeckChangedEvent {
  return {
    workspaceRoot: ROOT,
    deckId: DECK,
    revision: 0,
    source: 'runtime',
    slideIds: [],
    pages: [],
    slideCount: 0,
    at: '2026-07-27T00:00:00.000Z'
  }
}

describe('SlidesWorkspace 提纲阶段刷新', () => {
  beforeEach(() => {
    useBentoSlidesStore.getState().reset()
    useChatStore.getState().resetMirror()
  })

  afterEach(cleanup)

  it('会话技能写入 outline-proposed 后由 deck 事件刷新并自动打开审批面板', async () => {
    const listeners: Array<(event: SlidesDeckChangedEvent) => void> = []
    let readCount = 0
    const bridge = {
      slidesBentoGetDeck: vi.fn(async () => {
        readCount += 1
        return {
          ok: true as const,
          json: JSON.stringify(buildStarterBentoDoc('产品介绍')),
          revision: 0,
          stage: readCount === 1 ? ('draft' as const) : ('outline-proposed' as const),
          outline: readCount === 1 ? null : outline
        }
      }),
      slidesBentoCreateDeck: vi.fn(),
      onSlidesDeckChanged: (listener: (event: SlidesDeckChangedEvent) => void) => {
        listeners.push(listener)
        return () => undefined
      }
    } as unknown as DesktopBridge

    render(
      <CoreProvider wsId="w" identity={{ userId: 'u', name: 'n' }} desktopBridge={bridge}>
        <SlidesWorkspace
          workspaceRoot={ROOT}
          documentId={DECK}
          documentTitle="产品介绍"
        />
      </CoreProvider>
    )

    await waitFor(() => expect(bridge.slidesBentoGetDeck).toHaveBeenCalledTimes(1))
    expect(listeners).toHaveLength(1)

    act(() => listeners[0]!(deckEvent()))

    expect(await screen.findByTestId('slides-outline-dialog')).toBeInTheDocument()
    expect(bridge.slidesBentoGetDeck).toHaveBeenCalledTimes(2)
  })
})
