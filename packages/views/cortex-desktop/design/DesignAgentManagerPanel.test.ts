import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { useCanvasShapeStore } from '@cortex-work/core/design/canvas/canvas-shape-store'
import { createEmptyDocument } from '@cortex-work/core/design/canvas/canvas-types'
import { useDesignSystemStore } from '@cortex-work/core/design/canvas/design-system-store'
import { useDesignWorkspaceStore } from '@cortex-work/core/design/design-workspace-store'
import type { DesignDocument } from '@cortex-work/core/design/design-types'
import { DesignAgentManagerPanel } from './DesignAgentManagerPanel'

const now = '2026-07-02T00:00:00.000Z'

function designDocument(): DesignDocument {
  return {
    id: 'doc',
    title: 'Checkout redesign',
    createdAt: now,
    updatedAt: now,
    order: 0,
    artifacts: [],
    activeArtifactId: null
  }
}

describe('DesignAgentManagerPanel', () => {
  beforeEach(() => {
    useCanvasShapeStore.setState({ document: createEmptyDocument(), documentKey: null })
    useDesignSystemStore.setState({ system: { tokens: {}, components: {} } })
    useDesignWorkspaceStore.setState({ pagesRun: null, parallelPageStates: {} })
  })

  it('renders runnable design agent role controls', () => {
    const html = renderToStaticMarkup(
      createElement(DesignAgentManagerPanel, {
        document: designDocument(),
        onSeedPrompt: () => {}
      })
    )

    expect(html).toContain('Agent 管理器')
    expect(html).toContain('系统化 Agent')
    expect(html).toContain('extract-design-system · design.system')
    expect(html).toContain('aria-label="运行这个设计 Agent"')
    expect(html).toContain('aria-label="这个设计 Agent 当前不可用"')
  })

  it('renders nothing without an active design document', () => {
    expect(renderToStaticMarkup(createElement(DesignAgentManagerPanel, { document: null }))).toBe('')
  })
})
