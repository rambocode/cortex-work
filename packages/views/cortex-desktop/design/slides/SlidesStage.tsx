// 中间页面舞台:固定 16:9(1280×720)webview 预览当前 slide。
// 复用 DesignHtmlPreviewHost(authorizeWritePrototype 本地授权 + revision watch +
// 既有 webview 导航闸门);zoom=fit 时按容器实测缩放,否则用固定档位。
// 空/生成中/错误 slot 渲染对应占位,不挂 webview。
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Italic,
  Loader2,
  Redo2,
  Trash2,
  TriangleAlert,
  Underline,
  Undo2
} from 'lucide-react'
import { SLIDES_CANVAS_HEIGHT, SLIDES_CANVAS_WIDTH, type SlidesSlot } from '@cortex-work/core/design/slides/slides-types'
import { useDesignHtmlPreview } from '../DesignHtmlPreviewHost'
import {
  BRIDGE_DRAIN_INTERVAL_MS,
  buildSlideEditBridgeSource,
  compileSlideBridgeCommand,
  DRAIN_SLIDE_BRIDGE_SOURCE,
  parseSlideBridgeDrain,
  type SlideBridgeCommand
} from './slide-edit-bridge'
import { useSlidesStore } from './slides-store'

type Props = {
  workspaceRoot: string
  slot: SlidesSlot | null
  focusElement?: { slotId: string; elementId: string; nonce: number } | null
  /** 错误页占位上的「重试本页」回调(缺省不显示按钮)。 */
  onRetrySlide?: () => void
}

// 自写回静默窗时长:落盘 → 文件 watcher 推 revision 的延迟通常在数百毫秒内,
// 2s 窗口足够吞掉本次事件;超窗的迟到事件退化为一次多余重载(安全兜底)。
const SELF_SAVE_RELOAD_MUTE_MS = 2000

// fit 模式:容器尺寸 → 缩放因子(留 24px 内边距,夹在 0.1–1 之间,不放大超过 100%)。
export function slidesFitZoomFactor(containerWidth: number, containerHeight: number): number {
  const w = (containerWidth - 48) / SLIDES_CANVAS_WIDTH
  const h = (containerHeight - 48) / SLIDES_CANVAS_HEIGHT
  const factor = Math.min(w, h, 1)
  return Number.isFinite(factor) && factor > 0.1 ? Math.round(factor * 1000) / 1000 : 0.1
}

