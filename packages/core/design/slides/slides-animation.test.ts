// 动画预设库完整性合同测试:每个枚举都有条目、初态必含 opacity:0、3D 转场
// 必有降级映射且降级目标是 2D——防止加枚举时漏配导致运行时查表 undefined。
import { describe, expect, it } from 'vitest'
import {
  ENTRANCE_HIDDEN_CLASS,
  ENTRANCE_PRESETS,
  STAGGER_DEFAULT_MS,
  STYLE_DEFAULT_TRANSITION,
  STYLE_DURATION_SCALE,
  TRANSITIONS,
  TRANSITION_FALLBACK,
  buildEntranceStylesheet,
  buildTransitionStylesheet,
  entranceStepCount
} from './slides-animation'
import type {
  SlidesAnimationStyle,
  SlidesEntrancePreset,
  SlidesTransition
} from './slides-types'

const ALL_PRESETS: SlidesEntrancePreset[] = [
  'fade-in',
  'fade-up',
  'slide-in-left',
  'slide-in-right',
  'zoom-in',
  'reveal-clip'
]
const ALL_TRANSITIONS: SlidesTransition[] = [
  'none',
  'fade',
  'push-horizontal',
  'push-vertical',
  'zoom',
  'page-flip',
  'cube-rotate'
]
const ALL_STYLES: SlidesAnimationStyle[] = ['none', 'subtle', 'lively']

describe('动画预设库完整性', () => {
  it('每个入场 preset 都有条目,duration>0 且初态含 opacity: 0', () => {
    for (const preset of ALL_PRESETS) {
      const spec = ENTRANCE_PRESETS[preset]
      expect(spec, preset).toBeDefined()
      expect(spec.defaultDurationMs).toBeGreaterThan(0)
      expect(spec.initial).toContain('opacity: 0')
      expect(spec.keyframes.length).toBeGreaterThan(0)
    }
  })

  it('每个转场都有条目,3D 项 needsPerspective=true 且降级目标为 2D', () => {
    for (const id of ALL_TRANSITIONS) {
      const spec = TRANSITIONS[id]
      expect(spec, id).toBeDefined()
      if (spec.kind === '3d') expect(spec.needsPerspective).toBe(true)
      const fallback = TRANSITION_FALLBACK[id]
      expect(fallback, id).toBeDefined()
      expect(TRANSITIONS[fallback].kind).toBe('2d')
    }
  })

  it('每个风格都有 stagger/缩放/默认转场配置', () => {
    for (const style of ALL_STYLES) {
      expect(STAGGER_DEFAULT_MS[style]).toBeGreaterThanOrEqual(0)
      expect(STYLE_DURATION_SCALE[style]).toBeGreaterThanOrEqual(0)
      expect(TRANSITIONS[STYLE_DEFAULT_TRANSITION[style]]).toBeDefined()
    }
    expect(STYLE_DEFAULT_TRANSITION.none).toBe('none')
  })
})

describe('buildEntranceStylesheet', () => {
  it('style=none 返回空(不注入任何入场样式)', () => {
    expect(buildEntranceStylesheet('none')).toBe('')
  })

  it('包含每个 preset 的 keyframes、enter class 与隐藏兜底', () => {
    const css = buildEntranceStylesheet('lively')
    for (const preset of ALL_PRESETS) {
      expect(css).toContain(`@keyframes cortex-anim-${preset}`)
      expect(css).toContain(`.cortex-anim-enter-${preset}`)
    }
    expect(css).toContain(`.${ENTRANCE_HIDDEN_CLASS} { opacity: 0 !important; }`)
  })
})

describe('entranceStepCount', () => {
  it('无注解/空 entrances 为 1;显式注解取 max(step)+1', () => {
    expect(entranceStepCount(undefined)).toBe(1)
    expect(entranceStepCount({})).toBe(1)
    expect(entranceStepCount({ entrances: [] })).toBe(1)
    expect(
      entranceStepCount({
        entrances: [
          { elementId: 'a', preset: 'fade-in', step: 0 },
          { elementId: 'b', preset: 'fade-up', step: 2 }
        ]
      })
    ).toBe(3)
  })
})

describe('打印保护', () => {
  it('入场样式表含 @media print 全可见重置', () => {
    const css = buildEntranceStylesheet('subtle')
    expect(css).toContain('@media print')
    expect(css).toMatch(/@media print[^}]*opacity: 1 !important/)
  })
})

describe('buildTransitionStylesheet', () => {
  it('包含每个非 none 转场的 out/in/prep class', () => {
    const css = buildTransitionStylesheet()
    for (const id of ALL_TRANSITIONS) {
      if (id === 'none') continue
      expect(css).toContain(`.cortex-trans-out-${id}`)
      expect(css).toContain(`.cortex-trans-in-${id}`)
      expect(css).toContain(`.cortex-trans-prep-${id}`)
    }
    expect(css).toContain('perspective')
  })
})
