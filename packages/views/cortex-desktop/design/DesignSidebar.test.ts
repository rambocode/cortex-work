import { describe, expect, it } from 'vitest'
import type { DesignArtifact, DesignDocument } from '@cortex-work/core/design/design-types'
import {
  getDesignSidebarDocumentLabel,
  getDesignSidebarDocumentScreenCount,
  getDesignSidebarFilteredDocuments,
  getDesignSidebarVisibleArtifacts
} from './DesignSidebar'

function artifact(id: string, kind: DesignArtifact['kind'], patch: Partial<DesignArtifact> = {}): DesignArtifact {
  const createdAt = '2026-06-20T00:00:00.000Z'
  const relativePath = kind === 'canvas' ? `.cortex-design/${id}/canvas.json` : `.cortex-design/${id}/v1.html`
  return {
    id,
    kind,
    title: id,
    relativePath,
    createdAt,
    updatedAt: createdAt,
    versions: [{ id: `${id}-v1`, relativePath, createdAt, summary: '' }],
    ...patch
  }
}

describe('DesignSidebar helpers', () => {
  it('hides board-hidden screens from sidebar lists', () => {
    const visibleScreen = artifact('visible-screen', 'html')
    const hiddenScreen = artifact('hidden-screen', 'html', {
      node: { x: 40, y: 60, width: 390, height: 844, sizeMode: 'auto', boardHidden: true }
    })
    const canvas = artifact('board', 'canvas')

    expect(getDesignSidebarVisibleArtifacts([visibleScreen, hiddenScreen, canvas]).map((item) => item.id)).toEqual([
      'visible-screen',
      'board'
    ])
  })

  it('counts visible screens instead of implementation canvas artifacts', () => {
    const doc: Pick<DesignDocument, 'artifacts'> = {
      artifacts: [
        artifact('board', 'canvas'),
        artifact('hidden-screen', 'html', {
          node: { x: 40, y: 60, width: 390, height: 844, sizeMode: 'auto', boardHidden: true }
        }),
        artifact('visible-screen', 'html')
      ]
    }

    expect(getDesignSidebarDocumentScreenCount(doc)).toBe(1)
  })

  it('prefers the document title as the sidebar label, falling back to the ID', () => {
    expect(getDesignSidebarDocumentLabel({ id: 'a1b2c3d4', title: 'a1b2c3d4' })).toBe('a1b2c3d4')
    expect(getDesignSidebarDocumentLabel({ id: 'a1b2c3d4', title: '发布会初稿' })).toBe('发布会初稿')
    expect(getDesignSidebarDocumentLabel({ id: 'a1b2c3d4', title: '   ' })).toBe('a1b2c3d4')
  })

  it('filters documents by kind for the create-section filter', () => {
    const docs = [
      { id: 'board-1', kind: undefined, slidesManifestPath: undefined },
      { id: 'deck-1', kind: 'slides' as const, slidesManifestPath: '.cortex-design/deck-1/deck.bento.html' },
      { id: 'board-2', kind: undefined, slidesManifestPath: undefined }
    ]

    expect(getDesignSidebarFilteredDocuments(docs, null).map((doc) => doc.id)).toEqual(['board-1', 'deck-1', 'board-2'])
    expect(getDesignSidebarFilteredDocuments(docs, 'board').map((doc) => doc.id)).toEqual(['board-1', 'board-2'])
    expect(getDesignSidebarFilteredDocuments(docs, 'slides').map((doc) => doc.id)).toEqual(['deck-1'])
  })
})
