// Slides 顶部工具栏:deck 标题 + 状态、zoom 档位(fit/50/75/100)、检查/导出入口,
// 以及 revision 冲突与操作错误的就地提示。导出经 bridge.slidesExport(目标路径由主进程
// 保存对话框决定);用户取消静默,失败展示可读错误。
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, ChevronDown, Download, FileText, Loader2, Palette, Play, RefreshCw, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react'
import type { SlidesExportFormat } from '@cortex-work/core/desktop/slides-ipc-types'
import { useDesignWorkspaceStore } from '@cortex-work/core/design/design-workspace-store'
import { useSlidesStore, type SlidesZoom } from './slides-store'
import { SlidesTemplatePicker } from './SlidesTemplatePicker'
import { SlidesAnimationMenu } from './SlidesAnimationMenu'
import { SidebarTitlebarToggleButton } from '../compat/SidebarPrimitives'

const ZOOMS: SlidesZoom[] = ['fit', '50', '75', '100']

type Props = {
  onRunCheck?: () => void
  /** 左设计侧栏折叠态与开关:工具栏最左渲染折叠/展开按钮(对齐自由画布交互)。 */
  leftSidebarCollapsed?: boolean
  onToggleLeftSidebar?: () => void
}

export function SlidesToolbar({ onRunCheck, leftSidebarCollapsed = false, onToggleLeftSidebar }: Props): ReactElement {
  const { t } = useTranslation('design')
  const manifest = useSlidesStore((s) => s.manifest)
  const zoom = useSlidesStore((s) => s.zoom)
  const setZoom = useSlidesStore((s) => s.setZoom)
  const conflictNotice = useSlidesStore((s) => s.conflictNotice)
  const clearConflict = useSlidesStore((s) => s.clearConflict)
  const actionError = useSlidesStore((s) => s.actionError)
  const clearActionError = useSlidesStore((s) => s.clearActionError)
  const refresh = useSlidesStore((s) => s.refresh)
  const exportDeck = useSlidesStore((s) => s.exportDeck)
  const analyzeExportQuality = useSlidesStore((s) => s.analyzeExportQuality)
  const analyzingExport = useSlidesStore((s) => s.analyzingExport)
  const openTemplatePicker = useSlidesStore((s) => s.openTemplatePicker)
  const notesOpen = useSlidesStore((s) => s.notesOpen)
  const openNotes = useSlidesStore((s) => s.openNotes)
  const closeNotes = useSlidesStore((s) => s.closeNotes)
  const workflowOpen = useSlidesStore((s) => s.workflowOpen)
  const openWorkflow = useSlidesStore((s) => s.openWorkflow)
  const closeWorkflow = useSlidesStore((s) => s.closeWorkflow)
  const canPresent = useSlidesStore((s) => s.canPresent)
  const present = useSlidesStore((s) => s.present)
  // 右侧设计助手栏开关状态(design 工作台 store,与自由画布 CanvasToolbar 同一状态源)。
  const assistantOpen = useDesignWorkspaceStore((s) => s.canvasAssistantOpen)
  const setAssistantOpen = useDesignWorkspaceStore((s) => s.setCanvasAssistantOpen)
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportedPath, setExportedPath] = useState<string | null>(null)

  const handleExport = async (format: SlidesExportFormat): Promise<void> => {
    setExportOpen(false)
    if (format === 'pptx') {
      setExportedPath(null)
      await analyzeExportQuality()
      return
    }
    setExporting(true)
    setExportedPath(null)
    const result = await exportDeck(format)
    setExporting(false)
    if (result.ok) setExportedPath(result.path)
  }

  // 背景用 bg-ds-sidebar 与左侧缩略图栏/设计侧栏同色,避免白色工具栏悬在灰色舞台上突兀。
  // 整栏作为窗口拖拽区(ds-drag):左侧栏折叠后它是窗口顶部唯一的拖拽面;
  // 内部按钮/输入由 cortex-desktop.css 的 .ds-slides-toolbar 规则恢复 no-drag。
  return (
    <div className="ds-slides-toolbar ds-drag flex shrink-0 flex-col border-b border-black/8 bg-ds-sidebar dark:border-white/8">
      <div className="flex h-11 items-center gap-2 px-3">
        {onToggleLeftSidebar ? (
          // 折叠时工具栏顶到窗口左缘,需避让 mac 红绿灯(见 cortex-desktop.css 的
          // .app-frame[data-native-titlebar="mac"] .ds-slides-toolbar-toggle-inset 规则)。
          <span className={`flex shrink-0 items-center ${leftSidebarCollapsed ? 'ds-slides-toolbar-toggle-inset' : ''}`}>
            <SidebarTitlebarToggleButton
              onClick={onToggleLeftSidebar}
              title={leftSidebarCollapsed ? t('sidebarExpand') : t('sidebarCollapse')}
              ariaLabel={leftSidebarCollapsed ? t('sidebarExpand') : t('sidebarCollapse')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-ds-muted transition hover:bg-black/5 hover:text-ds-strong dark:hover:bg-white/8"
            />
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ds-strong">
          {manifest?.title ?? ''}
        </span>
        {/* zoom 档位;shrink-0 + whitespace-nowrap 防止窗口缩小时"适应"竖排换行 */}
        <div className="flex shrink-0 items-center whitespace-nowrap rounded-lg bg-black/5 p-0.5 dark:bg-white/8" role="group" aria-label="zoom">
          {ZOOMS.map((z) => (
            <button
              key={z}
              type="button"
              onClick={() => setZoom(z)}
              aria-pressed={zoom === z}
              className={`whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] transition ${
                zoom === z ? 'bg-white text-ds-strong shadow dark:bg-white/20' : 'text-ds-muted hover:text-ds-strong'
              }`}
            >
              {z === 'fit' ? t('slidesZoomFit') : `${z}%`}
            </button>
          ))}
        </div>
        {/* 模板入口:下拉面板(SlidesTemplatePicker)锚定在此 relative wrapper 下方。
            窗口缩窄时标签收起为纯图标(title 兜底),避免中文逐字换行竖排。
            wrapper 标 ds-no-drag:下拉面板整体保持可点,不触发窗口拖拽。 */}
        <div className="ds-no-drag relative shrink-0">
          <button
            type="button"
            onClick={() => void openTemplatePicker()}
            disabled={!manifest}
            title={t('slidesTemplateTitle')}
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-[12px] text-ds-muted transition hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/8"
          >
            <Palette className="h-3.5 w-3.5" strokeWidth={1.9} />
            <span className="hidden min-[1080px]:inline">{t('slidesTemplateButton')}</span>
          </button>
          <SlidesTemplatePicker />
        </div>
        {/* 动画菜单:全局风格 + 当前页转场;桥接无动画能力(web/旧壳)时组件自身返回 null。 */}
        <SlidesAnimationMenu />
        <button
          type="button"
          onClick={() => {
            if (workflowOpen) closeWorkflow()
            else void openWorkflow()
          }}
          disabled={!manifest}
          aria-pressed={workflowOpen}
          title={t('slidesWorkflow')}
          className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-[12px] transition disabled:opacity-40 ${
            workflowOpen
              ? 'bg-black/8 text-ds-strong dark:bg-white/15'
              : 'text-ds-muted hover:bg-black/5 hover:text-ds-strong dark:hover:bg-white/8'
          }`}
        >
          <Bot className="h-3.5 w-3.5" strokeWidth={1.9} />
          <span className="hidden min-[1080px]:inline">{t('slidesWorkflow')}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            if (notesOpen) void closeNotes()
            else void openNotes()
          }}
          disabled={!manifest}
          aria-pressed={notesOpen}
          title={t('slidesNotes')}
          className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-[12px] transition disabled:opacity-40 ${
            notesOpen
              ? 'bg-black/8 text-ds-strong dark:bg-white/15'
              : 'text-ds-muted hover:bg-black/5 hover:text-ds-strong dark:hover:bg-white/8'
          }`}
        >
          <FileText className="h-3.5 w-3.5" strokeWidth={1.9} />
          <span className="hidden min-[1080px]:inline">{t('slidesNotes')}</span>
        </button>
        <button
          type="button"
          onClick={onRunCheck}
          disabled={!onRunCheck}
          title={t('slidesCheck')}
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-[12px] text-ds-muted transition hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/8"
        >
          <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.9} />
          <span className="hidden min-[1080px]:inline">{t('slidesCheck')}</span>
        </button>
        {/* 播放(演示模式):桥接无该能力(web/旧壳)时整体隐藏;无 ready 页时禁用。 */}
        {canPresent ? (
          <button
            type="button"
            onClick={() => void present()}
            disabled={!manifest || !manifest.slides.some((s) => s.status === 'ready')}
            title={t('slidesPlay')}
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-[12px] text-ds-muted transition hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/8"
          >
            <Play className="h-3.5 w-3.5" strokeWidth={1.9} />
            <span className="hidden min-[1080px]:inline">{t('slidesPlay')}</span>
          </button>
        ) : null}
        {/* 导出入口:wrapper 标 ds-no-drag,格式下拉整体可点、不触发窗口拖拽。 */}
        <div className="ds-no-drag relative shrink-0">
          <button
            type="button"
            onClick={() => setExportOpen((v) => !v)}
            disabled={exporting || analyzingExport || !manifest}
            title={t('slidesExport')}
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-[#3b82d8] px-2.5 py-1 text-[12px] text-white transition hover:bg-[#2f6fc0] disabled:opacity-50"
          >
            {exporting || analyzingExport ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
            ) : (
              <Download className="h-3.5 w-3.5" strokeWidth={1.9} />
            )}
            <span className="hidden min-[1080px]:inline">
              {exporting ? t('slidesExporting') : analyzingExport ? t('slidesExportPreflight') : t('slidesExport')}
            </span>
            <ChevronDown className="h-3 w-3" strokeWidth={2} />
          </button>
          {exportOpen ? (
            <div className="absolute right-0 top-full z-30 mt-1 w-36 rounded-lg border border-black/10 bg-ds-main p-1 shadow-lg dark:border-white/10">
              {(['pptx', 'pdf', 'png', 'html'] as const).map((format) => (
                <button
                  key={format}
                  type="button"
                  onClick={() => void handleExport(format)}
                  className="block w-full rounded-md px-2 py-1.5 text-left text-[12px] text-ds-strong transition hover:bg-black/5 dark:hover:bg-white/8"
                >
                  {t(
                    format === 'pptx'
                      ? 'slidesExportPptx'
                      : format === 'pdf'
                        ? 'slidesExportPdf'
                        : format === 'png'
                          ? 'slidesExportPng'
                          : 'slidesExportHtml'
                  )}
                  {format === 'pdf' || format === 'png' ? ` · ${t('slidesExportNoNotes')}` : ''}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {/* 右侧设计助手栏开关:面板折叠后这是唯一的重开入口(对齐自由画布 CanvasToolbar 的 Sparkles 开关)。 */}
        <button
          type="button"
          onClick={() => setAssistantOpen(!assistantOpen)}
          aria-pressed={assistantOpen}
          title={t(assistantOpen ? 'designRailCollapse' : 'canvasToolAssistant')}
          aria-label={t(assistantOpen ? 'designRailCollapse' : 'canvasToolAssistant')}
          className={`inline-flex shrink-0 items-center justify-center rounded-lg px-2 py-1 text-[12px] transition ${
            assistantOpen
              ? 'bg-black/8 text-ds-strong dark:bg-white/15'
              : 'text-ds-muted hover:bg-black/5 hover:text-ds-strong dark:hover:bg-white/8'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5" strokeWidth={1.9} />
        </button>
      </div>
      {conflictNotice ? (
        <div className="flex items-center gap-2 bg-[#c98a3a]/12 px-3 py-1.5 text-[12px] text-[#9a6a24] dark:text-[#e6bd85]">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span className="min-w-0 flex-1 truncate">{t('slidesConflictNotice')}</span>
          <button
            type="button"
            onClick={() => {
              clearConflict()
              void refresh()
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 transition hover:bg-black/5 dark:hover:bg-white/8"
          >
            <RefreshCw className="h-3 w-3" strokeWidth={2} />
            {t('slidesRefresh')}
          </button>
        </div>
      ) : null}
      {actionError ? (
        <div className="flex items-center gap-2 bg-[#c0392b]/10 px-3 py-1.5 text-[12px] text-[#c0392b] dark:text-[#f0a0a0]">
          <span className="min-w-0 flex-1 truncate">{actionError}</span>
          <button type="button" onClick={clearActionError} className="shrink-0 hover:opacity-70">
            ✕
          </button>
        </div>
      ) : null}
      {exportedPath ? (
        <div className="flex items-center gap-2 bg-[#2e9e6b]/10 px-3 py-1.5 text-[12px] text-[#1f7a50] dark:text-[#7fd8ab]">
          <span className="min-w-0 flex-1 truncate">{exportedPath}</span>
          <button type="button" onClick={() => setExportedPath(null)} className="shrink-0 hover:opacity-70">
            ✕
          </button>
        </div>
      ) : null}
    </div>
  )
}
