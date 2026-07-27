// @vitest-environment jsdom
// CORTEX-PATCH: 属性栏在中文标签与动态属性切换时保持稳定布局。
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

beforeAll(() => {
  const style = document.createElement('style')
  style.textContent = readFileSync(resolve(process.cwd(), 'vendor/bento/src/styles.css'), 'utf8')
  document.head.appendChild(style)
})

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('右侧属性栏布局', () => {
  it('普通属性行保持单行，标签截断而不是把控件挤到下一行', () => {
    const props = document.createElement('aside')
    props.className = 'ed-props'
    props.innerHTML = `
      <label class="ed-row">
        <span>垂直对齐</span>
        <select><option>上</option></select>
      </label>
    `
    document.body.appendChild(props)

    const row = props.querySelector<HTMLElement>('.ed-row')!
    const label = row.querySelector<HTMLElement>('span')!
    expect(getComputedStyle(row).flexWrap).toBe('nowrap')
    expect(getComputedStyle(row).minHeight).toBe('28px')
    expect(getComputedStyle(label).whiteSpace).toBe('nowrap')
    expect(getComputedStyle(label).textOverflow).toBe('ellipsis')
  })

  it('位置网格使用共享标签轨道，长标签不再与输入框争抢同一个 flex 单元', () => {
    const props = document.createElement('aside')
    props.className = 'ed-props'
    props.innerHTML = `
      <div class="ed-grid2">
        <label class="ed-mini"><span>角度</span><input type="number"></label>
        <label class="ed-mini"><span>不透明度</span><input type="number"></label>
      </div>
    `
    document.body.appendChild(props)

    const grid = props.querySelector<HTMLElement>('.ed-grid2')!
    const mini = props.querySelector<HTMLElement>('.ed-mini')!
    const label = mini.querySelector<HTMLElement>('span')!
    expect(getComputedStyle(grid).gridTemplateColumns).toBe(
      'max-content minmax(0, 1fr) max-content minmax(0, 1fr)',
    )
    expect(getComputedStyle(mini).display).toBe('contents')
    expect(getComputedStyle(label).whiteSpace).toBe('nowrap')
  })
})
