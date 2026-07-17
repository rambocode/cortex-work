// 模板选择下拉:锚定在工具栏「模板」按钮下方(由 SlidesToolbar 的 relative wrapper 挂载),
// 单列行列表(配色条 + 名称 + 中文描述 + 明暗标签),hover 某行时在面板左侧弹出该模板
// 参考页的真实缩放预览。点选即把模板主题写进 deck(与 MCP apply_template 同一写入路径)。
//
// 为什么用真实参考页而非色板模拟:模板参考页(references/*.html)自包含(内联样式、
// 无外链资源),经 store.readTemplateReference(主进程校验路径后读盘)取回 HTML,
// 用沙箱 iframe srcdoc 按 1280×720 固定版面缩放渲染 —— 用户看到的就是 Agent 将照做的版式。
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, Search } from 'lucide-react'
import type { SlidesTemplateSummary } from '@cortex-work/core/design/slides/slides-templates'
import { useSlidesStore } from './slides-store'

/** 分类角标的 i18n key:business 为场景分类;其余按明暗,unknown 沿用历史行为归入浅色。 */
function categoryLabelKey(category: SlidesTemplateSummary['category']): string {
  if (category === 'business') return 'slidesTemplateBusiness'
  return category === 'dark' ? 'slidesTemplateDark' : 'slidesTemplateLight'
}

/** 配色条:直观展示模板的背景/前景/主色/强调色。 */
function PaletteStrip({ template }: { template: SlidesTemplateSummary }): ReactElement {
  const p = template.theme.palette
  return (
    <span className="flex h-5 w-14 shrink-0 overflow-hidden rounded-md shadow-[0_0_0_1px_rgba(0,0,0,0.08)]">
      {[p.background, p.foreground, p.primary, p.accent].map((color, i) => (
        <span key={i} className="h-full flex-1" style={{ background: color }} />
      ))}
    </span>
  )
}

// 参考页固定版面尺寸(与 deck 演示页同为 1280×720),缩放到预览卡片内。
const REF_WIDTH = 1280
const REF_HEIGHT = 720
const PREVIEW_WIDTH = 320
const PREVIEW_SCALE = PREVIEW_WIDTH / REF_WIDTH

