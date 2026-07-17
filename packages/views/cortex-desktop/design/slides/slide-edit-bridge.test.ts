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
  SELECTION_ITEMS_MAX,
  SELECTION_TEXT_MAX,
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
        type: 'selection-changed',
        items: [{ elementId: 'title', tagName: 'H1', rect: { x: 1, y: 2, w: 3, h: 4 }, text: '标题' }]
      })
    ).toMatchObject({ type: 'selection-changed', items: [{ elementId: 'title', text: '标题' }] })
    // 空 items = 取消选择,合法。
    expect(parseSlideBridgeMessage({ __cortexSlides: 1, type: 'selection-changed', items: [] })).toMatchObject({
      type: 'selection-changed',
      items: []
    })
    expect(parseSlideBridgeMessage({ __cortexSlides: 1, type: 'html-changed', html: '<html></html>' })).toMatchObject({
      type: 'html-changed'
    })
  })

  it('selection-changed:单条非法只丢该条,超长文本截断,条目数封顶', () => {
    const good = { elementId: 'a', tagName: 'P', rect: { x: 0, y: 0, w: 1, h: 1 }, text: 'x'.repeat(SELECTION_TEXT_MAX + 50) }
    const parsed = parseSlideBridgeMessage({
      __cortexSlides: 1,
      type: 'selection-changed',
      items: [good, { elementId: 42 }, 'garbage', { elementId: 'b', tagName: 'H1', rect: { x: 'x' } }]
    })
    expect(parsed?.type).toBe('selection-changed')
    if (parsed?.type === 'selection-changed') {
      expect(parsed.items).toHaveLength(1)
      expect(parsed.items[0]!.text).toHaveLength(SELECTION_TEXT_MAX)
    }
    const flood = parseSlideBridgeMessage({
      __cortexSlides: 1,
      type: 'selection-changed',
      items: Array.from({ length: SELECTION_ITEMS_MAX + 20 }, (_, i) => ({
        elementId: `e${i}`,
        tagName: 'P',
        rect: { x: 0, y: 0, w: 1, h: 1 },
        text: ''
      }))
    })
    if (flood?.type === 'selection-changed') expect(flood.items).toHaveLength(SELECTION_ITEMS_MAX)
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
    // 旧协议的 selected/deselected 不再是合法 type。
    expect(parseSlideBridgeMessage({ __cortexSlides: 1, type: 'selected', elementId: 'a' })).toBeNull()
    expect(parseSlideBridgeMessage({ __cortexSlides: 1, type: 'deselected' })).toBeNull()
    expect(parseSlideBridgeMessage({ __cortexSlides: 1, type: 'selection-changed', items: 'nope' })).toBeNull()
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

  it('点击白名单元素 → selection-changed(1 项);点击非法目标清空选区', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    document.querySelector('h1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const first = parseSlideBridgeDrain(bridge.drain())[0]
    expect(first).toMatchObject({
      type: 'selection-changed',
      items: [{ elementId: 'title', tagName: 'H1', text: '标题' }]
    })
    expect(document.querySelector('h1')!.getAttribute('data-cortex-selected')).toBe('1')

    // 点 body 空白(无可选目标)→ 选区清空。
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(parseSlideBridgeDrain(bridge.drain())[0]).toMatchObject({ type: 'selection-changed', items: [] })
    expect(document.querySelector('h1')!.getAttribute('data-cortex-selected')).toBeNull()
  })

  it('Shift+点击切换多选成员;再次 Shift+点击移出', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    document.querySelector('h1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    bridge.drain()
    document.querySelector('p')!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    const two = parseSlideBridgeDrain(bridge.drain())[0]
    expect(two).toMatchObject({ type: 'selection-changed' })
    if (two?.type === 'selection-changed') {
      expect(two.items.map((i) => i.elementId)).toEqual(['title', 'body'])
    }
    document.querySelector('h1')!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    const one = parseSlideBridgeDrain(bridge.drain())[0]
    if (one?.type === 'selection-changed') expect(one.items.map((i) => i.elementId)).toEqual(['body'])
  })

  it('拖拽移动:static 元素转 relative 偏移,落盘含新位置', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    const h1 = document.querySelector('h1') as HTMLElement
    h1.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }))
    // 4px 阈值内不算拖拽。
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 102, clientY: 101 }))
    expect(h1.style.left).toBe('')
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 130, clientY: 120 }))
    document.dispatchEvent(new MouseEvent('mouseup', {}))
    expect(h1.style.position).toBe('relative')
    expect(h1.style.left).toBe('30px')
    expect(h1.style.top).toBe('20px')
    // 拖拽后选区上报 + debounce 落盘。
    const msgs = parseSlideBridgeDrain(bridge.drain())
    expect(msgs.some((m) => m.type === 'selection-changed')).toBe(true)
    vi.advanceTimersByTime(EDIT_SAVE_DEBOUNCE_MS + 10)
    const changed = parseSlideBridgeDrain(bridge.drain()).find((m) => m.type === 'html-changed')
    expect(changed).toBeDefined()
    if (changed?.type === 'html-changed') {
      expect(changed.html).toContain('left: 30px')
      // 编辑态属性不落盘。
      expect(changed.html).not.toContain('data-cortex-selected')
    }
    // 拖拽结束后的 click 被抑制,不改写选区。
    h1.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(parseSlideBridgeDrain(bridge.drain()).some((m) => m.type === 'selection-changed')).toBe(false)
  })

  it('多选成组拖拽:两个元素同位移', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    const h1 = document.querySelector('h1') as HTMLElement
    const p = document.querySelector('p') as HTMLElement
    h1.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    bridge.drain()
    p.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 12, clientY: -8 }))
    document.dispatchEvent(new MouseEvent('mouseup', {}))
    expect(h1.style.left).toBe('12px')
    expect(h1.style.top).toBe('-8px')
    expect(p.style.left).toBe('12px')
    expect(p.style.top).toBe('-8px')
  })

  it('拖拽后 Cmd+Z 撤销位置,redo 命令重做;history-changed 驱动可用态', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    const h1 = document.querySelector('h1') as HTMLElement
    h1.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 20 }))
    document.dispatchEvent(new MouseEvent('mouseup', {}))
    expect(h1.style.left).toBe('30px')
    // 拖拽开始时 capture → canUndo。
    const history = parseSlideBridgeDrain(bridge.drain()).filter((m) => m.type === 'history-changed').at(-1)
    expect(history).toMatchObject({ canUndo: true, canRedo: false })

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }))
    // 撤销经 innerHTML 恢复,旧引用失效,重新查询。
    const restored = document.querySelector('h1') as HTMLElement
    expect(restored.style.left).toBe('')
    const afterUndo = parseSlideBridgeDrain(bridge.drain()).filter((m) => m.type === 'history-changed').at(-1)
    expect(afterUndo).toMatchObject({ canUndo: false, canRedo: true })

    bridge.exec({ type: 'redo' })
    expect((document.querySelector('h1') as HTMLElement).style.left).toBe('30px')
    // 撤销/重做本身也要落盘(否则文件与画布漂移)。
    vi.advanceTimersByTime(EDIT_SAVE_DEBOUNCE_MS + 10)
    expect(parseSlideBridgeDrain(bridge.drain()).some((m) => m.type === 'html-changed')).toBe(true)
  })

  it('删除后撤销可恢复元素', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    document.querySelector('p')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    expect(document.querySelector('p')).toBeNull()
    bridge.exec({ type: 'undo' })
    expect(document.querySelector('p')).not.toBeNull()
    expect(document.querySelector('p')!.textContent).toBe('正文')
  })

  it('拖拽吸附:距其它元素边线 5px 内自动贴齐并显示参考线,松手后隐藏', () => {
    const bridge = mountPage(`<head></head><body>
      <div id="a" style="position:absolute;left:100px;top:100px;width:200px;height:100px"></div>
      <div id="b" style="position:absolute;left:300px;top:300px;width:100px;height:50px"></div></body>`)
    bridge.drain()
    const stubRect = (el: HTMLElement, r: { left: number; top: number; w: number; h: number }): void => {
      Object.defineProperty(el, 'getBoundingClientRect', {
        value: () => ({
          left: r.left,
          top: r.top,
          width: r.w,
          height: r.h,
          right: r.left + r.w,
          bottom: r.top + r.h,
          x: r.left,
          y: r.top,
          toJSON: () => ({})
        })
      })
    }
    const a = document.getElementById('a') as HTMLElement
    const b = document.getElementById('b') as HTMLElement
    stubRect(a, { left: 100, top: 100, w: 200, h: 100 })
    stubRect(b, { left: 300, top: 300, w: 100, h: 50 })
    b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 500, clientY: 500 }))
    // dx=-197 → 拟移到 left=103,距 a 的左边线(100)3px → 吸附到 100。
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 303, clientY: 500 }))
    expect(b.style.left).toBe('100px')
    const guide = document.querySelector('div[data-cortex-bridge]') as HTMLElement
    expect(guide).not.toBeNull()
    expect(guide.style.display).toBe('block')
    expect(guide.style.left).toBe('100px')
    document.dispatchEvent(new MouseEvent('mouseup', {}))
    expect(guide.style.display).toBe('none')
    // 参考线绝不落盘。
    vi.advanceTimersByTime(EDIT_SAVE_DEBOUNCE_MS + 10)
    const changed = parseSlideBridgeDrain(bridge.drain()).find((m) => m.type === 'html-changed')
    if (changed?.type === 'html-changed') expect(changed.html).not.toContain('data-cortex-bridge')
  })

  it('font-step 按 computed 字号步进并夹在 8–200px', () => {
    const bridge = mountPage(`<head></head><body><h1 data-cortex-id="t" style="font-size:20px">T</h1></body>`)
    bridge.drain()
    const h1 = document.querySelector('h1') as HTMLElement
    h1.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    bridge.exec({ type: 'font-step', delta: 2 })
    expect(h1.style.fontSize).toBe('22px')
    bridge.exec({ type: 'font-step', delta: -100 })
    expect(h1.style.fontSize).toBe('8px')
  })

  it('方向键微调选区(Shift ×10)并触发保存', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    const h1 = document.querySelector('h1') as HTMLElement
    h1.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    bridge.drain()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(h1.style.left).toBe('1px')
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }))
    expect(h1.style.top).toBe('10px')
    vi.advanceTimersByTime(EDIT_SAVE_DEBOUNCE_MS + 10)
    expect(parseSlideBridgeDrain(bridge.drain()).some((m) => m.type === 'html-changed')).toBe(true)
  })

  // 回归:Agent 生成的页面常把 data-cortex-id 只打在容器 div 上,若选中强依赖 id
  // 会导致整页不可编辑(用户实测)。白名单标签缺 id 也要可选中,并就地补 id。
  it('无 data-cortex-id 的白名单元素仍可选中,并就地补打 id', () => {
    const bridge = mountPage(`<head></head><body>
      <div data-cortex-id="tile"><h3>裸标题</h3><p>裸正文</p></div></body>`)
    bridge.drain()
    const h3 = document.querySelector('h3')!
    h3.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const selected = parseSlideBridgeDrain(bridge.drain())
    expect(selected[0]).toMatchObject({ type: 'selection-changed', items: [{ tagName: 'H3' }] })
    const stamped = h3.getAttribute('data-cortex-id')
    expect(stamped).toMatch(/^edit-\d+$/)
    if (selected[0]?.type === 'selection-changed') expect(selected[0].items[0]!.elementId).toBe(stamped)
    // 补打的 id 随 debounce 落盘,LLM 才能引用。
    vi.advanceTimersByTime(EDIT_SAVE_DEBOUNCE_MS + 10)
    const persisted = parseSlideBridgeDrain(bridge.drain()).find((m) => m.type === 'html-changed')
    expect(persisted).toBeDefined()
    if (persisted?.type === 'html-changed') expect(persisted.html).toContain(`data-cortex-id="${stamped}"`)
    // 双击可进入编辑。
    h3.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(h3.getAttribute('contenteditable')).toBe('true')
  })

  it('纯文本 div(如 emoji 图标块)可选中;含块级子元素的容器不可', () => {
    const bridge = mountPage(`<head></head><body>
      <div class="icon">😊</div>
      <div class="wrap"><section>块级子元素</section></div></body>`)
    bridge.drain()
    document.querySelector('.icon')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(parseSlideBridgeDrain(bridge.drain())[0]).toMatchObject({
      type: 'selection-changed',
      items: [{ tagName: 'DIV' }]
    })
    document.querySelector('.wrap')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(parseSlideBridgeDrain(bridge.drain())[0]).toMatchObject({ type: 'selection-changed', items: [] })
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

  it('exec(focus-element) 按 data-cortex-id 定位并同步页内选区', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    bridge.exec({ type: 'focus-element', elementId: 'body' })
    expect(document.querySelector('p')!.getAttribute('data-cortex-selected')).toBe('1')
    const selected = parseSlideBridgeDrain(bridge.drain()).find((message) => message.type === 'selection-changed')
    expect(selected).toMatchObject({ type: 'selection-changed', items: [{ elementId: 'body' }] })
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
