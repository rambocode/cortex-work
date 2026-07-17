// Slides 顶部工具栏:deck 标题 + 状态、zoom 档位(fit/50/75/100)、检查/导出入口,
// 以及 revision 冲突与操作错误的就地提示。导出经 bridge.slidesExport(目标路径由主进程
// 保存对话框决定);用户取消静默,失败展示可读错误。
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, ChevronDown, Download, FileText, Loader2, Palette, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { SlidesExportFormat } from '@cortex-work/core/desktop/slides-ipc-types'
import { useSlidesStore, type SlidesZoom } from './slides-store'
import { SlidesTemplatePicker } from './SlidesTemplatePicker'

const ZOOMS: SlidesZoom[] = ['fit', '50', '75', '100']

type Props = {
  onRunCheck?: () => void
}

export function SlidesToolbar({ onRunCheck }: Props): ReactElement {
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
  return (
    <div className="ds-no-drag flex shrink-0 flex-col border-b border-black/8 bg-ds-sidebar dark:border-white/8">
      <div className="flex h-11 items-center gap-2 px-3">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ds-strong">
          {manifest?.title ?? ''}
        </span>
        {/* zoom 档位 */}
        <div className="flex items-center rounded-lg bg-black/5 p-0.5 dark:bg-white/8" role="group" aria-label="zoom">
          {ZOOMS.map((z) => (
            <button
              key={z}
              type="button"
              onClick={() => setZoom(z)}
              aria-pressed={zoom === z}
              className={`rounded-md px-2 py-0.5 text-[11.5px] transition ${
                zoom === z ? 'bg-white text-ds-strong shadow dark:bg-white/20' : 'text-ds-muted hover:text-ds-strong'
              }`}
            >
              {z === 'fit' ? t('slidesZoomFit') : `${z}%`}
            </button>
          ))}
        </div>
        {/* 模板入口:下拉面板(SlidesTemplatePicker)锚定在此 relative wrapper 下方。 */}
        <div className="relative">
          <button
            type="button"
            onClick={() => void openTemplatePicker()}
            disabled={!manifest}
            title={t('slidesTemplateTitle')}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-ds-muted transition hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/8"
          >
            <Palette className="h-3.5 w-3.5" strokeWidth={1.9} />
            {t('slidesTemplateButton')}
          </button>
          <SlidesTemplatePicker />
        </div>
        <button
          type="button"
          onClick={() => {
            if (workflowOpen) closeWorkflow()
            else void openWorkflow()
          }}
          disabled={!manifest}
          aria-pressed={workflowOpen}
          className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] transition disabled:opacity-40 ${
            workflowOpen
              ? 'bg-black/8 text-ds-strong dark:bg-white/15'
              : 'text-ds-muted hover:bg-black/5 hover:text-ds-strong dark:hover:bg-white/8'
          }`}
        >
          <Bot className="h-3.5 w-3.5" strokeWidth={1.9} />
          {t('slidesWorkflow')}
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
          className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] transition disabled:opacity-40 ${
            notesOpen
              ? 'bg-black/8 text-ds-strong dark:bg-white/15'
              : 'text-ds-muted hover:bg-black/5 hover:text-ds-strong dark:hover:bg-white/8'
          }`}
        >
          <FileText className="h-3.5 w-3.5" strokeWidth={1.9} />
          {t('slidesNotes')}
        </button>
        <button
          type="button"
          onClick={onRunCheck}
          disabled={!onRunCheck}
          title={t('slidesCheck')}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-ds-muted transition hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/8"
        >
          <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.9} />
          {t('slidesCheck')}
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => setExportOpen((v) => !v)}
            disabled={exporting || analyzingExport || !manifest}
            className="inline-flex items-center gap-1 rounded-lg bg-[#3b82d8] px-2.5 py-1 text-[12px] text-white transition hover:bg-[#2f6fc0] disabled:opacity-50"
          >
            {exporting || analyzingExport ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
            ) : (
              <Download className="h-3.5 w-3.5" strokeWidth={1.9} />
            )}
            {exporting ? t('slidesExporting') : analyzingExport ? t('slidesExportPreflight') : t('slidesExport')}
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
