import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Check, Loader2, RefreshCw, Sparkles, TriangleAlert, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { sortedSlidesSlots } from '@cortex-work/core/design/slides/slides-types'
import { useSlidesStore } from './slides-store'

const AUTO_SAVE_DEBOUNCE_MS = 600
const DEFAULT_PANEL_HEIGHT = 160
const MIN_PANEL_HEIGHT = 120
const MAX_PANEL_HEIGHT = 360

type Props = {
  onGenerate?: (slot: ReturnType<typeof sortedSlidesSlots>[number]) => void
}

export function SlidesNotesPanel({ onGenerate }: Props = {}): ReactElement | null {
  const { t } = useTranslation('design')
  const manifest = useSlidesStore((s) => s.manifest)
  const notesOpen = useSlidesStore((s) => s.notesOpen)
  const notesSlotId = useSlidesStore((s) => s.notesSlotId)
  const notesMarkdown = useSlidesStore((s) => s.notesMarkdown)
  const notesLoading = useSlidesStore((s) => s.notesLoading)
  const notesDirty = useSlidesStore((s) => s.notesDirty)
  const notesSaving = useSlidesStore((s) => s.notesSaving)
  const notesSavedAt = useSlidesStore((s) => s.notesSavedAt)
  const notesError = useSlidesStore((s) => s.notesError)
  const notesConflict = useSlidesStore((s) => s.notesConflict)
  const setNotesMarkdown = useSlidesStore((s) => s.setNotesMarkdown)
  const saveNotes = useSlidesStore((s) => s.saveNotes)
  const loadNotes = useSlidesStore((s) => s.loadNotes)
  const closeNotes = useSlidesStore((s) => s.closeNotes)
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT)
  const timerRef = useRef<number | null>(null)
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null)

  const activeSlot = useMemo(() => {
    const slots = sortedSlidesSlots(manifest?.slides ?? [])
    const slotId = notesSlotId ?? manifest?.activeSlideId
    return slots.find((slot) => slot.id === slotId) ?? null
  }, [manifest?.activeSlideId, manifest?.slides, notesSlotId])

  const characterCount = notesMarkdown.length

  const clearPendingSave = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const flushSave = useCallback(() => {
    clearPendingSave()
    if (!notesDirty || notesLoading || notesSaving || notesConflict) return
    void saveNotes()
  }, [clearPendingSave, notesConflict, notesDirty, notesLoading, notesSaving, saveNotes])

  useEffect(() => {
    const handlePointerMove = (event: MouseEvent): void => {
      const resize = resizeRef.current
      if (!resize) return
      const nextHeight = resize.startHeight + (resize.startY - event.clientY)
      setPanelHeight(Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, nextHeight)))
    }

    const handlePointerUp = (): void => {
      resizeRef.current = null
    }

    window.addEventListener('mousemove', handlePointerMove)
    window.addEventListener('mouseup', handlePointerUp)
    return () => {
      window.removeEventListener('mousemove', handlePointerMove)
      window.removeEventListener('mouseup', handlePointerUp)
    }
  }, [])

  useEffect(() => {
    if (!notesOpen || !notesDirty || notesLoading || notesSaving || notesConflict) {
      clearPendingSave()
      return
    }
    clearPendingSave()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void saveNotes()
    }, AUTO_SAVE_DEBOUNCE_MS)
    return clearPendingSave
  }, [clearPendingSave, notesConflict, notesDirty, notesLoading, notesMarkdown, notesOpen, notesSaving, saveNotes])

  useEffect(
    () => () => {
      clearPendingSave()
      const state = useSlidesStore.getState()
      if (state.notesDirty && !state.notesSaving) void state.saveNotes()
    },
    [clearPendingSave]
  )

  if (!notesOpen) return null

  let status: ReactElement
  if (notesLoading) {
    status = (
      <>
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
        <span>{t('slidesNotesLoading')}</span>
      </>
    )
  } else if (notesSaving) {
    status = (
      <>
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
        <span>{t('slidesNotesSaving')}</span>
      </>
    )
  } else if (notesConflict) {
    status = (
      <>
        <TriangleAlert className="h-3.5 w-3.5 text-[#c98a3a]" strokeWidth={2} />
        <span>{t('slidesNotesConflict')}</span>
      </>
    )
  } else if (notesError) {
    status = (
      <>
        <TriangleAlert className="h-3.5 w-3.5 text-[#c0392b]" strokeWidth={2} />
        <span>{notesError}</span>
      </>
    )
  } else if (notesSavedAt && !notesDirty) {
    status = (
      <>
        <Check className="h-3.5 w-3.5 text-[#1f7a50]" strokeWidth={2} />
        <span>{t('slidesNotesSaved')}</span>
      </>
    )
  } else {
    status = <span>{t('slidesNotesAutosave')}</span>
  }

  return (
    <section
      data-testid="slides-notes-panel"
      className="flex min-h-0 shrink-0 flex-col border-t border-black/8 bg-ds-main dark:border-white/8"
      aria-label={t('slidesNotesTitle')}
      style={{ height: `${panelHeight}px` }}
    >
      <button
        type="button"
        role="separator"
        aria-label={t('slidesNotesResize')}
        aria-orientation="horizontal"
        onMouseDown={(event) => {
          resizeRef.current = { startY: event.clientY, startHeight: panelHeight }
        }}
        className="group flex h-3 shrink-0 cursor-row-resize items-center justify-center"
      >
        <span className="h-1 w-12 rounded-full bg-black/10 transition group-hover:bg-black/20 dark:bg-white/10 dark:group-hover:bg-white/20" />
      </button>

      <div className="flex items-center justify-between gap-3 px-4 pb-2">
        <div className="min-w-0">
          <h2 className="text-[13px] font-medium text-ds-strong">{t('slidesNotesTitle')}</h2>
          <p className="truncate text-[11.5px] text-ds-muted">
            {t('slidesNotesCount', { title: activeSlot?.title ?? '', count: characterCount })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onGenerate && activeSlot ? (
            <button
              type="button"
              aria-label={t('slidesNotesGenerate')}
              onClick={() => onGenerate(activeSlot)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] text-[#2f6fc0] transition hover:bg-[#3b82d8]/10 dark:text-[#78b5ef]"
            >
              <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
              {t('slidesNotesGenerate')}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={t('slidesNotesClose')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              clearPendingSave()
              void closeNotes()
            }}
            className="rounded-md p-1 text-ds-muted transition hover:bg-black/5 hover:text-ds-strong dark:hover:bg-white/8"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-y border-black/8 px-4 py-2 text-[11.5px] text-ds-muted dark:border-white/8">
        <div className="inline-flex min-w-0 items-center gap-1.5">{status}</div>
        {notesConflict && notesSlotId ? (
          <>
            <button
              type="button"
              onClick={() => {
                clearPendingSave()
                void saveNotes()
              }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[#9a6a24] transition hover:bg-black/5 dark:text-[#e6bd85] dark:hover:bg-white/8"
            >
              <RefreshCw className="h-3 w-3" strokeWidth={2} />
              {t('slidesNotesRetry')}
            </button>
            <button
              type="button"
              onClick={() => {
                clearPendingSave()
                void loadNotes(notesSlotId)
              }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-ds-muted transition hover:bg-black/5 hover:text-ds-strong dark:hover:bg-white/8"
            >
              {t('slidesNotesReload')}
            </button>
          </>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 p-4 pt-3">
        <textarea
          aria-label={t('slidesNotesMarkdown')}
          value={notesMarkdown}
          onChange={(event) => setNotesMarkdown(event.target.value)}
          onBlur={flushSave}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
              event.preventDefault()
              flushSave()
            }
          }}
          disabled={notesLoading}
          spellCheck={false}
          placeholder={t('slidesNotesPlaceholder')}
          className="h-full min-h-0 w-full resize-none rounded-xl border border-black/10 bg-transparent px-3 py-2 text-[12.5px] leading-5 text-ds-strong outline-none transition placeholder:text-ds-muted focus:border-[#3b82d8] dark:border-white/10"
        />
      </div>
    </section>
  )
}
