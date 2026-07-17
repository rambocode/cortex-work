// Slides Workspace:kind === 'slides' 的设计稿的中间区域(取代自由画布)。
// 布局:左缩略图栏 / 中舞台(顶部工具栏);右侧 Agent 会话栏由 DesignWorkspace 统一渲染。
// 挂载时 setup slides store(load deck,不存在则补建);deck 级错误渲染破损态。
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, TriangleAlert } from 'lucide-react'
import { useDesktopBridge } from '@cortex-work/core/provider'
import { sortedSlidesSlots, type SlidesFinding, type SlidesSlot } from '@cortex-work/core/design/slides/slides-types'
import { sendDesignMessage } from '@cortex-work/core/design/run/design-run-manager'
import { buildSlidesTurnPrompt } from '@cortex-work/core/design/slides/slides-prompt'
import { useChatStore } from '@cortex-work/core/design/compat/chat-store'
import { SlidesCheckPanel } from './SlidesCheckPanel'
import { SlidesExportQualityDialog, type SlidesExportOptimizationRequest } from './SlidesExportQualityDialog'
import { SlidesNotesPanel } from './SlidesNotesPanel'
import { SlidesOutlineDialog } from './SlidesOutlineDialog'
import { SlidesStage } from './SlidesStage'
import { SlidesThumbnailRail } from './SlidesThumbnailRail'
import { SlidesToolbar } from './SlidesToolbar'
import { SlidesWorkflowPanel } from './SlidesWorkflowPanel'
import { useSlidesStore } from './slides-store'
import type { SlidesPipelineRunKind, SlidesRole } from '@cortex-work/core/design/slides/slides-pipeline-types'

type Props = {
  workspaceRoot: string
  documentId: string
  documentTitle: string
}

