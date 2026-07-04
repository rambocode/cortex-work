import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { useCanvasSelectionStore } from '@cortex-work/core/design/canvas/canvas-selection-store'
import { useCanvasShapeStore } from '@cortex-work/core/design/canvas/canvas-shape-store'
import {
  createDefaultShape,
  createEmptyDocument,
  createHtmlFrameShape,
  type CanvasDocument
} from '@cortex-work/core/design/canvas/canvas-types'
import { useDesignSystemStore } from '@cortex-work/core/design/canvas/design-system-store'
import type { DesignSystem } from '@cortex-work/core/design/canvas/design-system-types'
import { useDesignWorkspaceStore } from '@cortex-work/core/design/design-workspace-store'
import { DesignSystemPanel } from './DesignSystemPanel'

function addToRoot(doc: CanvasDocument, ...shapes: ReturnType<typeof createDefaultShape>[]): void {
  for (const shape of shapes) {
    doc.objects[shape.id] = { ...shape, parentId: doc.rootId }
  }
  doc.objects[doc.rootId] = {
    ...doc.objects[doc.rootId]!,
    children: shapes.map((shape) => shape.id)
  }
}

describe('DesignSystemPanel', () => {
  beforeEach(() => {
    useCanvasShapeStore.setState({ document: createEmptyDocument(), documentKey: null })
    useCanvasSelectionStore.setState({ selectedIds: new Set(), editingId: null })
    useDesignSystemStore.setState({ system: { tokens: {}, components: {} } })
    useDesignWorkspaceStore.setState({ designContext: { designTarget: 'web' } })
  })

  it('renders design.system actions with current system counts', () => {
    const doc = createEmptyDocument()
    const frame = createHtmlFrameShape('Home', 0, 0, 'home', 'desktop')
    const card = createDefaultShape('rect', 24, 32)
    card.name = 'CTA card'
    card.parentId = frame.id
    card.frameId = frame.id
    card.fills = [{ type: 'solid', color: '#2563eb', opacity: 1 }]
    card.tokenBindings = { fill: 'brand/primary' }
    frame.children = [card.id]
    addToRoot(doc, frame)
    doc.objects[card.id] = card
    const system: DesignSystem = {
      tokens: {
        'brand/primary': { name: 'brand/primary', kind: 'color', value: '#2563eb' }
      },
      components: {}
    }

    const html = renderToStaticMarkup(createElement(DesignSystemPanel, {
      canvasDocument: doc,
      designSystem: system,
      selectedIds: new Set([card.id]),
      designTarget: 'web',
      onSeedPrompt: () => {}
    }))

    expect(html).toContain('设计系统')
    expect(html).toContain('更新系统')
    expect(html).toContain('校验系统')
    expect(html).toContain('应用到选择区')
    expect(html).toContain('design.system')
    expect(html).toContain('1 个 token')
    expect(html).toContain('1 个绑定使用')
    expect(html).toContain('1 个选中')
  })

  it('shows disabled guidance when there is no canvas content or system', () => {
    const html = renderToStaticMarkup(createElement(DesignSystemPanel, { onSeedPrompt: () => {} }))

    expect(html).toContain('创建系统')
    expect(html).toContain('请先创建画布内容。')
    expect(html).toContain('请先选择画布对象。')
  })
})
