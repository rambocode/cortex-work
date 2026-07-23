// DesignDocument kind 归一化 + documents.json 索引兼容测试:旧数据(无 kind)一律
// 按 board 处理;slides 标记只有在 kind 与 manifest 路径同时合法时才存活。
import { describe, expect, it } from 'vitest'
import { designDocumentKind } from '../design-types'
import { parseDocumentsIndex, serializeDocumentsIndex } from '../design-document-persistence'
import type { DesignDocument } from '../design-types'
import {
  createEmptySlidesDeckManifest,
  resolveDeckAnimationStyle,
  slotHasExplicitEntrances,
  sortedSlidesSlots,
  type SlidesSlot
} from './slides-types'
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

describe('computeSlidesDeckStatus 状态机', () => {
  const mkSlot = (id: string, status: SlidesSlot['status']): SlidesSlot => ({
    id,
    order: 0,
    title: id,
    htmlPath: `.cortex-design/d/slides/${id}.html`,
    revision: 0,
    status,
    updatedAt: NOW
  })

  it('提纲前状态不被推导覆盖', async () => {
    const { computeSlidesDeckStatus } = await import('./slides-types')
    expect(computeSlidesDeckStatus([mkSlot('slot-001', 'ready')], 'draft')).toBe('draft')
    expect(computeSlidesDeckStatus([mkSlot('slot-001', 'ready')], 'outline-proposed')).toBe('outline-proposed')
  })

  it('批准后按 slot 状态推进:approved → generating → ready / error', async () => {
    const { computeSlidesDeckStatus } = await import('./slides-types')
    // 全空:仍是 outline-approved(等待生成)。
    expect(
      computeSlidesDeckStatus([mkSlot('slot-001', 'empty'), mkSlot('slot-002', 'empty')], 'outline-approved')
    ).toBe('outline-approved')
    // 部分完成:generating。
    expect(
      computeSlidesDeckStatus([mkSlot('slot-001', 'ready'), mkSlot('slot-002', 'empty')], 'outline-approved')
    ).toBe('generating')
    expect(
      computeSlidesDeckStatus([mkSlot('slot-001', 'generating'), mkSlot('slot-002', 'ready')], 'generating')
    ).toBe('generating')
    // 全部就绪:ready。
    expect(
      computeSlidesDeckStatus([mkSlot('slot-001', 'ready'), mkSlot('slot-002', 'ready')], 'generating')
    ).toBe('ready')
    // 完成但有失败页:error(单页失败不回滚其他页面)。
    expect(
      computeSlidesDeckStatus([mkSlot('slot-001', 'ready'), mkSlot('slot-002', 'error')], 'generating')
    ).toBe('error')
  })
})

describe('slides runId 前缀', () => {
  it('isDesignRunId 同时认 design: 与 slides: 前缀(共用设计 run 管线)', async () => {
    const { isDesignRunId, SLIDES_RUN_PREFIX } = await import('../run/design-run-manager')
    expect(SLIDES_RUN_PREFIX).toBe('slides:')
    expect(isDesignRunId('design:doc1:r1')).toBe(true)
    expect(isDesignRunId('slides:doc1:r1')).toBe(true)
    expect(isDesignRunId('writing:doc1:r1')).toBe(false)
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
    // 新 deck 开箱带「稳重」动画风格(存量 deck 无此字段仍按 none)。
    expect(manifest.animationStyle).toBe('subtle')
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

describe('动画 helper', () => {
  it('resolveDeckAnimationStyle 缺省为 none', () => {
    expect(resolveDeckAnimationStyle({})).toBe('none')
    expect(resolveDeckAnimationStyle({ animationStyle: 'lively' })).toBe('lively')
  })

  it('slotHasExplicitEntrances 只在有非空 entrances 时为 true', () => {
    expect(slotHasExplicitEntrances({})).toBe(false)
    expect(slotHasExplicitEntrances({ animation: {} })).toBe(false)
    expect(slotHasExplicitEntrances({ animation: { entrances: [] } })).toBe(false)
    expect(
      slotHasExplicitEntrances({
        animation: { entrances: [{ elementId: 'e', preset: 'fade-in', step: 0 }] }
      })
    ).toBe(true)
  })
})
