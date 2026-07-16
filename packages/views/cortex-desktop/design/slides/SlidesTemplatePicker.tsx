// 模板选择器:列出内置模板(配色条 + 名称 + 中文描述 + 明暗/标签),点选即把该模板的
// 结构化主题写进 deck(与 MCP apply_template 同一写入路径)。当前主题名高亮为「已应用」。
//
// 为什么要有这个面板:模板此前只有 Agent 侧工具,用户在界面上无从选择/预览。
// 选定后风格指南随 deck 主题落盘,Agent 下一轮 get_deck_state 即可读到并照做。
import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, Search, X } from 'lucide-react'
import type { SlidesTemplateSummary } from '@cortex-work/core/design/slides/slides-templates'
import { useSlidesStore } from './slides-store'

/** 配色条:直观展示模板的背景/前景/主色/强调色。 */
function PaletteStrip({ template }: { template: SlidesTemplateSummary }): ReactElement {
  const p = template.theme.palette
  return (
    <span className="flex h-5 w-16 shrink-0 overflow-hidden rounded-md shadow-[0_0_0_1px_rgba(0,0,0,0.08)]">
      {[p.background, p.foreground, p.primary, p.accent].map((color, i) => (
        <span key={i} className="h-full flex-1" style={{ background: color }} />
      ))}
    </span>
  )
}

export function SlidesTemplatePicker(): ReactElement | null {
  const { t } = useTranslation('design')
  const open = useSlidesStore((s) => s.templatePickerOpen)
  const templates = useSlidesStore((s) => s.templates)
  const manifest = useSlidesStore((s) => s.manifest)
  const mutating = useSlidesStore((s) => s.mutating)
  const close = useSlidesStore((s) => s.closeTemplatePicker)
  const applyTemplate = useSlidesStore((s) => s.applyTemplate)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !templates) return templates ?? []
    return templates.filter((tpl) =>
      [tpl.title, tpl.description, tpl.descriptionZh, ...tpl.tags].join(' ').toLowerCase().includes(q)
    )
  }, [templates, query])

  if (!open) return null
  const appliedName = manifest?.theme.name ?? ''

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/35" role="dialog" aria-modal="true">
      <div
        data-testid="slides-template-picker"
        className="flex max-h-[85%] w-[620px] flex-col overflow-hidden rounded-xl bg-ds-main shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-black/8 px-4 py-3 dark:border-white/8">
          <div>
            <h2 className="text-[14px] font-semibold text-ds-strong">{t('slidesTemplateTitle')}</h2>
            <p className="mt-0.5 text-[11.5px] text-ds-muted">{t('slidesTemplateHint')}</p>
          </div>
          <button type="button" onClick={close} aria-label={t('close')} className="text-ds-muted hover:text-ds-strong">
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
        <div className="shrink-0 border-b border-black/8 px-4 py-2 dark:border-white/8">
          <label className="flex items-center gap-2 rounded-lg border border-black/10 px-2 py-1.5 dark:border-white/10">
            <Search className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={2} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('slidesTemplateSearch')}
              aria-label={t('slidesTemplateSearch')}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ds-strong outline-hidden"
            />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {templates === null ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[12.5px] text-ds-muted">
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
              {t('slidesTemplateLoading')}
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-10 text-center text-[12.5px] text-ds-muted">{t('slidesTemplateEmpty')}</p>
          ) : (
            <ul className="grid grid-cols-2 gap-2">
              {filtered.map((tpl) => {
                const applied = appliedName === tpl.theme.name
                return (
                  <li key={tpl.id}>
                    <button
                      type="button"
                      data-testid={`slides-template-${tpl.id}`}
                      disabled={mutating}
                      onClick={() => void applyTemplate(tpl.id)}
                      className={`flex w-full flex-col gap-1.5 rounded-lg border p-2.5 text-left transition disabled:opacity-50 ${
                        applied
                          ? 'border-[#3b82d8] bg-[#3b82d8]/8'
                          : 'border-black/10 hover:border-[#3b82d8]/60 dark:border-white/10'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <PaletteStrip template={tpl} />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ds-strong">
                          {tpl.title}
                        </span>
                        {applied ? (
                          <Check className="h-3.5 w-3.5 shrink-0 text-[#3b82d8]" strokeWidth={2.5} />
                        ) : null}
                      </span>
                      <span className="line-clamp-2 text-[11.5px] leading-4 text-ds-muted">
                        {tpl.descriptionZh || tpl.description}
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="rounded bg-black/6 px-1.5 py-0.5 text-[10.5px] text-ds-faint dark:bg-white/10">
                          {t(tpl.category === 'dark' ? 'slidesTemplateDark' : 'slidesTemplateLight')}
                        </span>
                        {tpl.tags.slice(0, 2).map((tag) => (
                          <span key={tag} className="truncate text-[10.5px] text-ds-faint">
                            #{tag}
                          </span>
                        ))}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
