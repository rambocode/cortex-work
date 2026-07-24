// slides deck webview 会话分区契约:必须 persist: 前缀,否则 Electron 给的是内存 session,
// localStorage(bento 语言 bento-lang、动效偏好 bento-reduce-motion)退出即丢 ——
// 「设置语言不持久化」的根因;此处钉住防回退。
import { describe, expect, it } from 'vitest'
import { SLIDES_WEBVIEW_PARTITION } from './slides-webview-partition'

describe('SLIDES_WEBVIEW_PARTITION', () => {
  it('必须是 persist: 分区(localStorage 落盘,语言/动效偏好跨重启存活)', () => {
    expect(SLIDES_WEBVIEW_PARTITION).toBe('persist:cortex-slides')
    expect(SLIDES_WEBVIEW_PARTITION.startsWith('persist:')).toBe(true)
  })
})
