import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createEmptyDocument, createHtmlFrameShape, type CanvasDocument } from '@cortex-work/core/design/canvas/canvas-types'
import type { DesignArtifact } from '@cortex-work/core/design/design-types'
import { DesignPrototypeFlowPanel } from './DesignPrototypeFlowPanel'

const createdAt = '2026-07-02T00:00:00.000Z'

function artifact(id: string, title: string, extra: Partial<DesignArtifact> = {}): DesignArtifact {
  const relativePath = `.cortex-design/doc/${id}/v1.html`
  return {
    id,
    kind: 'html',
    title,
    relativePath,
    createdAt,
    updatedAt: createdAt,
    versions: [{ id: `${id}-v1`, relativePath, createdAt, summary: '' }],
    ...extra
  }
}

function addFrame(doc: CanvasDocument, artifactId: string, title: string, x: number): string {
  const frame = createHtmlFrameShape(title, x, 0, artifactId, 'desktop')
  doc.objects[frame.id] = { ...frame, parentId: doc.rootId }
  doc.objects[doc.rootId] = {
    ...doc.objects[doc.rootId]!,
    children: [...doc.objects[doc.rootId]!.children, frame.id]
  }
  return frame.id
}

describe('DesignPrototypeFlowPanel', () => {
  it('renders prototype flow edges and health summary', () => {
    const doc = createEmptyDocument()
    const homeFrameId = addFrame(doc, 'home', 'Home', 0)
    addFrame(doc, 'signup', 'Signup', 1500)
    const artifacts = [
      artifact('home', 'Home', {
        prototypeLinks: [{ targetTitle: 'Signup', targetArtifactId: 'signup', href: '../signup/v1.html', label: 'Start' }]
      }),
      artifact('signup', 'Signup')
    ]

    const html = renderToStaticMarkup(createElement(DesignPrototypeFlowPanel, {
      artifacts,
      canvasDocument: doc,
      selectedIds: new Set([homeFrameId]),
      onSeedPrompt: () => {}
    }))

    expect(html).toContain('原型流程')
    expect(html).toContain('Home -&gt; Signup')
    expect(html).toContain('显式链接')
    expect(html).toContain('兜底连接')
    expect(html).toContain('2 个 screen')
    expect(html).toContain('1 条链接')
    expect(html).toContain('连接原型流程')
  })

  it('renders nothing without visible screens', () => {
    const html = renderToStaticMarkup(createElement(DesignPrototypeFlowPanel, {
      artifacts: [],
      canvasDocument: createEmptyDocument(),
      selectedIds: new Set<string>()
    }))

    expect(html).toBe('')
  })
})
