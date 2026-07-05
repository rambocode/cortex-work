import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createEmptyDocument } from '@cortex-work/core/design/canvas/canvas-types'
import { createRunningAppFrameShape } from '@cortex-work/core/design/canvas/running-app-frame'
import { DesignCodeSyncPanel } from './DesignCodeSyncPanel'

describe('DesignCodeSyncPanel', () => {
  it('renders the code bridge tool action for running app frames', () => {
    const doc = createEmptyDocument()
    const frame = createRunningAppFrameShape({
      x: 0,
      y: 0,
      url: 'localhost:5173/dashboard',
      title: 'Live dashboard',
      routePath: '/dashboard',
      sourceFile: 'src/app/dashboard/page.tsx'
    })!
    doc.objects[frame.id] = { ...frame, parentId: doc.rootId }
    doc.objects[doc.rootId] = { ...doc.objects[doc.rootId]!, children: [frame.id] }

    const html = renderToStaticMarkup(createElement(DesignCodeSyncPanel, {
      workspaceRoot: '/workspace',
      canvasDocument: doc,
      onSeedPrompt: () => {}
    }))

    expect(html).toContain('代码桥')
    expect(html).toContain('准备代码绑定')
    expect(html).toContain('design.bind_code')
    expect(html).toContain('1 个 live app frame')
  })

  it('renders nothing when there is no code bridge state', () => {
    const html = renderToStaticMarkup(createElement(DesignCodeSyncPanel, {
      workspaceRoot: '/workspace',
      canvasDocument: createEmptyDocument()
    }))

    expect(html).toBe('')
  })
})
