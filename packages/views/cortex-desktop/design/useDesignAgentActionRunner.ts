import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { DesignIntentMode } from '@cortex-work/core/design/design-types'
import { useDesignWorkspaceStore } from '@cortex-work/core/design/design-workspace-store'
import { resolveArtifactTurnDispatcher } from '@cortex-work/core/design/artifact-turn-dispatch'

type RunnableDesignAgentAction = {
  intentMode: DesignIntentMode
  prompt: string
  /** 菜单里的操作名;回流会话时用它当会话流里的正文(prompt 是几百字的英文指令)。 */
  labelKey?: string
  disabledReasonKey?: string
}

/**
 * 画布「智能操作」菜单的执行器。去向取决于宿主(见 core/design/artifact-turn-dispatch):
 *   · 会话产物面板 → 回流到发起会话,由那条会话的 agent 执行(面板里根本没有助手栏,
 *     原来的「打开助手栏 + 种下 prompt」在这里等于点了没反应,用户实测);
 *   · 独立设计工作台 → 维持原行为:切 intent 档、展开助手栏、把 prompt 种进输入框。
 */
export function useDesignAgentActionRunner(
  onSeedPrompt?: (prompt: string) => void
): (action: RunnableDesignAgentAction | null) => void {
  const { t } = useTranslation('design')
  const setDesignIntentMode = useDesignWorkspaceStore((s) => s.setDesignIntentMode)
  const setCanvasAssistantOpen = useDesignWorkspaceStore((s) => s.setCanvasAssistantOpen)
  const workspaceRoot = useDesignWorkspaceStore((s) => s.workspaceRoot)
  const activeDocumentId = useDesignWorkspaceStore((s) => s.activeDocumentId)
  return useCallback((action: RunnableDesignAgentAction | null): void => {
    if (!action || action.disabledReasonKey) return
    const conversation = activeDocumentId
      ? resolveArtifactTurnDispatcher({ workspaceRoot, documentId: activeDocumentId })
      : null
    if (conversation) {
      // 正文只放操作名:action.prompt 是几百字的英文指令(还带画布上下文),
      // 原样进会话流既刷屏又会污染会话标题。完整指令随 system prompt 下发。
      void conversation.send({
        text: action.labelKey ? t(action.labelKey) : action.prompt,
        systemPrompt: action.prompt
      })
      return
    }
    setDesignIntentMode(action.intentMode)
    setCanvasAssistantOpen(true)
    onSeedPrompt?.(action.prompt)
  }, [activeDocumentId, onSeedPrompt, setCanvasAssistantOpen, setDesignIntentMode, t, workspaceRoot])
}
