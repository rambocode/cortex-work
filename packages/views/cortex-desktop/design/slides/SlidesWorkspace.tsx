// Slides Workspace(bento 化):kind === 'slides' 设计稿的中间区域。
// 布局收敛为「工具栏 + bento 编辑器舞台」;缩略图/画布编辑由 bento 内置编辑器承担,
// 右侧 Agent 会话栏仍由 DesignWorkspace 统一渲染。
// 生命周期:挂载 setup(load/补建 deck)→ AI 回合中轮询 refresh(MCP 直接写盘,无推送)
// → stage 变 outline-proposed 时自动弹提纲批准 → 批准后派发全篇生成指令。
import { useEffect, useRef, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, TriangleAlert } from 'lucide-react'
import { useDesktopBridge } from '@cortex-work/core/provider'
import type { SlidesOutline } from '@cortex-work/core/design/slides/slides-types'
import { sendDesignMessage } from '@cortex-work/core/design/run/design-run-manager'
import { buildSlidesTurnPrompt } from '@cortex-work/core/design/slides/slides-prompt'
import { useChatStore } from '@cortex-work/core/design/compat/chat-store'
import { SlidesOutlineDialog } from './SlidesOutlineDialog'
import { SlidesStage } from './SlidesStage'
import { SlidesToolbar } from './SlidesToolbar'
import { useBentoSlidesStore } from './bento-slides-store'
import { useSlidesDeckActivity } from './use-slides-deck-activity'

type Props = {
  workspaceRoot: string
  documentId: string
  documentTitle: string
  /** 左设计侧栏折叠态:透传给工具栏渲染折叠/展开按钮(与自由画布同一交互)。 */
  leftSidebarCollapsed?: boolean
  onToggleLeftSidebar?: () => void
}

export function SlidesWorkspace({
  workspaceRoot,
  documentId,
  documentTitle,
  leftSidebarCollapsed = false,
  onToggleLeftSidebar
}: Props): ReactElement {
  const { t } = useTranslation('design')
  const bridge = useDesktopBridge()
  const setup = useBentoSlidesStore((s) => s.setup)
  const doc = useBentoSlidesStore((s) => s.doc)
  const stage = useBentoSlidesStore((s) => s.stage)
  const deckError = useBentoSlidesStore((s) => s.deckError)
  const refresh = useBentoSlidesStore((s) => s.refresh)
  const openOutlineDialog = useBentoSlidesStore((s) => s.openOutlineDialog)
  const outlineDialogOpen = useBentoSlidesStore((s) => s.outlineDialogOpen)
  // 右栏设计对话的 busy 态:agent 经 MCP 直接写盘,渲染端无推送,借 busy 驱动轮询刷新。
  const agentBusy = useChatStore((s) => s.busy)

  // deck 切换/挂载时初始化 store;bridge 缺失(web 端)时 setup 内部降级为不可用错误。
  useEffect(() => {
    if (!bridge || !workspaceRoot || !documentId) return
    void setup({ bridge, workspaceRoot, deckId: documentId, title: documentTitle })
  }, [bridge, workspaceRoot, documentId, documentTitle, setup])

  // AI 每写成一次盘就在会话时间线补一条「已更新 第N页 · rev X」(与工具芯片互相独立)。
  useSlidesDeckActivity({ bridge, workspaceRoot, deckId: documentId })

  // 生成期间每 2s 轮询(stage/提纲跟进;文档内容重载由文件 watcher 驱动);回合结束再刷终态。
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

  // 提纲生命周期:stage 变 outline-proposed(回合结束)且面板未开时自动弹出;
  // 应用重启恢复同样经此路径(setup 读到 outline-proposed 即弹)。
  useEffect(() => {
    if (stage === 'outline-proposed' && !agentBusy) openOutlineDialog()
  }, [stage, agentBusy, openOutlineDialog])

  // 批准后自动派发全篇生成指令:把用户编辑后的提纲原文并入本轮,AI 据此一次 set_deck_doc。
  const handleOutlineApproved = (outline: Omit<SlidesOutline, 'approvedAt'>): void => {
    void sendDesignMessage(
      buildSlidesTurnPrompt({
        text: `${t('slidesGenerateApprovedPrompt')}\n\n批准的提纲(用户可能已就地修改,以此为准):\n${JSON.stringify(outline, null, 2)}`,
        stage: 'outline-approved'
      }),
      'agent',
      { displayText: t('slidesOutlineApprove') }
    )
  }

  const handlePresent = (): void => {
    const state = useBentoSlidesStore.getState()
    if (!bridge?.slidesPresent || !state.doc) return
    void bridge.slidesPresent({ workspaceRoot, deckId: documentId })
  }

  // 舞台挂载 gate:doc 就绪(= deck.bento.html 已在磁盘)才渲染 SlidesStage。
  // 首帧 loading 尚未置位(setup 在 effect 里异步跑),仅凭 loading 判断会让 webview
  // 抢在主进程补建 deck 文件前发起授权 → "not authorized" 竞态(用户实测)。
  if (!doc && !deckError) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center gap-2 text-[13px] text-ds-muted">
        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
        {t('slidesDeckLoading')}
      </div>
    )
  }

  if (deckError && !doc) {
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
      <SlidesToolbar
        leftSidebarCollapsed={leftSidebarCollapsed}
        onToggleLeftSidebar={onToggleLeftSidebar}
        onPresent={handlePresent}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <SlidesStage workspaceRoot={workspaceRoot} deckId={documentId} />
        {outlineDialogOpen ? <SlidesOutlineDialog onApproved={handleOutlineApproved} /> : null}
      </div>
    </div>
  )
}
