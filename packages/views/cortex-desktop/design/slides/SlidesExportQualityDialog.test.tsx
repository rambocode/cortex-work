import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSlidesStore } from './slides-store'
import { SlidesExportQualityDialog } from './SlidesExportQualityDialog'

beforeEach(() => {
  useSlidesStore.getState().reset()
  useSlidesStore.setState({
    exportQualityOpen: true,
    exportQualityAnalysis: {
      revision: 7,
      slides: [
        {
          slotId: 'slot-001',
          order: 0,
          report: {
            nativeCount: 4,
            rasterCount: 1,
            rasterAreaRatio: 0.62,
            rasterReasons: ['canvas'],
            warnings: ['mixed-content'],
            quality: 'raster-heavy',
            nativeKinds: { text: 2, image: 1, table: 0, shape: 1, chart: 0 }
          }
        },
        {
          slotId: 'slot-002',
          order: 1,
          report: {
            nativeCount: 3,
            rasterCount: 0,
            rasterAreaRatio: 0.18,
            rasterReasons: [],
            warnings: ['chart-axis-title-ignored'],
            quality: 'mixed',
            nativeKinds: { text: 1, image: 1, table: 0, shape: 0, chart: 1 }
          }
        }
      ],
      deckReport: {
        slideCount: 2,
        nativeCount: 7,
        rasterCount: 1,
        rasterAreaRatio: 0.4,
        rasterReasons: ['canvas'],
        warnings: ['mixed-content', 'chart-axis-title-ignored'],
        quality: 'raster-heavy',
        nativeKinds: { text: 3, image: 2, table: 0, shape: 1, chart: 1 },
        qualityCounts: { high: 0, mixed: 1, 'raster-heavy': 1 }
      }
    }
  })
})

describe('SlidesExportQualityDialog', () => {
  it('逐页展示原生/栅格数量、nativeKinds 与 warnings,用户确认后继续导出', async () => {
    const exportDeck = vi.fn(async () => ({ ok: true as const, path: '/tmp/a.pptx', format: 'pptx' as const }))
    useSlidesStore.setState({ exportDeck })
    render(<SlidesExportQualityDialog />)

    expect(screen.getByText('40%')).toBeInTheDocument()
    expect(screen.getByText(/第 1 页 · 62% 栅格/)).toBeInTheDocument()
    expect(screen.getByText(/第 2 页 · 18% 栅格/)).toBeInTheDocument()
    expect(screen.getByText(/原生 4 · 栅格 1/)).toBeInTheDocument()
    expect(screen.getByText(/text 2 · image 1 · shape 1/)).toBeInTheDocument()
    expect(screen.getByText(/warnings：mixed-content/)).toBeInTheDocument()
    expect(screen.getByText(/原生 3 · 栅格 0/)).toBeInTheDocument()
    expect(screen.getByText(/text 1 · image 1 · chart 1/)).toBeInTheDocument()
    expect(screen.getByText(/warnings：chart-axis-title-ignored/)).toBeInTheDocument()
    expect(screen.getByText(/canvas/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '继续导出 PPTX' }))
    await waitFor(() => expect(exportDeck).toHaveBeenCalledWith('pptx'))
    expect(useSlidesStore.getState().exportQualityOpen).toBe(false)
  })

  it('可取消或请求 Agent 优化问题页面', () => {
    const onOptimize = vi.fn()
    const { rerender } = render(<SlidesExportQualityDialog onOptimize={onOptimize} />)
    fireEvent.click(screen.getByRole('button', { name: '让 Agent 优化' }))
    expect(onOptimize).toHaveBeenCalledWith(
      expect.objectContaining({ slideIds: ['slot-001', 'slot-002'], reasons: ['canvas'] })
    )

    act(() => useSlidesStore.setState({ exportQualityOpen: true }))
    rerender(<SlidesExportQualityDialog onOptimize={onOptimize} />)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(useSlidesStore.getState().exportQualityOpen).toBe(false)
  })
})
