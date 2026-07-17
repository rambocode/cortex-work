// 检查结果面板:浮于舞台右侧,按 severity 筛选 findings,点击条目定位对应 slide。
// findings 由 slides:check(静态+渲染)产出;检查只报告,不自动改写页面。
import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert, Info, Loader2, TriangleAlert, X } from 'lucide-react'
import type { SlidesFinding, SlidesFindingSeverity } from '@cortex-work/core/design/slides/slides-types'
import { sortedSlidesSlots } from '@cortex-work/core/design/slides/slides-types'
import { useSlidesStore } from './slides-store'

const SEVERITY_ICON: Record<SlidesFindingSeverity, ReactElement> = {
  blocking: <CircleAlert className="h-3.5 w-3.5 text-[#c0392b]" strokeWidth={2} />,
  warning: <TriangleAlert className="h-3.5 w-3.5 text-[#c98a3a]" strokeWidth={2} />,
  info: <Info className="h-3.5 w-3.5 text-[#3b82d8]" strokeWidth={2} />
}

type SourcedFinding = SlidesFinding & { source: 'rules' | 'narrative' | 'render' }

type Props = {
  onFocusFinding?: (finding: SourcedFinding) => void
  onFixFinding?: (finding: SourcedFinding) => void
}

export function SlidesCheckPanel({ onFocusFinding, onFixFinding }: Props = {}): ReactElement | null {
  const { t } = useTranslation('design')
  const open = useSlidesStore((s) => s.checkPanelOpen)
  const checking = useSlidesStore((s) => s.checking)
  const findings = useSlidesStore((s) => s.findings)
  const pipelineFindings = useSlidesStore((s) => s.pipelineFindings)
  const manifest = useSlidesStore((s) => s.manifest)
  const close = useSlidesStore((s) => s.closeCheckPanel)
  const setActiveSlide = useSlidesStore((s) => s.setActiveSlide)
  const [filter, setFilter] = useState<SlidesFindingSeverity | 'all'>('all')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'rules' | 'narrative' | 'render'>('all')
  const [decisions, setDecisions] = useState<Record<string, 'accepted' | 'ignored' | 'fixing'>>({})

  const slotIndex = useMemo(() => {
    const map = new Map<string, number>()
    sortedSlidesSlots(manifest?.slides ?? []).forEach((slot, index) => map.set(slot.id, index))
    return map
  }, [manifest?.slides])

  if (!open) return null

  const sourcedFindings = [
    ...(findings ?? []).map((finding) => ({ ...finding, source: 'rules' as const })),
    ...pipelineFindings
  ]
  const visible = sourcedFindings.filter(
    (finding) =>
      decisions[finding.id] !== 'ignored' &&
      (filter === 'all' || finding.severity === filter) &&
      (sourceFilter === 'all' || finding.source === sourceFilter)
  )
  const counts = {
    blocking: sourcedFindings.filter((f) => f.severity === 'blocking').length,
    warning: sourcedFindings.filter((f) => f.severity === 'warning').length
  }

  return (
    <div
      data-testid="slides-check-panel"
      className="absolute right-3 top-3 z-30 flex max-h-[80%] w-[300px] flex-col overflow-hidden rounded-xl border border-black/10 bg-ds-main shadow-xl dark:border-white/10"
    >
      <div className="flex items-center justify-between border-b border-black/8 px-3 py-2 dark:border-white/8">
        <span className="text-[12.5px] font-semibold text-ds-strong">
          {t('slidesCheck')}
          {findings ? `(${counts.blocking}/${counts.warning})` : ''}
        </span>
        <button type="button" onClick={close} aria-label={t('close')} className="text-ds-muted hover:text-ds-strong">
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
      <div className="flex gap-1 border-b border-black/8 px-2 py-1.5 dark:border-white/8">
        {(['all', 'blocking', 'warning', 'info'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setFilter(option)}
            aria-pressed={filter === option}
            className={`rounded-md px-1.5 py-0.5 text-[11px] transition ${
              filter === option ? 'bg-black/8 text-ds-strong dark:bg-white/15' : 'text-ds-muted hover:text-ds-strong'
            }`}
          >
            {option === 'all' ? t('slidesCheckFilterAll') : t(`slidesCheckSeverity_${option}`)}
          </button>
        ))}
      </div>
      <div className="flex gap-1 border-b border-black/8 px-2 py-1.5 dark:border-white/8">
        {(['all', 'rules', 'narrative', 'render'] as const).map((source) => (
          <button
            key={source}
            type="button"
            onClick={() => setSourceFilter(source)}
            aria-pressed={sourceFilter === source}
            className={`rounded-md px-1.5 py-0.5 text-[10.5px] transition ${
              sourceFilter === source
                ? 'bg-black/8 text-ds-strong dark:bg-white/15'
                : 'text-ds-muted hover:text-ds-strong'
            }`}
          >
            {source === 'all'
              ? t('slidesCheckSourceAll')
              : source === 'rules'
                ? t('slidesCheckSourceRules')
                : source === 'narrative'
                  ? 'Narrative'
                  : 'Render'}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {checking ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-ds-muted">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
            {t('slidesChecking')}
          </div>
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-ds-muted">{t('slidesCheckClean')}</p>
        ) : (
          <ul className="space-y-1.5">
            {visible.map((f) => (
              <li key={f.id} className="rounded-lg border border-black/8 dark:border-white/8">
                <button
                  type="button"
                  onClick={() => void setActiveSlide(f.slideId).then(() => onFocusFinding?.(f))}
                  className="w-full rounded-lg px-2 py-1.5 text-left transition hover:bg-black/3 dark:hover:bg-white/5"
                >
                  <span className="flex items-center gap-1.5">
                    {SEVERITY_ICON[f.severity]}
                    <span className="text-[11px] text-ds-faint">
                      {t('slidesSlideLabel', { index: (slotIndex.get(f.slideId) ?? 0) + 1 })}
                      {f.elementId ? ` · ${f.elementId}` : ''}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-4 text-ds-strong">{f.message}</span>
                  {f.hint ? <span className="mt-0.5 block text-[11px] leading-4 text-ds-muted">{f.hint}</span> : null}
                </button>
                {f.source !== 'rules' ? (
                  <div className="flex items-center gap-1 border-t border-black/8 px-2 py-1 dark:border-white/8">
                    <button
                      type="button"
                      aria-label={t('slidesFindingAccept')}
                      onClick={() => setDecisions((current) => ({ ...current, [f.id]: 'accepted' }))}
                      className="rounded px-1.5 py-0.5 text-[10.5px] text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300"
                    >
                      {decisions[f.id] === 'accepted' ? t('slidesFindingAccepted') : t('slidesFindingAccept')}
                    </button>
                    <button
                      type="button"
                      aria-label={t('slidesFindingIgnore')}
                      onClick={() => setDecisions((current) => ({ ...current, [f.id]: 'ignored' }))}
                      className="rounded px-1.5 py-0.5 text-[10.5px] text-ds-muted hover:bg-black/5 dark:hover:bg-white/8"
                    >
                      {t('slidesFindingIgnore')}
                    </button>
                    {onFixFinding ? (
                      <button
                        type="button"
                        aria-label={t('slidesFindingFix')}
                        onClick={() => {
                          setDecisions((current) => ({ ...current, [f.id]: 'fixing' }))
                          onFixFinding(f)
                        }}
                        className="rounded px-1.5 py-0.5 text-[10.5px] text-[#2f6fc0] hover:bg-[#3b82d8]/10 dark:text-[#78b5ef]"
                      >
                        {t('slidesFindingFix')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
