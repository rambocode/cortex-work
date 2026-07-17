// Slide 应用内编辑 bridge:宿主(renderer)与 slide webview 之间的受控消息协议。
//
// 传输模型(与仓库既有 design canvas 一致):**宿主 pull,不是 guest push**。
//   Electron `<webview>` 的 guest 是独立 frame,`window.parent.postMessage` 到不了
//   宿主;而给 webview 挂 preload 会把宿主能力暴露给 slide 页面。因此页内脚本只把
//   结构化消息压进 `window.__cortexSlidesBridge` 的队列,宿主经 executeJavaScript
//   周期性 drain(与 useDesignHtmlPreview.executeScript 同款通道)。
//
// 能力(editMode 下):
//  - 文字编辑:双击白名单标签/纯文本块进入 contenteditable;
//  - 选择:单击选中(蓝框),Shift/Cmd+单击切换多选,点空白清空;
//  - 移动:拖拽已选元素成组移动(absolute/fixed 调 left/top 并释放 right/bottom,
//    流内元素转 position:relative 偏移,不影响兄弟布局);方向键微调(Shift ×10);
//  - 删除:选中后 Delete/Backspace 批量删除;
//  - 撤销/重做:动作前入栈 body 快照(Cmd/Ctrl+Z、Shift+Cmd+Z / Ctrl+Y,或宿主工具栏
//    下发 undo/redo 命令);history-changed 消息驱动宿主按钮可用态;
//  - 吸附对齐:拖拽时组包围盒对画布边缘/中线与其它定位元素边/中线做 5px 吸附,
//    显示参考线(data-cortex-bridge 标记,不落盘);按住 Alt 临时禁用;
//  - 选区上报:selection-changed 携带 elementId/tagName/rect/文本摘要,宿主存入
//    slides-store,发消息时并入 LLM 回合的选区上下文(精准修订)。
//
// 安全契约(务必遵守):
//  - 版本化协议:每条消息必须带 `__cortexSlides: 1` 与白名单内的 type;任何不合协议的
//    输入(页面伪造的队列内容、未知 type、字段类型错、超大 HTML)一律丢弃 ——
//    绝不按 method name 派发。
//  - slide 页面拿不到 preload / Node 能力:落盘由宿主经 slides:saveEditedHtml IPC 完成,
//    主进程再做全量校验(路径/revision/字节数)。
//  - 可编辑目标 = 标签在 allowlist 内(见 EDITABLE_TAGS)或「纯文本块」(自身有直接
//    文本且子元素全为内联,如放 emoji 的 div);可选中/移动目标额外接受图形类标签
//    (svg/img/canvas/table 等)与绝对/固定定位块。不要求预先带 data-cortex-id ——
//    Agent 生成的页面常把 id 打在容器 div 上,若强依赖会导致整页不可编辑(用户实测)。
//    选中时缺 id 就地补打并随保存落盘,保证 LLM 修订有稳定锚点。
//  - presenter/导出渲染不注入本 bridge(见 export/html.ts 与 render.ts)。
//
// 保存策略:变更(文字/移动/删除/补 id)500ms debounce → 序列化整页 HTML(剥离编辑态
// 属性)→ 宿主携带 expectedRevision 保存;冲突时宿主停止自动保存并提示刷新(见 slides-store)。

/** 协议版本标记:宿主与页内脚本双向校验。 */
export const SLIDE_BRIDGE_PROTOCOL = 1

/** 可编辑标签白名单(纯文本类;结构性容器不开放就地编辑)。 */
export const EDITABLE_TAGS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'SPAN', 'LI', 'TD', 'TH', 'FIGCAPTION', 'BLOCKQUOTE', 'STRONG', 'EM'] as const

/** 宿主 drain 页内队列的表达式(返回 JSON 数组;页内未挂载 bridge 时返回空数组)。 */
export const DRAIN_SLIDE_BRIDGE_SOURCE =
  'window.__cortexSlidesBridge ? window.__cortexSlidesBridge.drain() : []'

/** 宿主 drain 轮询间隔:低于 debounce,保证一次编辑的保存延迟仍在亚秒级。 */
export const BRIDGE_DRAIN_INTERVAL_MS = 250

/** 选区条目的文本摘要上限(供 LLM 定位元素,不必带全文)。 */
export const SELECTION_TEXT_MAX = 120

/** 选区条目上限(异常页面千元素全选也不至于撑爆消息)。 */
export const SELECTION_ITEMS_MAX = 64

/** 一条选区条目:id 已确保存在(缺则页内就地补打)。 */
export type SlideBridgeSelectionItem = {
  elementId: string
  tagName: string
  rect: { x: number; y: number; w: number; h: number }
  /** 元素文本摘要(截断到 SELECTION_TEXT_MAX;无文本为空串)。 */
  text: string
}

/** 页内 → 宿主 的消息(只有这些 type 会被处理)。 */
export type SlideBridgeInboundMessage =
  | { __cortexSlides: 1; type: 'ready' }
  | { __cortexSlides: 1; type: 'selection-changed'; items: SlideBridgeSelectionItem[] }
  | { __cortexSlides: 1; type: 'html-changed'; html: string }
  | { __cortexSlides: 1; type: 'history-changed'; canUndo: boolean; canRedo: boolean }

