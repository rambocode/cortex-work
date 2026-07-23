// 中间页面舞台:固定 16:9(1280×720)webview 预览当前 slide。
// 复用 DesignHtmlPreviewHost(authorizeWritePrototype 本地授权 + revision watch +
// 既有 webview 导航闸门);zoom=fit 时按容器实测缩放,否则用固定档位。
// 空/生成中/错误 slot 渲染对应占位,不挂 webview。
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  Bold,
  BringToFront,
  ChevronDown,
  ChevronUp,
  CirclePlay,
  Italic,
  Loader2,
  Redo2,
  Wand2,
  SendToBack,
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
import type { SlidesElementAnimation, SlidesEntrancePreset } from '@cortex-work/core/design/slides/slides-types'
import { useSlidesStore } from './slides-store'
import { buildEntrancePlanProbeSource, buildSlideAnimationPreviewSource } from './slide-animation-preview'

// 选中元素可指定的入场预设(顺序即菜单顺序;null 项单独渲染为「移除动画」)。
const ELEMENT_PRESETS: Array<{ preset: SlidesEntrancePreset; labelKey: string }> = [
  { preset: 'fade-in', labelKey: 'slidesAnimPresetFadeIn' },
  { preset: 'fade-up', labelKey: 'slidesAnimPresetFadeUp' },
  { preset: 'slide-in-left', labelKey: 'slidesAnimPresetSlideLeft' },
  { preset: 'slide-in-right', labelKey: 'slidesAnimPresetSlideRight' },
  { preset: 'zoom-in', labelKey: 'slidesAnimPresetZoomIn' },
  { preset: 'reveal-clip', labelKey: 'slidesAnimPresetReveal' }
]

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

  // 「预览动画」:注入一次性预览脚本重放本页入场(播完自动清理,不落盘、不扰编辑桥)。
  // 风格为 none 时按钮禁用并以 title 提示先去工具栏选风格(避免点了没反应的困惑)。
  const animationStyle = useSlidesStore((s) => s.manifest?.animationStyle ?? 'none')
  const handlePreviewAnimation = useCallback(() => {
    if (!slot) return
    void executeScript(
      buildSlideAnimationPreviewSource({
        style: animationStyle,
        entrances: slot.animation?.entrances?.length ? slot.animation.entrances : null
      })
    )
  }, [executeScript, slot, animationStyle])

  // 舞台入场计划探针:webview 就绪时注册(供 store 把启发式编排物化为显式 entrances),
  // 页面/组件切换时注销,避免 store 拿着指向已卸载 webview 的探针。
  const registerStageAnimationProbe = useSlidesStore((s) => s.registerStageAnimationProbe)
  useEffect(() => {
    if (!showWebview || !preview.state.ready) return
    registerStageAnimationProbe(async () => {
      const raw = await executeScript(buildEntrancePlanProbeSource(animationStyle))
      if (typeof raw !== 'string') return null
      try {
        return JSON.parse(raw) as SlidesElementAnimation[]
      } catch {
        return null
      }
    })
    return () => registerStageAnimationProbe(null)
  }, [showWebview, preview.state.ready, executeScript, animationStyle, registerStageAnimationProbe])

  // 选中元素的入场动画设定:下拉列出预设 + 移除;应用于当前选区全部元素。
  const setElementAnimation = useSlidesStore((s) => s.setElementAnimation)
  const [elementAnimOpen, setElementAnimOpen] = useState(false)
  const selectedElementIds =
    stageSelection && stageSelection.slotId === slot?.id ? stageSelection.items.map((i) => i.elementId) : []
  const handleElementPreset = useCallback(
    (preset: SlidesEntrancePreset | null) => {
      setElementAnimOpen(false)
      if (!slot || selectedElementIds.length === 0) return
      void setElementAnimation(slot.id, selectedElementIds, preset)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedElementIds 由 selection 派生,数组身份逐次变化
    [slot?.id, stageSelection, setElementAnimation]
  )

  return (
    // 竖向三段布局:工具栏行(画布上方)→ 画布 → 选区 chip 行(画布下方)。
    // 工具栏与 chip 不再悬浮在幻灯片画布内部,避免遮挡页面内容;
    // 上下两行固定高度常驻,防止出现/消失时 fit 缩放反复抖动。
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-black/4 dark:bg-black/30">
      {/* 画布工具栏:撤销/重做常驻,选中后追加格式/字号/对齐/删除。 */}
      <div className="flex h-11 shrink-0 items-center justify-center">
        {showWebview && preview.state.ready ? (
          <div
            data-testid="slides-canvas-toolbar"
            className="flex items-center gap-0.5 rounded-lg bg-black/70 px-1.5 py-1 text-white shadow"
          >
            <ToolButton title={t('slidesUndo')} disabled={!stageHistory.canUndo} onClick={() => sendCommand({ type: 'undo' })}>
              <Undo2 className="h-3.5 w-3.5" strokeWidth={1.9} />
            </ToolButton>
            <ToolButton title={t('slidesRedo')} disabled={!stageHistory.canRedo} onClick={() => sendCommand({ type: 'redo' })}>
              <Redo2 className="h-3.5 w-3.5" strokeWidth={1.9} />
            </ToolButton>
            <span className="mx-0.5 h-4 w-px bg-white/20" aria-hidden />
            {/* 预览动画用「播放」语义图标,与元素动画(Wand2)、页面级动画菜单(Clapperboard)区分。 */}
            <ToolButton
              title={animationStyle === 'none' ? t('slidesAnimationPreviewNone') : t('slidesAnimationPreview')}
              disabled={animationStyle === 'none'}
              onClick={handlePreviewAnimation}
            >
              <CirclePlay className="h-3.5 w-3.5" strokeWidth={1.9} />
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
                {/* 元素对齐组:仅多选(≥2)时出现,按选区包围盒对齐元素位置(非 text-align)。 */}
                {selectionCount >= 2 ? (
                  <>
                    <span className="mx-0.5 h-4 w-px bg-white/20" aria-hidden />
                    <ToolButton title={t('slidesAlignElementsLeft')} onClick={() => sendCommand({ type: 'align-elements', value: 'left' })}>
                      <AlignStartVertical className="h-3.5 w-3.5" strokeWidth={1.9} />
                    </ToolButton>
                    <ToolButton title={t('slidesAlignElementsCenterX')} onClick={() => sendCommand({ type: 'align-elements', value: 'center-x' })}>
                      <AlignCenterVertical className="h-3.5 w-3.5" strokeWidth={1.9} />
                    </ToolButton>
                    <ToolButton title={t('slidesAlignElementsRight')} onClick={() => sendCommand({ type: 'align-elements', value: 'right' })}>
                      <AlignEndVertical className="h-3.5 w-3.5" strokeWidth={1.9} />
                    </ToolButton>
                    <ToolButton title={t('slidesAlignElementsTop')} onClick={() => sendCommand({ type: 'align-elements', value: 'top' })}>
                      <AlignStartHorizontal className="h-3.5 w-3.5" strokeWidth={1.9} />
                    </ToolButton>
                    <ToolButton title={t('slidesAlignElementsCenterY')} onClick={() => sendCommand({ type: 'align-elements', value: 'center-y' })}>
                      <AlignCenterHorizontal className="h-3.5 w-3.5" strokeWidth={1.9} />
                    </ToolButton>
                    <ToolButton title={t('slidesAlignElementsBottom')} onClick={() => sendCommand({ type: 'align-elements', value: 'bottom' })}>
                      <AlignEndHorizontal className="h-3.5 w-3.5" strokeWidth={1.9} />
                    </ToolButton>
                  </>
                ) : null}
                {/* 层级组:相对重叠元素调 z-index(上移/下移一层、置顶/置底)。 */}
                <span className="mx-0.5 h-4 w-px bg-white/20" aria-hidden />
                <ToolButton title={t('slidesLayerUp')} onClick={() => sendCommand({ type: 'z-order', value: 'up' })}>
                  <ChevronUp className="h-3.5 w-3.5" strokeWidth={1.9} />
                </ToolButton>
                <ToolButton title={t('slidesLayerDown')} onClick={() => sendCommand({ type: 'z-order', value: 'down' })}>
                  <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.9} />
                </ToolButton>
                <ToolButton title={t('slidesLayerFront')} onClick={() => sendCommand({ type: 'z-order', value: 'front' })}>
                  <BringToFront className="h-3.5 w-3.5" strokeWidth={1.9} />
                </ToolButton>
                <ToolButton title={t('slidesLayerBack')} onClick={() => sendCommand({ type: 'z-order', value: 'back' })}>
                  <SendToBack className="h-3.5 w-3.5" strokeWidth={1.9} />
                </ToolButton>
                {/* 所选元素入场动画:预设下拉(先物化整页编排,再对所选元素改预设)。 */}
                <span className="mx-0.5 h-4 w-px bg-white/20" aria-hidden />
                <span className="relative">
                  <ToolButton
                    title={animationStyle === 'none' ? t('slidesAnimationPreviewNone') : t('slidesAnimElement')}
                    disabled={animationStyle === 'none'}
                    onClick={() => setElementAnimOpen((v) => !v)}
                  >
                    <Wand2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </ToolButton>
                  {elementAnimOpen ? (
                    // 深色面板 + 显式颜色:该下拉悬在深色画布工具栏下,不用 ds token 类
                    // (曾在此上下文解析异常导致白底白字,用户实测文字不可见)。
                    <div
                      data-testid="slides-element-anim-menu"
                      className="absolute left-1/2 top-full z-40 mt-1 w-32 -translate-x-1/2 rounded-lg border border-white/10 bg-[#23262f] p-1 text-white shadow-xl"
                    >
                      {ELEMENT_PRESETS.map(({ preset, labelKey }) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => handleElementPreset(preset)}
                          className="block w-full rounded-md px-2 py-1 text-left text-[12px] text-white/90 transition hover:bg-white/12 hover:text-white"
                        >
                          {t(labelKey)}
                        </button>
                      ))}
                      <div className="my-1 h-px bg-white/12" aria-hidden />
                      <button
                        type="button"
                        onClick={() => handleElementPreset(null)}
                        className="block w-full rounded-md px-2 py-1 text-left text-[12px] text-white/60 transition hover:bg-white/12 hover:text-white"
                      >
                        {t('slidesAnimElementRemove')}
                      </button>
                    </div>
                  ) : null}
                </span>
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
      </div>
      {/* 画布区:仅此区域参与 fit 缩放测量(上下两行不占用画布空间)。 */}
      <div ref={containerRef} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto">
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
          </div>
        ) : (
          <div className="max-w-[380px] px-6 text-center text-[13px] leading-6 text-ds-muted">
            {t('slidesEmptyDeck')}
          </div>
        )}
      </div>
      {/* 选区 chip 行:画布下方,提示所选将随下一条消息进入 AI 上下文;可一键清除。 */}
      <div className="flex h-10 shrink-0 items-center justify-center">
        {selectionCount > 0 ? (
          <div
            data-testid="slides-selection-chip"
            className="flex items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-[11.5px] text-white shadow"
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
