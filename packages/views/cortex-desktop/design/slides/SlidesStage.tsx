// 中间舞台:整块 webview 直接加载 deck.bento.html —— bento 内置编辑器(缩略图栏/
// Moveable 拖拽/属性面板)即编辑体验,宿主不再自研画布工具。
// 职责只剩四件:
//   1. 经 DesignHtmlPreviewHost 加载(partition 授权 + 文件 watch 兜底重载);
//   2. dom-ready 注入宿主桥 shim(保存 + 选区 + 作者名),周期 drain 整份 HTML 落盘;
//   3. **热应用**:主进程写盘后广播 slides:deckChanged,这里把新文档就地换进编辑器,
//      不重载 webview —— 保住选区/撤销栈/滚动位置(见下方 R_page 注释);
//   4. 选区泵:把 bento 内的当前选区回传给 store,供右栏会话面板显示引用 chip。
//
// revision 空间(三套,绝不可混用,见 slides-stage-refresh.ts 的文件头):
//   R_disk —— deck.meta.json 的权威内容版本,deckChanged 事件里带的就是它;
//   R_page —— 本组件维护:webview 内存文档当前对应的那个 R_disk;
//   useDesignHtmlPreview 内部的 revision —— watcher 本地计数器,从 0 起,与上面两个无关。
import { useCallback, useEffect, useRef, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useCoreContext, useDesktopBridge } from '@cortex-work/core/provider'
import { bentoDeckHtmlPath } from '@cortex-work/core/design/slides/slides-paths'
import { matchesSlidesDeckChange } from '@cortex-work/core/design/slides/slides-deck-activity'
import { useDesignHtmlPreview } from '../DesignHtmlPreviewHost'
import {
  APPLY_BENTO_DOC_SOURCE,
  BENTO_DRAIN_INTERVAL_MS,
  BENTO_SELECTION_POLL_INTERVAL_MS,
  DRAIN_BENTO_SAVE_SOURCE,
  READ_BENTO_SELECTION_SOURCE,
  buildBentoHostShimSource,
  parseBentoApplyResult,
  parseBentoSaveDrain,
  parseBentoSelectionRead
} from './bento-stage-bridge'
import { useBentoSlidesStore } from './bento-slides-store'
import {
  mergeDeferredRevision,
  slidesPageRevisionAlignment,
  slidesRefreshDecision
} from './slides-stage-refresh'
import { SLIDES_WEBVIEW_PARTITION } from './slides-webview-partition'

type Props = {
  workspaceRoot: string
  deckId: string
}

