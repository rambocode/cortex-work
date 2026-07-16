// Slide 应用内编辑 bridge:宿主(renderer)与 slide webview 之间的受控消息协议。
//
// 传输模型(与仓库既有 design canvas 一致):**宿主 pull,不是 guest push**。
//   Electron `<webview>` 的 guest 是独立 frame,`window.parent.postMessage` 到不了
//   宿主;而给 webview 挂 preload 会把宿主能力暴露给 slide 页面。因此页内脚本只把
//   结构化消息压进 `window.__cortexSlidesBridge` 的队列,宿主经 executeJavaScript
//   周期性 drain(与 useDesignHtmlPreview.executeScript 同款通道)。
//
// 安全契约(务必遵守):
//  - 版本化协议:每条消息必须带 `__cortexSlides: 1` 与白名单内的 type;任何不合协议的
//    输入(页面伪造的队列内容、未知 type、字段类型错、超大 HTML)一律丢弃 ——
//    绝不按 method name 派发。
//  - slide 页面拿不到 preload / Node 能力:落盘由宿主经 slides:saveEditedHtml IPC 完成,
//    主进程再做全量校验(路径/revision/字节数)。
//  - 只有带 data-cortex-id 且标签在 allowlist 内的元素可编辑(见 EDITABLE_TAGS)。
//  - presenter/导出渲染不注入本 bridge(见 export/html.ts 与 render.ts)。
//
// 保存策略:文本变更 500ms debounce → 序列化整页 HTML(剥离编辑态属性)→ 宿主携带
// expectedRevision 保存;冲突时宿主停止自动保存并提示刷新(见 slides-store)。

/** 协议版本标记:宿主与页内脚本双向校验。 */
export const SLIDE_BRIDGE_PROTOCOL = 1

/** 可编辑标签白名单(纯文本类;结构性容器不开放就地编辑)。 */
export const EDITABLE_TAGS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'SPAN', 'LI', 'TD', 'TH', 'FIGCAPTION', 'BLOCKQUOTE', 'STRONG', 'EM'] as const

/** 宿主 drain 页内队列的表达式(返回 JSON 数组;页内未挂载 bridge 时返回空数组)。 */
export const DRAIN_SLIDE_BRIDGE_SOURCE =
  'window.__cortexSlidesBridge ? window.__cortexSlidesBridge.drain() : []'

/** 宿主 drain 轮询间隔:低于 debounce,保证一次编辑的保存延迟仍在亚秒级。 */
export const BRIDGE_DRAIN_INTERVAL_MS = 250

/** 页内 → 宿主 的消息(只有这些 type 会被处理)。 */
export type SlideBridgeInboundMessage =
  | { __cortexSlides: 1; type: 'ready' }
  | { __cortexSlides: 1; type: 'selected'; elementId: string; tagName: string; rect: { x: number; y: number; w: number; h: number } }
  | { __cortexSlides: 1; type: 'deselected' }
  | { __cortexSlides: 1; type: 'html-changed'; html: string }

/** 宿主 → 页内 的命令(经 executeJavaScript 调用页内 API)。 */
export type SlideBridgeCommand =
  | { type: 'set-edit-mode'; enabled: boolean }
  | { type: 'format'; command: 'bold' | 'italic' | 'underline' }
  | { type: 'font-size'; px: number }
  | { type: 'color'; hex: string }
  | { type: 'align'; value: 'left' | 'center' | 'right' }
  | { type: 'delete-selected' }
  | { type: 'flush' }

/** 单页 HTML 上限(与主进程 MAX_SLIDE_HTML_BYTES 一致;超限宿主直接拒绝,不发 IPC)。 */
export const MAX_EDITED_HTML_BYTES = 2 * 1024 * 1024

/** 文本编辑保存 debounce。 */
export const EDIT_SAVE_DEBOUNCE_MS = 500

/**
 * 校验并归一化一条来自 slide 页面的消息。任何不合协议的输入(缺标记、未知 type、
 * 字段类型错、HTML 超限)一律返回 null —— 调用方据此静默丢弃。
 */
export function parseSlideBridgeMessage(raw: unknown): SlideBridgeInboundMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const msg = raw as Record<string, unknown>
  if (msg.__cortexSlides !== SLIDE_BRIDGE_PROTOCOL) return null
  switch (msg.type) {
    case 'ready':
      return { __cortexSlides: 1, type: 'ready' }
    case 'deselected':
      return { __cortexSlides: 1, type: 'deselected' }
    case 'selected': {
      const rect = msg.rect as Record<string, unknown> | undefined
      if (typeof msg.elementId !== 'string' || !msg.elementId) return null
      if (typeof msg.tagName !== 'string') return null
      if (
        !rect ||
        typeof rect.x !== 'number' ||
        typeof rect.y !== 'number' ||
        typeof rect.w !== 'number' ||
        typeof rect.h !== 'number'
      ) {
        return null
      }
      return {
        __cortexSlides: 1,
        type: 'selected',
        elementId: msg.elementId,
        tagName: msg.tagName,
        rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
      }
    }
    case 'html-changed': {
      if (typeof msg.html !== 'string' || !msg.html) return null
      // 超大 HTML 直接丢弃:恶意/异常页面不得撑爆 IPC 与磁盘。
      if (msg.html.length > MAX_EDITED_HTML_BYTES) return null
      return { __cortexSlides: 1, type: 'html-changed', html: msg.html }
    }
    default:
      return null
  }
}

