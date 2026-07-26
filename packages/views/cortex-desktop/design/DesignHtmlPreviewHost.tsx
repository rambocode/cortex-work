import { kunGuiPort } from '@cortex-work/core/design/compat/kun-gui-port'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type Ref
} from 'react'
import {
  startDesignHtmlPreviewWatch,
  type DesignPreviewRenderState
} from '@cortex-work/core/design/design-preview-file'

const PREVIEW_FAST_POLL_MS = 6_000
const PREVIEW_MAX_WAIT_MS = 300_000

export type DesignHtmlPreviewSizingPolicy = 'fixedViewport' | 'autoHeight' | 'autoBoth'

export type DesignHtmlPreviewWebviewElement = HTMLElement & {
  executeJavaScript?: (code: string) => Promise<unknown>
  loadURL?: (url: string) => Promise<void>
  reload?: () => void
  getURL?: () => string
  setZoomFactor?: (factor: number) => void
}

export type DesignHtmlPreviewState = {
  relativePath: string
  fileUrl: string
  revision: number
  renderState: DesignPreviewRenderState
  hasRenderableContent: boolean
  error: string
  ready: boolean
  webviewUrl: string
}

export type DesignHtmlPreviewRenderWebviewOptions = {
  className?: string
  style?: CSSProperties
  title?: string
  webpreferences?: string
  extraProps?: Record<string, unknown>
}

export type DesignHtmlPreviewHostRenderProps = {
  state: DesignHtmlPreviewState
  webview: DesignHtmlPreviewWebviewElement | null
  webviewMountNonce: number
  executeScript: (code: string) => Promise<unknown> | null
  renderWebview: (options?: DesignHtmlPreviewRenderWebviewOptions) => ReactElement | null
}

export type DesignHtmlPreviewHostProps = {
  workspaceRoot: string
  relativePath?: string
  enabled?: boolean
  partition: string
  zoom?: number
  retryMissingFile?: boolean
  webpreferences?: string
  /** See shouldRenderDesignHtmlPreviewWebview. Defaults to true. */
  mountWhileSkeleton?: boolean
  /** 见 shouldRenderDesignHtmlPreviewWebview:宿主自证文件可渲染时跳过体检。默认 false。 */
  assumeRenderable?: boolean
  onError?: (message: string) => void
  onRevision?: (revision: number) => void
  onRenderStateChange?: (state: DesignPreviewRenderState) => void
  onWebviewReady?: (webview: DesignHtmlPreviewWebviewElement) => void
  /**
   * 增量 revision 到来时是否跳过重载(见 designHtmlPreviewNavigateAction)。
   * slides 编辑保存属于「页面自己写回」:返回 true 可避免闪屏与选区/光标丢失;
   * 首次加载不受影响,外部(Agent)改写仍照常重载。
   */
  shouldSkipReload?: () => boolean
  children: (props: DesignHtmlPreviewHostRenderProps) => ReactNode
}

export type UseDesignHtmlPreviewOptions = Omit<DesignHtmlPreviewHostProps, 'children'>

export function shouldRenderDesignHtmlPreviewWebview({
  fileUrl,
  renderState,
  hasRenderableContent,
  mountWhileSkeleton = true,
  assumeRenderable = false
}: {
  fileUrl: string
  renderState: DesignPreviewRenderState
  hasRenderableContent: boolean
  /**
   * Surfaces that render their own generating placeholder (e.g. the canvas
   * screen frames' brush-sketch overlay) pass false so the skeleton HTML file
   * never paints; the webview then mounts only once real content exists.
   */
  mountWhileSkeleton?: boolean
  /**
   * 由宿主自己保证文件可渲染,跳过 renderState 体检直接挂载(默认 false,行为不变)。
   *
   * slides 的 deck 由主进程写、结构由 injectBentoDocJson 保证,挂载 gate 已由
   * SlidesWorkspace 的 doc 就绪判定承担 —— 不该再让「渲染端读整份 1.5MB HTML 做字符串
   * 体检」卡在链路上:读文件有 2MB 截断线,一旦越线 renderState 恒为 'transient',
   * webview 根本不挂载、revision 永不推进(实测症状:AI 改完中间画布毫无变化)。
   */
  assumeRenderable?: boolean
}): boolean {
  if (!fileUrl) return false
  if (hasRenderableContent) return true
  if (assumeRenderable) return true
  return mountWhileSkeleton && renderState === 'skeleton'
}

