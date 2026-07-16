// 工具栏测试:导出菜单四格式、导出中禁用与进度、成功路径展示、取消静默、
// 失败提示,以及 zoom 档位与冲突条。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@cortex-work/core/desktop/bridge'
import { createEmptySlidesDeckManifest, type SlidesDeckManifest } from '@cortex-work/core/design/slides/slides-types'
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
    for (const label of ['导出 PPTX', '导出 PDF', '导出 PNG', '导出 HTML']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }))
    await waitFor(() => expect(slidesExport).toHaveBeenCalledWith(expect.objectContaining({ format: 'pdf' })))
  })

  it('导出成功后展示落盘路径', async () => {
    const slidesExport = vi.fn(async () => ({ ok: true as const, path: '/out/季度汇报.pptx', format: 'pptx' as const }))
    await setup(fakeBridge({ slidesExport }))
    render(<SlidesToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(screen.getByRole('button', { name: '导出 PPTX' }))
    await waitFor(() => expect(screen.getByText('/out/季度汇报.pptx')).toBeInTheDocument())
  })

  it('导出中显示进度态并禁用按钮', async () => {
    let release: (() => void) | null = null
    const slidesExport = vi.fn(
      () =>
        new Promise<{ ok: true; path: string; format: 'pptx' }>((resolve) => {
          release = () => resolve({ ok: true, path: '/out/x.pptx', format: 'pptx' })
        })
    )
    await setup(fakeBridge({ slidesExport: slidesExport as unknown as DesktopBridge['slidesExport'] }))
    render(<SlidesToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(screen.getByRole('button', { name: '导出 PPTX' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /导出中/ })).toBeDisabled())
    release!()
    await waitFor(() => expect(screen.getByText('/out/x.pptx')).toBeInTheDocument())
  })

  it('用户取消导出 → 静默(无错误条、无路径条)', async () => {
    const slidesExport = vi.fn(async () => ({ ok: false as const, canceled: true }))
    await setup(fakeBridge({ slidesExport }))
    render(<SlidesToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(screen.getByRole('button', { name: '导出 PNG' }))
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

  it('检查按钮触发 onRunCheck', async () => {
    await setup(fakeBridge())
    const onRunCheck = vi.fn()
    render(<SlidesToolbar onRunCheck={onRunCheck} />)
    fireEvent.click(screen.getByRole('button', { name: /检查/ }))
    expect(onRunCheck).toHaveBeenCalledOnce()
  })
})
