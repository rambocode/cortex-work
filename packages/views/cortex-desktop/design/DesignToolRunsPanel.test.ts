import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  createDefaultShape,
  createEmptyDocument,
  type CanvasDocument
} from '@cortex-work/core/design/canvas/canvas-types'
import type { DesignSystem } from '@cortex-work/core/design/canvas/design-system-types'
import { DesignToolRunsPanel } from './DesignToolRunsPanel'

function addToRoot(doc: CanvasDocument, ...shapes: ReturnType<typeof createDefaultShape>[]): void {
  for (const shape of shapes) {
    doc.objects[shape.id] = { ...shape, parentId: doc.rootId }
  }
  doc.objects[doc.rootId] = {
    ...doc.objects[doc.rootId]!,
    children: shapes.map((shape) => shape.id)
  }
}

describe('DesignToolRunsPanel', () => {
  it('renders runnable local design tool entries', () => {
    const doc = createEmptyDocument()
    const card = createDefaultShape('rect', 20, 32)
    card.fills = [{ type: 'solid', color: '#2563eb', opacity: 1 }]
    addToRoot(doc, card)
    const system: DesignSystem = {
      tokens: {
        'brand/primary': { name: 'brand/primary', kind: 'color', value: '#2563eb' }
      },
      components: {}
    }

    const html = renderToStaticMarkup(createElement(DesignToolRunsPanel, {
      title: 'Checkout',
      canvasDocument: doc,
      designSystem: system,
      selectedIds: new Set([card.id])
    }))

    expect(html).toContain('设计工具')
    expect(html).toContain('规划下一步')
    expect(html).toContain('审查画布')
    expect(html).toContain('修复问题')
    expect(html).toContain('design.plan')
    expect(html).toContain('design.critique')
    expect(html).toContain('design.repair')
    expect(html).toContain('1 个对象')
    expect(html).toContain('1 个问题')
  })

  it('shows disabled hints without canvas content', () => {
    const html = renderToStaticMarkup(createElement(DesignToolRunsPanel, {
      canvasDocument: createEmptyDocument(),
      designSystem: { tokens: {}, components: {} },
      selectedIds: new Set<string>()
    }))

    expect(html).toContain('请先创建画布内容。')
    expect(html).toContain('暂无可修复问题。')
  })
})
