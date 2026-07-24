// Slides 顶部工具栏(bento 化后收敛):deck 标题 + 播放 + 另存为 .bento.html + 助手栏开关。
// 编辑类操作(缩放/模板/动画/检查/备注)全部由 bento 内置编辑器承担,不再在宿主重复。
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Download, Loader2, Play, TriangleAlert } from 'lucide-react'
import { useDesignWorkspaceStore } from '@cortex-work/core/design/design-workspace-store'
import { useBentoSlidesStore } from './bento-slides-store'
import { SidebarTitlebarToggleButton } from '../compat/SidebarPrimitives'

type Props = {
  /** 左设计侧栏折叠态与开关:工具栏最左渲染折叠/展开按钮(对齐自由画布交互)。 */
  leftSidebarCollapsed?: boolean
  onToggleLeftSidebar?: () => void
  /** 播放(演示窗口)回调:由宿主注入(经桥调用 slides:present)。 */
  onPresent?: () => void
}

export function SlidesToolbar({ leftSidebarCollapsed = false, onToggleLeftSidebar, onPresent }: Props): ReactElement {
  const { t } = useTranslation('design')
  const doc = useBentoSlidesStore((s) => s.doc)
  const mutating = useBentoSlidesStore((s) => s.mutating)
  const deckError = useBentoSlidesStore((s) => s.deckError)
  const exportDeck = useBentoSlidesStore((s) => s.exportDeck)
  const refresh = useBentoSlidesStore((s) => s.refresh)
  // 右侧设计助手栏开关状态(design 工作台 store,与自由画布 CanvasToolbar 同一状态源)。
  const assistantOpen = useDesignWorkspaceStore((s) => s.canvasAssistantOpen)
  const setAssistantOpen = useDesignWorkspaceStore((s) => s.setCanvasAssistantOpen)
  const [exporting, setExporting] = useState(false)

  const handleExport = async (): Promise<void> => {
    setExporting(true)
    await exportDeck()
    setExporting(false)
  }

  // 背景用 bg-ds-sidebar 与设计侧栏同色;整栏为窗口拖拽区(ds-drag),按钮由
  // cortex-desktop.css 的 .ds-slides-toolbar 规则恢复 no-drag(沿用旧约定)。
  return (
    <div className="ds-slides-toolbar ds-drag flex shrink-0 flex-col border-b border-black/8 bg-ds-sidebar dark:border-white/8">
      <div className="flex h-11 items-center gap-2 px-3">
        {onToggleLeftSidebar ? (
          // 折叠时工具栏顶到窗口左缘,需避让 mac 红绿灯(cortex-desktop.css 的
          // .ds-slides-toolbar-toggle-inset 规则,沿用旧约定)。
          <span className={`flex shrink-0 items-center ${leftSidebarCollapsed ? 'ds-slides-toolbar-toggle-inset' : ''}`}>
            <SidebarTitlebarToggleButton
              onClick={onToggleLeftSidebar}
              title={leftSidebarCollapsed ? t('sidebarExpand') : t('sidebarCollapse')}
              ariaLabel={leftSidebarCollapsed ? t('sidebarExpand') : t('sidebarCollapse')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-ds-muted transition hover:bg-black/5 hover:text-ds-strong dark:hover:bg-white/8"
            />
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ds-strong">{doc?.title ?? ''}</span>
        <button
          type="button"
          onClick={onPresent}
          disabled={!doc || !onPresent}
          title={t('slidesPlay')}
          data-testid="slides-play"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] text-ds-muted transition hover:bg-black/5 hover:text-ds-strong disabled:opacity-40 dark:hover:bg-white/8"
        >
          <Play className="h-3.5 w-3.5" strokeWidth={1.9} />
          <span className="hidden min-[1080px]:inline">{t('slidesPlay')}</span>
        </button>
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={!doc || mutating || exporting}
          title={t('slidesExport')}
          data-testid="slides-export"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] text-ds-muted transition hover:bg-black/5 hover:text-ds-strong disabled:opacity-40 dark:hover:bg-white/8"
        >
          {exporting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.9} />
          ) : (
            <Download className="h-3.5 w-3.5" strokeWidth={1.9} />
          )}
          <span className="hidden min-[1080px]:inline">{exporting ? t('slidesExporting') : t('slidesExport')}</span>
        </button>
        <button
          type="button"
          onClick={() => setAssistantOpen(!assistantOpen)}
          aria-pressed={assistantOpen}
          title={t('designAssistant')}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] transition ${
            assistantOpen
              ? 'bg-black/6 text-ds-strong dark:bg-white/12'
              : 'text-ds-muted hover:bg-black/5 hover:text-ds-strong dark:hover:bg-white/8'
          }`}
        >
          <Bot className="h-3.5 w-3.5" strokeWidth={1.9} />
        </button>
      </div>
      {deckError ? (
        <div className="flex items-center gap-2 bg-[#c0392b]/10 px-3 py-1 text-[11.5px] text-[#a63224] dark:text-[#e88477]">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span className="min-w-0 flex-1 truncate">{deckError.message}</span>
          <button type="button" onClick={() => void refresh()} className="shrink-0 underline-offset-2 hover:underline">
            {t('slidesRefresh')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
