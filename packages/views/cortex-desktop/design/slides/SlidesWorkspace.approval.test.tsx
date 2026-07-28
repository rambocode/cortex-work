// 提纲批准的去向:会话产物入口回流发起会话,独立设计工作台仍走 design run。
// 回归的是「批准完左侧毫无动静、用户得再手打一遍」(用户实测)。
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoreProvider } from '@cortex-work/core'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import { buildStarterBentoDoc } from '@cortex-work/core/design/slides/bento/bento-doc-schema'
import { useChatStore } from '@cortex-work/core/design/compat/chat-store'
import {
  clearSlidesTurnDispatcher,
  setSlidesTurnDispatcher,
  type SlidesTurnDispatcher
} from '@cortex-work/core/design/slides/slides-turn-dispatch'
import type { SlidesOutline } from '@cortex-work/core/design/slides/slides-types'
import { useBentoSlidesStore } from './bento-slides-store'

const sendDesignMessage = vi.fn(async () => true)
vi.mock('@cortex-work/core/design/run/design-run-manager', () => ({
  sendDesignMessage: (...args: unknown[]) => sendDesignMessage(...(args as []))
}))
vi.mock('./SlidesStage', () => ({ SlidesStage: () => <div data-testid="slides-stage" /> }))
vi.mock('./SlidesToolbar', () => ({ SlidesToolbar: () => <div data-testid="slides-toolbar" /> }))
vi.mock('./use-slides-deck-activity', () => ({ useSlidesDeckActivity: () => undefined }))
// 弹层只留一个「批准」按钮,直接回调既定提纲——审批表单本身另有测试。
vi.mock('./SlidesOutlineDialog', () => ({
  SlidesOutlineDialog: ({
    onApproved
  }: {
    onApproved?: (outline: Omit<SlidesOutline, 'approvedAt'>) => void
  }) => (
    <button type="button" data-testid="approve" onClick={() => onApproved?.(OUTLINE)}>
      approve
    </button>
  )
}))

import { SlidesWorkspace } from './SlidesWorkspace'

const ROOT = '/ws'
const DECK = 'deck-1'
const OUTLINE = {
  version: 1,
  summary: '三页产品介绍',
  items: [{ id: 'o1', title: '产品概览', purpose: '定位', keyPoints: ['价值主张'] }]
}

function bridge(): DesktopBridge {
  return {
    slidesBentoGetDeck: vi.fn(async () => ({
      ok: true as const,
      json: JSON.stringify(buildStarterBentoDoc('产品介绍')),
      revision: 1,
      stage: 'outline-proposed' as const,
      outline: OUTLINE
    })),
    slidesBentoCreateDeck: vi.fn()
  } as unknown as DesktopBridge
}

function renderWorkspace(): void {
  render(
    <CoreProvider wsId="w" identity={{ userId: 'u', name: 'n' }} desktopBridge={bridge()}>
      <SlidesWorkspace workspaceRoot={ROOT} documentId={DECK} documentTitle="产品介绍" />
    </CoreProvider>
  )
}

describe('SlidesWorkspace 提纲批准的去向', () => {
  beforeEach(() => {
    sendDesignMessage.mockClear()
    useBentoSlidesStore.getState().reset()
    useChatStore.getState().resetMirror()
  })

  afterEach(cleanup)

  it('会话产物入口:回流发起会话,不再起 design run', async () => {
    const send = vi.fn(async (...args: unknown[]) => {
      void args
      return true
    })
    const dispatcher: SlidesTurnDispatcher = { workspaceRoot: ROOT, deckId: DECK, send }
    setSlidesTurnDispatcher(dispatcher)
    try {
      renderWorkspace()
      const approve = await screen.findByTestId('approve')
      await act(async () => approve.click())

      await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      expect(sendDesignMessage).not.toHaveBeenCalled()
      const turn = send.mock.calls[0]![0] as { text: string; systemPrompt: string }
      expect(turn.text.length).toBeGreaterThan(0)
      expect(turn.systemPrompt).toContain('产品概览')
    } finally {
      clearSlidesTurnDispatcher(dispatcher)
    }
  })

  it('独立设计工作台(无派发器):仍走 design run,不回归', async () => {
    renderWorkspace()
    const approve = await screen.findByTestId('approve')
    await act(async () => approve.click())

    await waitFor(() => expect(sendDesignMessage).toHaveBeenCalledTimes(1))
  })

  it('回流失败时给出人话提示,而不是静默什么都没发生', async () => {
    const dispatcher: SlidesTurnDispatcher = {
      workspaceRoot: ROOT,
      deckId: DECK,
      send: vi.fn(async (...args: unknown[]) => {
        void args
        return false
      })
    }
    setSlidesTurnDispatcher(dispatcher)
    try {
      renderWorkspace()
      const approve = await screen.findByTestId('approve')
      await act(async () => approve.click())

      expect(await screen.findByTestId('slides-approval-relay-failed')).toBeInTheDocument()
      expect(sendDesignMessage).not.toHaveBeenCalled()
    } finally {
      clearSlidesTurnDispatcher(dispatcher)
    }
  })
})
