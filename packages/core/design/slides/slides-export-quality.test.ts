import { describe, expect, it } from 'vitest'
import { buildDeckExportReport, buildSceneExportReport } from './slides-export-quality'

type TestNode =
  | { kind: 'text' | 'image' | 'table' | 'shape'; x: number; y: number; w: number; h: number }
  | { kind: 'raster'; x: number; y: number; w: number; h: number; reason: string }

function scene(overrides: Partial<{ width: number; height: number; warnings: string[]; nodes: TestNode[] }> = {}) {
  return {
    width: 100,
    height: 100,
    warnings: [],
    nodes: [] as TestNode[],
    ...overrides
  }
}

describe('buildSceneExportReport', () => {
  it('按裁剪后的 raster 矩形并集计算覆盖率,不重复累计重叠面积', () => {
    const report = buildSceneExportReport(
      scene({
        nodes: [
          { kind: 'text', x: 5, y: 5, w: 10, h: 10 },
          { kind: 'image', x: 10, y: 10, w: 20, h: 20 },
          { kind: 'table', x: 20, y: 20, w: 20, h: 20 },
          { kind: 'shape', x: 30, y: 30, w: 20, h: 20 },
          { kind: 'raster', x: 0, y: 0, w: 60, h: 60, reason: 'canvas' },
          { kind: 'raster', x: 40, y: 40, w: 60, h: 60, reason: 'gradient' },
          { kind: 'raster', x: -10, y: -10, w: 20, h: 20, reason: 'svg' }
        ]
      })
    )

    expect(report.nativeCount).toBe(4)
    expect(report.rasterCount).toBe(3)
    expect(report.nativeKinds).toEqual({ text: 1, image: 1, table: 1, shape: 1, chart: 0 })
    expect(report.rasterReasons).toEqual(['canvas', 'gradient', 'svg'])
    expect(report.rasterAreaRatio).toBeCloseTo(0.68, 5)
    expect(report.quality).toBe('raster-heavy')
  })

  it('按阈值区分 high / mixed / raster-heavy', () => {
    expect(
      buildSceneExportReport(scene({ nodes: [{ kind: 'raster', x: 0, y: 0, w: 10, h: 10, reason: 'canvas' }] })).quality
    ).toBe('high')

    expect(
      buildSceneExportReport(scene({ nodes: [{ kind: 'raster', x: 0, y: 0, w: 40, h: 40, reason: 'canvas' }] })).quality
    ).toBe('mixed')

    expect(
      buildSceneExportReport(scene({ nodes: [{ kind: 'raster', x: 0, y: 0, w: 80, h: 80, reason: 'canvas' }] })).quality
    ).toBe('raster-heavy')
  })

  it('整页栅格或 blocking warning 会强制判为 raster-heavy,并清洗泄漏信息', () => {
    const fullPage = buildSceneExportReport(
      scene({
        nodes: [
          { kind: 'text', x: 5, y: 5, w: 10, h: 10 },
          { kind: 'raster', x: 0, y: 0, w: 100, h: 100, reason: 'body-background' }
        ]
      })
    )
    expect(fullPage.quality).toBe('raster-heavy')
    expect(fullPage.rasterAreaRatio).toBe(1)

    const blocking = buildSceneExportReport(
      scene({
        nodes: [{ kind: 'raster', x: 0, y: 0, w: 10, h: 10, reason: 'canvas' }],
        warnings: [
          'blocking:file:///Users/mike/source/ai/cortex-org/cortex-desktop/cortex-work/.cortex-design/deck/slide.html',
          'mixed-content:<div>用户标题</div>',
          'remote-image:https://example.com/deck?title=用户标题'
        ]
      })
    )

    expect(blocking.quality).toBe('raster-heavy')
    expect(blocking.warnings).toEqual(['blocking', 'mixed-content', 'remote-image'])
    expect(JSON.stringify(blocking)).not.toContain('/Users/mike/')
    expect(JSON.stringify(blocking)).not.toContain('<div>')
    expect(JSON.stringify(blocking)).not.toContain('用户标题')
  })
})

describe('buildDeckExportReport', () => {
  it('汇总整套 deck 的页级报告', () => {
    const deck = buildDeckExportReport([
      buildSceneExportReport(
        scene({
          nodes: [
            { kind: 'text', x: 5, y: 5, w: 10, h: 10 },
            { kind: 'raster', x: 0, y: 0, w: 10, h: 10, reason: 'canvas' }
          ]
        })
      ),
      buildSceneExportReport(
        scene({
          nodes: [
            { kind: 'image', x: 5, y: 5, w: 10, h: 10 },
            { kind: 'shape', x: 10, y: 10, w: 10, h: 10 },
            { kind: 'raster', x: 0, y: 0, w: 40, h: 40, reason: 'gradient' }
          ],
          warnings: ['mixed-content:card']
        })
      )
    ])

    expect(deck.slideCount).toBe(2)
    expect(deck.nativeCount).toBe(3)
    expect(deck.rasterCount).toBe(2)
    expect(deck.nativeKinds).toEqual({ text: 1, image: 1, table: 0, shape: 1, chart: 0 })
    expect(deck.rasterReasons).toEqual(['canvas', 'gradient'])
    expect(deck.warnings).toEqual(['mixed-content'])
    expect(deck.rasterAreaRatio).toBeCloseTo(0.085, 5)
    expect(deck.quality).toBe('high')
    expect(deck.qualityCounts).toEqual({ high: 1, mixed: 1, 'raster-heavy': 0 })
  })
})
