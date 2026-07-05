import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { useDesignWorkspaceStore } from '@cortex-work/core/design/design-workspace-store'
import { CanvasToolbar } from './CanvasToolbar'

describe('CanvasToolbar prototype playback', () => {
  it('hides design-only controls on the code canvas', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        workspaceRoot: '/workspace',
        surface: 'code'
      })
    )

    expect(html).toContain('aria-label="选择"')
    expect(html).toContain('aria-label="画板"')
    expect(html).toContain('aria-label="AI 图片"')
    expect(html).toContain('aria-label="上传图片到白板"')
    expect(html).not.toContain('aria-label="AI image slot"')
    expect(html).not.toContain('aria-label="上传图片到画布"')
    expect(html).not.toContain('aria-label="屏幕"')
    expect(html).not.toContain('aria-label="Design context"')
    expect(html).not.toContain('aria-label="智能操作"')
    expect(html).not.toContain('aria-label="Critique canvas"')
    expect(html).not.toContain('aria-label="Open design assistant"')
    expect(html).not.toContain('aria-label="播放原型"')
  })

  it('shows agent action seeds on the design canvas', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        workspaceRoot: '/workspace'
      })
    )

    expect(html).toContain('aria-label="智能操作"')
  })

  it('keeps the design canvas toolbar focused on screen workflow controls', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        workspaceRoot: '/workspace'
      })
    )

    expect(html).toContain('aria-label="选择"')
    expect(html).toContain('aria-label="屏幕"')
    expect(html).toContain('aria-label="画板"')
    expect(html).toContain('aria-label="手型"')
    expect(html).toContain('aria-label="上传图片到画布"')
    expect(html).not.toContain('aria-label="AI image slot"')
    expect(html).not.toContain('aria-label="Rectangle"')
    expect(html).not.toContain('aria-label="Ellipse"')
    expect(html).not.toContain('aria-label="Text"')
    expect(html).not.toContain('aria-label="Arrow"')
    expect(html).not.toContain('aria-label="Line"')
    expect(html).not.toContain('aria-label="Draw"')
  })

  it('explains why prototype playback is disabled before a screen exists', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        workspaceRoot: '/workspace',
        prototypePlayable: false,
        onOpenPrototypePlayer: () => {}
      })
    )

    expect(html).toContain('先创建至少一个 screen，才能播放原型')
    expect(html).toContain(
      'aria-label="先创建至少一个 screen，才能播放原型"'
    )
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="先创建至少一个 screen，才能播放原型"/)
  })

  it('keeps the normal play affordance when prototype screens exist', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        workspaceRoot: '/workspace',
        prototypePlayable: true,
        onOpenPrototypePlayer: () => {}
      })
    )

    expect(html).toContain('aria-label="播放原型"')
    expect(html).not.toContain('先创建至少一个 screen，才能播放原型')
  })

  it('labels the open design assistant button as a collapsible toggle', () => {
    useDesignWorkspaceStore.setState({ canvasAssistantOpen: true, aiRailCollapsed: false })
    const openHtml = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        workspaceRoot: '/workspace'
      })
    )
    expect(openHtml).toContain('aria-label="折叠助手"')
    expect(openHtml).toContain('aria-pressed="true"')
  })
})
