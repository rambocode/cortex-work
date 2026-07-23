// 编辑 bridge 协议测试:消息校验(恶意/伪造/超大一律丢弃)、命令编译白名单、
// 注入脚本幂等,以及在 jsdom 中直接跑页内脚本验证选择/编辑/删除/flush 行为。
//
// 测试宿主说明:下方用 `new Function(buildSlideEditBridgeSource())` 在 jsdom 里执行
// 页内脚本、用 innerHTML 灌入字面量 fixture —— 这是「在测试进程里模拟 webview guest」
// 的手段,执行的是本仓库自己 builder 产出的源码(配置经 JSON.stringify 注入,无外部
// 输入),与生产路径无关;生产侧脚本经 webview.executeJavaScript 注入到沙箱 guest。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const PAGE = `<head></head><body>
    <h1 data-cortex-id="title">标题</h1>
    <p data-cortex-id="body">正文</p>
    <div data-cortex-id="box"><span>无 id 的内容</span></div>
  </body>`

  // jsdom 无布局引擎,getBoundingClientRect 恒为 0 —— 需要几何的用例逐元素 mock。
  function mockRect(el: HTMLElement, left: number, top: number, width: number, height: number): void {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({})
    } as DOMRect)
  }

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
    // 2px 阈值内不算拖拽(1px 只是手抖);拖拽期间实时位移走 transform,left 松手才写。
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 101, clientY: 100 }))
    expect(h1.style.transform).toBe('')
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

  it('拖拽元素逐事件紧跟鼠标,拖动期间不测量手柄布局', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const bridge = mountPage(PAGE)
    bridge.drain()
    const h1 = document.querySelector('h1') as HTMLElement
    const rect = vi.spyOn(h1, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 40,
      right: 100,
      bottom: 40,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect)

    h1.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: 0 }))
    expect(h1.style.transform).toBe('')
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 0 }))
    // 1px 手抖后,首次有效移动立即显示。
    expect(h1.style.transform).toBe('translate(10px, 0px)')
    rect.mockClear()

    for (let x = 101; x <= 140; x += 1) {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: 0 }))
    }

    // 元素自身逐事件跟到最新指针;高成本手柄测量在整个拖动期间都不执行。
    expect(h1.style.transform).toBe('translate(140px, 0px)')
    expect(h1.style.getPropertyPriority('transform')).toBe('important')
    expect(rect).not.toHaveBeenCalled()
    expect(frames).toHaveLength(0)
    const handles = document.querySelector('[data-cortex-handles]') as HTMLElement
    const rotate = document.querySelector('[data-cortex-rotate]') as HTMLElement
    expect(handles.style.display).toBe('none')
    expect(rotate.style.display).toBe('none')
    document.dispatchEvent(new MouseEvent('mouseup', {}))
    expect(handles.style.display).not.toBe('none')
    expect(rotate.style.display).not.toBe('none')
  })

  it('拖拽期间启用 transform 合成提示,松手后恢复原样式', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    const h1 = document.querySelector('h1') as HTMLElement

    h1.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 10 }))
    expect(h1.style.willChange).toBe('transform')
    document.dispatchEvent(new MouseEvent('mouseup', {}))
    expect(h1.style.willChange).toBe('')
  })

  it('拖拽期间屏蔽页面 transition/animation,松手后完整恢复', () => {
    const bridge = mountPage(`<head></head><body>
      <h1 data-cortex-id="title"
        style="position:absolute;left:10px;top:20px;transform:rotate(2deg);transition:transform 300ms ease;animation:pulse 2s infinite">
        标题
      </h1>
    </body>`)
    bridge.drain()
    const h1 = document.querySelector('h1') as HTMLElement

    h1.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 10 }))
    expect(h1.style.getPropertyValue('transition')).toBe('none')
    expect(h1.style.getPropertyPriority('transition')).toBe('important')
    expect(h1.style.getPropertyValue('animation')).toBe('none')
    expect(h1.style.getPropertyPriority('animation')).toBe('important')
    expect(h1.style.transform).toBe('translate(20px, 10px) rotate(2deg)')
    expect(h1.style.getPropertyPriority('transform')).toBe('important')

    document.dispatchEvent(new MouseEvent('mouseup', {}))
    expect(h1.style.transform).toBe('rotate(2deg)')
    expect(h1.style.getPropertyPriority('transform')).toBe('')
    expect(h1.style.transition).toBe('transform 300ms ease')
    expect(h1.style.getPropertyPriority('transition')).toBe('')
    expect(h1.style.animation).toBe('pulse 2s infinite')
    expect(h1.style.getPropertyPriority('animation')).toBe('')
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
    // 拖拽期间实时位移(含吸附修正 -3px)走 transform;left 到松手才落盘。
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 303, clientY: 500 }))
    vi.advanceTimersByTime(16)
    expect(b.style.transform).toBe('translate(-200px, 0px)')
    // 排除缩放手柄层与旋转手柄(同为 data-cortex-bridge 节点,拖拽开始选中 b 时已创建)。
    const guide = document.querySelector('div[data-cortex-bridge]:not([data-cortex-handles]):not([data-cortex-rotate])') as HTMLElement
    expect(guide).not.toBeNull()
    expect(guide.style.display).toBe('block')
    expect(guide.style.left).toBe('100px')
    document.dispatchEvent(new MouseEvent('mouseup', {}))
    expect(guide.style.display).toBe('none')
    // 松手落盘:吸附后的最终位置写入 left,临时 transform 还原。
    expect(b.style.left).toBe('100px')
    expect(b.style.transform).toBe('')
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

  it('exec(align-elements) 多选时按选区包围盒对齐;单选/非法取值忽略', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    const h1 = document.querySelector('h1') as HTMLElement
    const p = document.querySelector('p') as HTMLElement
    // h1 占 (10,10)-(110,30),p 占 (50,50)-(110,60),包围盒 left=10 / bottom=60。
    mockRect(h1, 10, 10, 100, 20)
    mockRect(p, 50, 50, 60, 10)
    h1.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // 单选时元素对齐无意义,命令被忽略。
    bridge.exec({ type: 'align-elements', value: 'left' })
    expect(h1.style.left).toBe('')
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    bridge.drain()
    bridge.exec({ type: 'align-elements', value: 'left' })
    // 左对齐到包围盒 left=10:h1 已贴边不动,p 左移 40(static 转 relative 偏移)。
    expect(h1.style.left).toBe('')
    expect(p.style.position).toBe('relative')
    expect(p.style.left).toBe('-40px')
    bridge.exec({ type: 'align-elements', value: 'bottom' })
    // 底对齐到包围盒 bottom=60:p 已在底边,h1 下移 30。
    expect(h1.style.top).toBe('30px')
    // 非法取值直接忽略,不产生位移。
    bridge.exec({ type: 'align-elements', value: 'diagonal' })
    vi.advanceTimersByTime(EDIT_SAVE_DEBOUNCE_MS + 10)
    expect(parseSlideBridgeDrain(bridge.drain()).some((m) => m.type === 'html-changed')).toBe(true)
  })

  it('exec(insert-image) 插入居中 img 并选中;非法/超限 dataUrl 拒绝', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    bridge.exec({ type: 'insert-image', dataUrl: 'data:image/webp;base64,AAAA', width: 200, height: 100 })
    const img = document.querySelector('img') as HTMLImageElement
    expect(img).not.toBeNull()
    // 画布(1280×720)居中:left=(1280-200)/2,top=(720-100)/2;插入即选中并补 id。
    expect(img.style.position).toBe('absolute')
    expect(img.style.left).toBe('540px')
    expect(img.style.top).toBe('310px')
    expect(img.getAttribute('data-cortex-selected')).toBe('1')
    expect(img.getAttribute('data-cortex-id')).toBeTruthy()
    const selected = parseSlideBridgeDrain(bridge.drain()).find((m) => m.type === 'selection-changed')
    expect(selected).toMatchObject({ type: 'selection-changed', items: [{ tagName: 'IMG' }] })
    vi.advanceTimersByTime(EDIT_SAVE_DEBOUNCE_MS + 10)
    const changed = parseSlideBridgeDrain(bridge.drain()).find((m) => m.type === 'html-changed')
    expect(changed && changed.type === 'html-changed' ? changed.html : '').toContain('data:image/webp')

    // 非法输入一律拒绝:远程 URL、javascript:、SVG(可携带脚本)、非法尺寸、超预算大图。
    bridge.exec({ type: 'insert-image', dataUrl: 'https://evil.example/x.png', width: 10, height: 10 })
    bridge.exec({ type: 'insert-image', dataUrl: 'javascript:alert(1)', width: 10, height: 10 })
    bridge.exec({ type: 'insert-image', dataUrl: 'data:image/svg+xml;base64,AAAA', width: 10, height: 10 })
    bridge.exec({ type: 'insert-image', dataUrl: 'data:image/png;base64,AAAA', width: -5, height: 10 })
    bridge.exec({ type: 'insert-image', dataUrl: 'data:image/png;base64,' + 'A'.repeat(MAX_EDITED_HTML_BYTES), width: 10, height: 10 })
    expect(document.querySelectorAll('img')).toHaveLength(1)
  })

  it('exec(z-order) 相对重叠元素调层级;static 目标转 relative;无重叠不改动', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    const h1 = document.querySelector('h1') as HTMLElement
    const p = document.querySelector('p') as HTMLElement
    // 插入图片(自动选中),几何上与 h1 重叠、与 p 不重叠。
    bridge.exec({ type: 'insert-image', dataUrl: 'data:image/webp;base64,AAAA', width: 200, height: 100 })
    const img = document.querySelector('img') as HTMLElement
    mockRect(h1, 500, 300, 300, 60)
    mockRect(img, 540, 310, 200, 100)
    mockRect(p, 0, 600, 100, 20)
    // 下移一层:唯一下层 peer 是 h1(static 流内文字视作 z=0)→ img 压到 -1,绘制到文字之后。
    bridge.exec({ type: 'z-order', value: 'down' })
    expect(img.style.zIndex).toBe('-1')
    // 置顶:回到 h1 之上。
    bridge.exec({ type: 'z-order', value: 'front' })
    expect(img.style.zIndex).toBe('1')
    // 选中 h1(static 文本)上移一层:转 relative 让 z-index 生效,压过 img。
    h1.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    bridge.drain()
    bridge.exec({ type: 'z-order', value: 'up' })
    expect(h1.style.position).toBe('relative')
    expect(h1.style.zIndex).toBe('2')
    // p 与谁都不重叠:调层级无视觉意义,不产生改动。
    p.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    bridge.drain()
    bridge.exec({ type: 'z-order', value: 'front' })
    expect(p.style.zIndex).toBe('')
    vi.advanceTimersByTime(EDIT_SAVE_DEBOUNCE_MS + 10)
    expect(parseSlideBridgeDrain(bridge.drain()).some((m) => m.type === 'html-changed')).toBe(true)
  })

  it('单选出缩放手柄:文本调宽自动换行(nowrap 转 normal),多选隐藏', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    const h1 = document.querySelector('h1') as HTMLElement
    h1.style.whiteSpace = 'nowrap'
    // 带 max-width 约束:调宽时须被解除,否则 style.width 被钳住拉不动。
    h1.style.maxWidth = '300px'
    mockRect(h1, 100, 100, 300, 60)
    h1.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    bridge.drain()
    const layer = document.querySelector('[data-cortex-handles]') as HTMLElement
    expect(layer.style.display).toBe('block')
    expect(layer.querySelectorAll('[data-key]')).toHaveLength(8)
    // 拖东侧手柄 +50px:宽度固化为 350px,nowrap 转 normal 让文字可折行。
    const east = layer.querySelector('[data-key="e"]') as HTMLElement
    east.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 400, clientY: 130 }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 450, clientY: 130 }))
    document.dispatchEvent(new MouseEvent('mouseup', {}))
    expect(h1.style.width).toBe('350px')
    expect(h1.style.whiteSpace).toBe('normal')
    expect(h1.style.maxWidth).toBe('none')
    // 真实浏览器 mouseup 后会补发一次 click(被 suppressClick 吞掉);jsdom 需手动补上。
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // 多选(≥2)时缩放语义不明,手柄隐藏。
    document.querySelector('p')!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    expect(layer.style.display).toBe('none')
    vi.advanceTimersByTime(EDIT_SAVE_DEBOUNCE_MS + 10)
    expect(parseSlideBridgeDrain(bridge.drain()).some((m) => m.type === 'html-changed')).toBe(true)
  })

  it('图片等比缩放:仅四角手柄,宽高比锁定', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    bridge.exec({ type: 'insert-image', dataUrl: 'data:image/webp;base64,AAAA', width: 200, height: 100 })
    const img = document.querySelector('img') as HTMLElement
    mockRect(img, 540, 310, 200, 100)
    const layer = document.querySelector('[data-cortex-handles]') as HTMLElement
    // 等比元素的边中点手柄(单轴)与等比语义冲突,隐藏;四角保留。
    expect((layer.querySelector('[data-key="s"]') as HTMLElement).style.display).toBe('none')
    expect((layer.querySelector('[data-key="se"]') as HTMLElement).style.display).toBe('block')
    // 拖东南角 dx=40 / dy=5:dx 主导,2:1 宽高比锁定 → 240×120。
    const se = layer.querySelector('[data-key="se"]') as HTMLElement
    se.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 740, clientY: 410 }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 780, clientY: 415 }))
    document.dispatchEvent(new MouseEvent('mouseup', {}))
    expect(img.style.width).toBe('240px')
    expect(img.style.height).toBe('120px')
  })

  // 剪贴板事件 stub:jsdom 无 DataTransfer 构造器,用共享 store 模拟 copy→paste 流转。
  function clipboardStub(store: Record<string, string>): unknown {
    return {
      items: [],
      setData: (type: string, v: string) => {
        store[type] = v
      },
      getData: (type: string) => store[type] ?? ''
    }
  }

  function dispatchClipboard(type: 'copy' | 'paste', store: Record<string, string>): Event {
    const evt = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(evt, 'clipboardData', { value: clipboardStub(store) })
    document.body.dispatchEvent(evt)
    return evt
  }

  it('画布内复制/粘贴所选元素:copy 写自定义 mime,paste 克隆到原元素旁并偏移选中', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    const h1 = document.querySelector('h1') as HTMLElement
    h1.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    bridge.drain()
    const store: Record<string, string> = {}
    const copyEvt = dispatchClipboard('copy', store)
    expect(copyEvt.defaultPrevented).toBe(true)
    expect(store['application/x-cortex-slide-elements']).toContain('标题')
    expect(store['text/html']).toContain('<h1')

    dispatchClipboard('paste', store)
    const clones = document.querySelectorAll('h1')
    expect(clones).toHaveLength(2)
    const clone = clones[1] as HTMLElement
    // 插回原元素旁、偏移 16px(static 转 relative)、清旧 id 后重新编号、自动选中。
    expect(clone.previousElementSibling).toBe(h1)
    expect(clone.style.left).toBe('16px')
    expect(clone.style.top).toBe('16px')
    expect(clone.getAttribute('data-cortex-selected')).toBe('1')
    expect(clone.getAttribute('data-cortex-id')).not.toBe('title')
    vi.advanceTimersByTime(EDIT_SAVE_DEBOUNCE_MS + 10)
    expect(parseSlideBridgeDrain(bridge.drain()).some((m) => m.type === 'html-changed')).toBe(true)
  })

  it('粘贴的剪贴板 HTML 按不可信输入清洗:剥 script 与 on* 事件属性', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    const store: Record<string, string> = {
      'application/x-cortex-slide-elements': JSON.stringify([
        { id: '', html: '<div onclick="evil()"><script>evil()</' + 'script><span onmouseover="evil()">ok</span></div>' },
        { id: '', html: '<script>evil()</' + 'script>' }
      ])
    }
    dispatchClipboard('paste', store)
    // 第二条根节点即脚本,整条拒绝;第一条清洗后插入。
    const pasted = document.querySelector('[data-cortex-selected]') as HTMLElement
    expect(pasted).not.toBeNull()
    expect(pasted.tagName).toBe('DIV')
    expect(pasted.getAttribute('onclick')).toBeNull()
    expect(pasted.querySelector('script')).toBeNull()
    expect(pasted.querySelector('span')!.getAttribute('onmouseover')).toBeNull()
    expect(document.querySelectorAll('script[data-cortex-test]')).toHaveLength(0)
  })

  it('吸附速度自适应:指针高速移动时不吸附,慢速精调时吸附', () => {
    const bridge = mountPage(`<head></head><body>
      <div id="a" style="position:absolute;left:100px;top:100px;width:200px;height:100px"></div>
      <div id="b" style="position:absolute;left:300px;top:300px;width:100px;height:50px"></div></body>`)
    bridge.drain()
    const a = document.getElementById('a') as HTMLElement
    const b = document.getElementById('b') as HTMLElement
    mockRect(a, 100, 100, 200, 100)
    mockRect(b, 300, 300, 100, 50)
    b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 500, clientY: 500 }))
    // 首帧(无速度历史)建立采样。
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 495, clientY: 500 }))
    // 4ms 内跨 192px ≈ 48px/ms:高速移动,拟移到 left=103(距线 3px)也不吸附。
    vi.advanceTimersByTime(4)
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 303, clientY: 500 }))
    vi.advanceTimersByTime(16)
    expect(b.style.transform).toBe('translate(-197px, 0px)')
    // 200ms 才挪 1px:慢速精调,吸附恢复(102 → 贴 100,修正 -2)。
    vi.advanceTimersByTime(200)
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 302, clientY: 500 }))
    vi.advanceTimersByTime(16)
    expect(b.style.transform).toBe('translate(-200px, 0px)')
    document.dispatchEvent(new MouseEvent('mouseup', {}))
    expect(b.style.left).toBe('100px')
  })

  it('框选:空白处拖矩形,相交即选、实时反馈,嵌套只选最外层', () => {
    const bridge = mountPage(`<head></head><body>
      <div id="card" style="position:absolute;left:40px;top:40px;width:200px;height:100px"><p>卡内文字</p></div>
      <p id="far" data-cortex-id="far">远处文字</p></body>`)
    bridge.drain()
    const card = document.getElementById('card') as HTMLElement
    const inner = card.querySelector('p') as HTMLElement
    const far = document.getElementById('far') as HTMLElement
    mockRect(card, 40, 40, 200, 100)
    mockRect(inner, 50, 50, 100, 20)
    mockRect(far, 40, 400, 100, 20)
    // 空白处(body 直接命中,无可选目标)按下开始框选。
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 200 }))
    // 框到 card 与其内部 p:只选最外层 card;far 未相交不选。
    expect(card.getAttribute('data-cortex-selected')).toBe('1')
    expect(inner.getAttribute('data-cortex-selected')).toBeNull()
    expect(far.getAttribute('data-cortex-selected')).toBeNull()
    const marquee = document.querySelector('[data-cortex-marquee]') as HTMLElement
    expect(marquee).not.toBeNull()
    // 拉大到覆盖 far:相交即入选。
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 500 }))
    expect(far.getAttribute('data-cortex-selected')).toBe('1')
    document.dispatchEvent(new MouseEvent('mouseup', {}))
    // 框选矩形移除;结束后的 click 被抑制,不清空选区。
    expect(document.querySelector('[data-cortex-marquee]')).toBeNull()
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(card.getAttribute('data-cortex-selected')).toBe('1')
    const sel = parseSlideBridgeDrain(bridge.drain()).filter((m) => m.type === 'selection-changed').at(-1)
    if (sel?.type === 'selection-changed') expect(sel.items).toHaveLength(2)
  })

  it('框选不被满画布容器吞掉:容器视为背景可发起框选,子元素可多选', () => {
    const bridge = mountPage(`<head></head><body>
      <div id="wrap" style="position:absolute;left:0;top:0;width:1280px;height:720px">
        <div id="c1" style="position:absolute;left:100px;top:100px;width:200px;height:100px"></div>
        <div id="c2" style="position:absolute;left:400px;top:100px;width:200px;height:100px"></div>
      </div></body>`)
    bridge.drain()
    const wrap = document.getElementById('wrap') as HTMLElement
    const c1 = document.getElementById('c1') as HTMLElement
    const c2 = document.getElementById('c2') as HTMLElement
    mockRect(wrap, 0, 0, 1280, 720)
    mockRect(c1, 100, 100, 200, 100)
    mockRect(c2, 400, 100, 200, 100)
    // 从满画布 wrapper 的背景上按下:容器视为空白,框选正常发起(而非拖动 wrapper)。
    wrap.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 50, clientY: 50 }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 650, clientY: 250 }))
    document.dispatchEvent(new MouseEvent('mouseup', {}))
    // 两张卡片同时入选;完全包住框选矩形的 wrapper 自身不入选。
    expect(c1.getAttribute('data-cortex-selected')).toBe('1')
    expect(c2.getAttribute('data-cortex-selected')).toBe('1')
    expect(wrap.getAttribute('data-cortex-selected')).toBeNull()
    // 消耗框选结束的 click 抑制后,点背景容器=点空白 → 清空选区。
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    wrap.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(c1.getAttribute('data-cortex-selected')).toBeNull()
    expect(wrap.getAttribute('data-cortex-selected')).toBeNull()
  })

  it('旋转 v1:拖旋转手柄绕中心旋转,Shift 吸附 15°,旋转态缩放手柄隐藏', () => {
    const bridge = mountPage(PAGE)
    bridge.drain()
    const h1 = document.querySelector('h1') as HTMLElement
    mockRect(h1, 100, 100, 100, 50)
    h1.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    bridge.drain()
    const handle = document.querySelector('[data-cortex-rotate]') as HTMLElement
    expect(handle).not.toBeNull()
    expect(handle.style.display).toBe('block')
    // 中心 (150,125);从正上方(-90°)拖到正右方(0°)= 旋转 +90°。
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 150, clientY: 50 }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 250, clientY: 125 }))
    document.dispatchEvent(new MouseEvent('mouseup', {}))
    expect(h1.style.transform).toBe('rotate(90deg)')
    // 旋转态:AABB 与真实四角错位,缩放手柄整组隐藏。
    const dot = document.querySelector('[data-cortex-handles] [data-key="e"]') as HTMLElement
    expect(dot.style.display).toBe('none')
    // Shift 吸附:再往下拖到 116.6° 方向,吸到 120°(90 + 26.57 → 120)。
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 150, clientY: 50 }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 250, clientY: 175, shiftKey: true }))
    document.dispatchEvent(new MouseEvent('mouseup', {}))
    expect(h1.style.transform).toBe('rotate(210deg)')
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