/** hover 预览卡片:参考页 HTML 可用时以沙箱 iframe 缩放渲染,否则退化为大号色板占位。 */
function TemplatePreviewCard({
  template,
  html,
  loading
}: {
  template: SlidesTemplateSummary
  html: string | null
  loading: boolean
}): ReactElement {
  const { t } = useTranslation('design')
  const p = template.theme.palette
  return (
    // pointer-events-none:预览纯展示,鼠标不可落入 —— 否则移向预览会触发列表 mouseleave 抖动。
    <div className="pointer-events-none absolute right-[312px] top-full z-50 mt-1 w-[336px] rounded-xl border border-black/10 bg-ds-main p-2 shadow-2xl dark:border-white/10">
      <div
        className="relative overflow-hidden rounded-md shadow-[0_0_0_1px_rgba(0,0,0,0.08)]"
        style={{ width: PREVIEW_WIDTH, height: REF_HEIGHT * PREVIEW_SCALE }}
      >
        {html ? (
          <iframe
            sandbox=""
            srcDoc={html}
            title={template.title}
            className="origin-top-left border-0"
            style={{ width: REF_WIDTH, height: REF_HEIGHT, transform: `scale(${PREVIEW_SCALE})` }}
          />
        ) : (
          // 加载中 / 无参考页 / web 端无桥接能力:色板铺底占位,不报错。
          <div className="flex h-full w-full">
            {[p.background, p.foreground, p.primary, p.accent].map((color, i) => (
              <div key={i} className="h-full flex-1" style={{ background: color }} />
            ))}
            {loading ? (
              <Loader2 className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/80 mix-blend-difference" strokeWidth={2} />
            ) : null}
          </div>
        )}
      </div>
      <p className="mt-1.5 truncate text-[12px] font-medium text-ds-strong">{template.title}</p>
      <p className="line-clamp-2 text-[11px] leading-4 text-ds-muted">
        {template.descriptionZh || template.description}
      </p>
      <p className="mt-0.5 truncate text-[10.5px] text-ds-faint">
        {t(categoryLabelKey(template.category))}
        {template.tags.slice(0, 3).map((tag) => ` #${tag}`).join('')}
      </p>
    </div>
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
  const readTemplateReference = useSlidesStore((s) => s.readTemplateReference)
  const [query, setQuery] = useState('')
  const [hoverTpl, setHoverTpl] = useState<SlidesTemplateSummary | null>(null)
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  // 参考页 HTML 缓存(模板资源只读,取一次终身有效);null 也缓存,避免失败后反复请求。
  const htmlCache = useRef(new Map<string, string | null>())

  // Escape 关闭(下拉惯例;backdrop 负责点击外部关闭)。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  // 重新打开时清掉上次的 hover 残留(组件常驻,只是 open=false 时不渲染)。
  useEffect(() => {
    if (!open) setHoverTpl(null)
  }, [open])

  // hover 变化 → 取参考页 HTML(带缓存与竞态保护:响应回来时若已 hover 别处则丢弃)。
  useEffect(() => {
    if (!hoverTpl) {
      setPreviewHtml(null)
      return
    }
    const file = hoverTpl.referenceSlides[0]?.file
    if (!file) {
      setPreviewHtml(null)
      return
    }
    const key = `${hoverTpl.id}/${file}`
    const cached = htmlCache.current.get(key)
    if (cached !== undefined) {
      setPreviewHtml(cached)
      return
    }
    setPreviewHtml(null)
    let stale = false
    void readTemplateReference(hoverTpl.id, file).then((html) => {
      htmlCache.current.set(key, html)
      if (!stale) setPreviewHtml(html)
    })
    return () => {
      stale = true
    }
  }, [hoverTpl, readTemplateReference])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !templates) return templates ?? []
    return templates.filter((tpl) =>
      [tpl.title, tpl.description, tpl.descriptionZh, ...tpl.tags].join(' ').toLowerCase().includes(q)
    )
  }, [templates, query])

  if (!open) return null
  const appliedName = manifest?.theme.name ?? ''
  const previewLoading = hoverTpl ? previewHtml === null && !htmlCache.current.has(`${hoverTpl.id}/${hoverTpl.referenceSlides[0]?.file ?? ''}`) : false

  return (
    <>
      {/* 透明遮罩:点击面板外任意处关闭(不压暗页面,保持下拉轻量感)。 */}
      <div className="fixed inset-0 z-40" onClick={close} />
      <div
        data-testid="slides-template-picker"
        role="dialog"
        aria-label={t('slidesTemplateTitle')}
        className="absolute right-0 top-full z-50 mt-1 flex w-[304px] flex-col overflow-hidden rounded-xl border border-black/10 bg-ds-main shadow-2xl dark:border-white/10"
        onMouseLeave={() => setHoverTpl(null)}
      >
        <div className="shrink-0 border-b border-black/8 p-2 dark:border-white/8">
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
        <div className="min-h-0 max-h-[420px] flex-1 overflow-y-auto p-1">
          {templates === null ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-ds-muted">
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
              {t('slidesTemplateLoading')}
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-[12.5px] text-ds-muted">{t('slidesTemplateEmpty')}</p>
          ) : (
            <ul>
              {filtered.map((tpl) => {
                const applied = appliedName === tpl.theme.name
                return (
                  <li key={tpl.id}>
                    <button
                      type="button"
                      data-testid={`slides-template-${tpl.id}`}
                      disabled={mutating}
                      onClick={() => void applyTemplate(tpl.id)}
                      onMouseEnter={() => setHoverTpl(tpl)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition disabled:opacity-50 ${
                        applied ? 'bg-[#3b82d8]/8' : 'hover:bg-black/5 dark:hover:bg-white/8'
                      }`}
                    >
                      <PaletteStrip template={tpl} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium text-ds-strong">{tpl.title}</span>
                        <span className="block truncate text-[11px] leading-4 text-ds-muted">
                          {tpl.descriptionZh || tpl.description}
                        </span>
                      </span>
                      <span className="shrink-0 rounded bg-black/6 px-1.5 py-0.5 text-[10px] text-ds-faint dark:bg-white/10">
                        {t(categoryLabelKey(tpl.category))}
                      </span>
                      {applied ? <Check className="h-3.5 w-3.5 shrink-0 text-[#3b82d8]" strokeWidth={2.5} /> : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
      {hoverTpl ? <TemplatePreviewCard template={hoverTpl} html={previewHtml} loading={previewLoading} /> : null}
    </>
  )
}