export function SlidesStage({ workspaceRoot, deckId }: Props): ReactElement {
  const { t } = useTranslation('design')
  const bridge = useDesktopBridge()
  const saveEditedDeckHtml = useBentoSlidesStore((s) => s.saveEditedDeckHtml)
  const setEditorContext = useBentoSlidesStore((s) => s.setEditorContext)
  // 宿主身份用作 bento 评论的默认作者名,免去页内再问一次(Electron 不支持 window.prompt)。
  const { identity } = useCoreContext()
  const authorName = identity?.name

  // R_page:webview 内存文档对应的磁盘 revision。只有三处推进 —— 首帧/刷新读回、
  // 编辑器回写成功、热应用成功。任何其它来源都不许碰它,否则回声判定会失准。
  const pageRevisionRef = useRef(0)
  // 热应用/刷新进行中:此时 drain 泵整轮跳过(见保存泵注释),事件排队到 deferredRef。
  const busyRef = useRef(false)
  const deferredRef = useRef<number | null>(null)
  // 默认**不**因 watcher 计数而重载:编辑期重载会摧毁选区与撤销栈,而 AI 的改动走热应用。
  // 兜底重载由下面的 fallbackReload 主动发起 —— 刻意不用「置个标志等下次 watcher 事件」:
  // 热应用失败往往就是最后一次写入,再没有下一次事件来触发导航,标志会永远挂着(舞台不刷新)。
  const shouldSkipReload = useCallback(() => true, [])

  // 兜底重载需要 webview 句柄;dom-ready 回调里拿到后存下来(重载后会再次回调,自然刷新)。
  const webviewElRef = useRef<{ reload?: () => void } | null>(null)

  // dom-ready(含每次重载)注入宿主桥 shim;幂等,重复注入只刷新 authorName。
  const handleWebviewReady = useCallback(
    (webview: { executeJavaScript?: (code: string) => Promise<unknown>; reload?: () => void }) => {
      webviewElRef.current = webview
      void webview.executeJavaScript?.(buildBentoHostShimSource({ authorName })).catch(() => undefined)
    },
    [authorName]
  )

  /**
   * 热应用不可用时的兜底:整页重载(会闪屏、丢选区与撤销栈,所以只在热应用真的失败时走)。
   * reload() 直接从磁盘重读,拿到的必然 >= knownRevision,因此顺手把 R_page 对齐,
   * 免得紧接着的 deckChanged 又被判成「比页面新」而多跑一轮。
   */
  const fallbackReload = useCallback((knownRevision?: number): void => {
    if (typeof knownRevision === 'number') pageRevisionRef.current = knownRevision
    try {
      webviewElRef.current?.reload?.()
    } catch {
      /* webview 可能正在 detach(切 deck / 卸载),忽略 */
    }
  }, [])

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
    // deck 结构由主进程的 injectBentoDocJson 保证,挂载 gate 已由 SlidesWorkspace 的 doc
    // 就绪判定承担;不能再让「渲染端读整份 HTML 做字符串体检」卡在链路上 ——
    // 大 deck 会撞上 fs:readFile 的 2MB 截断,判定恒为 transient 导致 webview 永不挂载。
    assumeRenderable: true,
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
      // 热应用/刷新期间**整轮不 drain**:__cortexDrainDeckSave 是取后即清,
      // 先 drain 再丢弃等于把用户这一笔编辑扔掉。
      if (busyRef.current) return
      const html = parseBentoSaveDrain(await executeScript(DRAIN_BENTO_SAVE_SOURCE))
      if (disposed || !html) return
      // 切 deck 竞态:drain 结果必须仍属于当前 deck,否则丢弃(绝不把 A 稿写进 B 稿)。
      if (deckIdRef.current !== deckId) return
      const saved = await saveEditedDeckHtml(html, pageRevisionRef.current)
      if (saved.ok && typeof saved.revision === 'number') {
        pageRevisionRef.current = saved.revision
        return
      }
      // stale:磁盘已被 AI 写过,这份 HTML 是过期稿(主进程已拒写)。不是错误 ——
      // 把舞台追到最新稿:优先热应用(不闪屏),拿不到入口再退回整页重载。
      if (saved.stale) {
        const applyLatest = applyLatestRef.current
        if (applyLatest) void applyLatest()
        else fallbackReload()
      }
    }
    const timer = window.setInterval(() => void pump(), BENTO_DRAIN_INTERVAL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
      void pump()
    }
  }, [preview.state.ready, executeScript, saveEditedDeckHtml, deckId, fallbackReload])

  // 保存泵(上方)在弱锁冲突时也需要「追到最新稿」,但 applyLatest 定义在下面的 effect 里 ——
  // 用 ref 传递而不是把它提到组件顶层:它依赖 preview.state.ready 与 bridge,提上去会让
  // 依赖数组失真。null 表示热应用尚不可用(舞台未就绪),此时退回整页重载。
  const applyLatestRef = useRef<(() => Promise<void>) | null>(null)

  // 热应用:AI 写盘 → 主进程广播 → 读回新文档 → 页内 replaceDoc(不重载,不闪屏)。
  // 页内入口缺失(旧壳)或返回非 true 时回落整页重载,保证改动一定看得见。
  useEffect(() => {
    if (!preview.state.ready) return
    if (!bridge?.onSlidesDeckChanged || !bridge.slidesBentoGetDeck) return
    const getDeck = bridge.slidesBentoGetDeck
    let disposed = false

    // 刻意不接收「目标 revision」:磁盘是唯一真源,一律读最新那一版。
    // 分批改稿连发十几条事件时,这让「合并成一次」天然成立。
    const applyLatest = async (): Promise<void> => {
      busyRef.current = true
      try {
        const res = await getDeck({ workspaceRoot, deckId })
        if (disposed || deckIdRef.current !== deckId) return
        if (!res.ok || !res.json) {
          fallbackReload()
          return
        }
        const applied = parseBentoApplyResult(
          await executeScript(APPLY_BENTO_DOC_SOURCE(res.json, res.revision))
        )
        if (applied) {
          // 用读回来的 revision 而不是事件里的:两者之间可能又落了一次盘。
          pageRevisionRef.current = res.revision
        } else {
          // 页内入口不存在(存量旧壳尚未换)或应用失败 → 整页重载兜底。
          fallbackReload(res.revision)
        }
      } finally {
        busyRef.current = false
        // busy 期间堆积的事件:只按最新那一版补跑一次(分批改稿会连发十几条)。
        const pending = deferredRef.current
        deferredRef.current = null
        if (!disposed && pending !== null && pending > pageRevisionRef.current) {
          void applyLatest()
        }
      }
    }

    applyLatestRef.current = applyLatest

    const off = bridge.onSlidesDeckChanged((event) => {
      if (!matchesSlidesDeckChange(event, { workspaceRoot, deckId })) return
      const decision = slidesRefreshDecision({
        eventRevision: event.revision,
        pageRevision: pageRevisionRef.current,
        busy: busyRef.current
      })
      if (decision === 'ignore') return
      if (decision === 'defer') {
        deferredRef.current = mergeDeferredRevision(deferredRef.current, event.revision)
        return
      }
      void applyLatest()
    })

    return () => {
      disposed = true
      applyLatestRef.current = null
      off()
    }
  }, [preview.state.ready, bridge, workspaceRoot, deckId, executeScript, fallbackReload])

  // 首帧/切 deck 时把 R_page 对齐到 store 读回的 revision:webview 加载的就是那一版,
  // 不对齐会让首个 deckChanged 被误判为「比页面新」而多跑一次热应用。
  //
  // **只对齐一次**(每个 deck)。store 的 revision 还会被 SlidesWorkspace 在 AI 回合期间
  // 每 2s 的轮询刷新推到磁盘最新值 —— 若跟着它走,R_page 会在 webview 尚未应用新内容时
  // 就"追平"磁盘,紧随其后的 deckChanged 便被判成自写回声而丢弃,画布反而永远不刷新。
  const storeRevision = useBentoSlidesStore((s) => s.revision)
  const alignedDeckRef = useRef('')
  useEffect(() => {
    const alignment = slidesPageRevisionAlignment({
      deckId,
      alignedDeckId: alignedDeckRef.current,
      storeRevision
    })
    if (!alignment) return
    pageRevisionRef.current = alignment.pageRevision
    if (alignment.markAligned) alignedDeckRef.current = deckId
  }, [storeRevision, deckId])

  // 选区泵:与保存泵独立(选区要跟手、保存要合并写)。页内以单调 seq 标记状态版本,
  // 未变化时表达式直接返回 null,所以 300ms 轮询的代价只是一次空往返。
  useEffect(() => {
    if (!preview.state.ready) return
    let disposed = false
    // 页内以「seq 与宿主已知值相等即视为未变化」判断,不是单调比大小 —— webview 重载后
    // 页内 seq 从 1 重新开始,同样能被识别为变化,不需要额外的重载对齐逻辑。
    let lastSeq = 0
    const pump = async (): Promise<void> => {
      const read = parseBentoSelectionRead(await executeScript(READ_BENTO_SELECTION_SOURCE(lastSeq)))
      if (disposed || !read) return
      // 切 deck 竞态:与保存泵同一防线,A 稿的选区绝不能落到 B 稿的会话上。
      if (deckIdRef.current !== deckId) return
      lastSeq = read.seq
      setEditorContext(read.page, read.selection)
    }
    const timer = window.setInterval(() => void pump(), BENTO_SELECTION_POLL_INTERVAL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
      // 卸载/切 deck:清掉右栏的引用 chip,免得指向已经看不见的元素。
      setEditorContext(null, null)
    }
  }, [preview.state.ready, executeScript, setEditorContext, deckId])

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