export function SlidesWorkspace({ workspaceRoot, documentId, documentTitle }: Props): ReactElement {
  const { t } = useTranslation('design')
  const bridge = useDesktopBridge()
  const setup = useSlidesStore((s) => s.setup)
  const manifest = useSlidesStore((s) => s.manifest)
  const loading = useSlidesStore((s) => s.loading)
  const deckError = useSlidesStore((s) => s.deckError)
  const recoveredNotice = useSlidesStore((s) => s.recoveredNotice)
  const refresh = useSlidesStore((s) => s.refresh)
  const openOutlineDialog = useSlidesStore((s) => s.openOutlineDialog)
  const outlineDialogOpen = useSlidesStore((s) => s.outlineDialogOpen)
  const runCheck = useSlidesStore((s) => s.runCheck)
  const notesOpen = useSlidesStore((s) => s.notesOpen)
  const openNotes = useSlidesStore((s) => s.openNotes)
  const closeNotes = useSlidesStore((s) => s.closeNotes)
  const workflowOpen = useSlidesStore((s) => s.workflowOpen)
  const closeWorkflow = useSlidesStore((s) => s.closeWorkflow)
  const pipelineRun = useSlidesStore((s) => s.pipelineRun)
  const pipelineLoading = useSlidesStore((s) => s.pipelineLoading)
  const refreshPipeline = useSlidesStore((s) => s.refreshPipeline)
  const acceptPipelineRole = useSlidesStore((s) => s.acceptPipelineRole)
  const rejectPipelineRole = useSlidesStore((s) => s.rejectPipelineRole)
  const cancelPipelineRun = useSlidesStore((s) => s.cancelPipelineRun)
  // 右栏设计对话的 busy 态:agent 经 MCP 直接写盘,渲染端无推送,借 busy 驱动轮询刷新。
  const agentBusy = useChatStore((s) => s.busy)
  const [focusElement, setFocusElement] = useState<{ slotId: string; elementId: string; nonce: number } | null>(null)

  // deck 切换/挂载时初始化 store;bridge 缺失(web 端)时 setup 内部降级为不可用错误。
  useEffect(() => {
    if (!bridge || !workspaceRoot || !documentId) return
    void setup({ bridge, workspaceRoot, deckId: documentId, title: documentTitle })
  }, [bridge, workspaceRoot, documentId, documentTitle, setup])

  // 生成期间每 2s 轮询 manifest(缩略图/进度跟进);回合结束再刷一次终态。
  const wasBusyRef = useRef(false)
  const generatedNotesSlotRef = useRef<string | null>(null)
  useEffect(() => {
    if (agentBusy) {
      wasBusyRef.current = true
      const timer = window.setInterval(() => void refresh(), 2000)
      return () => window.clearInterval(timer)
    }
    if (wasBusyRef.current) {
      wasBusyRef.current = false
      void refresh().then(() => {
        // 生成回合结束:deck 已就绪/出错时自动跑一次基础检查(内部会定位第一条 blocking)。
        const current = useSlidesStore.getState().manifest
        if (current && (current.status === 'ready' || current.status === 'error')) {
          void useSlidesStore.getState().runCheck()
        }
        const generatedSlotId = generatedNotesSlotRef.current
        generatedNotesSlotRef.current = null
        const state = useSlidesStore.getState()
        if (generatedSlotId && state.notesOpen && state.notesSlotId === generatedSlotId && !state.notesDirty) {
          void state.loadNotes(generatedSlotId)
        }
      })
    }
    return undefined
  }, [agentBusy, refresh])

  useEffect(() => {
    if (!workflowOpen || (!agentBusy && pipelineRun?.status !== 'running')) return undefined
    const timer = window.setInterval(() => void refreshPipeline(), 2000)
    return () => window.clearInterval(timer)
  }, [agentBusy, pipelineRun?.status, refreshPipeline, workflowOpen])

  useEffect(() => {
    if (!agentBusy && workflowOpen) void refreshPipeline()
  }, [agentBusy, refreshPipeline, workflowOpen])

  // 提纲生命周期:status 变为 outline-proposed(agent 回合中/后)且面板未开时自动弹出。
  // 应用重启恢复同样经此路径(setup 加载到 outline-proposed 即弹),不自动重启 Agent。
  const status = manifest?.status
  useEffect(() => {
    if (status === 'outline-proposed' && !agentBusy) void openOutlineDialog()
  }, [status, agentBusy, openOutlineDialog])

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
      if (event.key.toLowerCase() !== 'n') return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      event.preventDefault()
      if (notesOpen) void closeNotes()
      else void openNotes()
    }

    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [closeNotes, notesOpen, openNotes])

  // 批准后自动派发「逐页生成」指令(displayText 只在对话里显示短句)。
  // 批准后自动派发「逐页生成」指令。与右栏手动发送共用同一 slides 合同(buildSlidesTurnPrompt),
  // 保证任何 slides 回合都不会漂到 design 的自由画布流水线上。
  const handleOutlineApproved = (): void => {
    void sendDesignMessage(
      buildSlidesTurnPrompt({
        text: t('slidesGenerateApprovedPrompt'),
        stage: 'outline-approved',
        themeName: manifest?.theme.name
      }),
      'agent',
      { displayText: t('slidesOutlineApprove') }
    )
  }

  // 单页重试:只针对该 slot 重新生成,不动已成功页面。
  const handleRetrySlide = (slot: SlidesSlot, index: number): void => {
    void sendDesignMessage(
      buildSlidesTurnPrompt({
        text: t('slidesRetrySlidePrompt', { index: index + 1, slotId: slot.id }),
        stage: manifest?.status ?? 'generating',
        themeName: manifest?.theme.name
      }),
      'agent',
      { displayText: `${t('slidesRetrySlide')}: ${t('slidesSlideLabel', { index: index + 1 })}` }
    )
  }

  const handleOptimizeExport = ({ slideIds, reasons }: SlidesExportOptimizationRequest): void => {
    void sendDesignMessage(
      buildSlidesTurnPrompt({
        text: `请只优化以下页面的 PPTX 可编辑性，不改变事实和叙事：${slideIds.join('、')}。当前降级原因：${reasons.join('、')}。优先改用原生文本、图片、表格、简单形状或带 data-cortex-chart-spec 的图表，完成后运行检查。`,
        stage: manifest?.status ?? 'ready',
        themeName: manifest?.theme.name
      }),
      'agent',
      { displayText: '优化 PPTX 可编辑性' }
    )
  }

  const handleGenerateNotes = (slot: SlidesSlot): void => {
    generatedNotesSlotRef.current = slot.id
    void sendDesignMessage(
      buildSlidesTurnPrompt({
        text: `请阅读当前演示文稿与页面 ${slot.id}（标题：${slot.title}），为这一页生成简洁、可直接演讲的 Markdown 备注，并调用 generate_speaker_notes 写入该 slot。不要修改页面内容或其他页面备注。`,
        stage: manifest?.status ?? 'ready',
        themeName: manifest?.theme.name
      }),
      'agent',
      { displayText: t('slidesNotesGenerate') }
    )
  }

  const handleStartWorkflow = (kind: SlidesPipelineRunKind): void => {
    const instruction =
      kind === 'research'
        ? '创建 research pipeline run，并使用 delegate_slides_role 并行执行 topic-researcher 与 visual-researcher。只提交结构化研究结果，等待我在 Workflow 面板批准。'
        : kind === 'review'
          ? '创建 review pipeline run，并使用 delegate_slides_role 执行 narrative-reviewer 与 render-reviewer。默认只报告问题，不直接重写页面，等待我在 Workflow 面板批准。'
          : '创建 notes pipeline run，并在审阅完成后使用 delegate_slides_role 执行 notes-writer，为现有每个 slot 生成 Markdown 草案；不要直接写正式备注，等待我批准。'
    void sendDesignMessage(
      buildSlidesTurnPrompt({ text: instruction, stage: manifest?.status ?? 'ready', themeName: manifest?.theme.name }),
      'agent',
      { displayText: kind === 'research' ? '生成前研究' : kind === 'review' ? '整套深度审阅' : '批量生成备注' }
    )
  }

  const handleRetryWorkflowRole = (role: SlidesRole): void => {
    if (!pipelineRun) return
    void sendDesignMessage(
      buildSlidesTurnPrompt({
        text: `请重试 pipeline run ${pipelineRun.id} 的 ${role}，仍只返回严格结构化结果并等待批准。`,
        stage: manifest?.status ?? 'ready',
        themeName: manifest?.theme.name
      }),
      'agent',
      { displayText: `重试 ${role}` }
    )
  }

  const handleFixFinding = (finding: SlidesFinding): void => {
    void sendDesignMessage(
      buildSlidesTurnPrompt({
        text: `请修复页面 ${finding.slideId} 的审阅问题（${finding.code}）：${finding.message}${finding.elementId ? `。目标元素：${finding.elementId}` : ''}${finding.hint ? `。建议：${finding.hint}` : ''}。只修改这一问题，完成后重新运行检查。`,
        stage: manifest?.status ?? 'ready',
        themeName: manifest?.theme.name
      }),
      'agent',
      { displayText: t('slidesFindingFix') }
    )
  }

  const activeSlot = manifest
    ? (sortedSlidesSlots(manifest.slides).find((s) => s.id === manifest.activeSlideId) ??
      sortedSlidesSlots(manifest.slides)[0] ??
      null)
    : null

  if (loading && !manifest) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center gap-2 text-[13px] text-ds-muted">
        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
        {t('slidesDeckLoading')}
      </div>
    )
  }

  if (deckError) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <TriangleAlert className="h-6 w-6 text-[#c0392b]" strokeWidth={2} />
        <p className="text-[13.5px] text-ds-strong">{t('slidesDeckBroken')}</p>
        <p className="max-w-[420px] text-[12px] leading-5 text-ds-muted">{deckError.message}</p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-lg bg-[#3b82d8] px-3 py-1.5 text-[12px] text-white transition hover:bg-[#2f6fc0]"
        >
          {t('slidesRefresh')}
        </button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="slides-workspace">
      <SlidesToolbar onRunCheck={() => void runCheck()} />
      {recoveredNotice ? (
        <div className="shrink-0 bg-[#2e9e6b]/10 px-3 py-1 text-[11.5px] text-[#1f7a50] dark:text-[#7fd8ab]">
          {t('slidesDeckRecovered')}
        </div>
      ) : null}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <SlidesThumbnailRail />
        <SlidesStage
          workspaceRoot={workspaceRoot}
          slot={activeSlot}
          focusElement={focusElement}
          onRetrySlide={
            activeSlot
              ? () =>
                  handleRetrySlide(
                    activeSlot,
                    sortedSlidesSlots(manifest?.slides ?? []).findIndex((s) => s.id === activeSlot.id)
                  )
              : undefined
          }
        />
        <SlidesCheckPanel
          onFocusFinding={(finding) => {
            if (finding.elementId) setFocusElement({ slotId: finding.slideId, elementId: finding.elementId, nonce: Date.now() })
          }}
          onFixFinding={handleFixFinding}
        />
        <SlidesWorkflowPanel
          open={workflowOpen}
          run={pipelineRun}
          loading={pipelineLoading}
          onClose={closeWorkflow}
          onStart={handleStartWorkflow}
          onAccept={(role) => void acceptPipelineRole(role)}
          onReject={(role) => void rejectPipelineRole(role)}
          onRetry={handleRetryWorkflowRole}
          onCancel={() => void cancelPipelineRun()}
        />
        {outlineDialogOpen ? <SlidesOutlineDialog onApproved={handleOutlineApproved} /> : null}
      </div>
      <SlidesNotesPanel onGenerate={handleGenerateNotes} />
      <SlidesExportQualityDialog onOptimize={handleOptimizeExport} />
    </div>
  )
}
