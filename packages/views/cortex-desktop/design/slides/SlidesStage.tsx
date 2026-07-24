// 中间舞台:整块 webview 直接加载 deck.bento.html —— bento 内置编辑器(缩略图栏/
// Moveable 拖拽/属性面板)即编辑体验,宿主不再自研画布工具。
// 职责只剩三件:
//   1. 经 DesignHtmlPreviewHost 加载(partition 授权 + 文件 watch 重载闸门);
//   2. dom-ready 注入保存桥 shim,周期 drain 编辑器 autosave 的整份 HTML 落盘;
//   3. 自写回静默窗:autosave 落盘 → watcher 推 revision,窗口期内跳过重载,
//      避免编辑中被自己的保存打断(选区/撤销栈会随重载消亡)。
import { useCallback, useEffect, useRef, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { bentoDeckHtmlPath } from '@cortex-work/core/design/slides/slides-paths'
import { useDesignHtmlPreview } from '../DesignHtmlPreviewHost'
import {
  BENTO_DRAIN_INTERVAL_MS,
  BENTO_HOST_SHIM_SOURCE,
  DRAIN_BENTO_SAVE_SOURCE,
  parseBentoSaveDrain
} from './bento-stage-bridge'
import { useBentoSlidesStore } from './bento-slides-store'
import { SLIDES_WEBVIEW_PARTITION } from './slides-webview-partition'

type Props = {
  workspaceRoot: string
  deckId: string
}

// 自写回静默窗:落盘 → watcher 推 revision 的延迟通常数百毫秒,2s 吞掉本次事件;
// 超窗的迟到事件退化为一次多余重载(安全兜底)。AI 外部改写不在窗口期,照常重载。
const SELF_SAVE_RELOAD_MUTE_MS = 2000

export function SlidesStage({ workspaceRoot, deckId }: Props): ReactElement {
  const { t } = useTranslation('design')
  const saveEditedDeckHtml = useBentoSlidesStore((s) => s.saveEditedDeckHtml)

  const selfSaveUntilRef = useRef(0)
  const shouldSkipReload = useCallback(() => Date.now() < selfSaveUntilRef.current, [])

  // dom-ready(含每次重载)注入保存桥 shim;幂等,重复注入无害。
  const handleWebviewReady = useCallback(
    (webview: { executeJavaScript?: (code: string) => Promise<unknown> }) => {
      void webview.executeJavaScript?.(BENTO_HOST_SHIM_SOURCE).catch(() => undefined)
    },
    []
  )

  const preview = useDesignHtmlPreview({
    workspaceRoot,
    relativePath: bentoDeckHtmlPath(deckId),
    enabled: Boolean(workspaceRoot && deckId),
    // persist: 分区:编辑器 localStorage(语言/动效偏好)落盘,且与放映窗共享(见常量注释)。
    partition: SLIDES_WEBVIEW_PARTITION,
    zoom: 1,
    // deck 文件由主进程异步创建/可能被外部改写重建:缺失时按 'prototype file not found'
    // 哨兵轮询等待(bridge-adapter 已区分 not-found 与越权),兜住挂载 gate 之外的迟到场景。
    retryMissingFile: true,
    onWebviewReady: handleWebviewReady,
    shouldSkipReload
  })

  // 保存泵:周期 drain 页内暂存的整份 HTML → 落盘。切 deck/卸载前最后 drain 一次不丢尾。
  const executeScript = preview.executeScript
  const deckIdRef = useRef(deckId)
  useEffect(() => {
    deckIdRef.current = deckId
  }, [deckId])

  useEffect(() => {
    if (!preview.state.ready) return
    let disposed = false
    const pump = async (): Promise<void> => {
      const html = parseBentoSaveDrain(await executeScript(DRAIN_BENTO_SAVE_SOURCE))
      if (disposed || !html) return
      // 切 deck 竞态:drain 结果必须仍属于当前 deck,否则丢弃(绝不把 A 稿写进 B 稿)。
      if (deckIdRef.current !== deckId) return
      selfSaveUntilRef.current = Date.now() + SELF_SAVE_RELOAD_MUTE_MS
      const saved = await saveEditedDeckHtml(html)
      if (!saved) selfSaveUntilRef.current = 0
    }
    const timer = window.setInterval(() => void pump(), BENTO_DRAIN_INTERVAL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
      void pump()
    }
  }, [preview.state.ready, executeScript, saveEditedDeckHtml, deckId])

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 bg-black/4 dark:bg-black/30" data-testid="bento-slides-stage">
      {preview.renderWebview({
        className: 'h-full w-full flex-1',
        style: { width: '100%', height: '100%' },
        title: t('slidesDeckLoading')
      }) ?? (
        <div className="flex h-full w-full items-center justify-center text-[12.5px] text-ds-muted">
          {preview.state.error || t('slidesDeckLoading')}
        </div>
      )}
      {preview.state.error ? (
        <div className="absolute inset-x-0 bottom-0 bg-[#c0392b]/85 px-2 py-1 text-[11px] text-white">
          {preview.state.error}
        </div>
      ) : null}
    </div>
  )
}
