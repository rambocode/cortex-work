import type { Dispatch, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import type { AttachmentReference } from '@cortex-work/core/design/compat/agent-types'
import type { ModelProviderModelGroup } from '@cortex-work/core/design/compat/kun-gui-api'
import { providerIdForComposerModel } from '@cortex-work/core/design/compat/chat-store-helpers'
import type { ComposerAttachmentScope } from './compat/workbench-composer-attachments'
import {
  composerReasoningEffortRequestValue,
  type ComposerReasoningEffort
} from './compat/FloatingComposerModelPicker'
import { useCanvasSelectionStore } from '@cortex-work/core/design/canvas/canvas-selection-store'
import type { DesignHtmlElementContext } from '@cortex-work/core/design/design-composer-context'
import {
  buildDesignPagesRunLabels,
  runDesignPagesDispatch
} from '@cortex-work/core/design/design-pages-dispatch'
import { routeDesignPrompt } from '@cortex-work/core/design/design-prompt-router'
import type { DesignPromptSource } from '@cortex-work/core/design/design-quality-repair-dispatch'
import { useDesignWorkspaceStore } from '@cortex-work/core/design/design-workspace-store'
import {
  submitDesignTurn,
  type DesignTurnSubmitSendMessage
} from '@cortex-work/core/design/design-turn-submit'
import { useDesignQualityRepair } from './useDesignQualityRepair'

export type DesignPromptControllerOptions = {
  route: string
  runtimeConnection: string
  busy: boolean
  workspaceRoot: string
  composerAttachments: AttachmentReference[]
  attachmentUploadEnabled: boolean
  composerReasoningEffort: ComposerReasoningEffort
  composerModelGroups: readonly ModelProviderModelGroup[]
  designContextSuppressedIds: ReadonlySet<string>
  designHtmlElementContext: DesignHtmlElementContext | null
  setInput: Dispatch<SetStateAction<string>>
  setAttachmentUploadError: (error: string | null) => void
  setError: (error: string | null) => void
  setDesignAssistantOpen: (open: boolean) => void
  ensureDesignThreadForWorkspace: (workspaceRoot: string, docId: string) => Promise<string | null>
  sendMessage: DesignTurnSubmitSendMessage
  getAttachmentScope: () => ComposerAttachmentScope
  clearComposerAttachments: (scope?: ComposerAttachmentScope) => void
  clearHtmlElementContext: () => void
}

export type SendDesignPromptOptions = {
  displayText?: string
  source?: DesignPromptSource
  screenShapeId?: string
}

export function useDesignPromptController({
  route,
  runtimeConnection,
  busy,
  workspaceRoot,
  composerAttachments,
  attachmentUploadEnabled,
  composerReasoningEffort,
  composerModelGroups,
  designContextSuppressedIds,
  designHtmlElementContext,
  setInput,
  setAttachmentUploadError,
  setError,
  setDesignAssistantOpen,
  ensureDesignThreadForWorkspace,
  sendMessage,
  getAttachmentScope,
  clearComposerAttachments,
  clearHtmlElementContext
}: DesignPromptControllerOptions) {
  const { t } = useTranslation('design')

  function generateDesignPages(brief: string): void {
    const designState = useDesignWorkspaceStore.getState()
    const designWorkspaceRoot = designState.workspaceRoot || workspaceRoot
    if (!designWorkspaceRoot) {
      setError(t('workspaceRequiredToCreateThread'))
      return
    }
    void (async () => {
      const docId = useDesignWorkspaceStore.getState().ensureActiveDocument()
      const threadId = await ensureDesignThreadForWorkspace(designWorkspaceRoot, docId)
      if (!threadId) {
        setInput(brief)
        return
      }
      await runDesignPagesDispatch({
        brief,
        workspaceRoot: designWorkspaceRoot,
        sendMessage,
        promptState: useDesignWorkspaceStore.getState(),
        resolveProviderId: (model) => providerIdForComposerModel(composerModelGroups, model),
        reasoningEffort: composerReasoningEffortRequestValue(composerReasoningEffort),
        labels: buildDesignPagesRunLabels(t)
      })
    })()
  }

  function sendDesignPrompt(value: string, options: SendDesignPromptOptions = {}): void {
    const source = options.source ?? 'user'
    const attachmentScope = getAttachmentScope()
    const promptRoute = routeDesignPrompt({
      value,
      displayText: options.displayText,
      attachments: composerAttachments,
      attachmentUploadEnabled,
      designState: useDesignWorkspaceStore.getState(),
      fallbackWorkspaceRoot: workspaceRoot,
      selectedCount: useCanvasSelectionStore.getState().selectedIds.size,
      imageOnlyDisplay: t('composerImageOnlyDisplay'),
      imageOnlyPrompt: t('composerImageOnlyPrompt')
    })
    if (promptRoute.kind === 'ignore') return
    if (promptRoute.kind === 'attachment-unsupported') {
      setAttachmentUploadError(t('composerAttachmentModelUnsupported'))
      return
    }
    if (promptRoute.kind === 'missing-workspace') {
      setError(t('workspaceRequiredToCreateThread'))
      return
    }
    setDesignAssistantOpen(true)
    if (promptRoute.kind === 'multi-page') {
      setInput('')
      generateDesignPages(promptRoute.brief)
      return
    }
    const {
      text: routeText,
      displayText,
      promptText,
      workspaceRoot: designWorkspaceRoot,
      attachmentIds,
      attachments
    } = promptRoute
    if (promptRoute.shouldClearInput) setInput('')
    void (async () => {
      const docId = useDesignWorkspaceStore.getState().ensureActiveDocument()
      const threadId = await ensureDesignThreadForWorkspace(designWorkspaceRoot, docId)
      if (!threadId) {
        setInput(routeText)
        return
      }
      const result = await submitDesignTurn({
        promptText,
        displayText,
        workspaceRoot: designWorkspaceRoot,
        source,
        sendMessage,
        resolveProviderId: (model) => providerIdForComposerModel(composerModelGroups, model),
        reasoningEffort: composerReasoningEffortRequestValue(composerReasoningEffort),
        attachmentIds,
        attachments,
        suppressedIds: designContextSuppressedIds,
        htmlElementContext: designHtmlElementContext,
        explicitScreenShapeId: options.screenShapeId,
        clearAutoRepairScope: clearDesignAutoRepairScope
      })
      if (result.status === 'missing-board' || result.status === 'file-error') {
        setInput(routeText)
        return
      }
      if (result.status === 'sent') {
        clearHtmlElementContext()
        if (result.clearAttachments) clearComposerAttachments(attachmentScope)
      }
    })()
  }

  const {
    clearDesignAutoRepairScope,
    handleDesignRuntimeQualityFindings,
    handleDesignQualityRepairRequest
  } = useDesignQualityRepair({
    route,
    runtimeConnection,
    busy,
    sendDesignPrompt
  })

  return {
    sendDesignPrompt,
    clearDesignAutoRepairScope,
    handleDesignRuntimeQualityFindings,
    handleDesignQualityRepairRequest
  }
}