export function designHtmlPreviewWebviewZoomFactor(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1
  return Math.min(4, Math.max(0.05, zoom))
}

export function executeDesignHtmlPreviewScript(
  webview: Pick<DesignHtmlPreviewWebviewElement, 'executeJavaScript'> | null | undefined,
  code: string
): Promise<unknown> | null {
  if (typeof webview?.executeJavaScript !== 'function') return null
  try {
    return webview.executeJavaScript(code).catch(() => null)
  } catch {
    // Electron throws synchronously when a <webview> exists but is not attached
    // and dom-ready yet. Guest script failures are normalized to null above so
    // callers do not leak GUEST_VIEW_MANAGER_CALL errors while frames churn.
    return null
  }
}

/**
 * revision 导航决策(纯函数,便于单测):
 *  - 'none':revision 未变,无需动作;
 *  - 'skip':增量 revision 但属于「页面自己写回」(如 slides 编辑保存)—— 页面 DOM 即
 *    刚落盘的内容,重载只会闪屏并清空选区/光标,故本次不导航;注意**不消费** revision
 *    (见 designHtmlPreviewConsumedRevision),否则静默窗内到达的外部改写会被永久吞掉;
 *  - 'load':需要真实导航(首次加载一律 load,不受 skip 影响)。
 */
export function designHtmlPreviewNavigateAction(options: {
  lastLoadedRevision: number
  revision: number
  skipSelfReload: boolean
}): 'none' | 'skip' | 'load' {
  if (options.lastLoadedRevision === options.revision) return 'none'
  const firstLoad = options.lastLoadedRevision < 0
  return !firstLoad && options.skipSelfReload ? 'skip' : 'load'
}

/**
 * 导航后 lastLoadedRevision 应推进到哪一版(纯函数,便于单测)。
 *
 * 'skip' **不消费** revision:它只是「这一次不导航」,不是「这一版已加载」。
 * 提前消费会让落在自写回静默窗内的外部改写(Agent 写盘)被永久标记为已加载,
 * 之后再也不会加载 —— 用户实测症状是「AI 改完演示文稿,中间画布毫无变化」。
 * 只有真的 loadURL/reload 过,页面 DOM 才等于那一版内容,才允许消费。
 */
export function designHtmlPreviewConsumedRevision(
  action: 'none' | 'skip' | 'load',
  lastLoadedRevision: number,
  revision: number
): number {
  return action === 'load' ? revision : lastLoadedRevision
}

export function designHtmlPreviewUrl(fileUrl: string, revision: number): string {
  if (!fileUrl) return ''
  return `${fileUrl}${fileUrl.includes('?') ? '&' : '?'}rev=${revision}`
}

