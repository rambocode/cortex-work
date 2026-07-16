// 检查结果面板:浮于舞台右侧,按 severity 筛选 findings,点击条目定位对应 slide。
// findings 由 slides:check(静态+渲染)产出;检查只报告,不自动改写页面。
import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert, Info, Loader2, TriangleAlert, X } from 'lucide-react'
import type { SlidesFindingSeverity } from '@cortex-work/core/design/slides/slides-types'
import { sortedSlidesSlots } from '@cortex-work/core/design/slides/slides-types'
import { useSlidesStore } from './slides-store'

const SEVERITY_ICON: Record<SlidesFindingSeverity, ReactElement> = {
  blocking: <CircleAlert className="h-3.5 w-3.5 text-[#c0392b]" strokeWidth={2} />,
  warning: <TriangleAlert className="h-3.5 w-3.5 text-[#c98a3a]" strokeWidth={2} />,
  info: <Info className="h-3.5 w-3.5 text-[#3b82d8]" strokeWidth={2} />
}

export function SlidesCheckPanel(): ReactElement | null {
  const { t } = useTranslation('design')
  const open = useSlidesStore((s) => s.checkPanelOpen)
  const checking = useSlidesStore((s) => s.checking)
  const findings = useSlidesStore((s) => s.findings)
  const manifest = useSlidesStore((s) => s.manifest)
  const close = useSlidesStore((s) => s.closeCheckPanel)
  const setActiveSlide = useSlidesStore((s) => s.setActiveSlide)
  const [filter, setFilter] = useState<SlidesFindingSeverity | 'all'>('all')

  const slotIndex = useMemo(() => {
    const map = new Map<string, number>()
    sortedSlidesSlots(manifest?.slides ?? []).forEach((slot, index) => map.set(slot.id, index))
    return map
  }, [manifest?.slides])

  if (!open) return null

  const visible = (findings ?? []).filter((f) => filter === 'all' || f.severity === filter)
  const counts = {
    blocking: (findings ?? []).filter((f) => f.severity === 'blocking').length,
    warning: (findings ?? []).filter((f) => f.severity === 'warning').length
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
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => void setActiveSlide(f.slideId)}
                  className="w-full rounded-lg border border-black/8 px-2 py-1.5 text-left transition hover:border-[#3b82d8]/60 dark:border-white/8"
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
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
