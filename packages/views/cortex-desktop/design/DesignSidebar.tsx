import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Check,
  FileCode2,
  FilePlus2,
  Folder,
  FolderOpen,
  Layers,
  Moon,
  Palette,
  Pencil,
  Plus,
  Presentation,
  RotateCcw,
  Settings,
  Sun,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SettingsRouteSection } from '@cortex-work/core/design/compat/chat-store'
import { WorkspaceModeTabs } from './compat/WorkspaceModeTabs'
import { useDesignWorkspaceStore } from '@cortex-work/core/design/design-workspace-store'
import { designDocumentKind, type DesignArtifact, type DesignDocument, type DesignDocumentKind } from '@cortex-work/core/design/design-types'
import { collectAgentDrawingArtifactIds, groupDesignArtifacts } from '@cortex-work/core/design/design-artifact-actions'
import { findDesignBoardArtifact } from '@cortex-work/core/design/design-board'
import { useCanvasShapeStore } from '@cortex-work/core/design/canvas/canvas-shape-store'
import { useCanvasSelectionStore } from '@cortex-work/core/design/canvas/canvas-selection-store'
import { isHtmlFrame, shapeBounds } from '@cortex-work/core/design/canvas/canvas-types'
import { useCanvasViewportStore } from '@cortex-work/core/design/canvas/canvas-viewport-store'
import {
  SidebarCommandRow,
  SidebarFrame,
  SidebarIconButton,
  SidebarSectionHeader,
  SidebarTreeRow
} from './compat/SidebarPrimitives'
import { CanvasLayersPanel } from './canvas/CanvasLayersPanel'

type Props = {
  onCodeOpen: () => void
  onWriteOpen: () => void
  onDesignOpen: () => void
  onOpenSettings: (section?: SettingsRouteSection) => void
  onToggleTheme: () => void
  /** 点击「演示文稿」类型的文稿行后回调(无论是否已激活):宿主用它自动折叠侧栏聚焦演示区。
      board 类型不触发——自由画布常需要侧栏的 screens 树,不该自动收起。 */
  onDocumentSelected?: () => void
}

export function getDesignSidebarVisibleArtifacts(artifacts: readonly DesignArtifact[]): DesignArtifact[] {
  return artifacts.filter((artifact) => artifact.node?.boardHidden !== true)
}

export function getDesignSidebarDocumentScreenCount(doc: Pick<DesignDocument, 'artifacts'>): number {
  return getDesignSidebarVisibleArtifacts(doc.artifacts).filter((artifact) => artifact.kind === 'html').length
}

/** 侧栏文稿标签:优先展示用户命名(title 在创建/重命名时写入,缺省与 id 相同),空白时回退到 id。 */
export function getDesignSidebarDocumentLabel(doc: Pick<DesignDocument, 'id' | 'title'>): string {
  return doc.title.trim() || doc.id
}

/** 新建区的类型过滤:null 表示全部,'board'/'slides' 只展示对应类型的文稿。 */
export type DesignSidebarKindFilter = DesignDocumentKind | null

/** 按新建区选中的类型过滤文稿列表;kind 判定复用 designDocumentKind(旧数据缺 kind 时归 board)。 */
export function getDesignSidebarFilteredDocuments<T extends Pick<DesignDocument, 'kind' | 'slidesManifestPath'>>(
  documents: readonly T[],
  filter: DesignSidebarKindFilter
): T[] {
  if (filter === null) return [...documents]
  return documents.filter((doc) => designDocumentKind(doc) === filter)
}

/**
 * Design-mode left sidebar: mode tabs + a 设计稿 (design document) tree. Each
 * 设计稿 is a top-level container; its 画布 (artifacts) show nested under the
 * active one.
 */
