// Slide 编辑 bridge 的页内注入脚本本体。传输模型/能力清单/安全契约见
// slide-edit-bridge.ts 的头注释;宿主经 buildSlideEditBridgeSource 把本函数
// toString 后注入 webview guest。
// 约束:函数必须自包含 —— 不引用模块内其它符号(配置经参数注入),否则
// toString 注入后运行时引用悬空。

import type { SlideExtrasApi, SlideExtrasCtx } from './slide-edit-inpage-extras'

/* eslint-disable */
// 页内注入脚本(自包含函数,toString 后由宿主 executeJavaScript 注入)。
// 约束:不引用闭包外变量;只经 outbox + 宿主 drain 通信;不触碰任何 Node/preload API。
// 类型注解仅为通过本包 typecheck —— 编译时被擦除,不影响 toString() 注入的运行时代码;
// 因此这里不得使用任何需要运行时 helper 的 TS 构造(enum/装饰器/参数属性等)。
// extrasFactory:扩展子系统(框选/旋转/z-order,见 slide-edit-inpage-extras.ts)的
// 工厂,由 builder 一并 toString 注入后作为参数传入。
export function slideEditBridgeInPage(
  config: { protocol: number; editableTags: string[]; debounceMs: number; textMax: number; htmlMaxBytes: number },
  extrasFactory?: (ctx: SlideExtrasCtx) => SlideExtrasApi
) {
  var PROTOCOL = config.protocol
  var HTML_MAX = config.htmlMaxBytes
  var EDITABLE: Record<string, boolean> = {}
  for (var i = 0; i < config.editableTags.length; i++) EDITABLE[config.editableTags[i]!] = true
  // 图形类可选中/移动标签(不开放文字编辑)。
  var MOVABLE: Record<string, boolean> = { SVG: true, IMG: true, VIDEO: true, CANVAS: true, TABLE: true, FIGURE: true }
  var DEBOUNCE_MS = config.debounceMs
  var TEXT_MAX = config.textMax
  // 选区:有序数组(多选成组移动/批量命令按此遍历)。
  var selected: HTMLElement[] = []
  var saveTimer: ReturnType<typeof setTimeout> | 0 = 0
  var editMode = true
  // 就地补 id 的序号(仅当元素缺 data-cortex-id 时使用;随保存落盘后长期有效)。
  var idSeq = 0
  // 拖拽结束后抑制紧随的 click(否则拖完会被当成点击改写选区)。
  var suppressClick = false
  // 方向键微调的撤销步合并窗计时。
  var lastNudgeAt = 0
  // 扩展子系统(框选/旋转/z-order):初始化末尾由 extrasFactory 装配。
  var extras: SlideExtrasApi | null = null
  // 出队缓冲:宿主经 drain() 拉取(webview guest 无法直接 postMessage 到宿主)。
  // 上限保护:队列只保留最近 32 条,避免宿主长时间不 drain 时无限增长。
  var outbox: Record<string, unknown>[] = []

  function post(msg: Record<string, unknown>): void {
    msg.__cortexSlides = PROTOCOL
    // html-changed / selection-changed 都只保留最新一条(全量快照语义,旧的没有价值)。
    if (msg.type === 'html-changed' || msg.type === 'selection-changed') {
      outbox = outbox.filter(function (m) {
        return m.type !== msg.type
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
    // 拖拽期间临时禁用的选字样式不落盘。
    var bodyClone = clone.querySelector('body')
    if (bodyClone) {
      ;(bodyClone as HTMLElement).style.removeProperty('user-select')
      if (!bodyClone.getAttribute('style')) bodyClone.removeAttribute('style')
    }
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

  function excerpt(el: HTMLElement): string {
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim()
    return t.length > TEXT_MAX ? t.slice(0, TEXT_MAX) : t
  }

  function ensureId(el: HTMLElement): string {
    var id = el.getAttribute('data-cortex-id')
    if (!id) {
      idSeq += 1
      id = 'edit-' + idSeq
      el.setAttribute('data-cortex-id', id)
      // 新 id 需落盘:否则 LLM 拿到的 id 在文件里不存在,无从修订。
      scheduleSave()
    }
    return id
  }

  // 选区全量上报(宿主存 slides-store,发消息时并入 LLM 上下文)。
  function postSelection(): void {
    var items: Record<string, unknown>[] = []
    for (var i = 0; i < selected.length; i++) {
      var el = selected[i]!
      var r = el.getBoundingClientRect()
      items.push({
        elementId: ensureId(el),
        tagName: el.tagName,
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        text: excerpt(el)
      })
    }
    post({ type: 'selection-changed', items: items })
    // 选区变化即刷新缩放手柄(单选显示、其余隐藏)。
    updateHandles()
  }

  function isSelected(el: HTMLElement): boolean {
    return selected.indexOf(el) !== -1
  }

  function applySelection(next: HTMLElement[]): void {
    // 空 → 空不重复上报(如 set-edit-mode(false) 时本就无选区)。
    if (!selected.length && !next.length) return
    for (var i = 0; i < selected.length; i++) {
      if (next.indexOf(selected[i]!) === -1) {
        selected[i]!.removeAttribute('data-cortex-selected')
        selected[i]!.removeAttribute('contenteditable')
      }
    }
    selected = next
    for (var j = 0; j < selected.length; j++) selected[j]!.setAttribute('data-cortex-selected', '1')
    postSelection()
  }

  // 纯文本块:自身有非空的直接文本节点,且元素子级全是内联层(BR / display:inline*)。
  // 覆盖「div 里直接放 emoji / 短语」这类不在标签白名单里的可编辑目标。
  function isTextBlockLike(el: HTMLElement): boolean {
    var hasText = false
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i] as HTMLElement
      if (c.nodeType === 3) {
        if (c.textContent && c.textContent.trim()) hasText = true
      } else if (c.nodeType === 1) {
        if (c.tagName !== 'BR' && getComputedStyle(c).display.indexOf('inline') !== 0) return false
      }
    }
    return hasText
  }

  // 文字可编辑目标:白名单标签或最近的「纯文本块」祖先。
  function editableTarget(el: unknown): HTMLElement | null {
    var node = el as HTMLElement | null
    while (node && node !== document.body) {
      if (node.tagName && EDITABLE[node.tagName]) return node
      if (node.nodeType === 1 && isTextBlockLike(node)) return node
      node = node.parentElement
    }
    return null
  }

  // 可选中/移动目标:文字目标之外,还接受图形类标签与绝对/固定定位块(卡片、贴纸等)。
  function selectTarget(el: unknown): HTMLElement | null {
    var node = el as HTMLElement | null
    // 桥附属节点(缩放手柄、参考线)不是页面内容,永不作为选择目标。
    // text node 没有 closest,退回父元素判断。
    var probe = node && typeof (node as { closest?: unknown }).closest === 'function' ? node : node ? node.parentElement : null
    if (probe && probe.closest('[data-cortex-bridge]')) return null
    while (node && node !== document.body && node !== document.documentElement) {
      // SVG 内部子节点统一归并到 <svg> 根(内部 shape 不单独选,整体移动才有意义)。
      var ownerSvg = (node as unknown as { ownerSVGElement?: HTMLElement | null }).ownerSVGElement
      if (ownerSvg) {
        node = ownerSvg
        continue
      }
      if (node.nodeType !== 1) {
        node = node.parentElement
        continue
      }
      if (node.tagName && EDITABLE[node.tagName]) return node
      if (isTextBlockLike(node)) return node
      if (node.tagName && MOVABLE[node.tagName.toUpperCase()]) return node
      var pos = getComputedStyle(node).position
      if (pos === 'absolute' || pos === 'fixed') {
        // 满画布(≥90% 视口)的定位容器视为页面背景:点它=点空白(清选区/发起框选),
        // 否则整页 wrapper 会拦下所有空白交互。图形/文本类元素在上方分支已返回,
        // 满画布背景图仍可正常点选。
        var nr = node.getBoundingClientRect()
        if (nr.width >= (window.innerWidth || 1280) * 0.9 && nr.height >= (window.innerHeight || 720) * 0.9) {
          node = node.parentElement
          continue
        }
        return node
      }
      node = node.parentElement
    }
    return null
  }

  // 接管元素定位,返回移动基准:absolute/fixed 以现有偏移为基准并释放 right/bottom
  //(避免 left+right 双约束把元素拉伸);流内元素转 position:relative 偏移(不脱离
  // 文档流,不影响兄弟布局)。
  function positionBase(el: HTMLElement): { el: HTMLElement; left: number; top: number } {
    var cs = getComputedStyle(el)
    var pos = cs.position
    var left = parseFloat(cs.left)
    var top = parseFloat(cs.top)
    if (pos === 'absolute' || pos === 'fixed') {
      if (isNaN(left)) left = (el as { offsetLeft?: number }).offsetLeft || 0
      if (isNaN(top)) top = (el as { offsetTop?: number }).offsetTop || 0
      el.style.right = 'auto'
      el.style.bottom = 'auto'
    } else {
      if (pos === 'static') el.style.position = 'relative'
      if (isNaN(left)) left = 0
      if (isNaN(top)) top = 0
    }
    return { el: el, left: left, top: top }
  }

  function moveBy(items: { el: HTMLElement; left: number; top: number }[], dx: number, dy: number): void {
    for (var i = 0; i < items.length; i++) {
      items[i]!.el.style.left = Math.round(items[i]!.left + dx) + 'px'
      items[i]!.el.style.top = Math.round(items[i]!.top + dy) + 'px'
    }
    // 拖拽/微调过程中手柄实时跟随(选区上报只在结束时发,手柄不能等)。
    updateHandles()
  }

  // —— 粘贴图片:仅接受 base64 位图 data URL(SVG 可携带脚本,不收)。
  var IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/

  // 把图片以 data URL 插入画布中央(绝对定位、可移动),插入后自动选中。
  // 粘贴管线与宿主 insert-image 命令共用;所有入参按不可信输入校验。
  function insertImage(dataUrl: unknown, width: unknown, height: unknown): void {
    if (typeof dataUrl !== 'string' || !IMAGE_DATA_URL_RE.test(dataUrl)) return
    if (typeof width !== 'number' || typeof height !== 'number' || !(width > 0) || !(height > 0)) return
    // 预算守卫:插入后整页若逼近 2MB 上限,html-changed 会被宿主/主进程静默丢弃,
    // 表现为「编辑不再保存」的隐性故障 —— 宁可拒绝本次插入。
    if (document.documentElement.outerHTML.length + dataUrl.length > HTML_MAX - 64 * 1024) return
    var w = Math.max(1, Math.min(1280, Math.round(width)))
    var h = Math.max(1, Math.min(720, Math.round(height)))
    capture()
    var img = document.createElement('img')
    img.src = dataUrl
    // 禁用原生 HTML5 拖拽,避免与 bridge 自己的 mousedown 拖动管线抢事件。
    img.draggable = false
    img.style.position = 'absolute'
    img.style.left = Math.round((1280 - w) / 2) + 'px'
    img.style.top = Math.round((720 - h) / 2) + 'px'
    img.style.width = w + 'px'
    img.style.height = h + 'px'
    document.body.appendChild(img)
    ensureId(img)
    applySelection([img])
    scheduleSave()
  }

  // 元素是否参与层级比较/框选命中:定位元素、图形类标签、可编辑文本、文本块。
  // (z-order 与框选的实现在 extras 子系统,见文件尾部的 extrasFactory 装配。)
  function isLayerParticipant(el: HTMLElement): boolean {
    if (el.nodeType !== 1) return false
    if (el.closest && el.closest('[data-cortex-bridge]')) return false
    if ((el as unknown as { ownerSVGElement?: unknown }).ownerSVGElement) return false
    var cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return false
    return (
      cs.position !== 'static' ||
      !!(el.tagName && (MOVABLE[el.tagName.toUpperCase()] || EDITABLE[el.tagName])) ||
      isTextBlockLike(el)
    )
  }

  // —— 缩放手柄:单选时沿元素包围盒摆 8 个手柄(图片只出四角)。手柄是 fixed 定位的
  // 桥附属节点(data-cortex-bridge,序列化剥离),不参与页面布局。
  // x/y 为手柄在包围盒上的归一位置(0=西/北缘,1=东/南缘,0.5=边中点)。
  var HANDLE_DEFS = [
    { key: 'nw', x: 0, y: 0, cursor: 'nwse-resize' },
    { key: 'n', x: 0.5, y: 0, cursor: 'ns-resize' },
    { key: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
    { key: 'e', x: 1, y: 0.5, cursor: 'ew-resize' },
    { key: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
    { key: 's', x: 0.5, y: 1, cursor: 'ns-resize' },
    { key: 'sw', x: 0, y: 1, cursor: 'nesw-resize' },
    { key: 'w', x: 0, y: 0.5, cursor: 'ew-resize' }
  ]
  var handleLayer: HTMLElement | null = null
  var handleDots: { el: HTMLElement; def: { key: string; x: number; y: number; cursor: string } }[] = []
  var RESIZE_MIN_PX = 16

  // 图片类内容变形会失真,缩放锁定初始宽高比。
  function isProportional(el: HTMLElement): boolean {
    return el.tagName === 'IMG' || el.tagName === 'VIDEO'
  }

  function ensureHandleLayer(): HTMLElement {
    if (handleLayer) return handleLayer
    var layer = document.createElement('div')
    layer.setAttribute('data-cortex-bridge', '1')
    layer.setAttribute('data-cortex-handles', '1')
    layer.style.position = 'fixed'
    layer.style.zIndex = '2147483647'
    // 容器不拦截事件,只有手柄点自身可交互。
    layer.style.pointerEvents = 'none'
    handleDots = []
    for (var i = 0; i < HANDLE_DEFS.length; i++) {
      var def = HANDLE_DEFS[i]!
      var dot = document.createElement('div')
      dot.setAttribute('data-key', def.key)
      dot.style.position = 'fixed'
      dot.style.width = '8px'
      dot.style.height = '8px'
      dot.style.background = '#fff'
      dot.style.border = '1.5px solid #3b82d8'
      dot.style.borderRadius = '2px'
      dot.style.boxSizing = 'border-box'
      dot.style.pointerEvents = 'auto'
      dot.style.cursor = def.cursor
      ;(function (boundDef) {
        dot.addEventListener('mousedown', function (e) {
          var me = e as MouseEvent
          if (me.button !== 0 || !editMode || selected.length !== 1) return
          startResize(selected[0]!, boundDef, me)
        })
      })(def)
      layer.appendChild(dot)
      handleDots.push({ el: dot, def: def })
    }
    document.body.appendChild(layer)
    handleLayer = layer
    return layer
  }

  // 手柄跟随选区包围盒;仅单选显示(多选缩放语义不明,隐藏)。
  function updateHandles(): void {
    if (!editMode || selected.length !== 1) {
      if (handleLayer) handleLayer.style.display = 'none'
      if (extras) extras.refreshUi()
      return
    }
    var el = selected[0]!
    var layer = ensureHandleLayer()
    layer.style.display = 'block'
    var r = el.getBoundingClientRect()
    var prop = isProportional(el)
    // 旋转 v1 约定:旋转态下 AABB 与元素真实四角错位,缩放手柄整组隐藏
    //(旋转手柄本身由 extras 维护,仍显示)。
    var rotated = /rotate\(/.test(el.style.transform || '')
    for (var i = 0; i < handleDots.length; i++) {
      var dot = handleDots[i]!
      // 等比元素的边中点手柄(单轴缩放)与等比语义冲突,隐藏。
      if (rotated || (prop && dot.def.key.length === 1)) {
        dot.el.style.display = 'none'
        continue
      }
      dot.el.style.display = 'block'
      dot.el.style.left = Math.round(r.left + dot.def.x * r.width - 4) + 'px'
      dot.el.style.top = Math.round(r.top + dot.def.y * r.height - 4) + 'px'
    }
    if (extras) extras.refreshUi()
  }

  // 手柄拖拽缩放。文本/容器自由调宽高(nowrap 文本先转 normal,调宽即自动折行);
  // 图片按下时的宽高比等比缩放;西/北侧手柄通过反向补偿 left/top 锚定对侧边。
  function startResize(el: HTMLElement, def: { key: string; x: number; y: number; cursor: string }, me: MouseEvent): void {
    me.preventDefault()
    me.stopPropagation()
    // 复用拖拽的 click 抑制:缩放结束后紧随的 click 不得改写选区。
    suppressClick = true
    var startX = me.clientX
    var startY = me.clientY
    var rect0 = el.getBoundingClientRect()
    var cs = getComputedStyle(el)
    // computed 尺寸拿不到时退回包围盒(box-sizing 差异只影响绝对值,不影响增量一致性)。
    var startW = parseFloat(cs.width) || rect0.width
    var startH = parseFloat(cs.height) || rect0.height
    var prop = isProportional(el)
    var aspect = startH > 0 ? startW / startH : 1
    // 方向系数:西/北侧手柄鼠标左/上移是「变大」。0 表示该轴不参与(边中点手柄)。
    var sx = def.x === 0 ? -1 : def.x === 1 ? 1 : 0
    var sy = def.y === 0 ? -1 : def.y === 1 ? 1 : 0
    var started = false
    var base: { el: HTMLElement; left: number; top: number } | null = null
    function onResizeMove(ev: Event): void {
      var mv = ev as MouseEvent
      var dx = (mv.clientX - startX) * sx
      var dy = (mv.clientY - startY) * sy
      if (!started) {
        started = true
        // 撤销点与定位接管推迟到确有位移时(空点手柄不产生编辑)。
        capture()
        base = positionBase(el)
        if (!prop && cs.whiteSpace.indexOf('nowrap') !== -1) el.style.whiteSpace = 'normal'
        // 解除宽/高约束,否则 style.width 被钳制,拖宽手柄毫无视觉效果
        // (生成页面的文本块普遍带 max-width;用户实测:上下能拉、左右拉不动)。
        if (sx || prop) {
          if (cs.maxWidth !== 'none') el.style.maxWidth = 'none'
          // inline 元素不吃 width,转 inline-block(不破坏行内上下文)。
          if (cs.display === 'inline') el.style.display = 'inline-block'
        }
        if ((sy || prop) && cs.maxHeight !== 'none') el.style.maxHeight = 'none'
        // flex 子项的尺寸可能被 grow/shrink/basis 接管,固定为显式宽高。
        var parentEl = el.parentElement
        if (parentEl && getComputedStyle(parentEl).display.indexOf('flex') !== -1) {
          el.style.flexGrow = '0'
          el.style.flexShrink = '0'
          el.style.flexBasis = 'auto'
        }
        document.body.style.userSelect = 'none'
      }
      var newW = startW
      var newH = startH
      if (prop) {
        // 等比:取投影更大的轴主导,另一轴按比例跟随。
        newW = Math.max(RESIZE_MIN_PX, startW + (Math.abs(dx) >= Math.abs(dy * aspect) ? dx : dy * aspect))
        newH = Math.max(RESIZE_MIN_PX, newW / aspect)
        newW = newH * aspect
      } else {
        if (sx) newW = Math.max(RESIZE_MIN_PX, startW + dx)
        if (sy) newH = Math.max(RESIZE_MIN_PX, startH + dy)
      }
      el.style.width = Math.round(newW) + 'px'
      if (prop || sy) el.style.height = Math.round(newH) + 'px'
      // 锚定对侧:西/北手柄的尺寸增量由 left/top 反向吃掉(用实际应用值,含 min 钳制)。
      if (def.x === 0) el.style.left = Math.round(base!.left - (Math.round(newW) - startW)) + 'px'
      if (def.y === 0 && (prop || sy)) el.style.top = Math.round(base!.top - (Math.round(newH) - startH)) + 'px'
      updateHandles()
      mv.preventDefault()
    }
    function onResizeUp(): void {
      document.removeEventListener('mousemove', onResizeMove, true)
      document.removeEventListener('mouseup', onResizeUp, true)
      if (started) {
        document.body.style.userSelect = ''
        postSelection()
        scheduleSave()
      }
    }
    document.addEventListener('mousemove', onResizeMove, true)
    document.addEventListener('mouseup', onResizeUp, true)
  }

  // —— 撤销/重做:全量 body 快照栈。恢复用 innerHTML 整体替换(body 元素本身不换,
  // 挂在 body 上的监听器存活);旧元素引用随之失效,选区一并清空。
  var undoStack: string[] = []
  var redoStack: string[] = []
  var HISTORY_LIMIT = 50

  function cleanBodyHtml(): string {
    var clone = document.body.cloneNode(true) as HTMLElement
    var marked = clone.querySelectorAll('[contenteditable],[data-cortex-selected]')
    for (var i = 0; i < marked.length; i++) {
      marked[i]!.removeAttribute('contenteditable')
      marked[i]!.removeAttribute('data-cortex-selected')
    }
    var injected = clone.querySelectorAll('[data-cortex-bridge]')
    for (var j = 0; j < injected.length; j++) injected[j]!.remove()
    return clone.innerHTML
  }

  function postHistory(): void {
    post({ type: 'history-changed', canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 })
  }

  // 在每次「将要改动 DOM」的动作前调用:入栈当前状态作为撤销点;新动作清空 redo 分支。
  function capture(): void {
    var snap = cleanBodyHtml()
    if (undoStack.length && undoStack[undoStack.length - 1] === snap) return
    undoStack.push(snap)
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
    redoStack = []
    postHistory()
  }

  function restoreBody(html: string): void {
    selected = []
    // 参考线/缩放手柄等 bridge 附属节点随 innerHTML 替换消亡,引用一并复位
    // (否则 ensureHandleLayer 会复用已脱离文档的节点,手柄从此消失)。
    guideV = null
    guideH = null
    handleLayer = null
    handleDots = []
    if (extras) extras.resetUi()
    // 安全性:html 只来自本 document 自身的历史快照(cleanBodyHtml 在同一沙箱 guest 内
    // 捕获),恢复它不引入任何新来源的内容;guest 本就无 preload/Node 能力。
    document.body.innerHTML = html
    postSelection()
    scheduleSave()
    postHistory()
  }

  function undo(): void {
    if (!undoStack.length) return
    redoStack.push(cleanBodyHtml())
    restoreBody(undoStack.pop()!)
  }

  function redo(): void {
    if (!redoStack.length) return
    undoStack.push(cleanBodyHtml())
    restoreBody(redoStack.pop()!)
  }

  // —— 吸附对齐:拖拽时把组包围盒的边/中线吸附到画布边缘/中线与其它定位元素的边/中线。
  var SNAP_PX = 5
  // 速度自适应门限(px/ms):指针快于此值时不吸附(意图是路过),慢速才启用(意图是对齐)。
  var SNAP_MAX_VEL = 1.2
  var guideV: HTMLElement | null = null
  var guideH: HTMLElement | null = null

  function collectSnapLines(): { xs: number[]; ys: number[] } {
    // 页面即 1280×720 固定画布(slides 合同保证),viewport 坐标 == 画布坐标。
    var xs = [0, 640, 1280]
    var ys = [0, 360, 720]
    var all = document.body.querySelectorAll('*')
    for (var i = 0; i < all.length; i++) {
      var el = all[i] as HTMLElement
      // 跳过选区自身与其子孙、SVG 内部节点、bridge 附属节点。
      if (el.closest && el.closest('[data-cortex-selected],[data-cortex-bridge]')) continue
      if ((el as unknown as { ownerSVGElement?: unknown }).ownerSVGElement) continue
      var cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      var movableTag = !!(el.tagName && MOVABLE[el.tagName.toUpperCase()])
      if (cs.position !== 'absolute' && cs.position !== 'fixed' && !movableTag) continue
      var r = el.getBoundingClientRect()
      if (r.width < 8 || r.height < 8) continue
      xs.push(r.left, r.left + r.width / 2, r.left + r.width)
      ys.push(r.top, r.top + r.height / 2, r.top + r.height)
    }
    return { xs: xs, ys: ys }
  }

  // 求组包围盒(左/中/右 × 上/中/下)到候选线的最近吸附;超过阈值返回不吸附。
  function snapAdjust(
    rect: { left: number; top: number; w: number; h: number },
    lines: { xs: number[]; ys: number[] }
  ): { dx: number; dy: number; x: number | null; y: number | null } {
    var result = { dx: 0, dy: 0, x: null as number | null, y: null as number | null }
    var anchorsX = [rect.left, rect.left + rect.w / 2, rect.left + rect.w]
    var anchorsY = [rect.top, rect.top + rect.h / 2, rect.top + rect.h]
    var bestX = Infinity
    var bestY = Infinity
    for (var i = 0; i < anchorsX.length; i++) {
      for (var j = 0; j < lines.xs.length; j++) {
        var dxv = lines.xs[j]! - anchorsX[i]!
        if (Math.abs(dxv) < Math.abs(bestX)) {
          bestX = dxv
          result.x = lines.xs[j]!
        }
      }
      for (var k = 0; k < lines.ys.length; k++) {
        var dyv = lines.ys[k]! - anchorsY[i]!
        if (Math.abs(dyv) < Math.abs(bestY)) {
          bestY = dyv
          result.y = lines.ys[k]!
        }
      }
    }
    if (Math.abs(bestX) <= SNAP_PX) result.dx = bestX
    else result.x = null
    if (Math.abs(bestY) <= SNAP_PX) result.dy = bestY
    else result.y = null
    return result
  }

  function showGuide(axis: string, at: number | null): void {
    var guide = axis === 'v' ? guideV : guideH
    if (at === null) {
      if (guide) guide.style.display = 'none'
      return
    }
    if (!guide) {
      guide = document.createElement('div')
      guide.setAttribute('data-cortex-bridge', '1')
      guide.style.position = 'fixed'
      guide.style.zIndex = '2147483647'
      guide.style.pointerEvents = 'none'
      guide.style.background = '#3b82d8'
      if (axis === 'v') {
        guide.style.top = '0'
        guide.style.bottom = '0'
        guide.style.width = '1px'
        guideV = guide
      } else {
        guide.style.left = '0'
        guide.style.right = '0'
        guide.style.height = '1px'
        guideH = guide
      }
      document.body.appendChild(guide)
    }
    guide.style.display = 'block'
    if (axis === 'v') guide.style.left = at + 'px'
    else guide.style.top = at + 'px'
  }

  function hideGuides(): void {
    showGuide('v', null)
    showGuide('h', null)
  }

  // 选区包围盒(viewport 坐标)。
  function boundsOf(els: HTMLElement[]): { left: number; top: number; w: number; h: number } {
    var left = Infinity
    var top = Infinity
    var right = -Infinity
    var bottom = -Infinity
    for (var i = 0; i < els.length; i++) {
      var r = els[i]!.getBoundingClientRect()
      if (r.left < left) left = r.left
      if (r.top < top) top = r.top
      if (r.left + r.width > right) right = r.left + r.width
      if (r.top + r.height > bottom) bottom = r.top + r.height
    }
    return { left: left, top: top, w: right - left, h: bottom - top }
  }

  // 监听挂在 body(而非 document):slide 内容恒在 body 内,冒泡照常;且页面导航/
  // 重建 body 时旧监听随之消亡,不会与新注入的实例叠加(注入是幂等的,但宿主可能在
  // 同一 document 上换页)。拖拽期间的 mousemove/mouseup 例外地临时挂 document
  //(鼠标可能移出元素),mouseup 时自清。
  var host = document.body || document.documentElement

  host.addEventListener('mousedown', function (e) {
    if (!editMode) return
    var me = e as MouseEvent
    if (me.button !== 0) return
    suppressClick = false
    var target = selectTarget(me.target)
    if (!target) return
    // 正在文字编辑的元素交给原生光标/选字,不启动拖拽。
    if (target.getAttribute && target.getAttribute('contenteditable')) return
    var startX = me.clientX
    var startY = me.clientY
    var started = false
    var dragItems: { el: HTMLElement; left: number; top: number }[] = []
    // 拖拽期间覆盖的内联样式(逐项对应 dragItems):实时位移经 transform 反馈,
    // transition/animation 必须暂时关闭,否则页面模板的动效会让元素追赶鼠标。
    // 松手时完整恢复 value + priority,再把最终位移落盘到 left/top。
    var dragStyles: {
      transform: { value: string; priority: string }
      transition: { value: string; priority: string }
      animation: { value: string; priority: string }
      willChange: { value: string; priority: string }
    }[] = []
    var dragChrome: { el: HTMLElement; display: { value: string; priority: string } }[] = []
    var groupRect0 = { left: 0, top: 0, w: 0, h: 0 }
    var snapLines = { xs: [] as number[], ys: [] as number[] }
    // 指针速度采样(px/ms):快速移动时禁用吸附(意图是「路过」不是「对齐」),
    // 消除黏手/跳变;慢速精调时吸附照常。
    var lastMoveT = 0
    var lastMoveX = 0
    var lastMoveY = 0
    var pointerVel = 0
    var finalDx = 0
    var finalDy = 0
    function readInlineStyle(el: HTMLElement, name: string): { value: string; priority: string } {
      return {
        value: el.style.getPropertyValue(name),
        priority: el.style.getPropertyPriority(name)
      }
    }
    function restoreInlineStyle(
      el: HTMLElement,
      name: string,
      original: { value: string; priority: string }
    ): void {
      if (original.value) el.style.setProperty(name, original.value, original.priority)
      else el.style.removeProperty(name)
    }
    function applyMove(mv: { x: number; y: number; altKey: boolean; velocity: number }): void {
      var dx = mv.x - startX
      var dy = mv.y - startY
      if (!started) {
        // 2px 阈值区分点击与拖拽(点击不改写任何样式);再小会把手抖当拖拽。
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return
        started = true
        suppressClick = true
        // 拖未选中元素 → 先把它变成唯一选区;拖已选元素 → 成组移动整个选区。
        if (!isSelected(target!)) applySelection([target!])
        // 撤销点:改动样式前入栈。
        capture()
        // 吸附基准:组包围盒初值与候选线在拖拽开始时一次性采集(拖拽中元素在动,不能重采)。
        groupRect0 = boundsOf(selected)
        snapLines = collectSnapLines()
        for (var i = 0; i < selected.length; i++) {
          var selectedEl = selected[i]!
          dragItems.push(positionBase(selectedEl))
          var styles = {
            transform: readInlineStyle(selectedEl, 'transform'),
            transition: readInlineStyle(selectedEl, 'transition'),
            animation: readInlineStyle(selectedEl, 'animation'),
            willChange: readInlineStyle(selectedEl, 'will-change')
          }
          dragStyles.push(styles)
          // 页面模板可能在标签或样式表中使用 !important;拖动态也必须以最高
          // 优先级关闭补间/关键帧,避免视觉位置落后于真实指针。
          selectedEl.style.setProperty('transition', 'none', 'important')
          selectedEl.style.setProperty('animation', 'none', 'important')
          var willChange = styles.willChange.value
          if (!/(^|,\s*)transform(\s*,|$)/.test(willChange)) {
            selectedEl.style.setProperty('will-change', willChange ? willChange + ', transform' : 'transform')
          }
        }
        // 控制框刷新依赖 getBoundingClientRect,会强制布局。拖动中隐藏并停止测量,
        // 松手后由 moveBy 一次性按最终位置恢复。
        var chrome = document.querySelectorAll('[data-cortex-handles],[data-cortex-rotate]')
        for (var ci = 0; ci < chrome.length; ci++) {
          var chromeEl = chrome[ci] as HTMLElement
          dragChrome.push({ el: chromeEl, display: readInlineStyle(chromeEl, 'display') })
          chromeEl.style.setProperty('display', 'none', 'important')
        }
        document.body.style.userSelect = 'none'
      }
      // 吸附(Alt 按住或指针高速移动时禁用):对组包围盒做修正,整组一起贴线。
      var adj = { dx: 0, dy: 0, x: null as number | null, y: null as number | null }
      if (!mv.altKey && mv.velocity <= SNAP_MAX_VEL) {
        adj = snapAdjust(
          { left: groupRect0.left + dx, top: groupRect0.top + dy, w: groupRect0.w, h: groupRect0.h },
          snapLines
        )
      }
      finalDx = dx + adj.dx
      finalDy = dy + adj.dy
      // 实时反馈走 transform(前置 translate = 屏幕空间位移,不进布局管线,
      // 也不与元素既有 rotate/translate 冲突);left/top 到松手才写。
      for (var di = 0; di < dragItems.length; di++) {
        var orig = dragStyles[di]!.transform.value
        dragItems[di]!.el.style.setProperty(
          'transform',
          'translate(' + Math.round(finalDx) + 'px, ' + Math.round(finalDy) + 'px)' + (orig ? ' ' + orig : ''),
          'important'
        )
      }
      showGuide('v', adj.x)
      showGuide('h', adj.y)
    }
    function onMove(ev: Event): void {
      var mv = ev as MouseEvent
      // 速度必须按原始事件采样,不能等到帧提交时再算:同一帧内的快速掠过也应关闭吸附。
      var now = Date.now()
      if (lastMoveT && now > lastMoveT) {
        var mdx = mv.clientX - lastMoveX
        var mdy = mv.clientY - lastMoveY
        pointerVel = Math.sqrt(mdx * mdx + mdy * mdy) / (now - lastMoveT)
      }
      lastMoveT = now
      lastMoveX = mv.clientX
      lastMoveY = mv.clientY
      applyMove({ x: mv.clientX, y: mv.clientY, altKey: mv.altKey, velocity: pointerVel })
      if (Math.abs(mv.clientX - startX) >= 2 || Math.abs(mv.clientY - startY) >= 2) mv.preventDefault()
    }
    function onUp(): void {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      if (started) {
        document.body.style.userSelect = ''
        hideGuides()
        // 先还原页面元素的全部临时样式,再把最终位移落到 left/top
        //(落盘语义与旧实现一致,临时性能样式不会被保存)。
        for (var ri = 0; ri < dragItems.length; ri++) {
          var dragEl = dragItems[ri]!.el
          var original = dragStyles[ri]!
          restoreInlineStyle(dragEl, 'transform', original.transform)
          restoreInlineStyle(dragEl, 'transition', original.transition)
          restoreInlineStyle(dragEl, 'animation', original.animation)
          restoreInlineStyle(dragEl, 'will-change', original.willChange)
        }
        for (var ui = 0; ui < dragChrome.length; ui++) {
          restoreInlineStyle(dragChrome[ui]!.el, 'display', dragChrome[ui]!.display)
        }
        moveBy(dragItems, finalDx, finalDy)
        // rect 已变化,同步宿主;落盘走 debounce。
        postSelection()
        scheduleSave()
      }
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
  })

  host.addEventListener('click', function (e) {
    if (!editMode) return
    if (suppressClick) {
      suppressClick = false
      return
    }
    var me = e as MouseEvent
    var target = selectTarget(me.target)
    var additive = me.shiftKey || me.metaKey || me.ctrlKey
    if (!target) {
      if (!additive && selected.length) applySelection([])
      return
    }
    if (additive) {
      // Shift/Cmd+点击:切换该元素的选区成员身份。
      var next = selected.slice()
      var idx = next.indexOf(target)
      if (idx === -1) next.push(target)
      else next.splice(idx, 1)
      applySelection(next)
    } else if (!(selected.length === 1 && selected[0] === target)) {
      applySelection([target])
    }
  })

  host.addEventListener('dblclick', function (e) {
    if (!editMode) return
    var target = editableTarget((e as MouseEvent).target)
    if (!target) return
    if (!(selected.length === 1 && selected[0] === target)) applySelection([target])
    // 撤销点:进入文字编辑前的状态(编辑期间的输入合并为一步)。
    capture()
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
    var ke = e as KeyboardEvent
    var active = document.activeElement as HTMLElement | null
    var editing = !!(active && active.getAttribute && active.getAttribute('contenteditable'))
    if (editing) {
      // 编辑中:Esc 退出编辑并冲刷;其余按键(含 Delete 删字符、原生文本撤销)交给原生行为。
      if (ke.key === 'Escape') {
        active!.removeAttribute('contenteditable')
        flush()
      }
      return
    }
    // 撤销/重做快捷键(Cmd/Ctrl+Z,Shift 反向;Ctrl+Y 同 redo)。
    if ((ke.metaKey || ke.ctrlKey) && (ke.key === 'z' || ke.key === 'Z')) {
      ke.preventDefault()
      if (ke.shiftKey) redo()
      else undo()
      return
    }
    if ((ke.metaKey || ke.ctrlKey) && (ke.key === 'y' || ke.key === 'Y')) {
      ke.preventDefault()
      redo()
      return
    }
    if ((ke.key === 'Delete' || ke.key === 'Backspace') && selected.length) {
      ke.preventDefault()
      capture()
      for (var i = 0; i < selected.length; i++) selected[i]!.remove()
      selected = []
      postSelection()
      scheduleSave()
      return
    }
    // 方向键微调整个选区(Shift ×10);800ms 内的连续按键合并为一个撤销步。
    if (selected.length && (ke.key === 'ArrowLeft' || ke.key === 'ArrowRight' || ke.key === 'ArrowUp' || ke.key === 'ArrowDown')) {
      ke.preventDefault()
      var now = Date.now()
      if (now - lastNudgeAt > 800) capture()
      lastNudgeAt = now
      var step = ke.shiftKey ? 10 : 1
      var dx = ke.key === 'ArrowLeft' ? -step : ke.key === 'ArrowRight' ? step : 0
      var dy = ke.key === 'ArrowUp' ? -step : ke.key === 'ArrowDown' ? step : 0
      var items: { el: HTMLElement; left: number; top: number }[] = []
      for (var j = 0; j < selected.length; j++) items.push(positionBase(selected[j]!))
      moveBy(items, dx, dy)
      postSelection()
      scheduleSave()
      return
    }
    if (ke.key === 'Escape' && selected.length) {
      flush()
      applySelection([])
    }
  })

  // —— 画布内复制/粘贴所选元素:copy 把所选元素净化后的 outerHTML 写入系统剪贴板的
  // 自定义 mime(粘贴时优先识别;跨页粘贴同样可用),paste 克隆插回原元素旁并偏移。
  // 走系统剪贴板而非内部变量:菜单 Cmd+C/V 以 copy/paste 事件派发到 guest,
  // keydown 在 macOS 菜单加速器场景下未必可见。
  var ELEMENTS_MIME = 'application/x-cortex-slide-elements'
  var PASTE_OFFSET_PX = 16

  // 单个元素的净化 outerHTML(剥编辑态属性,与 serialize 同口径)。
  function cleanElementHtml(el: HTMLElement): string {
    var clone = el.cloneNode(true) as HTMLElement
    var marked = [clone].concat([].slice.call(clone.querySelectorAll('[contenteditable],[data-cortex-selected]')) as HTMLElement[])
    for (var i = 0; i < marked.length; i++) {
      marked[i]!.removeAttribute('contenteditable')
      marked[i]!.removeAttribute('data-cortex-selected')
    }
    return clone.outerHTML
  }

  // 防御性清洗:剪贴板 HTML 跨页面流转,按不可信输入处理 —— 根节点是脚本类标签
  // 直接拒绝,子树剥掉脚本类节点与 on* 事件属性。返回是否可用。
  function sanitizeClone(root: HTMLElement): boolean {
    var BLOCKED: Record<string, boolean> = { SCRIPT: true, IFRAME: true, OBJECT: true, EMBED: true, LINK: true, META: true }
    if (!root.tagName || BLOCKED[root.tagName.toUpperCase()]) return false
    var bad = root.querySelectorAll('script,iframe,object,embed,link,meta')
    for (var i = 0; i < bad.length; i++) bad[i]!.remove()
    var nodes = [root].concat([].slice.call(root.querySelectorAll('*')) as HTMLElement[])
    for (var j = 0; j < nodes.length; j++) {
      var attrs = nodes[j]!.attributes
      if (!attrs) continue
      for (var a = attrs.length - 1; a >= 0; a--) {
        if (attrs[a]!.name.toLowerCase().indexOf('on') === 0) nodes[j]!.removeAttribute(attrs[a]!.name)
      }
    }
    return true
  }

  function findByCortexId(id: string): HTMLElement | null {
    var candidates = document.querySelectorAll('[data-cortex-id]')
    for (var i = 0; i < candidates.length; i++) {
      if ((candidates[i] as HTMLElement).getAttribute('data-cortex-id') === id) return candidates[i] as HTMLElement
    }
    return null
  }

  // 粘贴元素:克隆插回原元素旁(继承同一容器的样式上下文);原元素已不在
  // (跨页粘贴)则挂 body。克隆整树旧 id 清空 —— 撞 id 会破坏 focus-element 锚定。
  function pasteElements(json: string): void {
    var items: unknown
    try {
      items = JSON.parse(json)
    } catch (err) {
      return
    }
    if (!Array.isArray(items) || !items.length || items.length > 64) return
    capture()
    var clones: HTMLElement[] = []
    for (var i = 0; i < items.length; i++) {
      var it = items[i] as { id?: unknown; html?: unknown }
      if (!it || typeof it.html !== 'string' || !it.html || it.html.length > HTML_MAX / 4) continue
      // DOMParser 惰性文档解析:脚本不执行、资源不加载、on* 不触发 ——
      // 直接 innerHTML 进(哪怕游离)div,img onerror 这类 handler 会在清洗前抢跑。
      var parsedDoc: Document | null = null
      try {
        parsedDoc = new DOMParser().parseFromString(it.html, 'text/html')
      } catch (err) {
        continue
      }
      var inert = parsedDoc && parsedDoc.body ? (parsedDoc.body.firstElementChild as HTMLElement | null) : null
      if (!inert || !sanitizeClone(inert)) continue
      // 清洗完成后才导入主文档。
      var clone = document.importNode(inert, true) as HTMLElement
      var anchor = typeof it.id === 'string' && it.id ? findByCortexId(it.id) : null
      if (anchor && anchor.parentElement) anchor.insertAdjacentElement('afterend', clone)
      else document.body.appendChild(clone)
      clone.removeAttribute('data-cortex-id')
      var stale = clone.querySelectorAll('[data-cortex-id]')
      for (var s = 0; s < stale.length; s++) stale[s]!.removeAttribute('data-cortex-id')
      clones.push(clone)
    }
    if (!clones.length) return
    // 与原元素错开一个偏移量,肉眼可辨「粘贴成功」;选中后 ensureId 补发新 id。
    for (var m = 0; m < clones.length; m++) moveBy([positionBase(clones[m]!)], PASTE_OFFSET_PX, PASTE_OFFSET_PX)
    applySelection(clones)
    scheduleSave()
  }

  host.addEventListener('copy', function (e) {
    if (!editMode || !selected.length) return
    // 文字编辑中的复制交给原生(复制的是选中文本,不是元素)。
    var active = document.activeElement as HTMLElement | null
    if (active && active.getAttribute && active.getAttribute('contenteditable')) return
    var ce = e as ClipboardEvent
    if (!ce.clipboardData) return
    var payload: { id: string; html: string }[] = []
    var parts: string[] = []
    for (var i = 0; i < selected.length; i++) {
      payload.push({ id: ensureId(selected[i]!), html: cleanElementHtml(selected[i]!) })
      parts.push(payload[i]!.html)
    }
    ce.clipboardData.setData(ELEMENTS_MIME, JSON.stringify(payload))
    // text/html 兜底:粘到外部应用时仍是合法片段。
    ce.clipboardData.setData('text/html', parts.join('\n'))
    ce.preventDefault()
  })

  // 粘贴:优先识别画布元素(自定义 mime,仅本编辑器的 copy 会写入),
  // 其次剪贴板位图(缩放 + webp 转码后插入画布)。文字编辑态与非图片粘贴
  // (如 contenteditable 里贴文字)不拦截,交给原生行为。
  host.addEventListener('paste', function (e) {
    if (!editMode) return
    var ce = e as ClipboardEvent
    var dt = ce.clipboardData
    if (!dt) return
    var activeNow = document.activeElement as HTMLElement | null
    var editingText = !!(activeNow && activeNow.getAttribute && activeNow.getAttribute('contenteditable'))
    var payload = ''
    try {
      payload = dt.getData(ELEMENTS_MIME) || ''
    } catch (err) {
      payload = ''
    }
    if (payload && !editingText) {
      ce.preventDefault()
      pasteElements(payload)
      return
    }
    if (!dt.items) return
    var file: File | null = null
    for (var pi = 0; pi < dt.items.length; pi++) {
      var it = dt.items[pi]!
      if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
        file = it.getAsFile()
        if (file) break
      }
    }
    if (!file) return
    ce.preventDefault()
    var objectUrl = URL.createObjectURL(file)
    var image = new Image()
    image.onload = function () {
      URL.revokeObjectURL(objectUrl)
      var nw = image.naturalWidth || 1
      var nh = image.naturalHeight || 1
      // 展示尺寸:等比缩进 1280×720 画布,不放大原图。
      var base = Math.min(1, 1280 / nw, 720 / nh)
      var dw = Math.max(1, Math.round(nw * base))
      var dh = Math.max(1, Math.round(nh * base))
      // 编码尺寸逐档下调 + 降质重试:大图(截屏常见数 MB)压进字节预算;
      // 展示尺寸始终用 dw/dh,低分辨率档只牺牲清晰度不缩小版面。
      // 统一 webp 转码顺带抹平 EXIF 等元数据。
      var attempts = [
        { scale: base, quality: 0.85 },
        { scale: base * 0.7, quality: 0.7 },
        { scale: base * 0.5, quality: 0.55 }
      ]
      for (var ai = 0; ai < attempts.length; ai++) {
        var ew = Math.max(1, Math.round(nw * attempts[ai]!.scale))
        var eh = Math.max(1, Math.round(nh * attempts[ai]!.scale))
        var canvas = document.createElement('canvas')
        canvas.width = ew
        canvas.height = eh
        var ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(image, 0, 0, ew, eh)
        var dataUrl = canvas.toDataURL('image/webp', attempts[ai]!.quality)
        // 预算取上限一半:留足页面本体与后续编辑余量;最后一档仍超限则交由
        // insertImage 的总量守卫拒绝。
        if (dataUrl.length <= HTML_MAX / 2 || ai === attempts.length - 1) {
          insertImage(dataUrl, dw, dh)
          return
        }
      }
    }
    image.onerror = function () {
      URL.revokeObjectURL(objectUrl)
    }
    image.src = objectUrl
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
            applySelection([])
          }
          break
        case 'format':
          if (!selected.length) return
          capture()
          for (var f = 0; f < selected.length; f++) {
            var el = selected[f]!
            if (command.command === 'bold') {
              el.style.fontWeight = el.style.fontWeight === '700' ? '' : '700'
            } else if (command.command === 'italic') {
              el.style.fontStyle = el.style.fontStyle === 'italic' ? '' : 'italic'
            } else if (command.command === 'underline') {
              el.style.textDecoration = el.style.textDecoration === 'underline' ? '' : 'underline'
            }
          }
          scheduleSave()
          break
        case 'font-size':
          if (!selected.length || typeof command.px !== 'number') return
          capture()
          for (var s = 0; s < selected.length; s++) selected[s]!.style.fontSize = command.px + 'px'
          scheduleSave()
          break
        case 'font-step': {
          if (!selected.length || typeof command.delta !== 'number') return
          capture()
          for (var fs = 0; fs < selected.length; fs++) {
            var cur = parseFloat(getComputedStyle(selected[fs]!).fontSize) || 16
            // 夹在 8–200px:防连点把字号步进到不可用区间。
            var next = Math.min(200, Math.max(8, cur + (command.delta as number)))
            selected[fs]!.style.fontSize = next + 'px'
          }
          scheduleSave()
          break
        }
        case 'color':
          if (!selected.length || typeof command.hex !== 'string') return
          if (!/^#[0-9a-fA-F]{3,8}$/.test(command.hex)) return
          capture()
          for (var c = 0; c < selected.length; c++) selected[c]!.style.color = command.hex as string
          scheduleSave()
          break
        case 'align':
          if (!selected.length) return
          if (command.value !== 'left' && command.value !== 'center' && command.value !== 'right') return
          capture()
          for (var a = 0; a < selected.length; a++) selected[a]!.style.textAlign = command.value as string
          scheduleSave()
          break
        case 'align-elements': {
          // 元素对齐:各选中元素向「选区包围盒」的边/中线看齐。单选无意义,直接忽略。
          if (selected.length < 2) return
          var av = command.value
          if (av !== 'left' && av !== 'center-x' && av !== 'right' && av !== 'top' && av !== 'center-y' && av !== 'bottom') return
          capture()
          // 包围盒在移动前一次性求得;逐元素位移用 relative/absolute 偏移,不影响
          // 兄弟布局,因此后续元素的 rect 不会被先移动的元素带偏。
          var abox = boundsOf(selected)
          for (var ae = 0; ae < selected.length; ae++) {
            var ael = selected[ae]!
            var ar = ael.getBoundingClientRect()
            var adx = 0
            var ady = 0
            if (av === 'left') adx = abox.left - ar.left
            else if (av === 'center-x') adx = abox.left + abox.w / 2 - (ar.left + ar.width / 2)
            else if (av === 'right') adx = abox.left + abox.w - (ar.left + ar.width)
            else if (av === 'top') ady = abox.top - ar.top
            else if (av === 'center-y') ady = abox.top + abox.h / 2 - (ar.top + ar.height / 2)
            else ady = abox.top + abox.h - (ar.top + ar.height)
            if (adx || ady) moveBy([positionBase(ael)], adx, ady)
          }
          postSelection()
          scheduleSave()
          break
        }
        case 'delete-selected':
          if (!selected.length) return
          capture()
          for (var d = 0; d < selected.length; d++) selected[d]!.remove()
          selected = []
          postSelection()
          scheduleSave()
          break
        case 'focus-element': {
          if (typeof command.elementId !== 'string' || !command.elementId || command.elementId.length > 256) return
          var candidates = document.querySelectorAll('[data-cortex-id]')
          var target: HTMLElement | null = null
          for (var fe = 0; fe < candidates.length; fe++) {
            var candidate = candidates[fe] as HTMLElement
            if (candidate.getAttribute('data-cortex-id') === command.elementId) {
              target = candidate
              break
            }
          }
          applySelection(target ? [target] : [])
          if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          break
        }
        case 'insert-image':
          insertImage(command.dataUrl, command.width, command.height)
          break
        case 'z-order': {
          if (!selected.length || !extras) return
          var zdir = command.value
          if (zdir !== 'up' && zdir !== 'down' && zdir !== 'front' && zdir !== 'back') return
          capture()
          // 实现在 extras 子系统(相对重叠元素比较绘制序调 z-index)。
          if (extras.zOrder(selected, zdir as string)) scheduleSave()
          break
        }
        case 'clear-selection':
          applySelection([])
          break
        case 'undo':
          undo()
          break
        case 'redo':
          redo()
          break
        case 'flush':
          flush()
          break
      }
    }
  }

  // 装配扩展子系统(框选/旋转/z-order):在全部监听注册之后调用,保证 extras 的
  // mousedown 监听排在主拖动监听之后(空白处主监听先行短路,框选才接手)。
  if (typeof extrasFactory === 'function') {
    extras = extrasFactory({
      isEditMode: function () {
        return editMode
      },
      getSelected: function () {
        return selected
      },
      applySelection: applySelection,
      capture: capture,
      scheduleSave: scheduleSave,
      postSelection: postSelection,
      suppressNextClick: function () {
        suppressClick = true
      },
      selectTarget: selectTarget,
      isLayerParticipant: isLayerParticipant,
      positionBase: positionBase,
      updateHandles: updateHandles,
      host: host
    })
  }

  // 选中框样式(标记 data-cortex-bridge,序列化时剥离)。
  var style = document.createElement('style')
  style.setAttribute('data-cortex-bridge', '1')
  style.textContent =
    '[data-cortex-selected]{outline:2px solid #3b82d8 !important;outline-offset:2px;cursor:move;}' +
    '[contenteditable="true"]{cursor:text;}'
  document.head.appendChild(style)

  post({ type: 'ready' })
}
/* eslint-enable */