/** 宿主 → 页内 的命令(经 executeJavaScript 调用页内 API)。 */
export type SlideBridgeCommand =
  | { type: 'set-edit-mode'; enabled: boolean }
  | { type: 'format'; command: 'bold' | 'italic' | 'underline' }
  | { type: 'font-size'; px: number }
  /** 字号增减(工具栏 A-/A+):按各选中元素当前 computed 字号步进。 */
  | { type: 'font-step'; delta: number }
  | { type: 'color'; hex: string }
  | { type: 'align'; value: 'left' | 'center' | 'right' }
  | { type: 'delete-selected' }
  | { type: 'focus-element'; elementId: string }
  | { type: 'clear-selection' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'flush' }

/** 单页 HTML 上限(与主进程 MAX_SLIDE_HTML_BYTES 一致;超限宿主直接拒绝,不发 IPC)。 */
export const MAX_EDITED_HTML_BYTES = 2 * 1024 * 1024

/** 文本编辑保存 debounce。 */
export const EDIT_SAVE_DEBOUNCE_MS = 500

// 校验一条选区条目;非法返回 null,文本超限截断(不整条丢弃)。
function parseSelectionItem(raw: unknown): SlideBridgeSelectionItem | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const rect = item.rect as Record<string, unknown> | undefined
  if (typeof item.elementId !== 'string' || !item.elementId) return null
  if (typeof item.tagName !== 'string') return null
  if (
    !rect ||
    typeof rect.x !== 'number' ||
    typeof rect.y !== 'number' ||
    typeof rect.w !== 'number' ||
    typeof rect.h !== 'number'
  ) {
    return null
  }
  const text = typeof item.text === 'string' ? item.text.slice(0, SELECTION_TEXT_MAX) : ''
  return {
    elementId: item.elementId,
    tagName: item.tagName,
    rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    text
  }
}

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
    case 'selection-changed': {
      if (!Array.isArray(msg.items)) return null
      const items: SlideBridgeSelectionItem[] = []
      for (const raw of msg.items.slice(0, SELECTION_ITEMS_MAX)) {
        const item = parseSelectionItem(raw)
        // 单条非法只丢该条,不整包丢弃(空数组本身就是「取消选择」的合法语义)。
        if (item) items.push(item)
      }
      return { __cortexSlides: 1, type: 'selection-changed', items }
    }
    case 'html-changed': {
      if (typeof msg.html !== 'string' || !msg.html) return null
      // 超大 HTML 直接丢弃:恶意/异常页面不得撑爆 IPC 与磁盘。
      if (msg.html.length > MAX_EDITED_HTML_BYTES) return null
      return { __cortexSlides: 1, type: 'html-changed', html: msg.html }
    }
    case 'history-changed':
      return { __cortexSlides: 1, type: 'history-changed', canUndo: msg.canUndo === true, canRedo: msg.canRedo === true }
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
function slideEditBridgeInPage(config: { protocol: number; editableTags: string[]; debounceMs: number; textMax: number }) {
  var PROTOCOL = config.protocol
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
      if (pos === 'absolute' || pos === 'fixed') return node
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
    // 参考线等 bridge 附属节点随 innerHTML 替换消亡,引用一并复位。
    guideV = null
    guideH = null
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
    var groupRect0 = { left: 0, top: 0, w: 0, h: 0 }
    var snapLines = { xs: [] as number[], ys: [] as number[] }
    function onMove(ev: Event): void {
      var mv = ev as MouseEvent
      var dx = mv.clientX - startX
      var dy = mv.clientY - startY
      if (!started) {
        // 4px 阈值区分点击与拖拽(点击不改写任何样式)。
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return
        started = true
        suppressClick = true
        // 拖未选中元素 → 先把它变成唯一选区;拖已选元素 → 成组移动整个选区。
        if (!isSelected(target!)) applySelection([target!])
        // 撤销点:改动样式前入栈。
        capture()
        // 吸附基准:组包围盒初值与候选线在拖拽开始时一次性采集(拖拽中元素在动,不能重采)。
        groupRect0 = boundsOf(selected)
        snapLines = collectSnapLines()
        for (var i = 0; i < selected.length; i++) dragItems.push(positionBase(selected[i]!))
        document.body.style.userSelect = 'none'
      }
      // 吸附(Alt 按住时禁用):对组包围盒做修正,整组一起贴线。
      var adj = { dx: 0, dy: 0, x: null as number | null, y: null as number | null }
      if (!mv.altKey) {
        adj = snapAdjust(
          { left: groupRect0.left + dx, top: groupRect0.top + dy, w: groupRect0.w, h: groupRect0.h },
          snapLines
        )
      }
      moveBy(dragItems, dx + adj.dx, dy + adj.dy)
      showGuide('v', adj.x)
      showGuide('h', adj.y)
      mv.preventDefault()
    }
    function onUp(): void {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      if (started) {
        document.body.style.userSelect = ''
        hideGuides()
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

/** 生成可直接 executeJavaScript 的注入源码(幂等:重复注入不会重复挂载)。 */
export function buildSlideEditBridgeSource(): string {
  const config = JSON.stringify({
    protocol: SLIDE_BRIDGE_PROTOCOL,
    editableTags: [...EDITABLE_TAGS],
    debounceMs: EDIT_SAVE_DEBOUNCE_MS,
    textMax: SELECTION_TEXT_MAX
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
