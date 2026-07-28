import type { ReactElement } from 'react'
import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useDesignWorkspaceStore } from '@cortex-work/core/design/design-workspace-store'
import type { DesignHtmlElementContext } from '@cortex-work/core/design/design-composer-context'
import { designDocumentKind, type DesignArtifact } from '@cortex-work/core/design/design-types'
import type { DesignRuntimeQualityPayload } from '@cortex-work/core/design/design-html-quality'
import { DesignCanvas } from './DesignCanvas'
import { SlidesWorkspace } from './slides/SlidesWorkspace'

type Props = {
  leftSidebarCollapsed: boolean
  onToggleLeftSidebar: () => void
  /** 宿主自带顶栏(会话产物右栏):slides 不再渲染自己的工具栏行。 */
  chromeless?: boolean
  busy?: boolean
  onOpenAgentSettings?: () => void
  onImplementDesign?: (artifact: DesignArtifact) => void
  onScreenCreated?: (shapeId: string, userPrompt: string, brief?: string) => void
  onUseElementAsContext?: (context: DesignHtmlElementContext | null, promptSeed?: string) => void
  onRuntimeQualityFindings?: (payload: DesignRuntimeQualityPayload) => void
  onRequestQualityRepair?: (payload: DesignRuntimeQualityPayload) => void
}

/**
 * Design-mode center surface: the canvas/preview output. Design input is owned
 * by the floating assistant/composer overlay rendered by the workbench route.
 * The 设计上下文 form lives in a popover triggered from the canvas toolbar.
 */
export function DesignWorkspaceView({
  leftSidebarCollapsed,
  onToggleLeftSidebar,
  chromeless = false,
  busy = false,
  onOpenAgentSettings,
  onImplementDesign,
  onScreenCreated,
  onUseElementAsContext,
  onRuntimeQualityFindings,
  onRequestQualityRepair
}: Props): ReactElement {
  const { t } = useTranslation('design')
  const loadDesignSettings = useDesignWorkspaceStore((s) => s.loadDesignSettings)
  const fileError = useDesignWorkspaceStore((s) => s.fileError)
  const setFileError = useDesignWorkspaceStore((s) => s.setFileError)
  // Slides 分流:kind === 'slides' 的设计稿用专用 Slides Workspace,不进自由画布。
  const workspaceRoot = useDesignWorkspaceStore((s) => s.workspaceRoot)
  const activeDocumentId = useDesignWorkspaceStore((s) => s.activeDocumentId)
  const documents = useDesignWorkspaceStore((s) => s.documents)
  const activeDocument = documents.find((doc) => doc.id === activeDocumentId) ?? null
  const isSlidesDocument = activeDocument ? designDocumentKind(activeDocument) === 'slides' : false

  useEffect(() => {
    void loadDesignSettings()
  }, [loadDesignSettings])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {fileError ? (
        <div className="ds-no-drag flex shrink-0 items-center justify-between gap-2 bg-[#c0392b]/10 px-3 py-1.5 text-[12px] text-[#c0392b] shadow-[inset_0_-1px_0_rgba(192,57,43,0.25)] dark:text-[#f0a0a0]">
          <span className="min-w-0 flex-1 truncate">{fileError}</span>
          <button
            type="button"
            onClick={() => setFileError(null)}
            aria-label={t('close')}
            className="shrink-0 transition-opacity hover:opacity-70"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
      ) : null}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {isSlidesDocument && activeDocument ? (
          <SlidesWorkspace
            workspaceRoot={workspaceRoot}
            documentId={activeDocument.id}
            documentTitle={activeDocument.title}
            leftSidebarCollapsed={leftSidebarCollapsed}
            onToggleLeftSidebar={onToggleLeftSidebar}
            chromeless={chromeless}
          />
        ) : (
          <DesignCanvas
            leftSidebarCollapsed={leftSidebarCollapsed}
            onToggleLeftSidebar={onToggleLeftSidebar}
            busy={busy}
            onOpenAgentSettings={onOpenAgentSettings}
            onImplementDesign={onImplementDesign}
            onScreenCreated={onScreenCreated}
            onUseElementAsContext={onUseElementAsContext}
            onRuntimeQualityFindings={onRuntimeQualityFindings}
            onRequestQualityRepair={onRequestQualityRepair}
          />
        )}
      </div>
    </div>
  )
}
