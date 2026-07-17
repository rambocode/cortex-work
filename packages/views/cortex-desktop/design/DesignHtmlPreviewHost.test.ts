import { describe, expect, it } from 'vitest'
import {
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