export function useDesignHtmlPreview({
  workspaceRoot,
  relativePath,
  enabled = true,
  partition,
  zoom,
  retryMissingFile = true,
  webpreferences = 'contextIsolation=yes,nodeIntegration=no,sandbox=yes',
  mountWhileSkeleton = true,
  assumeRenderable = false,
  onError,
  onRevision,
  onRenderStateChange,
  onWebviewReady,
  shouldSkipReload
}: UseDesignHtmlPreviewOptions): DesignHtmlPreviewHostRenderProps {
  const webviewRef = useRef<DesignHtmlPreviewWebviewElement | null>(null)
  const webviewReadyRef = useRef(false)
  const loadedFileRef = useRef('')
  const lastLoadedRevisionRef = useRef(-1)
  const zoomRef = useRef(zoom)
  const [webviewMountNonce, setWebviewMountNonce] = useState(0)
  const [previewRelativePath, setPreviewRelativePath] = useState('')
  const [fileUrl, setFileUrl] = useState('')
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [renderState, setRenderState] = useState<DesignPreviewRenderState>('transient')
  const [hasRenderableContent, setHasRenderableContent] = useState(false)
  const [ready, setReady] = useState(false)

  const reportError = useCallback((message: string): void => {
    setError(message)
    onError?.(message)
  }, [onError])

  const setWebviewNode = useCallback((node: DesignHtmlPreviewWebviewElement | null): void => {
    webviewRef.current = node
    webviewReadyRef.current = false
    setReady(false)
    if (node) setWebviewMountNonce((value) => value + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    let cleanupWatch: (() => void) | null = null
    let retryTimer = 0
    const startedAt = Date.now()

    setFileUrl('')
    setPreviewRelativePath('')
    setRevision(0)
    setError('')
    setRenderState('transient')
    setHasRenderableContent(false)
    setReady(false)
    webviewReadyRef.current = false
    loadedFileRef.current = ''
    lastLoadedRevisionRef.current = -1

    const path = relativePath?.trim()
    if (!enabled || !workspaceRoot || !path) return
    if (typeof kunGuiPort()?.authorizeWritePrototype !== 'function') {
      reportError('Prototype preview is unavailable.')
      return
    }

    const tryAuthorize = (): void => {
      void kunGuiPort()!
        .authorizeWritePrototype({ path, workspaceRoot })
        .then((res) => {
          if (cancelled) return
          if (res.ok) {
            setError('')
            setPreviewRelativePath(path)
            setFileUrl(res.fileUrl)
            cleanupWatch?.()
            cleanupWatch = startDesignHtmlPreviewWatch({
              workspaceRoot,
              path,
              onRevision: (nextRevision) => {
                if (cancelled) return
                setError('')
                setRevision(nextRevision)
                onRevision?.(nextRevision)
              },
              onPreviewStateChange: (nextState) => {
                if (cancelled) return
                setRenderState(nextState)
                onRenderStateChange?.(nextState)
                if (nextState === 'renderable') setHasRenderableContent(true)
              },
              onError: reportError
            })
            return
          }
          if (retryMissingFile && res.message === 'prototype file not found') {
            const elapsed = Date.now() - startedAt
            if (elapsed <= PREVIEW_MAX_WAIT_MS) {
              retryTimer = window.setTimeout(
                tryAuthorize,
                elapsed < PREVIEW_FAST_POLL_MS ? 250 : 2000
              )
            }
            return
          }
          reportError(res.message)
        })
        .catch((err: unknown) => {
          if (!cancelled) reportError(err instanceof Error ? err.message : String(err))
        })
    }

    tryAuthorize()

    return () => {
      cancelled = true
      if (retryTimer) window.clearTimeout(retryTimer)
      cleanupWatch?.()
    }
  }, [
    enabled,
    onRenderStateChange,
    onRevision,
    relativePath,
    reportError,
    retryMissingFile,
    workspaceRoot
  ])

  const webviewUrl = shouldRenderDesignHtmlPreviewWebview({
    fileUrl,
    renderState,
    hasRenderableContent,
    mountWhileSkeleton,
    assumeRenderable
  })
    ? designHtmlPreviewUrl(fileUrl, revision)
    : ''

  useEffect(() => {
    if (fileUrl !== loadedFileRef.current) {
      webviewReadyRef.current = false
      setReady(false)
      loadedFileRef.current = fileUrl
      lastLoadedRevisionRef.current = -1
    }
    const webview = webviewRef.current
    if (!webview || !webviewUrl) return
    const target = webviewUrl
    const navigate = (): void => {
      const action = designHtmlPreviewNavigateAction({
        lastLoadedRevision: lastLoadedRevisionRef.current,
        revision,
        skipSelfReload: shouldSkipReload?.() === true
      })
      // 先算动作再决定是否消费:'skip' 直接 return 且**不写 ref**(见
      // designHtmlPreviewConsumedRevision 的注释),否则静默窗会吞掉外部改写。
      if (action === 'none') return
      if (action === 'skip') return
      lastLoadedRevisionRef.current = designHtmlPreviewConsumedRevision(
        action,
        lastLoadedRevisionRef.current,
        revision
      )
      if (typeof webview.loadURL === 'function') {
        try {
          void webview.loadURL(target).catch(() => undefined)
        } catch {
          /* webview may detach while React is swapping canvas state */
        }
      } else if (typeof webview.reload === 'function') {
        try {
          webview.reload()
        } catch {
          /* webview may detach while React is swapping canvas state */
        }
      }
    }
    // dom-ready 监听常驻:revision 重载(loadURL ?rev=N)后的每次导航都会再次 dom-ready,
    // onWebviewReady 需逐次回调 —— slides 编辑桥依赖它在新 document 上重新注入(注入幂等)。
    // 旧实现只在首个 dom-ready 前挂监听,重载一次后桥即永久丢失(用户实测:移动元素保存
    // 触发重载后再也无法选中)。
    const onReady = (): void => {
      webviewReadyRef.current = true
      setReady(true)
      onWebviewReady?.(webview)
      navigate()
    }
    webview.addEventListener('dom-ready', onReady)
    if (webviewReadyRef.current) navigate()
    return () => webview.removeEventListener('dom-ready', onReady)
  }, [fileUrl, onWebviewReady, revision, shouldSkipReload, webviewMountNonce, webviewUrl])

  const applyZoomFactor = useCallback((): void => {
    const webview = webviewRef.current
    if (typeof zoomRef.current !== 'number' || typeof webview?.setZoomFactor !== 'function') return
    try {
      webview.setZoomFactor(designHtmlPreviewWebviewZoomFactor(zoomRef.current))
    } catch {
      /* webview may be mid-navigation/detached */
    }
  }, [])

  useEffect(() => {
    zoomRef.current = zoom
    if (typeof zoom !== 'number') return
    const timer = window.setTimeout(applyZoomFactor, 120)
    return () => window.clearTimeout(timer)
  }, [applyZoomFactor, zoom])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview || !webviewUrl || typeof zoom !== 'number') return
    applyZoomFactor()
    webview.addEventListener('dom-ready', applyZoomFactor)
    return () => webview.removeEventListener('dom-ready', applyZoomFactor)
  }, [applyZoomFactor, webviewMountNonce, webviewUrl, zoom])

  const state = useMemo<DesignHtmlPreviewState>(() => ({
    relativePath: previewRelativePath,
    fileUrl,
    revision,
    renderState,
    hasRenderableContent,
    error,
    ready,
    webviewUrl
  }), [error, fileUrl, hasRenderableContent, previewRelativePath, ready, renderState, revision, webviewUrl])

  const executeScript = useCallback((code: string): Promise<unknown> | null => {
    return executeDesignHtmlPreviewScript(webviewRef.current, code)
  }, [])

  const renderWebview = useCallback((options: DesignHtmlPreviewRenderWebviewOptions = {}): ReactElement | null => {
    if (!state.webviewUrl) return null
    const mergedWebpreferences = options.webpreferences ?? webpreferences
    return (
      <webview
        key={state.fileUrl}
        ref={setWebviewNode as Ref<DesignHtmlPreviewWebviewElement>}
        src={state.fileUrl}
        partition={partition}
        webpreferences={mergedWebpreferences}
        className={options.className}
        style={options.style}
        title={options.title}
        {...(options.extraProps ?? {})}
      />
    )
  }, [partition, setWebviewNode, state.fileUrl, state.webviewUrl, webpreferences])

  return {
    state,
    webview: webviewRef.current,
    webviewMountNonce,
    executeScript,
    renderWebview
  }
}

export function DesignHtmlPreviewHost(props: DesignHtmlPreviewHostProps): ReactElement {
  const { children, ...options } = props
  const preview = useDesignHtmlPreview(options)
  return <>{children(preview)}</>
}
