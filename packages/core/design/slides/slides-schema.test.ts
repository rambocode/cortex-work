// deck.json schema 合同测试:合法 manifest 通过;重复 slot id/order、非 1280×720、
// 绝对路径与 `..` 逃逸、坏 JSON 一律拒绝并给出 invalid_manifest 结构化错误。
import { describe, expect, it } from 'vitest'
import { parseSlidesManifest, serializeSlidesManifest } from './slides-schema'
import { createEmptySlidesDeckManifest, type SlidesDeckManifest, type SlidesSlot } from './slides-types'
import { slidesSlideHtmlPath, slidesSnapshotPath } from './slides-paths'

const NOW = '2026-07-16T00:00:00.000Z'

function slot(deckId: string, id: string, order: number, overrides: Partial<SlidesSlot> = {}): SlidesSlot {
  return {
    id,
    order,
    title: `第 ${order + 1} 页`,
    htmlPath: slidesSlideHtmlPath(deckId, id),
    snapshotPath: slidesSnapshotPath(deckId, id),
    revision: 0,
    status: 'ready',
    updatedAt: NOW,
    ...overrides
  }
}

function validManifest(): SlidesDeckManifest {
  const manifest = createEmptySlidesDeckManifest({ id: 'deck1234', title: '测试 deck', now: NOW })
  manifest.slides = [slot('deck1234', 'slot-001', 0), slot('deck1234', 'slot-002', 1)]
  manifest.activeSlideId = 'slot-001'
  return manifest
}

describe('parseSlidesManifest', () => {
  it('接受合法 manifest(对象与 JSON 字符串两种输入)', () => {
    const manifest = validManifest()
    expect(parseSlidesManifest(manifest).ok).toBe(true)
    const fromString = parseSlidesManifest(serializeSlidesManifest(manifest))
    expect(fromString.ok).toBe(true)
    if (fromString.ok) expect(fromString.manifest.slides).toHaveLength(2)
  })

  it('拒绝坏 JSON 字符串且不抛异常', () => {
    const result = parseSlidesManifest('{ not json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_manifest')
  })

  it('拒绝重复 slot id', () => {
    const manifest = validManifest()
    manifest.slides[1] = slot('deck1234', 'slot-001', 1)
    manifest.activeSlideId = null
    const result = parseSlidesManifest(manifest)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('duplicate slot id')
  })

  it('拒绝重复 order', () => {
    const manifest = validManifest()
    manifest.slides[1] = slot('deck1234', 'slot-002', 0)
    const result = parseSlidesManifest(manifest)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('duplicate slot order')
  })

  it('拒绝非 1280×720 画布', () => {
    const manifest = validManifest() as unknown as Record<string, unknown>
    manifest.width = 1920
    expect(parseSlidesManifest(manifest).ok).toBe(false)
  })

  it('拒绝绝对路径与 .. 逃逸与跨 deck 引用', () => {
    for (const bad of [
      '/etc/passwd',
      '.cortex-design/deck1234/../other/x.html',
      '.cortex-design/otherdeck/slides/slot-001.html',
      'C:\\slides\\slot-001.html'
    ]) {
      const manifest = validManifest()
      manifest.slides[0] = slot('deck1234', 'slot-001', 0, { htmlPath: bad })
      const result = parseSlidesManifest(manifest)
      expect(result.ok, `should reject ${bad}`).toBe(false)
    }
  })

  it('拒绝 activeSlideId 指向不存在的 slot', () => {
    const manifest = validManifest()
    manifest.activeSlideId = 'slot-999'
    expect(parseSlidesManifest(manifest).ok).toBe(false)
  })

  it('拒绝非法 slot id 形状', () => {
    const manifest = validManifest()
    manifest.slides[0] = slot('deck1234', 'slot-001', 0)
    ;(manifest.slides[0] as unknown as Record<string, unknown>).id = '../evil'
    expect(parseSlidesManifest(manifest).ok).toBe(false)
  })

  it('无动画字段的旧 manifest 仍解析成功(向后兼容)', () => {
    const manifest = validManifest()
    // 模拟存量 deck:工厂现在默认带 animationStyle,旧 deck.json 没有该字段。
    delete manifest.animationStyle
    const result = parseSlidesManifest(serializeSlidesManifest(manifest))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest.animationStyle).toBeUndefined()
      expect(result.manifest.slides[0]!.animation).toBeUndefined()
    }
  })

  it('接受合法动画注解并原样保留', () => {
    const manifest = validManifest()
    manifest.animationStyle = 'lively'
    manifest.slides[0] = slot('deck1234', 'slot-001', 0, {
      animation: {
        transition: 'page-flip',
        entrances: [{ elementId: 'el-1', preset: 'fade-up', step: 0, delayMs: 100 }]
      }
    })
    const result = parseSlidesManifest(manifest)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest.animationStyle).toBe('lively')
      expect(result.manifest.slides[0]!.animation?.transition).toBe('page-flip')
      expect(result.manifest.slides[0]!.animation?.entrances?.[0]?.preset).toBe('fade-up')
    }
  })

  it('未知动画枚举值降级为安全默认而非整体拒绝', () => {
    const manifest = validManifest() as unknown as Record<string, unknown>
    manifest.animationStyle = 'future-style'
    const slides = manifest.slides as Array<Record<string, unknown>>
    slides[0]!.animation = {
      transition: 'future-transition',
      entrances: [{ elementId: 'el-1', preset: 'future-preset', step: 0 }]
    }
    const result = parseSlidesManifest(manifest)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest.animationStyle).toBe('none')
      expect(result.manifest.slides[0]!.animation?.transition).toBe('fade')
      expect(result.manifest.slides[0]!.animation?.entrances?.[0]?.preset).toBe('fade-in')
    }
  })

  it('病态 duration/delay 夹取上限而非报错', () => {
    const manifest = validManifest()
    manifest.slides[0] = slot('deck1234', 'slot-001', 0, {
      animation: {
        entrances: [{ elementId: 'el-1', preset: 'fade-in', step: 0, delayMs: 999_999, durationMs: 60_000 }]
      }
    })
    const result = parseSlidesManifest(manifest)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const entrance = result.manifest.slides[0]!.animation?.entrances?.[0]
      expect(entrance?.delayMs).toBe(10_000)
      expect(entrance?.durationMs).toBe(5_000)
    }
  })

  it('拒绝重复 outline item id', () => {
    const manifest = validManifest()
    manifest.outline = {
      version: 1,
      summary: '概要',
      items: [
        { id: 'o1', title: '开场', purpose: 'hook', keyPoints: [] },
        { id: 'o1', title: '结尾', purpose: 'cta', keyPoints: [] }
      ]
    }
    expect(parseSlidesManifest(manifest).ok).toBe(false)
  })
})
