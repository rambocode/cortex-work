// DesignDocument kind 归一化 + documents.json 索引兼容测试:旧数据(无 kind)一律
// 按 board 处理;slides 标记只有在 kind 与 manifest 路径同时合法时才存活。
import { describe, expect, it } from 'vitest'
import { designDocumentKind } from '../design-types'
import { parseDocumentsIndex, serializeDocumentsIndex } from '../design-document-persistence'
import type { DesignDocument } from '../design-types'
import { createEmptySlidesDeckManifest, sortedSlidesSlots, type SlidesSlot } from './slides-types'
import { slidesManifestPath } from './slides-paths'

const NOW = '2026-07-16T00:00:00.000Z'

function doc(overrides: Partial<DesignDocument> = {}): DesignDocument {
  return {
    id: 'doc1',
    title: '设计稿',
    createdAt: NOW,
    updatedAt: NOW,
    order: 0,
    artifacts: [],
    activeArtifactId: null,
    ...overrides
  }
}

describe('designDocumentKind', () => {
  it('旧 document 缺少 kind 归一化为 board', () => {
    expect(designDocumentKind(doc())).toBe('board')
  })

  it('kind=slides 但缺 manifest 路径时降级为 board(不误入 Slides loader)', () => {
    expect(designDocumentKind(doc({ kind: 'slides' }))).toBe('board')
    expect(designDocumentKind(doc({ kind: 'slides', slidesManifestPath: '' }))).toBe('board')
  })

  it('kind=slides 且带 manifest 路径时识别为 slides', () => {
    expect(designDocumentKind(doc({ kind: 'slides', slidesManifestPath: slidesManifestPath('doc1') }))).toBe(
      'slides'
    )
  })

  it('board document 即使误带 manifest 路径仍是 board', () => {
    expect(designDocumentKind(doc({ slidesManifestPath: slidesManifestPath('doc1') }))).toBe('board')
  })
})

describe('documents.json 索引兼容', () => {
  it('slides 字段随索引序列化/解析往返保留;board 条目保持旧形状', () => {
    const docs = [
      doc(),
      doc({ id: 'doc2', kind: 'slides', slidesManifestPath: slidesManifestPath('doc2'), order: 1 })
    ]
    const raw = serializeDocumentsIndex(docs, 'doc2')
    expect(raw).toContain('slidesManifestPath')
    const parsed = parseDocumentsIndex(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.documents[0]!.kind).toBeUndefined()
    expect(parsed!.documents[1]!.kind).toBe('slides')
    expect(parsed!.documents[1]!.slidesManifestPath).toBe(slidesManifestPath('doc2'))
    // board 条目不应带出 slides 字段(与旧版索引 byte 兼容)。
    expect(JSON.stringify(parsed!.documents[0])).not.toContain('slides')
  })

  it('解析容忍脏数据:kind=slides 但缺路径时降级为 board 条目', () => {
    const raw = JSON.stringify({
      version: 1,
      activeDocumentId: 'doc1',
      documents: [{ id: 'doc1', title: 't', order: 0, createdAt: NOW, updatedAt: NOW, activeArtifactId: null, kind: 'slides' }]
    })
    const parsed = parseDocumentsIndex(raw)
    expect(parsed!.documents[0]!.kind).toBeUndefined()
  })
})

describe('deck manifest 工厂与排序', () => {
  it('createEmptySlidesDeckManifest 产出可解析的 draft manifest', () => {
    const manifest = createEmptySlidesDeckManifest({ id: 'deck1', title: 'T', now: NOW })
    expect(manifest.status).toBe('draft')
    expect(manifest.revision).toBe(0)
    expect(manifest.width).toBe(1280)
    expect(manifest.height).toBe(720)
    expect(manifest.slides).toEqual([])
  })

  it('sortedSlidesSlots 按 order 升序、同序按 id 稳定排序', () => {
    const mk = (id: string, order: number): SlidesSlot => ({
      id,
      order,
      title: id,
      htmlPath: `.cortex-design/deck1/slides/${id}.html`,
      revision: 0,
      status: 'empty',
      updatedAt: NOW
    })
    const sorted = sortedSlidesSlots([mk('slot-b', 2), mk('slot-a', 0), mk('slot-c', 1)])
    expect(sorted.map((s) => s.id)).toEqual(['slot-a', 'slot-c', 'slot-b'])
  })
})
