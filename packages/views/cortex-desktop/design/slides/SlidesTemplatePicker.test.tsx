// 模板选择器测试:懒加载列表、搜索过滤、点选应用(带 expectedRevision)、
// 已应用模板高亮、加载失败提示。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import type { SlidesTemplateSummary } from '@cortex-work/core/design/slides/slides-templates'
import { createEmptySlidesDeckManifest, type SlidesDeckManifest } from '@cortex-work/core/design/slides/slides-types'
import { SlidesTemplatePicker } from './SlidesTemplatePicker'
import { useSlidesStore } from './slides-store'

const NOW = '2026-07-16T00:00:00.000Z'
const ROOT = '/ws'
const DECK = 'decktpl001'

function template(id: string, patch: Partial<SlidesTemplateSummary> = {}): SlidesTemplateSummary {
  return {
    id,
    title: id,
    description: `${id} description`,
    descriptionZh: `${id} 中文描述`,
    category: 'light',
    tags: ['clean'],
    styleGuide: 'guide',
    theme: {
      name: id,
      mood: ['clean'],
      palette: {
        background: '#ffffff',
        foreground: '#0f172a',
        primary: '#2563eb',
        secondary: '#64748b',
        accent: '#f59e0b'
      },
      fonts: { heading: 'PingFang SC', body: 'PingFang SC' },
      density: 'balanced'
    },
    referenceSlides: [{ layout: 'cover', file: 'references/template.html' }],
    ...patch
  }
}

const TEMPLATES = [
  template('quiet-axis', { title: 'Quiet Axis', descriptionZh: '静态坐标', tags: ['elegant', 'literary'] }),
  template('pixel-orbit', { title: 'Pixel Orbit', descriptionZh: '像素轨道', category: 'dark', tags: ['arcade'] })
]

function manifest(themeName = 'Cortex Default'): SlidesDeckManifest {
  const m = createEmptySlidesDeckManifest({ id: DECK, title: 'T', now: NOW })
  m.revision = 4
  m.theme = { ...m.theme, name: themeName }
  return m
}

function fakeBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    slidesLoadDeck: vi.fn(async () => ({ ok: true as const, manifest: manifest() })),
    slidesCreateDeck: vi.fn(),
    slidesListTemplates: vi.fn(async () => ({ ok: true as const, templates: TEMPLATES })),
    ...overrides
  } as unknown as DesktopBridge
}

async function setup(bridge: DesktopBridge): Promise<void> {
  await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: 'T' })
}

beforeEach(() => {
  useSlidesStore.getState().reset()
})

afterEach(() => {
  cleanup()
})

