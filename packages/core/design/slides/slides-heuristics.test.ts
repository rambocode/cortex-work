// 默认入场编排启发式测试:role 推断表、title→body→chart 顺序、同 role 按
// top→left、stagger 递增、style=none 返回空;并校验函数自包含(可 toString 注入)。
import { describe, expect, it } from 'vitest'
import {
  inferElementRole,
  planDefaultEntrances,
  type SlideElementDescriptor
} from './slides-heuristics'

const W = 1280
const H = 720

function el(overrides: Partial<SlideElementDescriptor> & { elementId: string }): SlideElementDescriptor {
  return { tag: 'div', top: 400, left: 100, area: 5000, ...overrides }
}

describe('inferElementRole', () => {
  it('h1/h2 一律 title;图表标记优先于标签', () => {
    expect(inferElementRole({ tag: 'h1', top: 600, area: 100 }, W, H)).toBe('title')
    expect(inferElementRole({ tag: 'h2', top: 600, area: 100 }, W, H)).toBe('title')
    expect(inferElementRole({ tag: 'h1', top: 0, area: 100, isChart: true }, W, H)).toBe('chart')
  })

  it('img/video → image;canvas 类图表容器靠 isChart 标记', () => {
    expect(inferElementRole({ tag: 'img', top: 0, area: 100 }, W, H)).toBe('image')
    expect(inferElementRole({ tag: 'video', top: 0, area: 100 }, W, H)).toBe('image')
    expect(inferElementRole({ tag: 'div', top: 0, area: 100, isChart: true }, W, H)).toBe('chart')
  })

  it('顶部 1/3 的大块元素视为 title,小块/下方是 body', () => {
    const bigArea = W * H * 0.05
    expect(inferElementRole({ tag: 'div', top: 100, area: bigArea }, W, H)).toBe('title')
    expect(inferElementRole({ tag: 'div', top: 500, area: bigArea }, W, H)).toBe('body')
    expect(inferElementRole({ tag: 'div', top: 100, area: 100 }, W, H)).toBe('body')
  })
})

describe('planDefaultEntrances', () => {
  it('style=none 返回空数组', () => {
    expect(planDefaultEntrances([el({ elementId: 'a' })], 'none', W, H)).toEqual([])
  })

  it('顺序:标题先、正文按 top→left、图表/图片最后;全部 step 0', () => {
    const plan = planDefaultEntrances(
      [
        el({ elementId: 'chart', isChart: true, top: 300 }),
        el({ elementId: 'body-low', top: 500 }),
        el({ elementId: 'title', tag: 'h1', top: 60 }),
        el({ elementId: 'body-high-right', top: 200, left: 700 }),
        el({ elementId: 'body-high-left', top: 200, left: 80 })
      ],
      'subtle',
      W,
      H
    )
    expect(plan.map((p) => p.elementId)).toEqual([
      'title',
      'body-high-left',
      'body-high-right',
      'body-low',
      'chart'
    ])
    expect(plan.every((p) => p.step === 0)).toBe(true)
  })

  it('delayMs 按序递增错峰,lively 间隔大于 subtle', () => {
    const els = [el({ elementId: 'a', top: 100 }), el({ elementId: 'b', top: 200 })]
    const subtle = planDefaultEntrances(els, 'subtle', W, H)
    const lively = planDefaultEntrances(els, 'lively', W, H)
    expect(subtle[0]!.delayMs).toBe(0)
    expect(subtle[1]!.delayMs!).toBeGreaterThan(0)
    expect(lively[1]!.delayMs!).toBeGreaterThan(subtle[1]!.delayMs!)
  })

  it('lively 风格按 role 混搭 preset,subtle 只用淡入系', () => {
    const plan = planDefaultEntrances(
      [
        el({ elementId: 'title', tag: 'h1', top: 60 }),
        el({ elementId: 'body', top: 400 }),
        el({ elementId: 'chart', isChart: true, top: 500 })
      ],
      'lively',
      W,
      H
    )
    const byId = Object.fromEntries(plan.map((p) => [p.elementId, p.preset]))
    expect(byId.title).toBe('reveal-clip')
    expect(byId.chart).toBe('zoom-in')
    expect(byId.body).toBe('fade-up')
    const subtlePlan = planDefaultEntrances([el({ elementId: 'body', top: 400 })], 'subtle', W, H)
    expect(subtlePlan[0]!.preset).toBe('fade-up')
  })

  it('函数自包含:toString 注入后在无模块作用域下仍可执行', () => {
    // presenter 运行时靠 .toString() 注入浏览器,函数体不得引用模块级符号。
    // 用 new Function 在干净作用域重建两个函数并调用,引用泄漏会直接 ReferenceError。
    // 安全性:拼接的字符串是本模块自身函数的源码(编译期可信),无任何外部输入。
    // 与 presenter 注入形态一致:inferRole 经参数显式传入(不靠模块作用域解析)。
    const factory = new Function(
      `return (${planDefaultEntrances.toString()});`
    )
    const rebuilt = factory() as typeof planDefaultEntrances
    const roleFactory = new Function(`return (${inferElementRole.toString()});`)
    const plan = rebuilt(
      [
        { elementId: 't', tag: 'h1', top: 10, left: 0, area: 100 },
        { elementId: 'b', tag: 'p', top: 400, left: 0, area: 100 }
      ],
      'lively',
      W,
      H,
      roleFactory() as typeof inferElementRole
    )
    expect(plan.map((p) => p.elementId)).toEqual(['t', 'b'])
  })
})
