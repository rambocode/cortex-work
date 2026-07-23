// @vitest-environment jsdom
// collectSlideEntranceDescriptors 测试:整页根容器自动下钻到子内容元素、多顶层不下钻、
// display:none 不可测时的唯一根仍下钻并保留文档序。jsdom 无布局引擎,rect 需手动 stub。
import { describe, expect, it } from 'vitest'
import { collectSlideEntranceDescriptors } from './slides-heuristics'

const W = 1280
const H = 720

/** 给元素 stub 一个固定 rect(jsdom getBoundingClientRect 恒为 0)。 */
function stubRect(el: Element, rect: { top: number; left: number; width: number; height: number }): void {
  ;(el as HTMLElement).getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect
}

function build(html: string): Document {
  const doc = document.implementation.createHTMLDocument('t')
  doc.body.innerHTML = html
  return doc
}

describe('collectSlideEntranceDescriptors', () => {
  it('整页根容器(≥80% 画布)下钻到直接标注子元素', () => {
    const doc = build(`
      <div data-cortex-id="root">
        <h1 data-cortex-id="title"><em data-cortex-id="em1">x</em></h1>
        <p data-cortex-id="p1">a</p>
        <p data-cortex-id="p2">b</p>
      </div>`)
    stubRect(doc.querySelector('[data-cortex-id="root"]')!, { top: 0, left: 0, width: W, height: H })
    stubRect(doc.querySelector('[data-cortex-id="title"]')!, { top: 60, left: 80, width: 800, height: 90 })
    stubRect(doc.querySelector('[data-cortex-id="p1"]')!, { top: 200, left: 80, width: 600, height: 40 })
    stubRect(doc.querySelector('[data-cortex-id="p2"]')!, { top: 260, left: 80, width: 600, height: 40 })
    const out = collectSlideEntranceDescriptors(doc, W, H)
    // root 被子元素替代;em1 嵌在 title 内不单独出现。
    expect(out.map((d) => d.elementId).sort()).toEqual(['p1', 'p2', 'title'])
  })

  it('多个内容级顶层元素不下钻,原样返回', () => {
    const doc = build(`
      <h1 data-cortex-id="title">t</h1>
      <div data-cortex-id="card"><span data-cortex-id="chip">c</span><span data-cortex-id="chip2">d</span></div>`)
    stubRect(doc.querySelector('[data-cortex-id="title"]')!, { top: 60, left: 80, width: 800, height: 90 })
    stubRect(doc.querySelector('[data-cortex-id="card"]')!, { top: 300, left: 80, width: 400, height: 200 })
    const out = collectSlideEntranceDescriptors(doc, W, H)
    // card 面积远小于画布 80%,即便有 2 个标注子元素也不下钻(整卡一起入场)。
    expect(out.map((d) => d.elementId).sort()).toEqual(['card', 'title'])
  })

  it('布局不可测(rect 全 0)时唯一根仍下钻,并按文档序保留全部子元素', () => {
    const doc = build(`
      <div data-cortex-id="root">
        <span data-cortex-id="kicker">k</span>
        <h1 data-cortex-id="title">t</h1>
        <p data-cortex-id="desc">d</p>
      </div>`)
    // 不 stub:jsdom 所有 rect 均为 0,模拟 display:none 的非激活页。
    const out = collectSlideEntranceDescriptors(doc, W, H)
    expect(out.map((d) => d.elementId)).toEqual(['kicker', 'title', 'desc'])
  })

  it('无标注元素返回空;图表容器带 isChart 标记', () => {
    expect(collectSlideEntranceDescriptors(build('<p>x</p>'), W, H)).toEqual([])
    const doc = build('<div data-cortex-id="chart"><svg></svg></div><p data-cortex-id="p">x</p>')
    stubRect(doc.querySelector('[data-cortex-id="chart"]')!, { top: 100, left: 0, width: 400, height: 300 })
    stubRect(doc.querySelector('[data-cortex-id="p"]')!, { top: 500, left: 0, width: 400, height: 40 })
    const out = collectSlideEntranceDescriptors(doc, W, H)
    expect(out.find((d) => d.elementId === 'chart')?.isChart).toBe(true)
    expect(out.find((d) => d.elementId === 'p')?.isChart).toBe(false)
  })

  it('函数自包含:toString 注入到干净作用域仍可执行(三端共用契约)', () => {
    // 安全性:拼接的是本模块自身函数源码(编译期可信),无外部输入。
    const factory = new Function(`return (${collectSlideEntranceDescriptors.toString()});`)
    const rebuilt = factory() as typeof collectSlideEntranceDescriptors
    const doc = build('<div data-cortex-id="root"><p data-cortex-id="a">1</p><p data-cortex-id="b">2</p></div>')
    expect(rebuilt(doc, W, H).map((d) => d.elementId)).toEqual(['a', 'b'])
  })
})
