import { describe, expect, it } from 'vitest'
import {
  designHtmlPreviewConsumedRevision,
  designHtmlPreviewNavigateAction,
  designHtmlPreviewUrl,
  designHtmlPreviewWebviewZoomFactor,
  executeDesignHtmlPreviewScript,
  shouldRenderDesignHtmlPreviewWebview
} from './DesignHtmlPreviewHost'

describe('DesignHtmlPreviewHost helpers', () => {
  it('renders skeletons and last-good previews, but not transient first chunks', () => {
    expect(shouldRenderDesignHtmlPreviewWebview({
      fileUrl: 'file:///workspace/.cortex-design/screen/v1.html',
      renderState: 'skeleton',
      hasRenderableContent: false
    })).toBe(true)
    expect(shouldRenderDesignHtmlPreviewWebview({
      fileUrl: 'file:///workspace/.cortex-design/screen/v1.html',
      renderState: 'transient',
      hasRenderableContent: false
    })).toBe(false)
    expect(shouldRenderDesignHtmlPreviewWebview({
      fileUrl: 'file:///workspace/.cortex-design/screen/v1.html',
      renderState: 'transient',
      hasRenderableContent: true
    })).toBe(true)
    expect(shouldRenderDesignHtmlPreviewWebview({
      fileUrl: '',
      renderState: 'skeleton',
      hasRenderableContent: true
    })).toBe(false)
  })

  it('never mounts skeletons for surfaces that opt out of skeleton painting', () => {
    expect(shouldRenderDesignHtmlPreviewWebview({
      fileUrl: 'file:///workspace/.cortex-design/screen/v1.html',
      renderState: 'skeleton',
      hasRenderableContent: false,
      mountWhileSkeleton: false
    })).toBe(false)
    expect(shouldRenderDesignHtmlPreviewWebview({
      fileUrl: 'file:///workspace/.cortex-design/screen/v1.html',
      renderState: 'renderable',
      hasRenderableContent: true,
      mountWhileSkeleton: false
    })).toBe(true)
  })

  it('builds revision URLs without remount-oriented keys', () => {
    expect(designHtmlPreviewUrl('file:///workspace/page.html', 3)).toBe('file:///workspace/page.html?rev=3')
    expect(designHtmlPreviewUrl('file:///workspace/page.html?token=1', 4)).toBe('file:///workspace/page.html?token=1&rev=4')
  })

  it('clamps native webview zoom factors', () => {
    expect(designHtmlPreviewWebviewZoomFactor(1)).toBe(1)
    expect(designHtmlPreviewWebviewZoomFactor(0)).toBe(1)
    expect(designHtmlPreviewWebviewZoomFactor(Number.NaN)).toBe(1)
    expect(designHtmlPreviewWebviewZoomFactor(0.001)).toBe(0.05)
    expect(designHtmlPreviewWebviewZoomFactor(50)).toBe(4)
  })

  // 自写回静默:slides 编辑保存后 watcher 推 revision,页面 DOM 即最新内容,
  // 重载只会清空选区/光标;首次加载与外部改写必须照常导航。
  it('navigate action: skips self-save reloads but never the first load', () => {
    // revision 未变 → 无动作。
    expect(designHtmlPreviewNavigateAction({ lastLoadedRevision: 3, revision: 3, skipSelfReload: true })).toBe('none')
    // 首次加载(lastLoadedRevision<0)即便处于静默窗也要加载。
    expect(designHtmlPreviewNavigateAction({ lastLoadedRevision: -1, revision: 0, skipSelfReload: true })).toBe('load')
    // 自写回的增量 revision → 跳过(标记已消费,不导航)。
    expect(designHtmlPreviewNavigateAction({ lastLoadedRevision: 0, revision: 1, skipSelfReload: true })).toBe('skip')
    // 外部改写(不在静默窗)→ 正常重载。
    expect(designHtmlPreviewNavigateAction({ lastLoadedRevision: 1, revision: 2, skipSelfReload: false })).toBe('load')
  })

  // 只有真的导航过才算「这一版已加载」。'skip' 只是「这一次不导航」——
  // 提前消费会让静默窗内到达的外部改写被永久吞掉(用户实测:AI 改完中间画布再也不刷新)。
  it('consumes revision only on a real load, never on skip', () => {
    expect(designHtmlPreviewConsumedRevision('skip', 0, 1)).toBe(0)
    expect(designHtmlPreviewConsumedRevision('load', 0, 1)).toBe(1)
    expect(designHtmlPreviewConsumedRevision('none', 3, 3)).toBe(3)
    // 首次加载:lastLoadedRevision 为哨兵 -1,load 后推进到真实 revision。
    expect(designHtmlPreviewConsumedRevision('load', -1, 0)).toBe(0)
  })

  // 回归场景(阶段 5 bug (a)):静默窗内到达的 AI revision 判 skip 后不得被消费,
  // 否则静默窗结束后同一个 revision 再也不会触发导航。
  it('keeps a muted external revision loadable after the mute window closes', () => {
    let lastLoaded = 0
    const muted = designHtmlPreviewNavigateAction({
      lastLoadedRevision: lastLoaded,
      revision: 1,
      skipSelfReload: true
    })
    expect(muted).toBe('skip')
    lastLoaded = designHtmlPreviewConsumedRevision(muted, lastLoaded, 1)
    expect(lastLoaded).toBe(0)

    const afterMute = designHtmlPreviewNavigateAction({
      lastLoadedRevision: lastLoaded,
      revision: 1,
      skipSelfReload: false
    })
    expect(afterMute).toBe('load')
    expect(designHtmlPreviewConsumedRevision(afterMute, lastLoaded, 1)).toBe(1)
  })

  // slides 的 deck 由主进程写、结构由 injectBentoDocJson 保证,挂载 gate 已由
  // SlidesWorkspace 的 doc 就绪判定承担 —— 不该再让「读整份 1.5MB HTML 做字符串体检」卡住链路。
  it('mounts transient content when the surface asserts the file is renderable', () => {
    expect(shouldRenderDesignHtmlPreviewWebview({
      fileUrl: 'file:///workspace/.cortex-design/d7b7/deck.bento.html',
      renderState: 'transient',
      hasRenderableContent: false,
      assumeRenderable: true
    })).toBe(true)
    // 缺省(不传)必须与既有行为逐字一致。
    expect(shouldRenderDesignHtmlPreviewWebview({
      fileUrl: 'file:///workspace/.cortex-design/d7b7/deck.bento.html',
      renderState: 'transient',
      hasRenderableContent: false
    })).toBe(false)
    // fileUrl 仍是硬前置条件:没有 URL 就没有可导航目标。
    expect(shouldRenderDesignHtmlPreviewWebview({
      fileUrl: '',
      renderState: 'transient',
      hasRenderableContent: false,
      assumeRenderable: true
    })).toBe(false)
  })

  it('guards synchronous Electron executeJavaScript throws', async () => {
    expect(
      executeDesignHtmlPreviewScript({
        executeJavaScript: () => {
          throw new Error('not ready')
        }
      }, 'true')
    ).toBeNull()
    await expect(
      executeDesignHtmlPreviewScript({
        executeJavaScript: async () => 42
      }, 'true')
    ).resolves.toBe(42)
    await expect(
      executeDesignHtmlPreviewScript({
        executeJavaScript: async () => {
          throw new Error('guest script failed')
        }
      }, 'true')
    ).resolves.toBeNull()
  })
})
