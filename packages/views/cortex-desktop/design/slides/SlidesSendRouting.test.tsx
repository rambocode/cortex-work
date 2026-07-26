// 回归:slides 设计稿的右栏发送必须走 slides 合同回合,绝不能进 design 的 prompt 路由
// —— 那条路会过 multi-page 闸门,跑出「起草设计规格 / 生成设计系统与设计令牌 /
// 设计品牌 Logo / Design N pages in parallel」,产物落自由画布、与 deck 无关(用户实测)。
import { describe, expect, it } from 'vitest'
import { routeDesignComposerSend } from '../DesignWorkspace'

describe('routeDesignComposerSend', () => {
  it('slides:走 slides 合同回合(带 trim 后的原话)', () => {
    expect(routeDesignComposerSend({ input: '  做个季度汇报  ', slidesMode: true })).toEqual({
      kind: 'slides-turn',
      text: '做个季度汇报'
    })
  })

  it('board:仍走原 design prompt 路由(不回归)', () => {
    expect(routeDesignComposerSend({ input: '做个落地页', slidesMode: false })).toEqual({ kind: 'design-prompt' })
  })

  it('空输入两种模式都不发', () => {
    expect(routeDesignComposerSend({ input: '   ', slidesMode: true })).toEqual({ kind: 'ignore' })
    expect(routeDesignComposerSend({ input: '', slidesMode: false })).toEqual({ kind: 'ignore' })
  })

  // 只贴一张截图不打字也应发得出去(「照这个改」的常见用法);文本仍为空串透传。
  it('只有图片没有文字时照发', () => {
    expect(routeDesignComposerSend({ input: '', slidesMode: true, hasImages: true })).toEqual({
      kind: 'slides-turn',
      text: ''
    })
    expect(routeDesignComposerSend({ input: '  ', slidesMode: false, hasImages: true })).toEqual({
      kind: 'design-prompt'
    })
  })

  it('只有文本附件没有文字时照发', () => {
    expect(routeDesignComposerSend({ input: '', slidesMode: true, hasTextFiles: true })).toEqual({
      kind: 'slides-turn',
      text: ''
    })
    expect(routeDesignComposerSend({ input: '', slidesMode: false, hasTextFiles: true })).toEqual({
      kind: 'design-prompt'
    })
  })

  it('文字、图片、文件三者都空时不发', () => {
    expect(routeDesignComposerSend({
      input: '  ',
      slidesMode: true,
      hasImages: false,
      hasTextFiles: false
    })).toEqual({ kind: 'ignore' })
  })
})
