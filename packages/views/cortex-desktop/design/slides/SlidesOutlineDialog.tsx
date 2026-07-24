// 提纲确认面板:agent propose_outline 后弹出;用户可就地编辑标题/目的/要点,
// 「批准并开始生成」→ gate 推进 outline-approved → onApproved(编辑后的提纲)回调
// (宿主把它并入生成指令);「关闭」只收起面板,草案保留,用户可在对话里要求重做。
import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { SlidesOutline } from '@cortex-work/core/design/slides/slides-types'
import { useBentoSlidesStore } from './bento-slides-store'

type Props = {
  /** 批准成功后的回调,携带用户编辑后的提纲(宿主据此自动发送「开始生成」指令)。 */
  onApproved?: (outline: Omit<SlidesOutline, 'approvedAt'>) => void
}

type EditableItem = {
  id: string
  title: string
  purpose: string
  keyPointsText: string
  visualIntent?: string
}

function toEditable(outline: SlidesOutline | null): { summary: string; items: EditableItem[] } {
  return {
    summary: outline?.summary ?? '',
    items: (outline?.items ?? []).map((item) => ({
      id: item.id,
      title: item.title,
      purpose: item.purpose,
      keyPointsText: item.keyPoints.join('\n'),
      visualIntent: item.visualIntent
    }))
  }
}

export function SlidesOutlineDialog({ onApproved }: Props): ReactElement | null {
  const { t } = useTranslation('design')
  const open = useBentoSlidesStore((s) => s.outlineDialogOpen)
  const draft = useBentoSlidesStore((s) => s.outline)
  const mutating = useBentoSlidesStore((s) => s.mutating)
  const close = useBentoSlidesStore((s) => s.closeOutlineDialog)
  const approve = useBentoSlidesStore((s) => s.approveOutline)

  const [summary, setSummary] = useState('')
  const [items, setItems] = useState<EditableItem[]>([])

  // 草案变化(重开面板/新版本)时重置编辑态。
  useEffect(() => {
    const editable = toEditable(draft)
    setSummary(editable.summary)
    setItems(editable.items)
  }, [draft])

  if (!open) return null

  const updateItem = (id: string, patch: Partial<EditableItem>): void => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  const handleApprove = async (): Promise<void> => {
    const outline: Omit<SlidesOutline, 'approvedAt'> = {
      version: draft?.version ?? 1,
      summary,
      audience: draft?.audience,
      goal: draft?.goal,
      items: items.map((item) => ({
        id: item.id,
        title: item.title.trim() || item.id,
        purpose: item.purpose,
        keyPoints: item.keyPointsText
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        visualIntent: item.visualIntent
      }))
    }
    const ok = await approve(outline)
    if (ok) onApproved?.(outline)
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/35" role="dialog" aria-modal="true">
      <div className="flex max-h-[85%] w-[560px] flex-col overflow-hidden rounded-xl bg-ds-main shadow-2xl">
        <div className="flex items-center justify-between border-b border-black/8 px-4 py-3 dark:border-white/8">
          <div>
            <h2 className="text-[14px] font-semibold text-ds-strong">{t('slidesOutlineTitle')}</h2>
            <p className="mt-0.5 text-[11.5px] text-ds-muted">{t('slidesOutlineHint')}</p>
          </div>
          <button type="button" onClick={close} aria-label={t('close')} className="text-ds-muted hover:text-ds-strong">
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {draft === null ? (
            <p className="text-[12.5px] text-[#c0392b]">{t('slidesOutlineDraftMissing')}</p>
          ) : (
            <>
              <label className="block">
                <span className="text-[11.5px] text-ds-muted">{t('slidesOutlineSummary')}</span>
                <textarea
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  rows={2}
                  className="mt-1 w-full resize-none rounded-lg border border-black/12 bg-transparent px-2.5 py-1.5 text-[12.5px] text-ds-strong outline-hidden focus:border-[#3b82d8] dark:border-white/12"
                />
              </label>
              <ol className="space-y-3">
                {items.map((item, index) => (
                  <li key={item.id} className="rounded-lg border border-black/10 p-2.5 dark:border-white/10">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 rounded bg-black/6 px-1.5 py-0.5 text-[11px] text-ds-muted dark:bg-white/10">
                        {index + 1}
                      </span>
                      <input
                        value={item.title}
                        onChange={(e) => updateItem(item.id, { title: e.target.value })}
                        aria-label={t('slidesSlideLabel', { index: index + 1 })}
                        className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-[13px] font-medium text-ds-strong outline-hidden focus:border-[#3b82d8]"
                      />
                    </div>
                    <label className="mt-2 block">
                      <span className="text-[11px] text-ds-faint">{t('slidesOutlineItemPurpose')}</span>
                      <input
                        value={item.purpose}
                        onChange={(e) => updateItem(item.id, { purpose: e.target.value })}
                        className="mt-0.5 h-7 w-full rounded-md border border-black/10 bg-transparent px-1.5 text-[12px] text-ds-muted outline-hidden focus:border-[#3b82d8] dark:border-white/10"
                      />
                    </label>
                    <label className="mt-2 block">
                      <span className="text-[11px] text-ds-faint">{t('slidesOutlineItemKeyPoints')}</span>
                      <textarea
                        value={item.keyPointsText}
                        onChange={(e) => updateItem(item.id, { keyPointsText: e.target.value })}
                        rows={Math.max(2, item.keyPointsText.split('\n').length)}
                        className="mt-0.5 w-full resize-none rounded-md border border-black/10 bg-transparent px-1.5 py-1 text-[12px] text-ds-muted outline-hidden focus:border-[#3b82d8] dark:border-white/10"
                      />
                    </label>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-black/8 px-4 py-3 dark:border-white/8">
          <button
            type="button"
            onClick={close}
            className="rounded-lg px-3 py-1.5 text-[12px] text-ds-muted transition hover:bg-black/5 dark:hover:bg-white/8"
          >
            {t('slidesOutlineRevise')}
          </button>
          <button
            type="button"
            onClick={() => void handleApprove()}
            disabled={mutating || draft === null || items.length === 0}
            className="rounded-lg bg-[#3b82d8] px-3 py-1.5 text-[12px] text-white transition hover:bg-[#2f6fc0] disabled:opacity-50"
          >
            {t('slidesOutlineApprove')}
          </button>
        </div>
      </div>
    </div>
  )
}
