// 左侧页面缩略图栏:按 manifest order 展示 slot 列表(页码/标题/状态),支持点击切页、
// 新增/复制/删除与 HTML5 拖拽排序。
//
// 缩略图经 slides:readSnapshot 取 data URL(store 按 `<slotId>@<updatedAt>` 缓存):
// renderer 页不是 file:// 源,直接 <img src="file://…"> 会被 Chromium 拦掉(实测全碎图)。
// 快照缺失/未截图时退化为状态占位块。
import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Loader2, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { sortedSlidesSlots, type SlidesSlot } from '@cortex-work/core/design/slides/slides-types'
import { useSlidesStore } from './slides-store'

/** 缩略图缓存 key:updatedAt 变即换 key → 自动重取(等价旧 file:// 的 ?rev= cache-bust)。 */
export function slidesSnapshotKey(slot: Pick<SlidesSlot, 'id' | 'updatedAt'>): string {
  return `${slot.id}@${slot.updatedAt}`
}

function StatusBadge({ status }: { status: SlidesSlot['status'] }): ReactElement | null {
  const { t } = useTranslation('design')
  if (status === 'ready') return null
  if (status === 'generating') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-[#3b82d8]">
        <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
        {t('slidesStatusGenerating')}
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-[#c0392b]">
        <TriangleAlert className="h-3 w-3" strokeWidth={2} />
        {t('slidesStatusError')}
      </span>
    )
  }
  return <span className="text-[11px] text-ds-faint">{t('slidesStatusEmpty')}</span>
}

export function SlidesThumbnailRail(): ReactElement {
  const { t } = useTranslation('design')
  const manifest = useSlidesStore((s) => s.manifest)
  const snapshots = useSlidesStore((s) => s.snapshots)
  const ensureSnapshot = useSlidesStore((s) => s.ensureSnapshot)
  const mutating = useSlidesStore((s) => s.mutating)
  const insertSlide = useSlidesStore((s) => s.insertSlide)
  const duplicateSlide = useSlidesStore((s) => s.duplicateSlide)
  const deleteSlide = useSlidesStore((s) => s.deleteSlide)
  const reorderSlides = useSlidesStore((s) => s.reorderSlides)
  const setActiveSlide = useSlidesStore((s) => s.setActiveSlide)

  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const slots = manifest ? sortedSlidesSlots(manifest.slides) : []
  const activeSlideId = manifest?.activeSlideId ?? null

  // 按需拉取:仅已生成且已入册快照的页面(未截图的页拉了也是 not_found)。
  // 依赖用稳定签名而非 slots 数组本身 —— 后者每次渲染都是新引用,会打成循环。
  const snapshotSignature = slots
    .filter((s) => s.status === 'ready' && s.snapshotPath)
    .map((s) => slidesSnapshotKey(s))
    .join('|')
  useEffect(() => {
    for (const key of snapshotSignature ? snapshotSignature.split('|') : []) {
      const at = key.lastIndexOf('@')
      void ensureSnapshot(key.slice(0, at), key.slice(at + 1))
    }
  }, [snapshotSignature, ensureSnapshot])

  // 拖拽落点:把 dragId 移动到 targetId 的位置(其余顺序不变),提交整个新排列。
  const handleDrop = (targetId: string): void => {
    setDragOverId(null)
    const sourceId = dragId
    setDragId(null)
    if (!sourceId || sourceId === targetId) return
    const ids = slots.map((s) => s.id)
    const from = ids.indexOf(sourceId)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) return
    ids.splice(from, 1)
    ids.splice(to, 0, sourceId)
    void reorderSlides(ids)
  }

  return (
    <div className="flex h-full w-[168px] shrink-0 flex-col border-r border-black/8 bg-ds-sidebar dark:border-white/8">
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2.5 py-3" aria-label={t('slidesDragToReorder')}>
        {slots.map((slot, index) => {
          const active = slot.id === activeSlideId
          // 每 slot 单份缓存:新图未取到前展示旧图(只有「图片」一种覆盖模式,不闪占位框)。
          const snapshotUrl = snapshots[slot.id]?.url ?? null
          return (
            <li key={slot.id}>
              <button
                type="button"
                draggable
                data-testid={`slides-thumb-${slot.id}`}
                aria-current={active ? 'true' : undefined}
                onClick={() => void setActiveSlide(slot.id)}
                onDragStart={() => setDragId(slot.id)}
                onDragEnd={() => {
                  setDragId(null)
                  setDragOverId(null)
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOverId(slot.id)
                }}
                onDragLeave={() => setDragOverId((cur) => (cur === slot.id ? null : cur))}
                onDrop={() => handleDrop(slot.id)}
                className={`group w-full rounded-lg p-1.5 text-left transition ${
                  active
                    ? 'bg-[var(--ds-sidebar-row-active)] shadow-[inset_0_0_0_1.5px_#3b82d8]'
                    : 'hover:bg-[var(--ds-sidebar-row-active)]'
                } ${dragOverId === slot.id && dragId !== slot.id ? 'ring-2 ring-[#3b82d8]/60' : ''}`}
              >
                <div className="relative aspect-video w-full overflow-hidden rounded-md bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.08)] dark:bg-white/8">
                  {snapshotUrl ? (
                    <>
                      <img
                        src={snapshotUrl}
                        alt={slot.title}
                        className="h-full w-full object-cover"
                        draggable={false}
                      />
                      {/* 非 ready 态(重新生成/失败)叠小角标,旧图继续兜底展示。 */}
                      {slot.status !== 'ready' ? (
                        <span className="absolute right-1 top-1 rounded bg-black/55 px-1 py-0.5">
                          <StatusBadge status={slot.status} />
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <StatusBadge status={slot.status} />
                    </div>
                  )}
                  <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1 text-[10px] leading-4 text-white">
                    {index + 1}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-ds-muted">{slot.title}</span>
                  <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                    <span
                      role="button"
                      tabIndex={0}
                      title={t('slidesDuplicateSlide')}
                      aria-label={t('slidesDuplicateSlide')}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (!mutating) void duplicateSlide(slot.id)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !mutating) void duplicateSlide(slot.id)
                      }}
                      className="rounded p-0.5 text-ds-faint hover:text-ds-muted"
                    >
                      <Copy className="h-3 w-3" strokeWidth={1.9} />
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      title={t('slidesDeleteSlide')}
                      aria-label={t('slidesDeleteSlide')}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (!mutating) void deleteSlide(slot.id)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !mutating) void deleteSlide(slot.id)
                      }}
                      className="rounded p-0.5 text-ds-faint hover:text-[#c0392b]"
                    >
                      <Trash2 className="h-3 w-3" strokeWidth={1.9} />
                    </span>
                  </span>
                </div>
              </button>
            </li>
          )
        })}
      </ol>
      <div className="shrink-0 border-t border-black/8 p-2 dark:border-white/8">
        <button
          type="button"
          onClick={() => void insertSlide(slots.at(-1)?.id)}
          disabled={mutating || !manifest}
          aria-label={t('slidesAddSlide')}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-black/15 py-2 text-[12px] text-ds-muted transition hover:border-[#3b82d8] hover:text-[#3b82d8] disabled:opacity-50 dark:border-white/15"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          {t('slidesAddSlide')}
        </button>
      </div>
    </div>
  )
}
