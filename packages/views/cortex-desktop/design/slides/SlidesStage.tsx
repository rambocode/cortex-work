// 中间页面舞台:固定 16:9(1280×720)webview 预览当前 slide。
// 复用 DesignHtmlPreviewHost(authorizeWritePrototype 本地授权 + revision watch +
// 既有 webview 导航闸门);zoom=fit 时按容器实测缩放,否则用固定档位。
// 空/生成中/错误 slot 渲染对应占位,不挂 webview。
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, TriangleAlert } from 'lucide-react'
import { SLIDES_CANVAS_HEIGHT, SLIDES_CANVAS_WIDTH, type SlidesSlot } from '@cortex-work/core/design/slides/slides-types'
import { useDesignHtmlPreview } from '../DesignHtmlPreviewHost'
import { useSlidesStore } from './slides-store'

type Props = {
  workspaceRoot: string
  slot: SlidesSlot | null
}

// fit 模式:容器尺寸 → 缩放因子(留 24px 内边距,夹在 0.1–1 之间,不放大超过 100%)。
export function slidesFitZoomFactor(containerWidth: number, containerHeight: number): number {
  const w = (containerWidth - 48) / SLIDES_CANVAS_WIDTH
  const h = (containerHeight - 48) / SLIDES_CANVAS_HEIGHT
  const factor = Math.min(w, h, 1)
  return Number.isFinite(factor) && factor > 0.1 ? Math.round(factor * 1000) / 1000 : 0.1
}

export function SlidesStage({ workspaceRoot, slot }: Props): ReactElement {
  const { t } = useTranslation('design')
  const zoom = useSlidesStore((s) => s.zoom)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [fitFactor, setFitFactor] = useState(0.5)

  // fit 缩放:观察容器尺寸变化(侧栏开合/窗口缩放)。
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setFitFactor(slidesFitZoomFactor(rect.width, rect.height))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const factor = zoom === 'fit' ? fitFactor : Number(zoom) / 100
  const stageWidth = Math.round(SLIDES_CANVAS_WIDTH * factor)
  const stageHeight = Math.round(SLIDES_CANVAS_HEIGHT * factor)

  const showWebview = Boolean(slot && slot.status === 'ready')

  const preview = useDesignHtmlPreview({
    workspaceRoot,
    relativePath: showWebview ? slot!.htmlPath : undefined,
    enabled: showWebview,
    partition: 'cortex-slides',
    zoom: factor,
    // slide 文件由主进程原子写,不存在=尚未生成;不要长轮询等待。
    retryMissingFile: false
  })

  return (
    <div ref={containerRef} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto bg-black/4 dark:bg-black/30">
      {slot ? (
        <div
          data-testid="slides-stage-frame"
          className="relative shrink-0 overflow-hidden rounded-md bg-white shadow-[0_2px_16px_rgba(0,0,0,0.18)]"
          style={{ width: stageWidth, height: stageHeight }}
        >
          {showWebview ? (
            preview.renderWebview({
              className: 'h-full w-full',
              style: { width: '100%', height: '100%' },
              title: slot!.title
            }) ?? <StagePlaceholder status={slot!.status} error={preview.state.error} />
          ) : (
            <StagePlaceholder status={slot?.status ?? 'empty'} />
          )}
          {preview.state.error ? (
            <div className="absolute inset-x-0 bottom-0 bg-[#c0392b]/85 px-2 py-1 text-[11px] text-white">
              {preview.state.error}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="max-w-[380px] px-6 text-center text-[13px] leading-6 text-ds-muted">
          {t('slidesEmptyDeck')}
        </div>
      )}
    </div>
  )
}

function StagePlaceholder({ status, error }: { status: SlidesSlot['status']; error?: string }): ReactElement {
  const { t } = useTranslation('design')
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-ds-muted">
      {status === 'generating' ? (
        <>
          <Loader2 className="h-5 w-5 animate-spin text-[#3b82d8]" strokeWidth={2} />
          <span className="text-[12.5px]">{t('slidesStatusGenerating')}</span>
        </>
      ) : status === 'error' ? (
        <>
          <TriangleAlert className="h-5 w-5 text-[#c0392b]" strokeWidth={2} />
          <span className="text-[12.5px]">{error || t('slidesStatusError')}</span>
        </>
      ) : (
        <span className="text-[12.5px]">{t('slidesEmptySlideHint')}</span>
      )}
    </div>
  )
}
