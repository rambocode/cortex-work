import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { CanvasDocument } from '@cortex-work/core/design/canvas/canvas-types'
import { useCanvasShapeStore } from '@cortex-work/core/design/canvas/canvas-shape-store'
import { useImageAnnotationStore } from '@cortex-work/core/design/canvas/image-annotation-store'
import { applyImageAnnotationResult } from '@cortex-work/core/design/canvas/image-annotation-dispatch'
import { useDesignWorkspaceStore } from '@cortex-work/core/design/design-workspace-store'
import { DesignImageAnnotationOverlay } from './DesignImageAnnotationOverlay'
import type { ImageAnnotationResult } from './ImageAnnotationEditor'

export type WorkbenchImageAnnotationOverlayProps = {
  route: string
  activeSddDraft: boolean
  canvasDocumentKey?: string | null
  canvasDocument: CanvasDocument
  activeCodeCanvasWorkspace: string
  designWorkspaceRoot: string
  fallbackWorkspaceRoot: string
  setError: (error: string | null) => void
  sendCodeCanvasPrompt: (value: string, options?: { displayText?: string }) => Promise<void>
  sendDesignPrompt: (
    value: string,
    options?: { displayText?: string }
  ) => void
}

export function WorkbenchImageAnnotationOverlay({
  route,
  activeSddDraft,
  canvasDocumentKey,
  canvasDocument,
  activeCodeCanvasWorkspace,
  designWorkspaceRoot,
  fallbackWorkspaceRoot,
  setError,
  sendCodeCanvasPrompt,
  sendDesignPrompt
}: WorkbenchImageAnnotationOverlayProps): ReactElement {
  const { t } = useTranslation('design')
  const [busy, setBusy] = useState(false)
  const annotatingShapeId = useImageAnnotationStore((s) => s.editingShapeId)
  const closeImageAnnotation = useImageAnnotationStore((s) => s.closeImageAnnotation)

  const handleApply = async (result: ImageAnnotationResult): Promise<void> => {
    await applyImageAnnotationResult({
      result,
      shapeId: useImageAnnotationStore.getState().editingShapeId,
      currentDocumentKey: useCanvasShapeStore.getState().documentKey,
      route,
      activeCodeCanvasWorkspace,
      designWorkspaceRoot: useDesignWorkspaceStore.getState().workspaceRoot || fallbackWorkspaceRoot,
      workspaceRequiredMessage: t('workspaceRequiredToCreateThread'),
      unsupportedSaveMessage: '当前环境不支持保存批注图片',
      saveFailedMessage: (message) => `保存批注图片失败：${message}`,
      setError,
      setAnnotationBusy: setBusy,
      closeImageAnnotation,
      sendCodeCanvasPrompt,
      sendDesignPrompt
    })
  }

  return (
    <DesignImageAnnotationOverlay
      route={route}
      activeSddDraft={activeSddDraft}
      canvasDocumentKey={canvasDocumentKey}
      annotatingShapeId={annotatingShapeId}
      canvasDocument={canvasDocument}
      activeCodeCanvasWorkspace={activeCodeCanvasWorkspace}
      designWorkspaceRoot={designWorkspaceRoot}
      fallbackWorkspaceRoot={fallbackWorkspaceRoot}
      busy={busy}
      onCancel={() => {
        if (!busy) closeImageAnnotation()
      }}
      onApply={(annotationResult) => void handleApply(annotationResult)}
    />
  )
}
