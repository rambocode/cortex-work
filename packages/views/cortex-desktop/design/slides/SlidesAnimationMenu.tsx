// 工具栏「动画」下拉菜单:上半为全局动画风格三选一(无动画/稳重/活泼),下半为当前页
// 翻页过渡选择(含「跟随风格」= 清除页级覆写)。数据落 deck.json:风格走
// slides:setAnimationStyle,页过渡走 slides:setSlideAnimation(经 slides-store 乐观锁)。
// 动画只在播放/HTML 导出生效,编辑舞台保持静态(可用 Stage 的「预览动画」按钮重放)。
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Clapperboard } from 'lucide-react'
import type { SlidesAnimationStyle, SlidesTransition } from '@cortex-work/core/design/slides/slides-types'
import { useSlidesStore } from './slides-store'

const STYLES: SlidesAnimationStyle[] = ['none', 'subtle', 'lively']

// 过渡选项:null = 跟随全局风格默认(清除页级覆写)。顺序:2D 在前、3D 在后。
const TRANSITIONS: Array<SlidesTransition | null> = [
  null,
  'none',
  'fade',
  'push-horizontal',
  'push-vertical',
  'zoom',
  'page-flip',
  'cube-rotate'
]

const STYLE_KEY: Record<SlidesAnimationStyle, string> = {
  none: 'slidesAnimationStyleNone',
  subtle: 'slidesAnimationStyleSubtle',
  lively: 'slidesAnimationStyleLively'
}

const TRANSITION_KEY: Record<SlidesTransition, string> = {
  none: 'slidesAnimationTransitionNone',
  fade: 'slidesAnimationTransitionFade',
  'push-horizontal': 'slidesAnimationTransitionPushH',
  'push-vertical': 'slidesAnimationTransitionPushV',
  zoom: 'slidesAnimationTransitionZoom',
  'page-flip': 'slidesAnimationTransitionFlip',
  'cube-rotate': 'slidesAnimationTransitionCube'
}

/** 工具栏动画菜单(SlidesToolbar 内的 relative wrapper 下渲染,与模板/导出下拉同范式)。 */
export function SlidesAnimationMenu(): ReactElement | null {
  const { t } = useTranslation('design')
  const manifest = useSlidesStore((s) => s.manifest)
  const canAnimate = useSlidesStore((s) => s.canAnimate)
  const mutating = useSlidesStore((s) => s.mutating)
  const setAnimationStyle = useSlidesStore((s) => s.setAnimationStyle)
  const setSlotTransition = useSlidesStore((s) => s.setSlotTransition)
  const materializeSlotEntrances = useSlidesStore((s) => s.materializeSlotEntrances)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 点击菜单外部关闭(与工具栏其它下拉一致的轻量处理)。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  if (!canAnimate) return null

  const style = manifest?.animationStyle ?? 'none'
  const activeSlide = manifest?.slides.find((s) => s.id === manifest.activeSlideId) ?? null
  const currentTransition = activeSlide?.animation?.transition ?? null
  // 入场触发方式:任一 entrance 带 step>0 视为「按键逐个」;否则「自动依次」。
  const triggerMode: 'auto' | 'stepped' = activeSlide?.animation?.entrances?.some((e) => e.step > 0)
    ? 'stepped'
    : 'auto'

  return (
    <div ref={rootRef} className="ds-no-drag relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!manifest}
        aria-expanded={open}
        title={t('slidesAnimationTitle')}
        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-[12px] text-ds-muted transition hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/8"
      >
        <Clapperboard className="h-3.5 w-3.5" strokeWidth={1.9} />
        <span className="hidden min-[1080px]:inline">{t('slidesAnimation')}</span>
        <ChevronDown className="h-3 w-3" strokeWidth={2} />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1 w-48 rounded-lg border border-black/10 bg-ds-main p-2 shadow-lg dark:border-white/10">
          <div className="px-1 pb-1 text-[11px] font-medium text-ds-muted">{t('slidesAnimationStyleLabel')}</div>
          <div className="flex gap-1 pb-2">
            {STYLES.map((s) => (
              <button
                key={s}
                type="button"
                disabled={mutating}
                aria-pressed={style === s}
                onClick={() => void setAnimationStyle(s)}
                className={`flex-1 rounded-md px-1.5 py-1 text-[12px] transition disabled:opacity-40 ${
                  style === s
                    ? 'bg-black/8 font-medium text-ds-strong dark:bg-white/15'
                    : 'text-ds-muted hover:bg-black/5 hover:text-ds-strong dark:hover:bg-white/8'
                }`}
              >
                {t(STYLE_KEY[s])}
              </button>
            ))}
          </div>
          {/* 入场触发:自动依次(切页即播) / 按键逐个(每按一次键出现一个元素,PPT 分步)。
              切换会把当前页编排物化为显式 entrances 落 deck.json(双屏步进权威依赖它)。 */}
          <div className="px-1 pb-1 text-[11px] font-medium text-ds-muted">{t('slidesAnimationTriggerLabel')}</div>
          <div className="flex gap-1 pb-2">
            {(['auto', 'stepped'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                disabled={mutating || !activeSlide || style === 'none'}
                aria-pressed={triggerMode === mode}
                title={style === 'none' ? t('slidesAnimationPreviewNone') : undefined}
                onClick={() => {
                  if (activeSlide && triggerMode !== mode) void materializeSlotEntrances(activeSlide.id, mode)
                }}
                className={`flex-1 rounded-md px-1.5 py-1 text-[12px] transition disabled:opacity-40 ${
                  triggerMode === mode
                    ? 'bg-black/8 font-medium text-ds-strong dark:bg-white/15'
                    : 'text-ds-muted hover:bg-black/5 hover:text-ds-strong dark:hover:bg-white/8'
                }`}
              >
                {t(mode === 'auto' ? 'slidesAnimationTriggerAuto' : 'slidesAnimationTriggerStepped')}
              </button>
            ))}
          </div>
          <div className="px-1 pb-1 text-[11px] font-medium text-ds-muted">{t('slidesAnimationTransitionLabel')}</div>
          <div className="max-h-56 overflow-y-auto">
            {TRANSITIONS.map((tr) => {
              const selected = tr === currentTransition
              return (
                <button
                  key={tr ?? 'default'}
                  type="button"
                  disabled={mutating || !activeSlide}
                  aria-pressed={selected}
                  onClick={() => {
                    if (activeSlide) void setSlotTransition(activeSlide.id, tr)
                  }}
                  className={`block w-full rounded-md px-2 py-1 text-left text-[12px] transition disabled:opacity-40 ${
                    selected
                      ? 'bg-black/8 font-medium text-ds-strong dark:bg-white/15'
                      : 'text-ds-strong hover:bg-black/5 dark:hover:bg-white/8'
                  }`}
                >
                  {tr === null ? t('slidesAnimationTransitionDefault') : t(TRANSITION_KEY[tr])}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}