describe('SlidesTemplatePicker', () => {
  it('未打开时不渲染', async () => {
    await setup(fakeBridge())
    render(<SlidesTemplatePicker />)
    expect(screen.queryByTestId('slides-template-picker')).toBeNull()
  })

  it('打开时拉取并展示模板(仅一次,后续复用缓存)', async () => {
    const list = vi.fn(async () => ({ ok: true as const, templates: TEMPLATES }))
    await setup(fakeBridge({ slidesListTemplates: list }))
    render(<SlidesTemplatePicker />)
    await useSlidesStore.getState().openTemplatePicker()
    expect(screen.getByTestId('slides-template-picker')).toBeInTheDocument()
    expect(screen.getByText('Quiet Axis')).toBeInTheDocument()
    expect(screen.getByText('像素轨道')).toBeInTheDocument()
    expect(screen.getByText('深色')).toBeInTheDocument()
    // 关掉再开:不重复请求。
    useSlidesStore.getState().closeTemplatePicker()
    await useSlidesStore.getState().openTemplatePicker()
    expect(list).toHaveBeenCalledOnce()
  })

  it('搜索按名称/中文描述/标签过滤', async () => {
    await setup(fakeBridge())
    render(<SlidesTemplatePicker />)
    await useSlidesStore.getState().openTemplatePicker()
    const search = screen.getByLabelText('搜索模板名称、描述或标签…')
    fireEvent.change(search, { target: { value: '像素' } })
    expect(screen.getByText('Pixel Orbit')).toBeInTheDocument()
    expect(screen.queryByText('Quiet Axis')).toBeNull()
    fireEvent.change(search, { target: { value: 'literary' } })
    expect(screen.getByText('Quiet Axis')).toBeInTheDocument()
    fireEvent.change(search, { target: { value: '找不到' } })
    expect(screen.getByText('没有匹配的模板')).toBeInTheDocument()
  })

  it('点选模板 → 带 expectedRevision 应用并关闭面板', async () => {
    const applied = manifest('Quiet Axis')
    applied.revision = 5
    const apply = vi.fn(async () => ({ ok: true as const, manifest: applied }))
    await setup(fakeBridge({ slidesApplyTemplate: apply }))
    render(<SlidesTemplatePicker />)
    await useSlidesStore.getState().openTemplatePicker()
    fireEvent.click(screen.getByTestId('slides-template-quiet-axis'))
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: 'quiet-axis', expectedRevision: 4, deckId: DECK })
      )
    )
    await waitFor(() => expect(useSlidesStore.getState().templatePickerOpen).toBe(false))
    expect(useSlidesStore.getState().manifest?.theme.name).toBe('Quiet Axis')
  })

  it('当前主题对应的模板显示为已应用', async () => {
    // 匹配依据是 theme.name(fixture 里 = 模板 id),不是展示标题。
    const bridge = fakeBridge({
      slidesLoadDeck: vi.fn(async () => ({ ok: true as const, manifest: manifest('quiet-axis') }))
    })
    await setup(bridge)
    render(<SlidesTemplatePicker />)
    await useSlidesStore.getState().openTemplatePicker()
    expect(screen.getByTestId('slides-template-quiet-axis').className).toContain('bg-[#3b82d8]/8')
    expect(screen.getByTestId('slides-template-pixel-orbit').className).not.toContain('bg-[#3b82d8]/8')
  })

  it('悬停模板行 → 经桥接取参考页并渲染缩放 iframe 预览', async () => {
    const readRef = vi.fn(async () => ({
      ok: true as const,
      html: '<!DOCTYPE html><html><body>REF</body></html>'
    }))
    await setup(fakeBridge({ slidesReadTemplateReference: readRef }))
    render(<SlidesTemplatePicker />)
    await useSlidesStore.getState().openTemplatePicker()
    fireEvent.mouseEnter(screen.getByTestId('slides-template-quiet-axis'))
    await waitFor(() =>
      expect(readRef).toHaveBeenCalledWith({ templateId: 'quiet-axis', file: 'references/template.html' })
    )
    // 预览 iframe 以模板标题命名(title 属性),srcdoc 为参考页 HTML。
    await waitFor(() => expect(screen.getByTitle('Quiet Axis')).toBeInTheDocument())
  })

  it('桥接无参考页能力 → 悬停不报错,预览退化为色板占位', async () => {
    await setup(fakeBridge())
    render(<SlidesTemplatePicker />)
    await useSlidesStore.getState().openTemplatePicker()
    fireEvent.mouseEnter(screen.getByTestId('slides-template-pixel-orbit'))
    // 无 iframe,但预览卡片仍展示模板标题与描述(色板占位)。
    await waitFor(() => expect(screen.queryByTitle('Pixel Orbit')).toBeNull())
    expect(screen.getAllByText('Pixel Orbit').length).toBeGreaterThan(1)
  })

  it('模板加载失败 → 空列表 + 可读错误', async () => {
    const bridge = fakeBridge({
      slidesListTemplates: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'io_error' as const, message: '模板目录不可读' }
      }))
    })
    await setup(bridge)
    render(<SlidesTemplatePicker />)
    await useSlidesStore.getState().openTemplatePicker()
    expect(screen.getByText('没有匹配的模板')).toBeInTheDocument()
    expect(useSlidesStore.getState().actionError).toBe('模板目录不可读')
  })
})
