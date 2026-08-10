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
    // 会话白板不借用 Kun 的文件选择端口；Cortex 尚未提供原生图片选择契约前隐藏入口。
    expect(html).not.toContain('aria-label="上传图片到白板"')
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

// 会话产物面板里没有设计助手栏,那个开关按下去什么也不会发生(死按钮)。
describe('CanvasToolbar chromeless(会话产物面板)', () => {
  it('隐藏设计助手开关,其余工具照常', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, { workspaceRoot: '/workspace', chromeless: true })
    )

    expect(html).not.toContain('aria-label="打开设计助手"')
    expect(html).not.toContain('aria-label="折叠助手"')
    expect(html).toContain('aria-label="选择"')
    expect(html).toContain('aria-label="智能操作"')
  })

  it('默认(独立设计工作台)仍渲染设计助手开关', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, { workspaceRoot: '/workspace' })
    )
    // 助手栏默认展开,按钮此时的文案是「折叠助手」;两种态都算「按钮还在」。
    expect(
      html.includes('aria-label="打开设计助手"') || html.includes('aria-label="折叠助手"')
    ).toBe(true)
  })
})
