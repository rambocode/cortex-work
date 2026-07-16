// Slides Workspace:kind === 'slides' 的设计稿的中间区域(取代自由画布)。
// 布局:左缩略图栏 / 中舞台(顶部工具栏);右侧 Agent 会话栏由 DesignWorkspace 统一渲染。
// 挂载时 setup slides store(load deck,不存在则补建);deck 级错误渲染破损态。
import { useEffect, useRef, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, TriangleAlert } from 'lucide-react'
import { useDesktopBridge } from '@cortex-work/core/provider'
import { sortedSlidesSlots, type SlidesSlot } from '@cortex-work/core/design/slides/slides-types'
import { sendDesignMessage } from '@cortex-work/core/design/run/design-run-manager'
import { useChatStore } from '@cortex-work/core/design/compat/chat-store'
import { SlidesOutlineDialog } from './SlidesOutlineDialog'
import { SlidesStage } from './SlidesStage'
import { SlidesThumbnailRail } from './SlidesThumbnailRail'
import { SlidesToolbar } from './SlidesToolbar'
import { useSlidesStore } from './slides-store'

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
  // 右栏设计对话的 busy 态:agent 经 MCP 直接写盘,渲染端无推送,借 busy 驱动轮询刷新。
  const agentBusy = useChatStore((s) => s.busy)

  // deck 切换/挂载时初始化 store;bridge 缺失(web 端)时 setup 内部降级为不可用错误。
  useEffect(() => {
    if (!bridge || !workspaceRoot || !documentId) return
    void setup({ bridge, workspaceRoot, deckId: documentId, title: documentTitle })
  }, [bridge, workspaceRoot, documentId, documentTitle, setup])

  // 生成期间每 2s 轮询 manifest(缩略图/进度跟进);回合结束再刷一次终态。
  const wasBusyRef = useRef(false)
  useEffect(() => {
    if (agentBusy) {
      wasBusyRef.current = true
      const timer = window.setInterval(() => void refresh(), 2000)
      return () => window.clearInterval(timer)
    }
    if (wasBusyRef.current) {
      wasBusyRef.current = false
      void refresh()
    }
    return undefined
  }, [agentBusy, refresh])

  // 提纲生命周期:status 变为 outline-proposed(agent 回合中/后)且面板未开时自动弹出。
  // 应用重启恢复同样经此路径(setup 加载到 outline-proposed 即弹),不自动重启 Agent。
  const status = manifest?.status
  useEffect(() => {
    if (status === 'outline-proposed' && !agentBusy) void openOutlineDialog()
  }, [status, agentBusy, openOutlineDialog])

  // 批准后自动派发「逐页生成」指令(displayText 只在对话里显示短句)。
  const handleOutlineApproved = (): void => {
    void sendDesignMessage(t('slidesGenerateApprovedPrompt'), 'agent', {
      displayText: t('slidesOutlineApprove')
    })
  }

  // 单页重试:只针对该 slot 重新生成,不动已成功页面。
  const handleRetrySlide = (slot: SlidesSlot, index: number): void => {
    void sendDesignMessage(t('slidesRetrySlidePrompt', { index: index + 1, slotId: slot.id }), 'agent', {
      displayText: `${t('slidesRetrySlide')}: ${t('slidesSlideLabel', { index: index + 1 })}`
    })
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
      <SlidesToolbar />
      {recoveredNotice ? (
        <div className="shrink-0 bg-[#2e9e6b]/10 px-3 py-1 text-[11.5px] text-[#1f7a50] dark:text-[#7fd8ab]">
          {t('slidesDeckRecovered')}
        </div>
      ) : null}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <SlidesThumbnailRail workspaceRoot={workspaceRoot} />
        <SlidesStage
          workspaceRoot={workspaceRoot}
          slot={activeSlot}
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
        {outlineDialogOpen ? <SlidesOutlineDialog onApproved={handleOutlineApproved} /> : null}
      </div>
    </div>
  )
}
