// deck 变更 → 会话时间线活动条(订阅侧接线;判定与文案全在 core 的纯函数里)。
//
// 为什么需要:AI 改稿全程只发生在磁盘上,右栏此前只能看到工具芯片,而 codex 把所有 MCP
// 调用都归一成 "MCP" —— 一屏「2 个操作」看不出改了什么。这条活动流不依赖 agent 自述、
// 也不受工具名归一化影响:主进程每写成一次盘就播报一次「改了第几页 / 到了哪个 revision」。
import { useEffect } from 'react'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import {
  formatSlidesDeckActivity,
  matchesSlidesDeckChange,
  slidesDeckActivityBlockId
} from '@cortex-work/core/design/slides/slides-deck-activity'
import { useChatStore } from '@cortex-work/core/design/compat/chat-store'
import type { ChatBlock } from '@cortex-work/core/design/compat/agent-types'

type Options = {
  bridge: DesktopBridge | null | undefined
  workspaceRoot: string
  deckId: string
}

export function useSlidesDeckActivity({ bridge, workspaceRoot, deckId }: Options): void {
  useEffect(() => {
    if (!bridge?.onSlidesDeckChanged || !workspaceRoot || !deckId) return
    // 退订函数必须回传给 effect 清理:reload/切 deck 时不退订会累积 listener(MaxListeners 告警)。
    return bridge.onSlidesDeckChanged((event) => {
      if (!matchesSlidesDeckChange(event, { workspaceRoot, deckId })) return
      const text = formatSlidesDeckActivity(event)
      if (!text) return
      const id = slidesDeckActivityBlockId(event)
      const mirror = useChatStore.getState()
      // pushBlock 是纯 append 不去重,而广播可能因多窗口/重复订阅到达多次 —— 这里按 id 自查。
      if (mirror.blocks.some((block) => block.id === id)) return
      mirror.pushBlock({
        kind: 'system',
        id,
        text,
        code: 'slides.deckChanged',
        severity: 'info'
      } as ChatBlock)
    })
  }, [bridge, workspaceRoot, deckId])
}