/** 把宿主命令编译成页内可执行的表达式(经 webview.executeJavaScript 下发)。 */
export function compileSlideBridgeCommand(command: SlideBridgeCommand): string {
  return `window.__cortexSlidesBridge && window.__cortexSlidesBridge.exec(${JSON.stringify(command)})`
}

/* eslint-disable */
// 页内注入脚本(自包含函数,toString 后由宿主 executeJavaScript 注入)。
// 约束:不引用闭包外变量;只经 outbox + 宿主 drain 通信;不触碰任何 Node/preload API。
// 类型注解仅为通过本包 typecheck —— 编译时被擦除,不影响 toString() 注入的运行时代码;
// 因此这里不得使用任何需要运行时 helper 的 TS 构造(enum/装饰器/参数属性等)。
function slideEditBridgeInPage(config: { protocol: number; editableTags: string[]; debounceMs: number }) {
  var PROTOCOL = config.protocol
  var EDITABLE: Record<string, boolean> = {}
  for (var i = 0; i < config.editableTags.length; i++) EDITABLE[config.editableTags[i]!] = true
  var DEBOUNCE_MS = config.debounceMs
  var selected: HTMLElement | null = null
  var saveTimer: ReturnType<typeof setTimeout> | 0 = 0
  var editMode = true
  // 出队缓冲:宿主经 drain() 拉取(webview guest 无法直接 postMessage 到宿主)。
  // 上限保护:队列只保留最近 32 条,避免宿主长时间不 drain 时无限增长。
  var outbox: Record<string, unknown>[] = []

  function post(msg: Record<string, unknown>): void {
    msg.__cortexSlides = PROTOCOL
    // html-changed 只保留最新一条(整页快照,旧的没有价值且体积大)。
    if (msg.type === 'html-changed') {
      outbox = outbox.filter(function (m) {
        return m.type !== 'html-changed'
      })
    }
    outbox.push(msg)
    if (outbox.length > 32) outbox.shift()
  }

  // 序列化整页:先剥离编辑态残留(选中框样式、contenteditable、bridge 脚本本身),
  // 保证落盘 HTML 与「非编辑态渲染结果」等价 —— 否则导出/presenter 会带上编辑痕迹。
  function serialize(): string {
    var clone = document.documentElement.cloneNode(true) as HTMLElement
    var marked = clone.querySelectorAll('[contenteditable],[data-cortex-selected]')
    for (var i = 0; i < marked.length; i++) {
      marked[i]!.removeAttribute('contenteditable')
      marked[i]!.removeAttribute('data-cortex-selected')
    }
    var injected = clone.querySelectorAll('[data-cortex-bridge]')
    for (var j = 0; j < injected.length; j++) injected[j]!.remove()
    return '<!doctype html>\n' + clone.outerHTML
  }

  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(function () {
      saveTimer = 0
      post({ type: 'html-changed', html: serialize() })
    }, DEBOUNCE_MS)
  }

  function flush(): void {
    if (!saveTimer) return
    clearTimeout(saveTimer)
    saveTimer = 0
    post({ type: 'html-changed', html: serialize() })
  }

  function editableTarget(el: unknown): HTMLElement | null {
    // 只认「带 data-cortex-id 且标签在白名单内」的元素;向上冒泡找最近的合法祖先。
    var node = el as HTMLElement | null
    while (node && node !== document.body) {
      if (node.getAttribute && node.getAttribute('data-cortex-id') && EDITABLE[node.tagName]) return node
      node = node.parentElement
    }
    return null
  }

  function clearSelection() {
    if (selected) {
      selected.removeAttribute('data-cortex-selected')
      selected.removeAttribute('contenteditable')
      selected = null
    }
  }

  function select(el: HTMLElement): void {
    if (selected === el) return
    clearSelection()
    selected = el
    el.setAttribute('data-cortex-selected', '1')
    var r = el.getBoundingClientRect()
    post({
      type: 'selected',
      elementId: el.getAttribute('data-cortex-id'),
      tagName: el.tagName,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height }
    })
  }

  // 监听挂在 body(而非 document):slide 内容恒在 body 内,冒泡照常;且页面导航/
  // 重建 body 时旧监听随之消亡,不会与新注入的实例叠加(注入是幂等的,但宿主可能在
  // 同一 document 上换页)。
  var host = document.body || document.documentElement

  host.addEventListener('click', function (e) {
    if (!editMode) return
    var target = editableTarget(e.target)
    if (!target) {
      clearSelection()
      post({ type: 'deselected' })
      return
    }
    select(target)
  })

  host.addEventListener('dblclick', function (e) {
    if (!editMode) return
    var target = editableTarget(e.target)
    if (!target) return
    select(target)
    target.setAttribute('contenteditable', 'true')
    target.focus()
  })

  host.addEventListener('input', function (e) {
    if (!editMode) return
    var target = e.target as HTMLElement | null
    if (target && target.getAttribute && target.getAttribute('contenteditable')) scheduleSave()
  })

  host.addEventListener('keydown', function (e) {
    if (!editMode) return
    // Delete:仅删除「已选中且非编辑中」的元素(编辑中要保留删字符的原生行为)。
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !selected.getAttribute('contenteditable')) {
      e.preventDefault()
      selected.remove()
      selected = null
      post({ type: 'deselected' })
      scheduleSave()
    }
    if (e.key === 'Escape') {
      flush()
      clearSelection()
      post({ type: 'deselected' })
    }
  })

  // 离开页面前冲刷 pending save(切页/关闭时不丢最后一次编辑)。
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)

  ;(window as unknown as Record<string, unknown>).__cortexSlidesBridge = {
    // 宿主拉取:取走并清空缓冲。
    drain: function (): Record<string, unknown>[] {
      var items = outbox
      outbox = []
      return items
    },
    exec: function (command: Record<string, unknown> | undefined): void {
      if (!command || typeof command.type !== 'string') return
      switch (command.type) {
        case 'set-edit-mode':
          editMode = command.enabled === true
          if (!editMode) {
            flush()
            clearSelection()
          }
          break
        case 'format':
          if (!selected) return
          if (command.command === 'bold') {
            selected.style.fontWeight = selected.style.fontWeight === '700' ? '' : '700'
          } else if (command.command === 'italic') {
            selected.style.fontStyle = selected.style.fontStyle === 'italic' ? '' : 'italic'
          } else if (command.command === 'underline') {
            selected.style.textDecoration = selected.style.textDecoration === 'underline' ? '' : 'underline'
          }
          scheduleSave()
          break
        case 'font-size':
          if (!selected || typeof command.px !== 'number') return
          selected.style.fontSize = command.px + 'px'
          scheduleSave()
          break
        case 'color':
          if (!selected || typeof command.hex !== 'string') return
          if (!/^#[0-9a-fA-F]{3,8}$/.test(command.hex)) return
          selected.style.color = command.hex
          scheduleSave()
          break
        case 'align':
          if (!selected) return
          if (command.value !== 'left' && command.value !== 'center' && command.value !== 'right') return
          selected.style.textAlign = command.value
          scheduleSave()
          break
        case 'delete-selected':
          if (!selected) return
          selected.remove()
          selected = null
          post({ type: 'deselected' })
          scheduleSave()
          break
        case 'flush':
          flush()
          break
      }
    }
  }

  // 选中框样式(标记 data-cortex-bridge,序列化时剥离)。
  var style = document.createElement('style')
  style.setAttribute('data-cortex-bridge', '1')
  style.textContent =
    '[data-cortex-selected]{outline:2px solid #3b82d8 !important;outline-offset:2px;}' +
    '[contenteditable="true"]{cursor:text;}'
  document.head.appendChild(style)

  post({ type: 'ready' })
}
/* eslint-enable */

/** 生成可直接 executeJavaScript 的注入源码(幂等:重复注入不会重复挂载)。 */
export function buildSlideEditBridgeSource(): string {
  const config = JSON.stringify({
    protocol: SLIDE_BRIDGE_PROTOCOL,
    editableTags: [...EDITABLE_TAGS],
    debounceMs: EDIT_SAVE_DEBOUNCE_MS
  })
  // 幂等守卫:webview 每次 dom-ready 都会注入,已挂载则跳过。
  return `(function(){ if (window.__cortexSlidesBridge) return; (${slideEditBridgeInPage.toString()})(${config}); })()`
}

/** 校验并归一化一次 drain 的结果:逐条过协议校验,不合法项静默丢弃。 */
export function parseSlideBridgeDrain(raw: unknown): SlideBridgeInboundMessage[] {
  if (!Array.isArray(raw)) return []
  const messages: SlideBridgeInboundMessage[] = []
  for (const item of raw) {
    const parsed = parseSlideBridgeMessage(item)
    if (parsed) messages.push(parsed)
  }
  return messages
}
