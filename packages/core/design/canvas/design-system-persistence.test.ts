import { afterEach, describe, expect, it, vi } from 'vitest'
import { setKunGuiPort, type KunGuiPort } from '../compat/kun-gui-port'
import {
  designSystemPath,
  parseDesignSystem,
  persistDesignSystem,
  serializeDesignSystem
} from './design-system-persistence'
import { createEmptyDesignSystem, type DesignSystem } from './design-system-types'

describe('design-system-persistence', () => {
  it('puts design-system.json at the doc dir (baseDir)', () => {
    expect(designSystemPath('.cortex-design/doc_123')).toBe('.cortex-design/doc_123/design-system.json')
  })

  it('round-trips a design system through serialize/parse', () => {
    const system: DesignSystem = {
      tokens: {
        'brand/primary': { name: 'brand/primary', kind: 'color', value: '#3b82d8' },
        'space/md': { name: 'space/md', kind: 'space', value: 16 }
      },
      components: {}
    }
    const parsed = parseDesignSystem(serializeDesignSystem(system))
    expect(parsed).toEqual(system)
  })

  it('returns null on garbage and an empty system on a bare object', () => {
    expect(parseDesignSystem('not json {')).toBeNull()
    expect(parseDesignSystem('{}')).toEqual(createEmptyDesignSystem())
  })

  // 实测事故:agent(pi 跑 design skill)自己造了一份 design-system.json,结构是它自己的
  // 分类法 { tokens: { colors: {...}, typography: {...} } }。旧实现原样 cast,
  // 下游 summarizeDesignSystemForGraph 对无 name 的条目调 localeCompare 抛错 → 整窗白屏。
  it('丢弃形状不符的 token/component(agent 自造结构不再炸下游)', () => {
    const raw = JSON.stringify({
      tokens: {
        colors: { 'bg-primary': '#0B0E17', 'accent-primary': '#00D4FF' },
        typography: { display: { fontFamily: 'Inter', fontWeight: 800 } },
        'brand/primary': { name: 'brand/primary', kind: 'color', value: '#3b82d8' }
      },
      components: { card: { name: '卡片' }, hero: 'nope' }
    })
    const parsed = parseDesignSystem(raw)
    expect(parsed).toEqual({
      tokens: { 'brand/primary': { name: 'brand/primary', kind: 'color', value: '#3b82d8' } },
      components: {}
    })
  })

  it('token 只是漏了 name 时用键名补齐(能救回的就别丢)', () => {
    const parsed = parseDesignSystem(
      JSON.stringify({ tokens: { 'space/md': { kind: 'space', value: 16 } } })
    )
    expect(parsed?.tokens['space/md']).toEqual({ name: 'space/md', kind: 'space', value: 16 })
  })

  it('component 漏 id/version 时按键名与 v1 补齐,tree/slots 缺失则丢弃', () => {
    const parsed = parseDesignSystem(
      JSON.stringify({
        components: {
          card: { name: '卡片', tree: [{ id: 'root' }], slots: [] },
          broken: { name: '坏的' }
        }
      })
    )
    expect(parsed?.components.card).toMatchObject({ id: 'card', name: '卡片', version: 1 })
    expect(parsed?.components.broken).toBeUndefined()
  })

  describe('debounced save', () => {
    afterEach(() => {
      vi.useRealTimers()
      vi.unstubAllGlobals()
      setKunGuiPort(null)
    })

    it('does not let one design-system file cancel another design-system save', () => {
      vi.useFakeTimers()
      const writeWorkspaceFile = vi.fn(async () => ({ ok: true as const }))
      setKunGuiPort({ writeWorkspaceFile } as unknown as KunGuiPort)
      const designSystem: DesignSystem = {
        tokens: {
          'brand/primary': { name: 'brand/primary', kind: 'color', value: '#3b82d8' }
        },
        components: {}
      }
      const codeSystem: DesignSystem = {
        tokens: {
          'brand/primary': { name: 'brand/primary', kind: 'color', value: '#14b8a6' }
        },
        components: {}
      }

      persistDesignSystem('/workspace', designSystem, '.cortex-design/doc-1')
      persistDesignSystem('/workspace', codeSystem, '.kun-canvas/code-thread-1')
      vi.advanceTimersByTime(600)

      expect(writeWorkspaceFile).toHaveBeenCalledTimes(2)
      expect(writeWorkspaceFile).toHaveBeenCalledWith({
        path: designSystemPath('.cortex-design/doc-1'),
        workspaceRoot: '/workspace',
        content: serializeDesignSystem(designSystem)
      })
      expect(writeWorkspaceFile).toHaveBeenCalledWith({
        path: designSystemPath('.kun-canvas/code-thread-1'),
        workspaceRoot: '/workspace',
        content: serializeDesignSystem(codeSystem)
      })
    })

    it('keeps debouncing repeated saves for the same design-system file', () => {
      vi.useFakeTimers()
      const writeWorkspaceFile = vi.fn(async () => ({ ok: true as const }))
      setKunGuiPort({ writeWorkspaceFile } as unknown as KunGuiPort)
      const firstSystem = createEmptyDesignSystem()
      const latestSystem: DesignSystem = {
        tokens: {
          'brand/primary': { name: 'brand/primary', kind: 'color', value: '#14b8a6' }
        },
        components: {}
      }

      persistDesignSystem('/workspace', firstSystem, '.kun-canvas/code-thread-1')
      persistDesignSystem('/workspace', latestSystem, '.kun-canvas/code-thread-1')
      vi.advanceTimersByTime(600)

      expect(writeWorkspaceFile).toHaveBeenCalledTimes(1)
      expect(writeWorkspaceFile).toHaveBeenCalledWith({
        path: designSystemPath('.kun-canvas/code-thread-1'),
        workspaceRoot: '/workspace',
        content: serializeDesignSystem(latestSystem)
      })
    })
  })
})
