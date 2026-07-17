import { useState, type ReactElement } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSlidesStore } from './slides-store'

export type SlidesExportOptimizationRequest = {
  slideIds: string[]
  reasons: string[]
}

type Props = {
  onOptimize?: (request: SlidesExportOptimizationRequest) => void
}

export function SlidesExportQualityDialog({ onOptimize }: Props): ReactElement | null {
  const { t } = useTranslation('design')
  const open = useSlidesStore((state) => state.exportQualityOpen)
  const analysis = useSlidesStore((state) => state.exportQualityAnalysis)
  const close = useSlidesStore((state) => state.closeExportQuality)
  const exportDeck = useSlidesStore((state) => state.exportDeck)
  const [exporting, setExporting] = useState(false)

  if (!open || !analysis) return null
  const heavySlides = analysis.slides.filter((slide) => slide.report.quality !== 'high')
  const ratio = Math.round(analysis.deckReport.rasterAreaRatio * 100)
  const summarizeKinds = (nativeKinds: typeof analysis.deckReport.nativeKinds): string =>
    Object.entries(nativeKinds)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${kind} ${count}`)
      .join(' · ')

  const continueExport = async (): Promise<void> => {
    setExporting(true)
    const result = await exportDeck('pptx')
    setExporting(false)
    if (result.ok || result.canceled) close()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-6" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="slides-export-quality-title"
        className="flex max-h-[80vh] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-black/10 bg-ds-main shadow-2xl dark:border-white/10"
      >
        <header className="flex items-start justify-between gap-4 border-b border-black/8 px-5 py-4 dark:border-white/8">
          <div>
            <h2 id="slides-export-quality-title" className="text-[15px] font-semibold text-ds-strong">
              {t('slidesExportQualityTitle')}
            </h2>
            <p className="mt-1 text-[12px] text-ds-muted">{t('slidesExportQualityHint')}</p>
          </div>
          <button type="button" aria-label={t('slidesExportQualityClose')} onClick={close} className="rounded-md p-1 text-ds-muted hover:bg-black/5">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-4">
          <div className="flex items-center gap-3 rounded-xl bg-black/[0.035] p-4 dark:bg-white/[0.05]">
            {analysis.deckReport.quality === 'high' ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-amber-600" />
            )}
            <div className="flex-1">
              <p className="text-[13px] font-medium text-ds-strong">
                {t(
                  analysis.deckReport.quality === 'high'
                    ? 'slidesExportQualityHigh'
                    : analysis.deckReport.quality === 'mixed'
                      ? 'slidesExportQualityMixed'
                      : 'slidesExportQualityHeavy'
                )}
              </p>
              <p className="text-[12px] text-ds-muted">{t('slidesExportQualityRatio')}</p>
            </div>
            <strong className="text-[20px] text-ds-strong">{ratio}%</strong>
          </div>

          {heavySlides.length > 0 ? (
            <ul className="mt-4 space-y-2">
              {heavySlides.map((slide) => (
                <li key={slide.slotId} className="rounded-lg border border-black/8 px-3 py-2 dark:border-white/8">
                  <div className="flex justify-between text-[12px]">
                    <span className="font-medium text-ds-strong">
                      {t('slidesExportQualitySlideRaster', {
                        index: slide.order + 1,
                        ratio: Math.round(slide.report.rasterAreaRatio * 100)
                      })}
                    </span>
                  </div>
                  <p className="mt-1 text-[11.5px] text-ds-muted">
                    {t('slidesExportQualityCounts', {
                      nativeCount: slide.report.nativeCount,
                      rasterCount: slide.report.rasterCount
                    })}
                  </p>
                  <p className="mt-1 text-[11.5px] text-ds-muted">
                    {t('slidesExportQualityNativeKinds', {
                      kinds: summarizeKinds(slide.report.nativeKinds)
                    })}
                  </p>
                  <p className="mt-1 text-[11.5px] text-ds-muted">
                    {t('slidesExportQualityWarnings', {
                      warnings: slide.report.warnings.length ? slide.report.warnings.join('、') : t('slidesExportQualityWarningsNone')
                    })}
                  </p>
                  <p className="mt-1 text-[11.5px] text-ds-muted">
                    {t('slidesExportQualityReasons', {
                      reasons: slide.report.rasterReasons.length
                        ? slide.report.rasterReasons.join('、')
                        : t('slidesExportQualityReasonsNone')
                    })}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <footer className="flex flex-wrap justify-end gap-2 border-t border-black/8 px-5 py-4 dark:border-white/8">
          <button type="button" onClick={close} className="rounded-lg px-3 py-1.5 text-[12px] text-ds-muted hover:bg-black/5">
            {t('slidesCancel')}
          </button>
          {heavySlides.length > 0 && onOptimize ? (
            <button
              type="button"
              onClick={() => {
                onOptimize({
                  slideIds: heavySlides.map((slide) => slide.slotId),
                  reasons: [...new Set(heavySlides.flatMap((slide) => slide.report.rasterReasons))]
                })
                close()
              }}
              className="rounded-lg border border-black/10 px-3 py-1.5 text-[12px] text-ds-strong hover:bg-black/5 dark:border-white/10"
            >
              {t('slidesExportQualityOptimize')}
            </button>
          ) : null}
          <button
            type="button"
            disabled={exporting}
            onClick={() => void continueExport()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#2376d2] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-60"
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t('slidesExportQualityContinue')}
          </button>
        </footer>
      </section>
    </div>
  )
}