export function SlidesStage({ workspaceRoot, slot, focusElement, onRetrySlide }: Props): ReactElement {
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
  const saveEditedHtml = useSlidesStore((s) => s.saveEditedHtml)
  const conflictNotice = useSlidesStore((s) => s.conflictNotice)
  const stageSelection = useSlidesStore((s) => s.stageSelection)
  const setStageSelection = useSlidesStore((s) => s.setStageSelection)
  const clearStageSelection = useSlidesStore((s) => s.clearStageSelection)
  const stageHistory = useSlidesStore((s) => s.stageHistory)
  const setStageHistory = useSlidesStore((s) => s.setStageHistory)

  // webview dom-ready 时注入编辑 bridge(幂等;导航后需重注,故挂在 onWebviewReady)。
  // 页面重载(含 Agent 改写后刷新)意味着页内选区与历史栈已消亡,宿主侧同步清空。
  const handleWebviewReady = useCallback(
    (webview: { executeJavaScript?: (code: string) => Promise<unknown> }) => {
      clearStageSelection()
      setStageHistory({ canUndo: false, canRedo: false })
      void webview.executeJavaScript?.(buildSlideEditBridgeSource()).catch(() => undefined)
    },
    [clearStageSelection, setStageHistory]
  )

  // 自写回静默窗:编辑保存(移动/改字)落盘后 watcher 会推新 revision,但页面 DOM 本身
  // 就是刚保存的内容 —— 窗口期内跳过重载,避免闪屏、选区与光标被清空(用户实测:
  // 移动一次后重载把编辑桥吞掉,再也选不中)。Agent 外部改写不在窗口期,照常重载。
  const selfSaveUntilRef = useRef(0)
  const shouldSkipReload = useCallback(() => Date.now() < selfSaveUntilRef.current, [])

  const preview = useDesignHtmlPreview({
    workspaceRoot,
    relativePath: showWebview ? slot!.htmlPath : undefined,
    enabled: showWebview,
    partition: 'cortex-slides',
    zoom: factor,
    // slide 文件由主进程原子写,不存在=尚未生成;不要长轮询等待。
    retryMissingFile: false,
    onWebviewReady: handleWebviewReady,
    shouldSkipReload
  })

  // 编辑 bridge 消息泵:周期性 drain 页内队列,把 html-changed 提交保存。
  // 冲突后停机:conflictNotice 为真时不再自动保存(用户点「刷新」确认后恢复)。
  const executeScript = preview.executeScript
  const slotIdRef = useRef<string | null>(null)
  useEffect(() => {
    slotIdRef.current = slot?.id ?? null
    // 切页即清选区(旧页的选区对新页无意义,也不能进 LLM 上下文)。
    clearStageSelection()
  }, [slot?.id, clearStageSelection])

  useEffect(() => {
    if (!preview.state.ready || !focusElement || focusElement.slotId !== slot?.id) return
    void executeScript(compileSlideBridgeCommand({ type: 'focus-element', elementId: focusElement.elementId }))
  }, [executeScript, focusElement, preview.state.ready, slot?.id])

  useEffect(() => {
    if (!showWebview || !preview.state.ready || conflictNotice) return
    let disposed = false
    const pump = async (): Promise<void> => {
      const raw = await executeScript(DRAIN_SLIDE_BRIDGE_SOURCE)
      if (disposed || !raw) return
      for (const msg of parseSlideBridgeDrain(raw)) {
        const targetSlotId = slotIdRef.current
        // 页面切换竞态:drain 结果必须归属当前 slot,否则丢弃(绝不把 A 页内容写进 B 页)。
        if (!targetSlotId || targetSlotId !== slot?.id) continue
        if (msg.type === 'selection-changed') {
          setStageSelection(targetSlotId, msg.items)
          continue
        }
        if (msg.type === 'history-changed') {
          setStageHistory({ canUndo: msg.canUndo, canRedo: msg.canRedo })
          continue
        }
        if (msg.type !== 'html-changed') continue
        // 保存前开静默窗:watcher 的 revision 事件在落盘后异步到达。
        selfSaveUntilRef.current = Date.now() + SELF_SAVE_RELOAD_MUTE_MS
        const saved = await saveEditedHtml(targetSlotId, msg.html)
        // 保存失败(如 revision 冲突,文件已被别处改写)→ 立即解除静默,让重载展示真实内容。
        if (!saved) selfSaveUntilRef.current = 0
      }
    }
    const timer = window.setInterval(() => void pump(), BRIDGE_DRAIN_INTERVAL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
      // 离开页面前 flush pending save,再最后 drain 一次(不丢最后一次编辑)。
      void executeScript(compileSlideBridgeCommand({ type: 'flush' }))
      void executeScript(DRAIN_SLIDE_BRIDGE_SOURCE)?.then((raw) => {
        const slotId = slot?.id
        if (!slotId) return
        for (const msg of parseSlideBridgeDrain(raw)) {
          if (msg.type === 'html-changed') {
            selfSaveUntilRef.current = Date.now() + SELF_SAVE_RELOAD_MUTE_MS
            void saveEditedHtml(slotId, msg.html)
          }
        }
      })
    }
  }, [showWebview, preview.state.ready, conflictNotice, executeScript, saveEditedHtml, setStageSelection, setStageHistory, slot?.id])

  // 选区 chip 的「清除」:页内选区与宿主 store 同时清。
  const handleClearSelection = useCallback(() => {
    void executeScript(compileSlideBridgeCommand({ type: 'clear-selection' }))
    clearStageSelection()
  }, [executeScript, clearStageSelection])

  // 画布工具栏 → 编辑桥命令(选区/历史的实际变更由桥消息回流,宿主不预测状态)。
  const sendCommand = useCallback(
    (command: SlideBridgeCommand) => {
      void executeScript(compileSlideBridgeCommand(command))
    },
    [executeScript]
  )

  const selectionCount = stageSelection && stageSelection.slotId === slot?.id ? stageSelection.items.length : 0

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
            }) ?? <StagePlaceholder status={slot!.status} error={preview.state.error} onRetry={onRetrySlide} />
          ) : (
            <StagePlaceholder status={slot?.status ?? 'empty'} onRetry={onRetrySlide} />
          )}
          {preview.state.error ? (
            <div className="absolute inset-x-0 bottom-0 bg-[#c0392b]/85 px-2 py-1 text-[11px] text-white">
              {preview.state.error}
            </div>
          ) : null}
          {/* 画布工具栏:撤销/重做常驻,选中后追加格式/字号/对齐/删除。 */}
          {showWebview && preview.state.ready ? (
            <div
              data-testid="slides-canvas-toolbar"
              className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-lg bg-black/70 px-1.5 py-1 text-white shadow"
            >
              <ToolButton title={t('slidesUndo')} disabled={!stageHistory.canUndo} onClick={() => sendCommand({ type: 'undo' })}>
                <Undo2 className="h-3.5 w-3.5" strokeWidth={1.9} />
              </ToolButton>
              <ToolButton title={t('slidesRedo')} disabled={!stageHistory.canRedo} onClick={() => sendCommand({ type: 'redo' })}>
                <Redo2 className="h-3.5 w-3.5" strokeWidth={1.9} />
              </ToolButton>
              {selectionCount > 0 ? (
                <>
                  <span className="mx-0.5 h-4 w-px bg-white/20" aria-hidden />
                  <ToolButton title={t('slidesBold')} onClick={() => sendCommand({ type: 'format', command: 'bold' })}>
                    <Bold className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </ToolButton>
                  <ToolButton title={t('slidesItalic')} onClick={() => sendCommand({ type: 'format', command: 'italic' })}>
                    <Italic className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </ToolButton>
                  <ToolButton title={t('slidesUnderline')} onClick={() => sendCommand({ type: 'format', command: 'underline' })}>
                    <Underline className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </ToolButton>
                  <span className="mx-0.5 h-4 w-px bg-white/20" aria-hidden />
                  <ToolButton title={t('slidesFontSmaller')} onClick={() => sendCommand({ type: 'font-step', delta: -2 })}>
                    <span className="text-[11px] leading-none">A−</span>
                  </ToolButton>
                  <ToolButton title={t('slidesFontLarger')} onClick={() => sendCommand({ type: 'font-step', delta: 2 })}>
                    <span className="text-[12.5px] leading-none">A+</span>
                  </ToolButton>
                  <span className="mx-0.5 h-4 w-px bg-white/20" aria-hidden />
                  <ToolButton title={t('slidesAlignLeft')} onClick={() => sendCommand({ type: 'align', value: 'left' })}>
                    <AlignLeft className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </ToolButton>
                  <ToolButton title={t('slidesAlignCenter')} onClick={() => sendCommand({ type: 'align', value: 'center' })}>
                    <AlignCenter className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </ToolButton>
                  <ToolButton title={t('slidesAlignRight')} onClick={() => sendCommand({ type: 'align', value: 'right' })}>
                    <AlignRight className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </ToolButton>
                  <span className="mx-0.5 h-4 w-px bg-white/20" aria-hidden />
                  <ToolButton
                    title={t('slidesDeleteElement')}
                    danger
                    onClick={() => {
                      sendCommand({ type: 'delete-selected' })
                      clearStageSelection()
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </ToolButton>
                </>
              ) : null}
            </div>
          ) : null}
          {/* 选区 chip:提示所选将随下一条消息进入 AI 上下文;可一键清除。 */}
          {selectionCount > 0 ? (
            <div
              data-testid="slides-selection-chip"
              className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-[11.5px] text-white shadow"
            >
              <span>{t('slidesSelectionHint', { count: selectionCount })}</span>
              <button
                type="button"
                onClick={handleClearSelection}
                className="rounded-full px-1.5 py-0.5 text-white/80 transition hover:bg-white/15 hover:text-white"
              >
                {t('slidesSelectionClear')}
              </button>
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

// 画布工具栏按钮:统一尺寸/禁用态;danger 用于删除。
function ToolButton({
  title,
  disabled,
  danger,
  onClick,
  children
}: {
  title: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
  children: ReactNode
}): ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition disabled:opacity-35 ${
        danger ? 'hover:bg-[#c0392b]/80' : 'hover:bg-white/15'
      }`}
    >
      {children}
    </button>
  )
}

function StagePlaceholder({
  status,
  error,
  onRetry
}: {
  status: SlidesSlot['status']
  error?: string
  onRetry?: () => void
}): ReactElement {
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
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 rounded-lg bg-[#3b82d8] px-3 py-1 text-[12px] text-white transition hover:bg-[#2f6fc0]"
            >
              {t('slidesRetrySlide')}
            </button>
          ) : null}
        </>
      ) : (
        <span className="text-[12.5px]">{t('slidesEmptySlideHint')}</span>
      )}
    </div>
  )
}
