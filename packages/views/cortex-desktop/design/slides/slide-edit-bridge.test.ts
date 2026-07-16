// 编辑 bridge 协议测试:消息校验(恶意/伪造/超大一律丢弃)、命令编译白名单、
// 注入脚本幂等,以及在 jsdom 中直接跑页内脚本验证选择/编辑/删除/flush 行为。
//
// 测试宿主说明:下方用 `new Function(buildSlideEditBridgeSource())` 在 jsdom 里执行
// 页内脚本、用 innerHTML 灌入字面量 fixture —— 这是「在测试进程里模拟 webview guest」
// 的手段,执行的是本仓库自己 builder 产出的源码(配置经 JSON.stringify 注入,无外部
// 输入),与生产路径无关;生产侧脚本经 webview.executeJavaScript 注入到沙箱 guest。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_DRAIN_INTERVAL_MS,
  buildSlideEditBridgeSource,
  compileSlideBridgeCommand,
  DRAIN_SLIDE_BRIDGE_SOURCE,
  EDIT_SAVE_DEBOUNCE_MS,
  MAX_EDITED_HTML_BYTES,
  parseSlideBridgeDrain,
  parseSlideBridgeMessage,
  SLIDE_BRIDGE_PROTOCOL
} from './slide-edit-bridge'

describe('parseSlideBridgeMessage', () => {
  it('接受协议内的合法消息', () => {
    expect(parseSlideBridgeMessage({ __cortexSlides: 1, type: 'ready' })).toEqual({
      __cortexSlides: 1,
      type: 'ready'
    })
    expect(
      parseSlideBridgeMessage({
        __cortexSlides: 1,
        type: 'selected',
        elementId: 'title',
        tagName: 'H1',
        rect: { x: 1, y: 2, w: 3, h: 4 }
      })
    ).toMatchObject({ type: 'selected', elementId: 'title' })
    expect(parseSlideBridgeMessage({ __cortexSlides: 1, type: 'html-changed', html: '<html></html>' })).toMatchObject({
      type: 'html-changed'
    })
  })

  it('丢弃缺协议标记 / 版本不符的消息(恶意 postMessage)', () => {
    expect(parseSlideBridgeMessage({ type: 'html-changed', html: '<html>evil</html>' })).toBeNull()
    expect(parseSlideBridgeMessage({ __cortexSlides: 2, type: 'ready' })).toBeNull()
    expect(parseSlideBridgeMessage({ __cortexSlides: '1', type: 'ready' })).toBeNull()
  })

  it('丢弃未知 type(绝不按 method name 派发)', () => {
    expect(parseSlideBridgeMessage({ __cortexSlides: 1, type: 'eval' })).toBeNull()
    expect(parseSlideBridgeMessage({ __cortexSlides: 1, type: 'require', args: ['fs'] })).toBeNull()
    expect(parseSlideBridgeMessage({ __cortexSlides: 1, type: '__proto__' })).toBeNull()
  })

  it('丢弃字段类型错误的消息', () => {
    expect(parseSlideBridgeMessage({ __cortexSlides: 1, type: 'selected', elementId: 42 })).toBeNull()
    expect(
      parseSlideBridgeMessage({ __cortexSlides: 1, type: 'selected', elementId: 'a', tagName: 'H1', rect: { x: 'x' } })
    ).toBeNull()
    expect(parseSlideBridgeMessage({ __cortexSlides: 1, type: 'html-changed', html: '' })).toBeNull()
    expect(parseSlideBridgeMessage({ __cortexSlides: 1, type: 'html-changed', html: 123 })).toBeNull()
  })

  it('丢弃超大 HTML(不得撑爆 IPC/磁盘)', () => {
    const huge = 'x'.repeat(MAX_EDITED_HTML_BYTES + 1)
    expect(parseSlideBridgeMessage({ __cortexSlides: 1, type: 'html-changed', html: huge })).toBeNull()
  })

  it('非对象输入安全返回 null', () => {
    for (const bad of [null, undefined, 'str', 42, []]) {
      expect(parseSlideBridgeMessage(bad)).toBeNull()
    }
  })
})

