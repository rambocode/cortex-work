import { memo, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  ArrowLeft,
  ChevronDown,
  Layers,
  Loader2,
  Globe,
  MessageSquare,
  Plus,
  Sparkles,
  StopCircle,
  Target,
  X
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from './compat/format-relative-time'
import { deriveThreadTitleFromPrompt } from '@cortex-work/core/design/compat/thread-title'
import type { AttachmentReference, NormalizedThread, RuntimeConnectionStatus, ChatBlock } from '@cortex-work/core/design/compat/agent-types'
import { getProvider } from '@cortex-work/core/design/compat/agent-registry'
import type { QueuedUserMessage } from '@cortex-work/core/design/compat/chat-store-types'
import { threadSnapshotLooksRunning } from '@cortex-work/core/design/compat/chat-store-runtime-helpers'
import type { ModelProviderModelGroup } from '@cortex-work/core/design/compat/kun-gui-api'
import { DESIGN_ASSISTANT_THREAD_TITLE } from '@cortex-work/core/design/design-thread-registry'
import { useDesignWorkspaceStore } from '@cortex-work/core/design/design-workspace-store'
import { defaultFrameSizeForDesignTarget } from '@cortex-work/core/design/design-context'
import { cancelDesignPagesRun } from '@cortex-work/core/design/design-pages-run'
import {
  slidesSelectionCount,
  type SlidesPageSnapshot,
  type SlidesSelectionSnapshot
} from '@cortex-work/core/design/slides/slides-selection'
import type { AgentKind, DerivedAgentMeta } from '@cortex-work/core'
import { MessageTimeline } from './compat/MessageTimeline'
import { FloatingComposer } from './compat/FloatingComposer'
import type { ComposerPendingImage, ComposerPendingTextFile } from './compat/FloatingComposer'
import type { DesignComposerContext } from './compat/FloatingComposer'
import type { ComposerReasoningEffort } from './compat/FloatingComposerModelPicker'
import { DesignTargetToggle } from './DesignTargetToggle'
import { AgentSelect } from '../personal/chat/AgentSelect'

type Props = {
  input: string
  setInput: (value: string) => void
  mode: 'plan' | 'agent'
  setMode: (value: 'plan' | 'agent') => void
  busy: boolean
  runtimeConnection: RuntimeConnectionStatus
  activeThreadId: string | null
  blocks: ChatBlock[]
  liveReasoning: string
  liveAssistant: string
  composerModel: string
  composerProviderId?: string
  composerPickList: string[]
  composerModelGroups?: ModelProviderModelGroup[]
  composerReasoningEffort: ComposerReasoningEffort
  setComposerModel: (modelId: string, providerId?: string) => void
  setComposerReasoningEffort: (effort: ComposerReasoningEffort) => void
  queuedMessages: QueuedUserMessage[]
  removeQueuedMessage: (id: string) => void
  attachments?: AttachmentReference[]
  attachmentUploadEnabled?: boolean
  attachmentUploadBusy?: boolean
  attachmentUploadError?: string | null
  contextChips?: DesignComposerContext[]
  onPickAttachments?: (files: File[]) => void
  onPasteClipboardImage?: (options?: { silentNoImage?: boolean }) => void | Promise<void>
  onRemoveAttachment?: (id: string) => void
  onRemoveContextChip?: (id: string) => void
  onSend: () => void
  onInterrupt: (options?: { discard?: boolean }) => void
  onRetryConnection: () => void
  onOpenSettings: (section?: string) => void
  onConfigureProviders?: () => void
  onNewConversation: () => void
  designThreads: NormalizedThread[]
  onSwitchThread: (threadId: string) => void
  onCollapse: () => void
  // 设计助手栏 agent 选择器（DesignWorkspace 容器接线时 slides/board 两模式都显示）：
  // designAgent 为当前 base agent,designDerivedAgentId 为选中的派生 id;onSwitchAgent 切换后
  // 由容器落 designSettings。二者均可选——未接线的次级消费方(如 DesignRightPanelContent)不渲染选择器。
  designAgent?: AgentKind
  designDerivedAgentId?: string
  agentsAvailable?: Partial<Record<AgentKind, boolean>>
  derivedAgents?: DerivedAgentMeta[]
  onSwitchAgent?: (agent: AgentKind, derived?: DerivedAgentMeta) => void
  className?: string
  /**
   * 演示文稿(slides)设计稿:右栏复用同一会话管线,但上下文语义不同 ——
   * 隐藏「Web/App 目标 + 1280×800 Web 画布」这类自由画布专属控件(对 16:9 演示页是错的),
   * 换成 slides 自己的空态/占位文案。
   */
  slidesMode?: boolean
  /** bento 编辑器当前页；自动显示且不可清除，发送时作为页级请求默认目标。 */
  slidesCurrentPage?: SlidesPageSnapshot | null
  /**
   * bento 编辑器内的当前选区(仅 slidesMode 有意义)。有选区时在上下文行显示引用 chip,
   * 让用户看得见「agent 这一轮会盯着哪些元素改」;发送时由容器并入 slides 回合 prompt。
   */
  slidesSelection?: SlidesSelectionSnapshot | null
  /** 清除引用:只抑制本次显示与本轮注入,用户下次改选区会自动恢复。 */
  onClearSlidesSelection?: () => void
  /** 待发图片(粘贴 / 选取 / 拖入);由容器持有,发送后清空。 */
  composerImages?: ComposerPendingImage[]
  onAddComposerImages?: (files: File[]) => void
  onRemoveComposerImage?: (id: string) => void
  slidesWebSearch?: boolean
  slidesWebSearchUnavailable?: boolean
  onToggleSlidesWebSearch?: () => void
  composerTextFiles?: ComposerPendingTextFile[]
  composerTextFileAccept?: string
  onAddComposerTextFiles?: (files: File[]) => void
  onRemoveComposerTextFile?: (id: string) => void
}

export function designThreadTitleLooksDefault(
  title: string | null | undefined,
  localizedDefaultTitle?: string
): boolean {
  const raw = title?.trim() ?? ''
  if (!raw) return true
  return raw === DESIGN_ASSISTANT_THREAD_TITLE || raw === localizedDefaultTitle?.trim()
}

export function deriveDesignThreadTitleFromBlocks(blocks: readonly ChatBlock[]): string {
  const firstUser = blocks.find((block) => block.kind === 'user')
  if (!firstUser || firstUser.kind !== 'user') return ''
  const text = (firstUser.meta?.displayText ?? firstUser.text).trim()
  if (!text) return ''
  return deriveThreadTitleFromPrompt(text)
}

function DesignAIRailInner({
  input,
  setInput,
  mode,
  setMode,
  busy,
  runtimeConnection,
  activeThreadId,
  blocks,
  liveReasoning,
  liveAssistant,
  composerModel,
  composerProviderId,
  composerPickList,
  composerModelGroups = [],
  composerReasoningEffort,
  setComposerModel,
  setComposerReasoningEffort,
  queuedMessages,
  removeQueuedMessage,
  attachments = [],
  attachmentUploadEnabled = false,
  attachmentUploadBusy = false,
  attachmentUploadError = null,
  contextChips = [],
  onPickAttachments,
  onPasteClipboardImage,
  onRemoveAttachment,
  onRemoveContextChip,
  onSend,
  onInterrupt,
  onRetryConnection,
  onOpenSettings,
  onConfigureProviders,
  onNewConversation,
  designThreads,
  onSwitchThread,
  designAgent,
  designDerivedAgentId,
  agentsAvailable,
  derivedAgents,
  onSwitchAgent,
  className = '',
  slidesMode = false,
  slidesCurrentPage = null,
  slidesSelection = null,
  onClearSlidesSelection,
  composerImages,
  onAddComposerImages,
  onRemoveComposerImage,
  slidesWebSearch = false,
  slidesWebSearchUnavailable = false,
  onToggleSlidesWebSearch,
  composerTextFiles,
  composerTextFileAccept,
  onAddComposerTextFiles,
  onRemoveComposerTextFile
}: Props): ReactElement {
  const { t, i18n } = useTranslation('design')
  const workspaceRoot = useDesignWorkspaceStore((s) => s.workspaceRoot)
  const artifacts = useDesignWorkspaceStore((s) => s.artifacts)
  const activeArtifactId = useDesignWorkspaceStore((s) => s.activeArtifactId)
  const designIntentMode = useDesignWorkspaceStore((s) => s.designIntentMode)
  const designTarget = useDesignWorkspaceStore((s) => s.designContext.designTarget ?? 'web')
  const setDesignTarget = useDesignWorkspaceStore((s) => s.setDesignTarget)
  const multiPageMode = useDesignWorkspaceStore((s) => s.multiPageMode)
  const setMultiPageMode = useDesignWorkspaceStore((s) => s.setMultiPageMode)
  const pagesRun = useDesignWorkspaceStore((s) => s.pagesRun)
  const [threadListOpen, setThreadListOpen] = useState(false)
  const threadListRef = useRef<HTMLDivElement | null>(null)
  const threadPillRef = useRef<HTMLButtonElement | null>(null)
  const [childThreadId, setChildThreadId] = useState<string | null>(null)
  const [childBlocks, setChildBlocks] = useState<ChatBlock[]>([])
  const [childStatus, setChildStatus] = useState<string | undefined>(undefined)
  const [childLoading, setChildLoading] = useState(false)
  const [childError, setChildError] = useState<string | null>(null)
  const [threadTitleOverrides, setThreadTitleOverrides] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!threadListOpen) return
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target
      if (!(target instanceof Node)) return
      if (threadListRef.current?.contains(target)) return
      if (threadPillRef.current?.contains(target)) return
      setThreadListOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setThreadListOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [threadListOpen])

  useEffect(() => {
    const missing = designThreads.filter(
      (thread) =>
        designThreadTitleLooksDefault(thread.title, t('designRailTitle')) &&
        !threadTitleOverrides[thread.id]
    )
    if (missing.length === 0) return
    let cancelled = false
    for (const thread of missing) {
      void getProvider()
        .getThreadDetail(thread.id)
        .then((detail) => {
          if (cancelled) return
          const title = deriveDesignThreadTitleFromBlocks(detail.blocks)
          if (!title || designThreadTitleLooksDefault(title, t('designRailTitle'))) return
          setThreadTitleOverrides((current) =>
            current[thread.id] ? current : { ...current, [thread.id]: title }
          )
        })
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
  }, [designThreads, t, threadTitleOverrides])

  useEffect(() => {
    setChildThreadId(null)
    setChildBlocks([])
    setChildStatus(undefined)
    setChildError(null)
  }, [activeThreadId])

  useEffect(() => {
    if (!childThreadId) {
      setChildBlocks([])
      setChildStatus(undefined)
      setChildError(null)
      setChildLoading(false)
      return
    }
    let cancelled = false
    let pollTimer: number | null = null
    setChildLoading(true)
    setChildError(null)
    const load = async (): Promise<void> => {
      try {
        const detail = await getProvider().getThreadDetail(childThreadId)
        if (cancelled) return
        setChildBlocks(detail.blocks)
        // DesignThreadDetail 用 `& Record<string, unknown>` 兜底，threadStatus 被擦成 unknown，
        // 这里按运行时约定收窄回 string | undefined（compat 类型缺口，不改 core 类型）。
        const threadStatus = detail.threadStatus as string | undefined
        setChildStatus(threadStatus)
        setChildError(null)
        const shouldPoll = threadSnapshotLooksRunning(detail.blocks, threadStatus)
        if (shouldPoll) {
          pollTimer = window.setTimeout(load, 1500)
        }
      } catch (error) {
        if (!cancelled) {
          setChildError(error instanceof Error ? error.message : String(error))
        }
      } finally {
        if (!cancelled) setChildLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (pollTimer !== null) window.clearTimeout(pollTimer)
    }
  }, [childThreadId])


  const activeThread = designThreads.find((th) => th.id === activeThreadId) ?? null
  const showingDocumentThread = Boolean(activeThread)
  const viewingChildThread = Boolean(childThreadId)

  const timelineBlocks = viewingChildThread ? childBlocks : showingDocumentThread ? blocks : []
  const timelineThreadId = viewingChildThread ? childThreadId : showingDocumentThread ? activeThreadId : null
  const timelineLiveReasoning = viewingChildThread ? '' : showingDocumentThread ? liveReasoning : ''
  const timelineLiveAssistant = viewingChildThread ? '' : showingDocumentThread ? liveAssistant : ''
  const hasTimeline = viewingChildThread
    ? childBlocks.length > 0
    : showingDocumentThread && (
      blocks.length > 0 || liveReasoning.trim().length > 0 || liveAssistant.trim().length > 0
    )
  const runActive = Boolean(pagesRun)
  const activeArtifact = artifacts.find((artifact) => artifact.id === activeArtifactId) ?? null
  const designTargetContextChip = contextChips.find((chip) => chip.kind === 'design-target') ?? null
  const targetSize = defaultFrameSizeForDesignTarget(designTarget)
  const appTarget = designTarget === 'app'
  const targetChipMatchesSelection = designTargetContextChip?.id === `design-target:${designTarget}`
  const designTargetLabel = t(appTarget ? 'designTargetApp' : 'designTargetWeb')
  const designTargetDetail =
    (targetChipMatchesSelection ? designTargetContextChip?.detail : undefined) ??
    t(appTarget ? 'designTargetContextApp' : 'designTargetContextWeb', {
      width: targetSize.width,
      height: targetSize.height
    })
  const designTargetStatusTitle = `${t('designTargetContextStatus')}: ${designTargetLabel} - ${designTargetDetail}`
  const primaryContextChip = contextChips.find((chip) => chip.kind !== 'design-target') ?? null
  // Keep the composer + new-conversation locked across the whole multi-page run,
  // even during the brief idle gaps between page turns.
  const effectiveBusy = (showingDocumentThread && busy) || runActive
  const canCreateConversation = runtimeConnection === 'ready' && !effectiveBusy && !viewingChildThread
  // slides 设计稿没有自由画布产物,多页规划(Kun 的 board 多页 fanout)不适用。
  const showMultiPageToggle =
    !slidesMode && designIntentMode === 'generate' && !runActive && activeArtifact?.kind !== 'canvas'
  const contextLabel = primaryContextChip
    ? `${designIntentMode === 'preview' ? t('designProjectPreview') : t('designProjectModify')} · ${primaryContextChip.label}`
    : ''
  const showContextControls =
    !viewingChildThread && (runActive || Boolean(primaryContextChip) || showMultiPageToggle)
  const titleForDesignThread = (thread: NormalizedThread, index: number): string => {
    const localizedDefault = t('designRailTitle')
    if (!designThreadTitleLooksDefault(thread.title, localizedDefault)) return thread.title
    const fromActiveBlocks =
      thread.id === activeThreadId && !viewingChildThread
        ? deriveDesignThreadTitleFromBlocks(blocks)
        : ''
    return (
      fromActiveBlocks ||
      threadTitleOverrides[thread.id] ||
      t('designRailDrawingFallback', { number: index + 1 })
    )
  }
  const activeThreadIndex = activeThread
    ? Math.max(0, designThreads.findIndex((thread) => thread.id === activeThread.id))
    : 0
  const activeThreadTitle = activeThread ? titleForDesignThread(activeThread, activeThreadIndex) : ''
  const headerTitle = viewingChildThread
    ? t('subagentSessionBannerTitle')
    : activeThreadTitle || t(slidesMode ? 'slidesRailTitle' : 'designRailTitle')
  // slides 的空态/占位面向「演示主题」,不是「设计界面」。
  const railEmptyText = t(slidesMode ? 'slidesRailEmpty' : 'designRailEmpty')
  const railPlaceholder = t(slidesMode ? 'slidesRailPlaceholder' : 'designRailPlaceholder')

  const openChildThread = (threadId: string): void => {
    setThreadListOpen(false)
    setChildThreadId(threadId)
  }

  const closeChildThread = (): void => {
    setChildThreadId(null)
    setChildBlocks([])
    setChildStatus(undefined)
    setChildError(null)
  }

  return (
    <aside
      className={`design-ai-panel ds-no-drag relative flex min-h-0 flex-col overflow-hidden border-l border-ds-border-muted bg-white text-ds-ink backdrop-blur-xl dark:bg-ds-canvas ${className}`}
    >
        <div className="shrink-0 border-b border-ds-border-muted bg-white/92 px-3 py-3 dark:bg-ds-card">
          <div className="flex min-w-0 items-center gap-2">
            <button
              ref={threadPillRef}
              type="button"
              onClick={() => {
                if (viewingChildThread) return
                setThreadListOpen((v) => !v)
              }}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-ds-subtle px-3 py-2 transition hover:bg-ds-hover dark:bg-white/[0.08] dark:hover:bg-white/[0.12]"
              title={viewingChildThread ? t('subagentSessionBannerTitle') : t('designRailSwitchThread')}
              aria-label={viewingChildThread ? t('subagentSessionBannerTitle') : t('designRailSwitchThread')}
            >
              <Sparkles className="h-4 w-4 shrink-0 text-accent" strokeWidth={1.8} />
              <span className="min-w-0 truncate text-[13px] font-semibold text-ds-ink">
                {headerTitle}
              </span>
              {!viewingChildThread ? (
                <ChevronDown
                  className="ml-auto h-3 w-3 shrink-0 text-ds-faint transition-transform"
                  style={threadListOpen ? { transform: 'rotate(180deg)' } : undefined}
                  strokeWidth={2}
                />
              ) : null}
            </button>
            <button
              type="button"
              onClick={onNewConversation}
              disabled={!canCreateConversation}
              className="ds-sidebar-toggle-button shrink-0 disabled:cursor-not-allowed disabled:opacity-45"
              title={t('designRailNewConversation')}
              aria-label={t('designRailNewConversation')}
            >
              <Plus className="h-4 w-4" strokeWidth={2.1} />
            </button>
          </div>
        </div>

        {threadListOpen && !viewingChildThread ? (
          <div
            ref={threadListRef}
            className="absolute left-2 right-2 top-[58px] z-[60] max-h-[280px] overflow-y-auto rounded-2xl border border-ds-border bg-white p-1.5 shadow-[0_14px_34px_rgba(20,47,95,0.16)] dark:bg-ds-card"
          >
            {designThreads.length === 0 ? (
              <p className="px-2.5 py-3 text-center text-[12.5px] text-ds-faint">
                {railEmptyText}
              </p>
            ) : (
              designThreads.map((thread, index) => (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => {
                    onSwitchThread(thread.id)
                    setThreadListOpen(false)
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${
                    thread.id === activeThreadId
                      ? 'bg-accent/10 text-accent'
                      : 'text-ds-ink hover:bg-ds-hover'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-[13px]">{titleForDesignThread(thread, index)}</span>
                  <span className="shrink-0 text-[11px] text-ds-faint tabular-nums">
                    {formatRelativeTime(thread.updatedAt, i18n.language)}
                  </span>
                </button>
              ))
            )}
            <div className="mt-0.5 border-t border-ds-border-muted/60 pt-1">
              <button
                type="button"
                onClick={() => {
                  onNewConversation()
                  setThreadListOpen(false)
                }}
                disabled={!canCreateConversation}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-ds-muted transition hover:bg-ds-hover disabled:opacity-45"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                <span>{t('designRailNewConversation')}</span>
              </button>
            </div>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-white/36 dark:bg-transparent">
          {viewingChildThread ? (
            <div className="sticky top-0 z-20 border-b border-ds-border-muted/80 bg-white/88 px-4 py-3 backdrop-blur-xl dark:bg-ds-card/88">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={closeChildThread}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-ds-border bg-white px-2.5 text-[12px] font-semibold text-ds-muted shadow-xs transition hover:bg-ds-hover hover:text-ds-ink dark:bg-white/8"
                >
                  <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.9} />
                  {t('designRailChildBack', '返回设计主会话')}
                </button>
                <div className="min-w-0 flex-1 text-right">
                  <div className="truncate text-[12.5px] font-semibold text-ds-ink">
                    {t('subagentSessionBannerTitle')}
                  </div>
                  <div className="truncate text-[10.5px] text-ds-faint">
                    {childLoading ? t('designRailChildLoading', '加载子代理输出中…') : childStatus || childThreadId}
                  </div>
                </div>
              </div>
              {childError ? (
                <div className="mt-2 rounded-lg border border-red-200 bg-red-50/80 px-2.5 py-2 text-[12px] leading-5 text-red-700">
                  {t('designRailChildError', '子代理会话加载失败')}: {childError}
                </div>
              ) : null}
            </div>
          ) : null}
          {viewingChildThread && childLoading && childBlocks.length === 0 ? (
            <div className="flex h-40 items-center justify-center gap-2 text-[12.5px] font-medium text-ds-muted">
              <Loader2 className="h-4 w-4 animate-spin text-accent" strokeWidth={2} />
              {t('designRailChildLoading')}
            </div>
          ) : hasTimeline ? (
            <MessageTimeline
              blocks={timelineBlocks}
              liveReasoning={timelineLiveReasoning}
              live={timelineLiveAssistant}
              busy={effectiveBusy}
              busyLabel={t(slidesMode ? 'slidesRailWorking' : 'designAgentManagerStatusRunning')}
              activeThreadId={timelineThreadId}
              runtimeConnection={runtimeConnection}
              onRetryConnection={onRetryConnection}
              onOpenSettings={() => onOpenSettings('agents')}
              onSelectSuggestion={(text: string) => setInput(text)}
              // 编辑重发:回合可能因供应商侧错误失败(如 402 Insufficient Balance),
              // 原话只留在气泡里、得手打一遍才能重试。回填后聚焦输入框直接改。
              onEditUserMessage={(text: string) => {
                setInput(text)
                requestAnimationFrame(() => {
                  const el = document.querySelector<HTMLTextAreaElement>('[data-design-rail-composer] textarea')
                  el?.focus()
                  el?.setSelectionRange(text.length, text.length)
                })
              }}
              onOpenChildThread={openChildThread}
              compactCards
            />
          ) : !viewingChildThread ? (
            <div className="flex h-full items-center justify-center px-7 text-center">
              <div className="max-w-[260px]">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-[18px] border border-ds-border-muted bg-white/70 text-accent shadow-xs dark:bg-white/8">
                  <MessageSquare className="h-5 w-5" strokeWidth={1.55} />
                </div>
                <p className="mt-3 text-[13px] leading-6 text-ds-muted">
                  {railEmptyText}
                </p>
              </div>
            </div>
          ) : null}
        </div>

      <div
        data-design-rail-composer
        className="shrink-0 border-t border-ds-border-muted bg-white/92 px-4 pb-4 pt-3 dark:bg-ds-card"
      >
        {!viewingChildThread ? (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {/* 设计助手栏 agent 选择器:容器接线时 slides/board 两模式都显示,菜单向上弹避免被下方 composer 遮挡。 */}
            {designAgent && onSwitchAgent ? (
              <AgentSelect
                menuPlacement="up"
                // 选择器在 chip 行最左侧:默认右对齐会让菜单向左越过右栏边界被裁(用户实测)。
                menuAlign="left"
                agent={designAgent}
                derivedAgentId={designDerivedAgentId}
                agentsAvailable={agentsAvailable}
                derivedAgents={derivedAgents}
                onSwitch={onSwitchAgent}
              />
            ) : null}
            {/* slides:Web/App 目标与「1280×800 Web 画布」对演示文稿是错的上下文,
                换成固定的 16:9 演示画布提示(尺寸由 deck 合同锁死,用户无需选)。 */}
            {slidesMode ? (
              <div
                className="flex max-w-full items-center gap-1.5 rounded-full border border-accent/25 bg-accent/10 px-3 py-2 text-[12.5px] font-semibold text-ds-muted"
                title={t('slidesRailContextHint')}
                aria-label={t('slidesRailContextHint')}
              >
                <Target className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={1.8} />
                <span className="shrink-0 text-ds-ink">{t('slidesRailContextLabel')}</span>
                <span className="text-ds-faint">·</span>
                <span className="shrink-0 text-ds-ink">{t('slidesRailContextCanvas')}</span>
              </div>
            ) : null}
            {slidesMode && slidesCurrentPage ? (
              <div
                data-testid="slides-current-page-chip"
                className="flex max-w-full items-center gap-1.5 rounded-full border border-ds-border bg-ds-surface-subtle px-3 py-2 text-[12.5px] font-semibold text-ds-muted dark:bg-white/6"
                title={
                  slidesCurrentPage.slideName
                    ? t('slidesCurrentPageNamed', {
                        index: slidesCurrentPage.slideIndex + 1,
                        name: slidesCurrentPage.slideName
                      })
                    : t('slidesCurrentPage', { index: slidesCurrentPage.slideIndex + 1 })
                }
              >
                <Layers className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={1.8} />
                <span className="shrink-0 text-ds-ink">
                  {t('slidesCurrentPage', { index: slidesCurrentPage.slideIndex + 1 })}
                </span>
                {slidesCurrentPage.slideName ? (
                  <>
                    <span className="text-ds-faint">·</span>
                    <span className="min-w-0 truncate">{slidesCurrentPage.slideName}</span>
                  </>
                ) : null}
              </div>
            ) : null}
            {slidesMode && onToggleSlidesWebSearch ? (
              <button
                type="button"
                data-testid="slides-web-search-pill"
                aria-pressed={slidesWebSearch}
                aria-label={t('slidesWebSearchLabel')}
                title={
                  slidesWebSearchUnavailable
                    ? t('slidesWebSearchUnconfiguredTitle')
                    : slidesWebSearch
                      ? t('slidesWebSearchOnTitle')
                      : t('slidesWebSearchOffTitle')
                }
                disabled={effectiveBusy || slidesWebSearchUnavailable}
                onClick={onToggleSlidesWebSearch}
                className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-2 text-[12.5px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 ${
                  slidesWebSearch
                    ? 'border-accent bg-accent text-white'
                    : 'border-ds-border bg-ds-surface-subtle text-ds-muted hover:text-ds-ink dark:bg-white/6'
                }`}
              >
                <Globe className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
                {t('slidesWebSearchLabel')}
              </button>
            ) : null}
            {/* slides 选区引用:让用户在发消息前就看见「这一轮 agent 会盯着哪些元素改」。
                与上面的演示上下文 chip 并列,而不是走 primaryContextChip —— 那条链路是
                自由画布的产物上下文,容器从未给 slides 接线。 */}
            {slidesMode && slidesSelection ? (
              <div
                className="flex max-w-full items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-3 py-2 text-[12.5px] font-semibold text-ds-muted"
                data-testid="slides-selection-chip"
              >
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={1.8} />
                <span className="min-w-0 truncate text-ds-ink">
                  {t('slidesSelectionHint', { count: slidesSelectionCount(slidesSelection) })}
                </span>
                {onClearSlidesSelection ? (
                  <button
                    type="button"
                    onClick={onClearSlidesSelection}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
                    title={t('slidesSelectionClear')}
                    aria-label={t('slidesSelectionClear')}
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </button>
                ) : null}
              </div>
            ) : null}
            {!slidesMode ? (
              <>
                <DesignTargetToggle
                  designTarget={designTarget}
                  disabled={effectiveBusy}
                  disabledReason={effectiveBusy ? t('designTargetLockedHint') : undefined}
                  onChange={setDesignTarget}
                />
                <div
                  className="flex max-w-full items-center gap-1.5 rounded-full border border-accent/25 bg-accent/10 px-3 py-2 text-[12.5px] font-semibold text-ds-muted"
                  title={designTargetStatusTitle}
                  aria-label={designTargetStatusTitle}
                >
                  <Target className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={1.8} />
                  <span className="shrink-0 text-ds-ink">{t('designTargetContextStatus')}</span>
                  <span className="text-ds-faint">·</span>
                  <span className="shrink-0 text-ds-ink">{designTargetLabel}</span>
                  <span className="hidden min-w-0 truncate text-ds-faint sm:inline">{designTargetDetail}</span>
                </div>
              </>
            ) : null}
            {showContextControls ? (
              <>
            {pagesRun ? (
              <div className="flex max-w-full items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-2 text-[12.5px] font-semibold text-accent">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" strokeWidth={2} />
                <span className="min-w-0 truncate">
                  {pagesRun.phase === 'generating'
                    ? t('designPagesGenerating', {
                        done: Math.min(pagesRun.done + 1, pagesRun.total),
                        total: pagesRun.total,
                        title: pagesRun.title
                      })
                    : pagesRun.phase === 'foundation'
                      ? t('designPagesFoundation', { title: pagesRun.title })
                      : t('designPagesPlanning')}
                </span>
                <button
                  type="button"
                  onClick={() => cancelDesignPagesRun()}
                  className="flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] transition hover:bg-accent/15"
                  title={t('designPagesStop')}
                  aria-label={t('designPagesStop')}
                >
                  <StopCircle className="h-3.5 w-3.5" strokeWidth={1.9} />
                  {t('designPagesStop')}
                </button>
              </div>
            ) : (
              <>
                {primaryContextChip ? (
                  <div className="flex max-w-full items-center gap-2 rounded-full border border-ds-border bg-ds-surface-subtle px-3 py-2 text-[12.5px] font-semibold text-ds-muted dark:bg-white/6">
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={1.8} />
                    <span className="min-w-0 truncate">{contextLabel}</span>
                    {primaryContextChip.removable !== false && onRemoveContextChip ? (
                      <button
                        type="button"
                        onClick={() => onRemoveContextChip(primaryContextChip.id)}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
                        title={t('designProjectClearContext')}
                        aria-label={t('designProjectClearContext')}
                      >
                        <X className="h-3.5 w-3.5" strokeWidth={1.9} />
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {showMultiPageToggle ? (
                  <button
                    type="button"
                    onClick={() => setMultiPageMode(!multiPageMode)}
                    aria-pressed={multiPageMode}
                    title={t('designPagesToggleHint')}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-2 text-[12.5px] font-semibold transition ${
                      multiPageMode
                        ? 'border-accent bg-accent text-white'
                        : 'border-ds-border bg-ds-surface-subtle text-ds-muted hover:text-ds-ink dark:bg-white/6'
                    }`}
                  >
                    <Layers className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
                    {t('designPagesToggle')}
                  </button>
                ) : null}
              </>
            )}
              </>
            ) : null}
          </div>
        ) : null}
        {viewingChildThread ? (
          <div className="flex w-fit max-w-full items-center gap-2 rounded-full border border-ds-border bg-ds-surface-subtle px-3 py-2 text-[12.5px] font-semibold text-ds-muted dark:bg-white/6">
            <span>{t('subagentSessionBannerTitle')}</span>
            <button
              type="button"
              onClick={closeChildThread}
              className="inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11.5px] text-accent transition hover:bg-accent/10"
            >
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.9} />
              {t('designRailChildBack', '返回设计主会话')}
            </button>
          </div>
        ) : (
          <FloatingComposer
            variant="compact"
            workspaceRootOverride={workspaceRoot}
            placeholder={railPlaceholder}
            input={input}
            setInput={setInput}
            mode={mode}
            setMode={setMode}
            busy={effectiveBusy}
            runtimeReady={runtimeConnection === 'ready'}
            hasActiveThread={showingDocumentThread}
            composerModel={composerModel}
            composerProviderId={composerProviderId}
            composerPickList={composerPickList}
            composerModelGroups={composerModelGroups}
            composerReasoningEffort={composerReasoningEffort}
            onComposerModelChange={setComposerModel}
            onComposerReasoningEffortChange={setComposerReasoningEffort}
            modelPickerMode="combobox"
            queuedMessages={queuedMessages}
            onRemoveQueuedMessage={removeQueuedMessage}
            attachments={attachments}
            attachmentUploadEnabled={attachmentUploadEnabled}
            attachmentUploadBusy={attachmentUploadBusy}
            attachmentUploadError={attachmentUploadError}
            contextChips={contextChips}
            onPickAttachments={onPickAttachments}
            onPasteClipboardImage={onPasteClipboardImage}
            onRemoveAttachment={onRemoveAttachment}
            onRemoveContextChip={onRemoveContextChip}
            images={composerImages}
            onAddImages={onAddComposerImages}
            onRemoveImage={onRemoveComposerImage}
            textFiles={composerTextFiles}
            textFileAccept={composerTextFileAccept}
            onAddTextFiles={onAddComposerTextFiles}
            onRemoveTextFile={onRemoveComposerTextFile}
            onSend={onSend}
            onInterrupt={onInterrupt}
            onConfigureProviders={onConfigureProviders}
          />
        )}
      </div>
    </aside>
  )
}

export const DesignAIRail = memo(DesignAIRailInner)