export function DesignSidebar({
  onCodeOpen,
  onWriteOpen,
  onDesignOpen,
  onOpenSettings,
  onToggleTheme,
  onDocumentSelected
}: Props): ReactElement {
  const { t } = useTranslation('design')
  const [isDarkMode, setIsDarkMode] = useState(
    () => typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark'
  )

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDarkMode(document.documentElement.getAttribute('data-theme') === 'dark')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  const documents = useDesignWorkspaceStore((s) => s.documents)
  const activeDocumentId = useDesignWorkspaceStore((s) => s.activeDocumentId)
  const artifacts = useDesignWorkspaceStore((s) => s.artifacts)
  const activeArtifactId = useDesignWorkspaceStore((s) => s.activeArtifactId)
  const setActiveArtifact = useDesignWorkspaceStore((s) => s.setActiveArtifact)
  const removeArtifact = useDesignWorkspaceStore((s) => s.removeArtifact)
  const renameArtifact = useDesignWorkspaceStore((s) => s.renameArtifact)
  const createDocument = useDesignWorkspaceStore((s) => s.createDocument)
  const renameDocument = useDesignWorkspaceStore((s) => s.renameDocument)
  const removeDocument = useDesignWorkspaceStore((s) => s.removeDocument)
  const switchActiveDocument = useDesignWorkspaceStore((s) => s.switchActiveDocument)
  const designSystemHash = useDesignWorkspaceStore((s) => s.designSystemHash)
  const closeImplementPanel = useDesignWorkspaceStore((s) => s.closeImplementPanel)
  const setDesignIntentMode = useDesignWorkspaceStore((s) => s.setDesignIntentMode)
  const setCanvasAssistantOpen = useDesignWorkspaceStore((s) => s.setCanvasAssistantOpen)
  const activeArtifact = artifacts.find((a) => a.id === activeArtifactId) ?? null

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const committingRef = useRef(false)
  const [editingDocId, setEditingDocId] = useState<string | null>(null)
  const [docDraft, setDocDraft] = useState('')
  const committingDocRef = useRef(false)
  const [agentDrawingsOpen, setAgentDrawingsOpen] = useState(true)
  // 新建区选中类型的过滤态;null = 展示全部文稿
  const [kindFilter, setKindFilter] = useState<DesignSidebarKindFilter>(null)
  // 「+」点击后弹出的命名对话框:记录要创建的类型与输入的名称
  const [createPrompt, setCreatePrompt] = useState<{ kind: 'board' | 'slides' } | null>(null)
  const [createName, setCreateName] = useState('')

  const canvasDocument = useCanvasShapeStore((s) => s.document)
  const canvasObjects = canvasDocument.objects
  const selectedIds = useCanvasSelectionStore((s) => s.selectedIds)
  const visibleArtifacts = useMemo(() => getDesignSidebarVisibleArtifacts(artifacts), [artifacts])
  const screenLinkedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const id of Object.keys(canvasObjects)) {
      const shape = canvasObjects[id]
      if (shape && isHtmlFrame(shape) && shape.htmlArtifactId) ids.add(shape.htmlArtifactId)
    }
    return ids
  }, [canvasObjects])
  const selectedHtmlArtifactId = useMemo(() => {
    for (const id of selectedIds) {
      const shape = canvasObjects[id]
      if (shape && isHtmlFrame(shape) && shape.htmlArtifactId) return shape.htmlArtifactId
    }
    return null
  }, [canvasObjects, selectedIds])
  const grouped = useMemo(
    () => groupDesignArtifacts(visibleArtifacts, screenLinkedIds),
    [screenLinkedIds, visibleArtifacts]
  )
  const agentDrawingArtifactIds = useMemo(() => {
    return collectAgentDrawingArtifactIds(visibleArtifacts, grouped, screenLinkedIds)
  }, [grouped, screenLinkedIds, visibleArtifacts])
  const agentDrawingArtifacts = useMemo(
    () => visibleArtifacts.filter((artifact) => artifact.kind === 'html' && agentDrawingArtifactIds.has(artifact.id)),
    [agentDrawingArtifactIds, visibleArtifacts]
  )
  const sortedDocuments = useMemo(
    () => [...documents].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt)),
    [documents]
  )
  const visibleDocuments = useMemo(
    () => getDesignSidebarFilteredDocuments(sortedDocuments, kindFilter),
    [sortedDocuments, kindFilter]
  )

  const focusComposer = (): void => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('[data-design-rail-composer] textarea')?.focus()
    })
  }

  const beginRename = (artifactId: string, title: string): void => {
    committingRef.current = false
    setDraft(title)
    setEditingId(artifactId)
  }
  const commitRename = (artifactId: string): void => {
    if (committingRef.current) return
    committingRef.current = true
    renameArtifact(artifactId, draft)
    setEditingId(null)
  }

  const beginRenameDoc = (documentId: string, title: string): void => {
    committingDocRef.current = false
    setDocDraft(title)
    setEditingDocId(documentId)
  }
  const commitRenameDoc = (documentId: string): void => {
    if (committingDocRef.current) return
    committingDocRef.current = true
    renameDocument(documentId, docDraft)
    setEditingDocId(null)
  }

  // New 设计稿: a fresh top-level container (its own canvas + conversation).
  // kind === 'slides' 时创建演示文稿(deck 目录/manifest 由 SlidesWorkspace 挂载时经 IPC 补建);
  // title 来自命名对话框,落盘为文稿名(侧栏标签优先展示它)。
  const handleNewDocument = (kind: 'board' | 'slides' = 'board', title?: string): void => {
    closeImplementPanel()
    setDesignIntentMode('generate')
    setCanvasAssistantOpen(true)
    useCanvasSelectionStore.getState().clearSelection()
    createDocument(title, kind === 'slides' ? { kind: 'slides' } : undefined)
    // 新文档一定要在列表里可见:过滤切到其所属类型,避免「创建了却看不到」
    setKindFilter(kind)
    focusComposer()
  }

  // 新建区行点击 = 切换该类型的列表过滤(再点一次还原为全部)。
  const toggleKindFilter = (kind: 'board' | 'slides'): void => {
    setKindFilter((prev) => (prev === kind ? null : kind))
  }

  // 行尾「+」:弹出命名对话框,确认后才创建对应类型的新文稿。
  const openCreatePrompt = (kind: 'board' | 'slides'): void => {
    setCreateName('')
    setCreatePrompt({ kind })
  }

  const confirmCreatePrompt = (): void => {
    if (!createPrompt) return
    const name = createName.trim()
    if (!name) return
    handleNewDocument(createPrompt.kind, name)
    setCreatePrompt(null)
    setCreateName('')
  }

  const handleSelectDocument = (documentId: string): void => {
    // 仅演示文稿触发折叠回调(点已激活的也触发:用户意图是「进去干活」);board 不折叠。
    const doc = documents.find((d) => d.id === documentId)
    if (doc && designDocumentKind(doc) === 'slides') onDocumentSelected?.()
    if (documentId === activeDocumentId) return
    closeImplementPanel()
    useCanvasSelectionStore.getState().clearSelection()
    switchActiveDocument(documentId)
  }

  const handleSelectAgentDrawing = (artifact: DesignArtifact): void => {
    closeImplementPanel()
    const boardArtifact = findDesignBoardArtifact(useDesignWorkspaceStore.getState().artifacts)
    if (boardArtifact) setActiveArtifact(boardArtifact.id)

    const frame = Object.values(useCanvasShapeStore.getState().document.objects).find(
      (shape) => shape && isHtmlFrame(shape) && shape.htmlArtifactId === artifact.id
    )
    const viewportStore = useCanvasViewportStore.getState()
    viewportStore.setActiveTool('select')

    if (frame) {
      useCanvasSelectionStore.getState().select([frame.id])
      viewportStore.zoomToFit(shapeBounds(frame), 72, { maxZoom: 1, minZoom: 0.18 })
      return
    }

    useCanvasSelectionStore.getState().clearSelection()
    if (boardArtifact && artifact.kind === 'html' && artifact.node?.boardHidden) {
      useDesignWorkspaceStore.getState().updateArtifactNode(artifact.id, { boardHidden: false })
    }
    if (artifact.node) {
      viewportStore.zoomToFit(
        {
          x: artifact.node.x,
          y: artifact.node.y,
          width: artifact.node.width,
          height: artifact.node.height
        },
        72,
        { maxZoom: 1, minZoom: 0.18 }
      )
    }
    if (!boardArtifact) setActiveArtifact(artifact.id)
  }

  const renderArtifactStatus = (artifact: DesignArtifact): ReactElement | null => {
    const implemented = Boolean(artifact.implementedAt)
    if (!implemented) return null
    const drift = (artifact.implementedAt ?? '') < artifact.updatedAt
    const codeDrift =
      !drift &&
      Boolean(artifact.implementedDesignSystemHash) &&
      Boolean(designSystemHash) &&
      artifact.implementedDesignSystemHash !== designSystemHash
    const title = drift ? t('designDrift') : codeDrift ? t('designCodeDrift') : t('designImplemented')
    const Icon = drift ? RotateCcw : codeDrift ? TriangleAlert : Check
    return (
      <span
        title={title}
        aria-label={title}
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center ${
          drift ? 'text-[#c98a3a]' : codeDrift ? 'text-[#c0392b]' : 'text-[#2e9e6b]'
        }`}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      </span>
    )
  }

  const renderArtifactRows = (items: DesignArtifact[]): ReactElement => (
    <ul className="space-y-1">
      {items.map((artifact) => {
        const active = artifact.id === activeArtifactId
        const status = renderArtifactStatus(artifact)
        return (
          <li key={artifact.id}>
            {editingId === artifact.id ? (
              <div className="flex min-h-[34px] items-center rounded-[8px] bg-[var(--ds-sidebar-row-active)] px-2.5 py-1 shadow-[inset_0_0_0_1px_var(--ds-sidebar-row-ring)]">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(artifact.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(artifact.id)
                    else if (e.key === 'Escape') setEditingId(null)
                  }}
                  className="h-7 min-w-0 flex-1 rounded-md border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-focus)] px-2 text-[13px] text-[#1f2733] outline-hidden focus:border-[#3b82d8] dark:text-white"
                />
              </div>
            ) : (
              <SidebarTreeRow
                active={active}
                onClick={() => setActiveArtifact(artifact.id)}
                onDoubleClick={() => beginRename(artifact.id, artifact.title)}
                title={artifact.title}
                className="min-h-[34px]"
                buttonClassName="items-center gap-2 px-2.5 py-2"
                trailing={
                  <>
                    {artifact.versions.length > 1 ? (
                      <span className="text-[11.5px] text-ds-faint">v{artifact.versions.length}</span>
                    ) : null}
                    {status}
                  </>
                }
                actions={
                  <SidebarIconButton
                    onClick={() => removeArtifact(artifact.id)}
                    title={t('designDeleteArtifact')}
                    ariaLabel={t('designDeleteArtifact')}
                    tone="danger"
                    stopPropagation
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </SidebarIconButton>
                }
              >
                {artifact.kind === 'canvas' ? (
                  <Layers className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.9} />
                ) : (
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.9} />
                )}
                <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
              </SidebarTreeRow>
            )}
          </li>
        )
      })}
    </ul>
  )

  const renderAgentDrawingRows = (items: DesignArtifact[]): ReactElement => {
    const scrollable = items.length > 5
    return (
      <div className={scrollable ? 'max-h-[190px] overflow-y-auto pr-1' : undefined}>
        <ul className="space-y-1">
          {items.map((artifact) => {
            const active = artifact.id === activeArtifactId || artifact.id === selectedHtmlArtifactId
            const status = renderArtifactStatus(artifact)
            return (
              <li key={artifact.id}>
                {editingId === artifact.id ? (
                  <div className="flex min-h-[34px] items-center rounded-[8px] bg-[var(--ds-sidebar-row-active)] px-2.5 py-1 shadow-[inset_0_0_0_1px_var(--ds-sidebar-row-ring)]">
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(artifact.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(artifact.id)
                        else if (e.key === 'Escape') setEditingId(null)
                      }}
                      className="h-7 min-w-0 flex-1 rounded-md border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-focus)] px-2 text-[13px] text-[#1f2733] outline-hidden focus:border-[#3b82d8] dark:text-white"
                    />
                  </div>
                ) : (
                  <SidebarTreeRow
                    active={active}
                    onClick={() => handleSelectAgentDrawing(artifact)}
                    onDoubleClick={() => beginRename(artifact.id, artifact.title)}
                    title={artifact.title}
                    className="min-h-[34px]"
                    buttonClassName="items-center gap-2 px-2.5 py-2"
                    trailing={
                      <>
                        {artifact.versions.length > 1 ? (
                          <span className="text-[11.5px] text-ds-faint">v{artifact.versions.length}</span>
                        ) : null}
                        {status}
                      </>
                    }
                    actions={
                      <SidebarIconButton
                        onClick={() => removeArtifact(artifact.id)}
                        title={t('designDeleteArtifact')}
                        ariaLabel={t('designDeleteArtifact')}
                        tone="danger"
                        stopPropagation
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                      </SidebarIconButton>
                    }
                  >
                    <Palette className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.9} />
                    <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
                  </SidebarTreeRow>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  const renderAgentDrawingsSection = (items: DesignArtifact[]): ReactElement => {
    const toggleLabel = t(agentDrawingsOpen ? 'designAgentDrawingsCollapse' : 'designAgentDrawingsExpand')
    return (
      <section>
        <button
          type="button"
          onClick={() => setAgentDrawingsOpen((open) => !open)}
          title={toggleLabel}
          aria-label={toggleLabel}
          className="flex w-full items-center gap-1 px-2.5 pb-2 pt-5 text-left text-[12px] font-normal text-[#9aa5b5] transition hover:text-ds-muted dark:text-white/35 dark:hover:text-white/55"
        >
          {agentDrawingsOpen ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
          )}
          <span className="min-w-0 flex-1 truncate">{t('designAgentDrawingsTitle')}</span>
          <span className="shrink-0 text-[11.5px] text-ds-faint">{items.length}</span>
        </button>
        {agentDrawingsOpen ? renderAgentDrawingRows(items) : null}
      </section>
    )
  }

  // The board canvas is an implementation surface, so keep the tree focused on
  // user-created drafts while exposing board layers below.
  const renderActiveDocBody = (): ReactElement => {
    const items = grouped.html.filter((artifact) => !agentDrawingArtifactIds.has(artifact.id))
    return (
      <div className="ml-3 mt-0.5 space-y-1 border-l border-[var(--ds-sidebar-row-ring)] pl-2">
        {items.length > 0 ? (
          renderArtifactRows(items)
        ) : agentDrawingArtifacts.length === 0 && activeArtifact?.kind !== 'canvas' ? (
          <div className="px-2.5 py-1.5 text-[12px] leading-5 text-ds-faint">{t('designDocEmpty')}</div>
        ) : null}
        {agentDrawingArtifacts.length > 0 ? renderAgentDrawingsSection(agentDrawingArtifacts) : null}
        {activeArtifact?.kind === 'canvas' ? (
          <section>
            <SidebarSectionHeader label={t('canvasLayersTitle')} />
            <CanvasLayersPanel />
          </section>
        ) : null}
      </div>
    )
  }

  const renderDocument = (doc: DesignDocument): ReactElement => {
    const isActive = doc.id === activeDocumentId
    const isSlides = designDocumentKind(doc) === 'slides'
    const screenCount = getDesignSidebarDocumentScreenCount(doc)
    const documentLabel = getDesignSidebarDocumentLabel(doc)
    return (
      <li key={doc.id}>
        {editingDocId === doc.id ? (
          <div className="flex min-h-[34px] items-center rounded-[8px] bg-[var(--ds-sidebar-row-active)] px-2.5 py-1 shadow-[inset_0_0_0_1px_var(--ds-sidebar-row-ring)]">
            <input
              autoFocus
              value={docDraft}
              onChange={(e) => setDocDraft(e.target.value)}
              onBlur={() => commitRenameDoc(doc.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRenameDoc(doc.id)
                else if (e.key === 'Escape') setEditingDocId(null)
              }}
              className="h-7 min-w-0 flex-1 rounded-md border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-focus)] px-2 text-[13px] text-[#1f2733] outline-hidden focus:border-[#3b82d8] dark:text-white"
            />
          </div>
        ) : (
          <SidebarTreeRow
            active={isActive}
            onClick={() => handleSelectDocument(doc.id)}
            onDoubleClick={() => beginRenameDoc(doc.id, documentLabel)}
            title={`@${documentLabel}`}
            className="min-h-[34px]"
            buttonClassName="items-center gap-2 px-2.5 py-2"
            actionsVisibility="hidden"
            trailing={
              screenCount > 0 ? (
                <span className="text-[11.5px] text-ds-faint">{screenCount}</span>
              ) : null
            }
            actions={
              <>
                <SidebarIconButton
                  onClick={() => beginRenameDoc(doc.id, documentLabel)}
                  title={t('designRenameDocument')}
                  ariaLabel={t('designRenameDocument')}
                  stopPropagation
                >
                  <Pencil className="h-3.5 w-3.5" strokeWidth={1.9} />
                </SidebarIconButton>
                <SidebarIconButton
                  onClick={() => removeDocument(doc.id)}
                  title={t('designDeleteDocument')}
                  ariaLabel={t('designDeleteDocument')}
                  tone="danger"
                  stopPropagation
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                </SidebarIconButton>
              </>
            }
          >
            {isSlides ? (
              <Presentation
                className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-[#3b82d8]' : 'text-ds-muted'}`}
                strokeWidth={1.9}
              />
            ) : isActive ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[#3b82d8]" strokeWidth={1.9} />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.9} />
            )}
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="min-w-0 truncate font-mono">{documentLabel}</span>
            </span>
          </SidebarTreeRow>
        )}
        {/* slides 设计稿没有自由画布 screens/layers,body 只对 board 渲染。 */}
        {isActive && !isSlides ? renderActiveDocBody() : null}
      </li>
    )
  }

  return (
    <>
      <SidebarFrame
        title={t('appName')}
        titlebarContent={
          /* 「返回工作区」放在红绿灯右侧的标题栏,腾出侧栏首屏给新建/文稿区 */
          <WorkspaceModeTabs
            activeView="design"
            onCodeOpen={onCodeOpen}
            onWriteOpen={onWriteOpen}
            onDesignOpen={onDesignOpen}
          />
        }
        footer={
          <div className="space-y-1">
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <SidebarCommandRow
                  icon={<Settings className="h-4 w-4" strokeWidth={1.75} />}
                  label={t('settings')}
                  onClick={() => onOpenSettings('design')}
                  variant="footer"
                />
              </div>
              <SidebarIconButton
                title={isDarkMode ? t('switchToLight') : t('switchToDark')}
                ariaLabel={t('toggleTheme')}
                onClick={onToggleTheme}
              >
                {isDarkMode ? (
                  <Sun className="h-4 w-4" strokeWidth={1.75} />
                ) : (
                  <Moon className="h-4 w-4" strokeWidth={1.75} />
                )}
              </SidebarIconButton>
            </div>
          </div>
        }
      >
        <div className="ds-no-drag flex flex-col px-1">
          <SidebarCommandRow
            icon={<FilePlus2 className="h-4 w-4" strokeWidth={1.9} />}
            label={t('slidesNewBoard')}
            onClick={() => toggleKindFilter('board')}
            variant="accent"
            active={kindFilter === 'board'}
            trailing={
              // 嵌在 button 里的「+」不能用 button 元素(非法嵌套),用 span + role 模拟;
              // stopPropagation 保证点 + 只弹命名框、不触发行主体的过滤切换。
              <span
                role="button"
                tabIndex={0}
                title={t('designCreateDocumentTitle', { kind: t('slidesNewBoard') })}
                aria-label={t('designCreateDocumentTitle', { kind: t('slidesNewBoard') })}
                onClick={(e) => {
                  e.stopPropagation()
                  openCreatePrompt('board')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation()
                    openCreatePrompt('board')
                  }
                }}
                className="flex h-5 w-5 items-center justify-center rounded-md text-ds-faint transition hover:bg-[var(--ds-sidebar-row-hover)] hover:text-ds-muted"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden="true" />
              </span>
            }
          />
          <SidebarCommandRow
            icon={<Presentation className="h-4 w-4" strokeWidth={1.9} />}
            label={t('slidesNewDeck')}
            onClick={() => toggleKindFilter('slides')}
            variant="accent"
            active={kindFilter === 'slides'}
            trailing={
              <span
                role="button"
                tabIndex={0}
                title={t('designCreateDocumentTitle', { kind: t('slidesNewDeck') })}
                aria-label={t('designCreateDocumentTitle', { kind: t('slidesNewDeck') })}
                onClick={(e) => {
                  e.stopPropagation()
                  openCreatePrompt('slides')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation()
                    openCreatePrompt('slides')
                  }
                }}
                className="flex h-5 w-5 items-center justify-center rounded-md text-ds-faint transition hover:bg-[var(--ds-sidebar-row-hover)] hover:text-ds-muted"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden="true" />
              </span>
            }
          />
        </div>

        <div className="ds-no-drag flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            <SidebarSectionHeader
              label={t('designSidebarDocsSection')}
              actions={
                visibleDocuments.length > 0 ? (
                  <span className="text-[11.5px] text-ds-faint">{visibleDocuments.length}</span>
                ) : null
              }
            />
            {sortedDocuments.length === 0 ? (
              <div className="mx-2 mt-2 rounded-lg px-2 py-2">
                <p className="text-[15px] font-medium text-ds-muted">{t('designNewDocument')}</p>
                <p className="mt-1 text-[13px] leading-5 text-ds-faint">{t('designSidebarEmpty')}</p>
              </div>
            ) : visibleDocuments.length === 0 ? (
              <div className="mx-2 mt-2 rounded-lg px-2 py-2">
                <p className="text-[13px] leading-5 text-ds-faint">{t('designSidebarFilterEmpty')}</p>
              </div>
            ) : (
              <ul className="space-y-0.5">{visibleDocuments.map((doc) => renderDocument(doc))}</ul>
            )}
          </div>
        </div>
      </SidebarFrame>
      {/* 新建文稿命名对话框:fixed 居中,覆盖整个设计区(侧栏太窄放不下) */}
      {createPrompt ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35"
          role="dialog"
          aria-modal="true"
          aria-label={t('designCreateDocumentTitle', { kind: t(createPrompt.kind === 'slides' ? 'slidesNewDeck' : 'slidesNewBoard') })}
          onClick={() => setCreatePrompt(null)}
        >
          <div
            className="w-[320px] rounded-xl bg-ds-main p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-[14px] font-semibold text-ds-strong">
              {t('designCreateDocumentTitle', { kind: t(createPrompt.kind === 'slides' ? 'slidesNewDeck' : 'slidesNewBoard') })}
            </h2>
            <input
              autoFocus
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmCreatePrompt()
                else if (e.key === 'Escape') setCreatePrompt(null)
              }}
              placeholder={t('designCreateDocumentNamePlaceholder')}
              className="mt-3 h-8 w-full rounded-lg border border-black/12 bg-transparent px-2.5 text-[13px] text-ds-strong outline-hidden focus:border-[#3b82d8] dark:border-white/12"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreatePrompt(null)}
                className="h-8 rounded-lg px-3 text-[13px] text-ds-muted transition hover:text-ds-strong"
              >
                {t('slidesCancel')}
              </button>
              <button
                type="button"
                disabled={createName.trim().length === 0}
                onClick={confirmCreatePrompt}
                className="h-8 rounded-lg bg-[#3b82d8] px-3 text-[13px] font-medium text-white transition hover:bg-[#2f72c4] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {t('designCreateDocumentConfirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
