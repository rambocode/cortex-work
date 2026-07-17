// 工具栏测试:导出菜单四格式、导出中禁用与进度、成功路径展示、取消静默、
// 失败提示,以及 zoom 档位与冲突条。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import { createEmptySlidesDeckManifest, type SlidesDeckManifest } from '@cortex-work/core/design/slides/slides-types'
import { useDesignWorkspaceStore } from '@cortex-work/core/design/design-workspace-store'
import { SlidesToolbar } from './SlidesToolbar'
import { useSlidesStore } from './slides-store'

const NOW = '2026-07-16T00:00:00.000Z'
const ROOT = '/ws'
const DECK = 'decktb0001'

function manifest(): SlidesDeckManifest {
  const m = createEmptySlidesDeckManifest({ id: DECK, title: '季度汇报', now: NOW })
  m.revision = 3
  m.status = 'ready'
  return m
}

// 带一个 ready 页的 manifest:播放按钮仅在存在 ready 页时可点。
function manifestWithReadySlide(): SlidesDeckManifest {
  const m = manifest()
  m.slides = [
    { id: 'slot-001', order: 0, title: '开场', htmlPath: 'slides/slot-001.html', revision: 1, status: 'ready', updatedAt: NOW }
  ]
  m.activeSlideId = 'slot-001'
  return m
}

function fakeBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    slidesLoadDeck: vi.fn(async () => ({ ok: true as const, manifest: manifest() })),
    slidesCreateDeck: vi.fn(),
    ...overrides
  } as unknown as DesktopBridge
}

async function setup(bridge: DesktopBridge): Promise<void> {
  await useSlidesStore.getState().setup({ bridge, workspaceRoot: ROOT, deckId: DECK, title: '季度汇报' })
}

beforeEach(() => {
  useSlidesStore.getState().reset()
})

afterEach(() => {
  cleanup()
})