describe('parseSlideBridgeDrain', () => {
  it('逐条过滤:保留合法项,丢弃伪造项', () => {
    const drained = parseSlideBridgeDrain([
      { __cortexSlides: 1, type: 'ready' },
      { type: 'html-changed', html: '<html>forged</html>' },
      { __cortexSlides: 1, type: 'html-changed', html: '<html>ok</html>' },
      'garbage'
    ])
    expect(drained.map((m) => m.type)).toEqual(['ready', 'html-changed'])
  })

  it('非数组返回空', () => {
    expect(parseSlideBridgeDrain(null)).toEqual([])
    expect(parseSlideBridgeDrain({ length: 1 })).toEqual([])
  })
})

describe('compileSlideBridgeCommand', () => {
  it('编译为受控的 exec 调用(命令 JSON 化,不拼接裸代码)', () => {
    expect(compileSlideBridgeCommand({ type: 'format', command: 'bold' })).toBe(
      'window.__cortexSlidesBridge && window.__cortexSlidesBridge.exec({"type":"format","command":"bold"})'
    )
    // 含引号的取值被 JSON 转义:注入串只能作为 hex 字段的值存在,逃不出 JSON 字符串。
    const code = compileSlideBridgeCommand({ type: 'color', hex: '#fff"; alert(1); //' })
    expect(code).toContain('\\"; alert(1); //')
    expect(code).not.toContain('"#fff"; alert(1)')
    // 且页内 exec 会因正则校验拒绝该颜色(见下方 jsdom 用例)。
  })
})

describe('buildSlideEditBridgeSource', () => {
  it('注入源码带幂等守卫与协议常量', () => {
    const src = buildSlideEditBridgeSource()
    expect(src).toContain('if (window.__cortexSlidesBridge) return')
    expect(src).toContain(`"protocol":${SLIDE_BRIDGE_PROTOCOL}`)
    expect(src).toContain(`"debounceMs":${EDIT_SAVE_DEBOUNCE_MS}`)
    expect(src).toContain('"H1"')
  })

  it('drain 表达式在未挂载 bridge 时返回空数组', () => {
    expect(DRAIN_SLIDE_BRIDGE_SOURCE).toContain('window.__cortexSlidesBridge ?')
    expect(BRIDGE_DRAIN_INTERVAL_MS).toBeLessThan(EDIT_SAVE_DEBOUNCE_MS)
  })
})

