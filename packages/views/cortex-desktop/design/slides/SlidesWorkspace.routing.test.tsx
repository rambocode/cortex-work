// 中间区域分流测试:kind === 'slides' 的设计稿渲染 SlidesWorkspace,
// board(含旧数据无 kind)仍渲染 DesignCanvas。重组件一律 mock。
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesignWorkspaceStore } from '@cortex-work/core/design/design-workspace-store'
import { bentoDeckHtmlPath } from '@cortex-work/core/design/slides/slides-paths'
import type { DesignDocument } from '@cortex-work/core/design/design-types'

vi.mock('./SlidesWorkspace', () => ({
  SlidesWorkspace: ({ documentId }: { documentId: string }) => (
    <div data-testid="slides-workspace-mock">{documentId}</div>
  )
}))
vi.mock('../DesignCanvas', () => ({
  DesignCanvas: () => <div data-testid="design-canvas-mock" />
}))

import { DesignWorkspaceView } from '../DesignWorkspaceView'

const NOW = '2026-07-16T00:00:00.000Z'

function doc(id: string, patch: Partial<DesignDocument> = {}): DesignDocument {
  return {
    id,
    title: id,
    createdAt: NOW,
    updatedAt: NOW,
    order: 0,
    artifacts: [],
    activeArtifactId: null,
    ...patch
  }
}

beforeEach(() => {
  useDesignWorkspaceStore.setState({ workspaceRoot: '/ws' })
})

afterEach(() => {
  cleanup()
})

describe('DesignWorkspaceView kind 分流', () => {
  it('slides 设计稿渲染 SlidesWorkspace', () => {
    useDesignWorkspaceStore.setState({
      documents: [doc('deckdoc01', { kind: 'slides', slidesManifestPath: bentoDeckHtmlPath('deckdoc01') })],
      activeDocumentId: 'deckdoc01'
    })
    render(<DesignWorkspaceView leftSidebarCollapsed={false} onToggleLeftSidebar={() => {}} />)
    expect(screen.getByTestId('slides-workspace-mock')).toHaveTextContent('deckdoc01')
    expect(screen.queryByTestId('design-canvas-mock')).toBeNull()
  })

  it('board 设计稿(含旧数据无 kind)仍渲染 DesignCanvas', () => {
    useDesignWorkspaceStore.setState({
      documents: [doc('boarddoc1')],
      activeDocumentId: 'boarddoc1'
    })
    render(<DesignWorkspaceView leftSidebarCollapsed={false} onToggleLeftSidebar={() => {}} />)
    expect(screen.getByTestId('design-canvas-mock')).toBeInTheDocument()
    expect(screen.queryByTestId('slides-workspace-mock')).toBeNull()
  })

  it('kind=slides 但缺 manifest 路径的残缺数据回落 DesignCanvas(不误入 Slides loader)', () => {
    useDesignWorkspaceStore.setState({
      documents: [doc('halfdoc01', { kind: 'slides' })],
      activeDocumentId: 'halfdoc01'
    })
    render(<DesignWorkspaceView leftSidebarCollapsed={false} onToggleLeftSidebar={() => {}} />)
    expect(screen.getByTestId('design-canvas-mock')).toBeInTheDocument()
  })
})