describe('SlidesToolbar', () => {
  it('展示 deck 标题与 zoom 档位,可切换 zoom', async () => {
    await setup(fakeBridge())
    render(<SlidesToolbar />)
    expect(screen.getByText('季度汇报')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '75%' }))
    expect(useSlidesStore.getState().zoom).toBe('75')
    expect(screen.getByRole('button', { name: '75%' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('导出菜单含四种格式,点击调用对应 format', async () => {
    const slidesExport = vi.fn(async () => ({ ok: true as const, path: '/out/deck.pptx', format: 'pptx' as const }))
    await setup(fakeBridge({ slidesExport }))
    render(<SlidesToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    for (const label of [/导出 PPTX/, /导出 PDF.*不含备注/, /导出 PNG.*不含备注/, /导出 HTML/]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: /导出 PDF/ }))
    await waitFor(() => expect(slidesExport).toHaveBeenCalledWith(expect.objectContaining({ format: 'pdf' })))
  })

  it('导出成功后展示落盘路径', async () => {
    const slidesExport = vi.fn(async () => ({ ok: true as const, path: '/out/季度汇报.html', format: 'html' as const }))
    await setup(fakeBridge({ slidesExport }))
    render(<SlidesToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(screen.getByRole('button', { name: '导出 HTML' }))
    await waitFor(() => expect(screen.getByText('/out/季度汇报.html')).toBeInTheDocument())
  })

  it('导出中显示进度态并禁用按钮', async () => {
    let release: (() => void) | null = null
    const slidesExport = vi.fn(
      () =>
        new Promise<{ ok: true; path: string; format: 'html' }>((resolve) => {
          release = () => resolve({ ok: true, path: '/out/x.html', format: 'html' })
        })
    )
    await setup(fakeBridge({ slidesExport: slidesExport as unknown as DesktopBridge['slidesExport'] }))
    render(<SlidesToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(screen.getByRole('button', { name: '导出 HTML' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /导出中/ })).toBeDisabled())
    release!()
    await waitFor(() => expect(screen.getByText('/out/x.html')).toBeInTheDocument())
  })

  it('用户取消导出 → 静默(无错误条、无路径条)', async () => {
    const slidesExport = vi.fn(async () => ({ ok: false as const, canceled: true }))
    await setup(fakeBridge({ slidesExport }))
    render(<SlidesToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(screen.getByRole('button', { name: /导出 PNG/ }))
    await waitFor(() => expect(slidesExport).toHaveBeenCalled())
    expect(useSlidesStore.getState().actionError).toBeNull()
    expect(screen.queryByText(/\/out\//)).toBeNull()
  })

  it('导出失败 → 展示可读错误', async () => {
    const slidesExport = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'io_error' as const, message: '磁盘已满' }
    }))
    await setup(fakeBridge({ slidesExport }))
    render(<SlidesToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(screen.getByRole('button', { name: '导出 HTML' }))
    await waitFor(() => expect(screen.getByText('磁盘已满')).toBeInTheDocument())
  })

  it('PPTX 先运行可编辑性预检,不直接弹保存框', async () => {
    const slidesExport = vi.fn()
    const slidesAnalyzeExportQuality = vi.fn(async () => ({
      ok: true as const,
      analysis: {
        revision: 3,
        slides: [],
        deckReport: {
          slideCount: 0,
          nativeCount: 0,
          rasterCount: 0,
          rasterAreaRatio: 0,
          rasterReasons: [],
          warnings: [],
          quality: 'high' as const,
          nativeKinds: { text: 0, image: 0, table: 0, shape: 0, chart: 0 },
          qualityCounts: { high: 0, mixed: 0, 'raster-heavy': 0 }
        }
      }
    }))
    await setup(fakeBridge({ slidesExport, slidesAnalyzeExportQuality }))
    render(<SlidesToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(screen.getByRole('button', { name: '导出 PPTX' }))
    await waitFor(() => expect(slidesAnalyzeExportQuality).toHaveBeenCalledOnce())
    expect(slidesExport).not.toHaveBeenCalled()
    expect(useSlidesStore.getState().exportQualityOpen).toBe(true)
  })

  it('冲突时展示提示,点刷新后清除并重新拉取', async () => {
    const loadDeck = vi.fn(async () => ({ ok: true as const, manifest: manifest() }))
    await setup(fakeBridge({ slidesLoadDeck: loadDeck }))
    useSlidesStore.setState({ conflictNotice: true })
    render(<SlidesToolbar />)
    expect(screen.getByText('页面已在其他位置更新')).toBeInTheDocument()
    loadDeck.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }))
    expect(useSlidesStore.getState().conflictNotice).toBe(false)
    await waitFor(() => expect(loadDeck).toHaveBeenCalled())
  })

  it('播放按钮:桥接具备演示能力且有 ready 页时可点,点击触发演示', async () => {
    const slidesPresent = vi.fn(async () => ({ ok: true as const }))
    await setup(
      fakeBridge({
        slidesLoadDeck: vi.fn(async () => ({ ok: true as const, manifest: manifestWithReadySlide() })),
        slidesPresent
      })
    )
    render(<SlidesToolbar />)
    const button = screen.getByRole('button', { name: /播放/ })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    await waitFor(() =>
      expect(slidesPresent).toHaveBeenCalledWith({ workspaceRoot: ROOT, deckId: DECK, startSlideId: 'slot-001' })
    )
  })

  it('播放按钮:无 ready 页时禁用;桥接无演示能力时整体隐藏', async () => {
    // manifest() 无任何页 → 按钮存在但禁用。
    await setup(fakeBridge({ slidesPresent: vi.fn(async () => ({ ok: true as const })) }))
    render(<SlidesToolbar />)
    expect(screen.getByRole('button', { name: /播放/ })).toBeDisabled()
    cleanup()
    // 桥接无 slidesPresent → 按钮不渲染(web/旧壳降级)。
    useSlidesStore.getState().reset()
    await setup(fakeBridge())
    render(<SlidesToolbar />)
    expect(screen.queryByRole('button', { name: /播放/ })).toBeNull()
  })

  it('检查按钮触发 onRunCheck', async () => {
    await setup(fakeBridge())
    const onRunCheck = vi.fn()
    render(<SlidesToolbar onRunCheck={onRunCheck} />)
    fireEvent.click(screen.getByRole('button', { name: /检查/ }))
    expect(onRunCheck).toHaveBeenCalledOnce()
  })

  it('备注按钮可切换备注面板开关', async () => {
    await setup(fakeBridge())

    render(<SlidesToolbar />)
    const toggle = screen.getByRole('button', { name: '备注' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(toggle)
    await waitFor(() => expect(useSlidesStore.getState().notesOpen).toBe(true))
    expect(screen.getByRole('button', { name: '备注' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: '备注' }))
    await waitFor(() => expect(useSlidesStore.getState().notesOpen).toBe(false))
  })

  it('AI 工作流按钮打开状态面板并尝试恢复最近 run', async () => {
    const slidesGetLatestPipelineRun = vi.fn(async () => ({ ok: true as const, run: null }))
    await setup(fakeBridge({ slidesGetLatestPipelineRun }))
    render(<SlidesToolbar />)
    const toggle = screen.getByRole('button', { name: 'AI 工作流' })
    fireEvent.click(toggle)
    await waitFor(() => expect(useSlidesStore.getState().workflowOpen).toBe(true))
    expect(slidesGetLatestPipelineRun).toHaveBeenCalledOnce()
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('侧栏折叠按钮:未传 onToggleLeftSidebar 时不渲染,传入后点击触发开关', async () => {
    await setup(fakeBridge())
    render(<SlidesToolbar />)
    expect(screen.queryByRole('button', { name: '收起侧边栏' })).toBeNull()
    cleanup()

    const onToggleLeftSidebar = vi.fn()
    render(<SlidesToolbar onToggleLeftSidebar={onToggleLeftSidebar} />)
    fireEvent.click(screen.getByRole('button', { name: '收起侧边栏' }))
    expect(onToggleLeftSidebar).toHaveBeenCalledOnce()
    cleanup()

    render(<SlidesToolbar leftSidebarCollapsed onToggleLeftSidebar={onToggleLeftSidebar} />)
    expect(screen.getByRole('button', { name: '展开侧边栏' })).toBeInTheDocument()
  })

  it('右侧助手栏开关:折叠后可从工具栏重新展开', async () => {
    await setup(fakeBridge())
    useDesignWorkspaceStore.setState({ canvasAssistantOpen: false })
    render(<SlidesToolbar />)
    const toggle = screen.getByRole('button', { name: '打开设计助手' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(toggle)
    expect(useDesignWorkspaceStore.getState().canvasAssistantOpen).toBe(true)
    expect(screen.getByRole('button', { name: '折叠助手' })).toHaveAttribute('aria-pressed', 'true')
  })
})