// 页内脚本在 jsdom 中直跑:验证选择/编辑/debounce 保存/删除/flush 的真实行为。
describe('页内 bridge 行为(jsdom)', () => {
  type PageBridge = { drain: () => unknown[]; exec: (command: unknown) => void }

  function mountPage(html: string): PageBridge {
    document.documentElement.innerHTML = html
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function(buildSlideEditBridgeSource())()
    return (window as unknown as { __cortexSlidesBridge: PageBridge }).__cortexSlidesBridge
  }

  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).__cortexSlidesBridge
    vi.useFakeTimers()
  })

  const PAGE = `<head></head><body>
    <h1 data-cortex-id="title">标题</h1>
    <p data-cortex-id="body">正文</p>
    <div data-cortex-id="box"><span>无 id 的内容</span></div>
  </body>`

  it('挂载即发 ready;drain 后队列清空', () => {
    const bridge = mountPage(PAGE)
    const first = parseSlideBridgeDrain(bridge.drain())
    expect(first.map((m) => m.type)).toEqual(['ready'])
    expect(bridge.drain()).toEqual([])
  })

  it('点击带 data-cortex-id 的白名单元素 → selected;点击非法目标 → deselected', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    document.querySelector('h1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const selected = parseSlideBridgeDrain(bridge.drain())
    expect(selected[0]).toMatchObject({ type: 'selected', elementId: 'title', tagName: 'H1' })
    expect(document.querySelector('h1')!.getAttribute('data-cortex-selected')).toBe('1')

    // DIV 不在白名单 → 无可编辑祖先 → deselected。
    document.querySelector('div')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(parseSlideBridgeDrain(bridge.drain())[0]).toMatchObject({ type: 'deselected' })
  })

  it('双击进入 contenteditable;输入后 500ms debounce 才产出整页 HTML', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    const h1 = document.querySelector('h1')!
    h1.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(h1.getAttribute('contenteditable')).toBe('true')

    h1.textContent = '新标题'
    h1.dispatchEvent(new Event('input', { bubbles: true }))
    // debounce 未到:无 html-changed。
    vi.advanceTimersByTime(EDIT_SAVE_DEBOUNCE_MS - 50)
    expect(parseSlideBridgeDrain(bridge.drain()).some((m) => m.type === 'html-changed')).toBe(false)

    vi.advanceTimersByTime(100)
    const messages = parseSlideBridgeDrain(bridge.drain())
    const changed = messages.find((m) => m.type === 'html-changed')
    expect(changed).toBeDefined()
    if (changed?.type === 'html-changed') {
      expect(changed.html).toContain('新标题')
      expect(changed.html.startsWith('<!doctype html>')).toBe(true)
      // 编辑态属性被剥离,落盘 HTML 与非编辑态渲染等价。
      expect(changed.html).not.toContain('contenteditable')
      expect(changed.html).not.toContain('data-cortex-selected')
      expect(changed.html).not.toContain('data-cortex-bridge')
    }
  })

  it('多次输入只保留最新一份 html-changed(整页快照去重)', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    const h1 = document.querySelector('h1')!
    h1.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    for (const text of ['a', 'b', 'c']) {
      h1.textContent = text
      h1.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(EDIT_SAVE_DEBOUNCE_MS + 10)
    }
    const changes = parseSlideBridgeDrain(bridge.drain()).filter((m) => m.type === 'html-changed')
    expect(changes).toHaveLength(1)
    if (changes[0]?.type === 'html-changed') expect(changes[0].html).toContain('c')
  })

  it('exec(flush) 立即冲刷 pending save', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    const h1 = document.querySelector('h1')!
    h1.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    h1.textContent = '未保存'
    h1.dispatchEvent(new Event('input', { bubbles: true }))
    bridge.exec({ type: 'flush' })
    const changed = parseSlideBridgeDrain(bridge.drain()).find((m) => m.type === 'html-changed')
    expect(changed).toBeDefined()
  })

  it('exec 拒绝非法命令与非法颜色', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    document.querySelector('h1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    bridge.drain()
    bridge.exec({ type: 'eval', code: 'window.x=1' })
    bridge.exec('flush')
    bridge.exec({ type: 'color', hex: 'javascript:alert(1)' })
    expect((window as unknown as { x?: unknown }).x).toBeUndefined()
    expect(document.querySelector('h1')!.getAttribute('style') ?? '').not.toContain('javascript')
    expect(parseSlideBridgeDrain(bridge.drain())).toEqual([])
  })

  it('exec(font-size/color/align) 作用于选中元素并触发保存', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    document.querySelector('h1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    bridge.drain()
    bridge.exec({ type: 'font-size', px: 42 })
    bridge.exec({ type: 'color', hex: '#ff0000' })
    bridge.exec({ type: 'align', value: 'center' })
    const style = document.querySelector('h1')!.getAttribute('style') ?? ''
    expect(style).toContain('font-size: 42px')
    expect(style).toContain('text-align: center')
    vi.advanceTimersByTime(EDIT_SAVE_DEBOUNCE_MS + 10)
    expect(parseSlideBridgeDrain(bridge.drain()).some((m) => m.type === 'html-changed')).toBe(true)
  })

  it('Delete 删除已选中元素(编辑中不拦截)', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    document.querySelector('p')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    bridge.drain()
    // 真实场景 keydown 的 target 是焦点元素或 body,冒泡到 body 监听;不往 document 派发。
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    expect(document.querySelector('p')).toBeNull()
    vi.advanceTimersByTime(EDIT_SAVE_DEBOUNCE_MS + 10)
    expect(parseSlideBridgeDrain(bridge.drain()).some((m) => m.type === 'html-changed')).toBe(true)
  })

  it('set-edit-mode(false) 后点击不再选中(presenter/导出场景)', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    bridge.exec({ type: 'set-edit-mode', enabled: false })
    document.querySelector('h1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(parseSlideBridgeDrain(bridge.drain())).toEqual([])
    expect(document.querySelector('h1')!.getAttribute('data-cortex-selected')).toBeNull()
  })

  it('重复 data-cortex-id 时选中点击命中的那个(不误伤同 id 兄弟)', () => {
    const bridge = mountPage(`<head></head><body>
      <p data-cortex-id="dup">第一</p><p data-cortex-id="dup">第二</p></body>`)
    bridge.drain()
    const second = document.querySelectorAll('p')[1]!
    second.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    bridge.drain()
    second.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(document.querySelectorAll('p')[0]!.getAttribute('contenteditable')).toBeNull()
    expect(second.getAttribute('contenteditable')).toBe('true')
  })
})
