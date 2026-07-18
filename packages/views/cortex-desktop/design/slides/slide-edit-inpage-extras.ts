// Slide 编辑 bridge 的页内扩展子系统:框选/多选、旋转 v1、层级调整(z-order)。
// 与 slide-edit-inpage.ts 的主脚本同批注入 guest:宿主 builder 把两个函数分别
// toString 拼进注入源码,主脚本在初始化末尾以 ctx(共享内部能力的受控切面)调用
// 本工厂,拿回 api 供主脚本回调(UI 刷新/复位、z-order 执行)。
// 约束:函数必须自包含 —— 运行时不得引用本模块内其它符号(类型除外,编译期擦除)。

/** 主脚本 → 扩展子系统 的能力切面(全部为主脚本闭包内函数的引用)。 */
export type SlideExtrasCtx = {
  isEditMode: () => boolean
  getSelected: () => HTMLElement[]
  applySelection: (next: HTMLElement[]) => void
  capture: () => void
  scheduleSave: () => void
  postSelection: () => void
  /** 置位主脚本的 click 抑制:框选/旋转结束后的 click 不得改写选区。 */
  suppressNextClick: () => void
  selectTarget: (el: unknown) => HTMLElement | null
  /** 元素是否参与层级/框选(定位元素、图形标签、文本块;不含选中态过滤)。 */
  isLayerParticipant: (el: HTMLElement) => boolean
  positionBase: (el: HTMLElement) => { el: HTMLElement; left: number; top: number }
  /** 主脚本的缩放手柄刷新(旋转中每帧调用,让手柄感知旋转态并隐藏)。 */
  updateHandles: () => void
  host: HTMLElement
}

/** 扩展子系统 → 主脚本 的回调面。 */
export type SlideExtrasApi = {
  /** 选区 UI 刷新(主脚本 updateHandles 尾部调用):旋转手柄跟随/显隐。 */
  refreshUi: () => void
  /** body innerHTML 整体替换后复位(附属节点已消亡,引用不可复用)。 */
  resetUi: () => void
  /** 层级调整;返回是否有实际改动(供主脚本决定是否落盘)。 */
  zOrder: (els: HTMLElement[], direction: string) => boolean
}

/* eslint-disable */
// 自包含注入函数:同主脚本一样经 toString 注入,类型注解编译期擦除。
export function slideEditExtrasInPage(ctx: SlideExtrasCtx): SlideExtrasApi {
  // —— 层级调整:z-index 比较只在「与目标重叠」的元素间进行(不重叠的元素调层级无
  // 视觉意义,还会把 z 值越推越大)。跨 stacking context 的 z 比较在语义上不严格,
  // 但 Agent 生成的 slide 页面层级普遍扁平,务实处理;static 的流内元素视作 z=0、
  // 按 DOM 序垫底,与 CSS 实际绘制序一致(定位元素负 z 才会绘制到流内内容之后)。
  function zOf(el: HTMLElement): number {
    var z = parseInt(getComputedStyle(el).zIndex, 10)
    return isNaN(z) ? 0 : z
  }

  // peer 是否绘制在 base 之上:z 大者在上,同 z 按 DOM 后序在上。
  function paintsAbove(peer: HTMLElement, peerZ: number, baseZ: number, base: HTMLElement): boolean {
    if (peerZ !== baseZ) return peerZ > baseZ
    return !!(base.compareDocumentPosition(peer) & 4) // DOCUMENT_POSITION_FOLLOWING
  }

  // 收集与 el 视觉重叠的层级参与者(选区成员与 el 的祖先/子孙除外 ——
  // 祖先必然重叠,比较无意义)。
  function overlappingPeers(el: HTMLElement): HTMLElement[] {
    var r = el.getBoundingClientRect()
    var peers: HTMLElement[] = []
    var all = document.body.querySelectorAll('*')
    for (var i = 0; i < all.length; i++) {
      var candidate = all[i] as HTMLElement
      if (candidate === el || candidate.contains(el) || el.contains(candidate)) continue
      if (candidate.closest && candidate.closest('[data-cortex-selected]')) continue
      if (!ctx.isLayerParticipant(candidate)) continue
      var cr = candidate.getBoundingClientRect()
      if (cr.width < 8 || cr.height < 8) continue
      if (cr.left >= r.left + r.width || cr.left + cr.width <= r.left) continue
      if (cr.top >= r.top + r.height || cr.top + cr.height <= r.top) continue
      peers.push(candidate)
    }
    return peers
  }

  // 对单个元素执行层级调整;返回是否有实际改动。
  function reorderOne(el: HTMLElement, direction: string): boolean {
    var peers = overlappingPeers(el)
    if (!peers.length) return false
    var selfZ = zOf(el)
    var next: number | null = null
    if (direction === 'front') {
      var maxZ = -Infinity
      var anyAbove = false
      for (var i = 0; i < peers.length; i++) {
        var pz = zOf(peers[i]!)
        if (pz > maxZ) maxZ = pz
        if (paintsAbove(peers[i]!, pz, selfZ, el)) anyAbove = true
      }
      if (anyAbove) next = maxZ + 1
    } else if (direction === 'back') {
      var minZ = Infinity
      var anyBelow = false
      for (var b = 0; b < peers.length; b++) {
        var bz = zOf(peers[b]!)
        if (bz < minZ) minZ = bz
        if (!paintsAbove(peers[b]!, bz, selfZ, el)) anyBelow = true
      }
      if (anyBelow) next = minZ - 1
    } else if (direction === 'up') {
      // 最近的上层 peer:取其中最小 z,压过它一层。
      var lowestAbove = Infinity
      for (var u = 0; u < peers.length; u++) {
        var uz = zOf(peers[u]!)
        if (paintsAbove(peers[u]!, uz, selfZ, el) && uz < lowestAbove) lowestAbove = uz
      }
      if (lowestAbove !== Infinity) next = lowestAbove + 1
    } else {
      // down:最近的下层 peer,压到它之下一层。
      var highestBelow = -Infinity
      for (var d = 0; d < peers.length; d++) {
        var dz = zOf(peers[d]!)
        if (!paintsAbove(peers[d]!, dz, selfZ, el) && dz > highestBelow) highestBelow = dz
      }
      if (highestBelow !== -Infinity) next = highestBelow - 1
    }
    if (next === null || next === selfZ) return false
    // static 元素 z-index 不生效,转 relative(不脱离文档流,不影响兄弟布局)。
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
    el.style.zIndex = String(next)
    return true
  }

  // —— 框选/多选:空白处按下拖出矩形,相交即选(Figma 语义),实时反馈;
  // 嵌套元素只选「最外层」命中者(卡片与其内部文字同时命中时只选卡片,
  // 否则成组拖动会双重移动)。
  var MARQUEE_THRESHOLD_PX = 2

  function marqueeHits(rect: { left: number; top: number; right: number; bottom: number }): HTMLElement[] {
    var hits: HTMLElement[] = []
    var all = document.body.querySelectorAll('*')
    for (var i = 0; i < all.length; i++) {
      var el = all[i] as HTMLElement
      if (!ctx.isLayerParticipant(el)) continue
      var r = el.getBoundingClientRect()
      if (r.width < 8 || r.height < 8) continue
      if (r.left >= rect.right || r.left + r.width <= rect.left) continue
      if (r.top >= rect.bottom || r.top + r.height <= rect.top) continue
      // 完全包住框选矩形的元素是「在其内部框选」的容器(含满画布 wrapper):
      // 用户意图是选它的子元素;矩形跨过其边缘时才视为捕获该容器本身。
      if (r.left <= rect.left && r.top <= rect.top && r.left + r.width >= rect.right && r.top + r.height >= rect.bottom) continue
      hits.push(el)
    }
    // 最外层过滤:剔除「祖先也命中」的后代。
    var outer: HTMLElement[] = []
    for (var j = 0; j < hits.length; j++) {
      var contained = false
      for (var k = 0; k < hits.length; k++) {
        if (k !== j && hits[k]!.contains(hits[j]!)) {
          contained = true
          break
        }
      }
      if (!contained) outer.push(hits[j]!)
    }
    return outer
  }

  function sameSelection(a: HTMLElement[], b: HTMLElement[]): boolean {
    if (a.length !== b.length) return false
    for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]!) === -1) return false
    return true
  }

  ctx.host.addEventListener('mousedown', function (e) {
    if (!ctx.isEditMode()) return
    var me = e as MouseEvent
    if (me.button !== 0) return
    // 命中元素的 mousedown 由主脚本的拖动管线处理;框选只从空白处发起。
    if (ctx.selectTarget(me.target)) return
    var startX = me.clientX
    var startY = me.clientY
    var box: HTMLElement | null = null
    function onMove(ev: Event): void {
      var mv = ev as MouseEvent
      if (!box) {
        if (Math.abs(mv.clientX - startX) < MARQUEE_THRESHOLD_PX && Math.abs(mv.clientY - startY) < MARQUEE_THRESHOLD_PX) return
        box = document.createElement('div')
        box.setAttribute('data-cortex-bridge', '1')
        box.setAttribute('data-cortex-marquee', '1')
        box.style.position = 'fixed'
        box.style.zIndex = '2147483647'
        box.style.pointerEvents = 'none'
        box.style.border = '1px solid #3b82d8'
        box.style.background = 'rgba(59,130,216,0.08)'
        document.body.appendChild(box)
        document.body.style.userSelect = 'none'
      }
      var rect = {
        left: Math.min(startX, mv.clientX),
        top: Math.min(startY, mv.clientY),
        right: Math.max(startX, mv.clientX),
        bottom: Math.max(startY, mv.clientY)
      }
      box.style.left = rect.left + 'px'
      box.style.top = rect.top + 'px'
      box.style.width = rect.right - rect.left + 'px'
      box.style.height = rect.bottom - rect.top + 'px'
      // 实时选中(相交即选);集合未变化时不重复改写属性/上报。
      var hits = marqueeHits(rect)
      if (!sameSelection(hits, ctx.getSelected())) ctx.applySelection(hits)
      mv.preventDefault()
    }
    function onUp(): void {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      if (box) {
        box.remove()
        box = null
        document.body.style.userSelect = ''
        // 框选结束的 click 不得清空刚建立的选区。
        ctx.suppressNextClick()
      }
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
  })

  // —— 旋转 v1:单选时包围盒顶上出旋转手柄,拖动绕元素中心旋转,Shift 吸附 15°。
  // 以 CSS transform rotate 落盘;元素既有变换保留(内联的非 rotate 部分原样前置;
  // 无内联但 computed 有变换时,以 matrix 冻结为前缀,避免覆盖 translate 居中等)。
  var rotateHandle: HTMLElement | null = null
  var ROTATE_RE = /\s*rotate\((-?[\d.]+)deg\)/

  function rotationOf(el: HTMLElement): number {
    var m = ROTATE_RE.exec(el.style.transform || '')
    return m ? parseFloat(m[1]!) : 0
  }

  function ensureRotateHandle(): HTMLElement {
    if (rotateHandle) return rotateHandle
    var h = document.createElement('div')
    h.setAttribute('data-cortex-bridge', '1')
    h.setAttribute('data-cortex-rotate', '1')
    h.style.position = 'fixed'
    h.style.zIndex = '2147483647'
    h.style.width = '12px'
    h.style.height = '12px'
    h.style.borderRadius = '50%'
    h.style.background = '#fff'
    h.style.border = '1.5px solid #3b82d8'
    h.style.boxSizing = 'border-box'
    h.style.cursor = 'grab'
    h.style.pointerEvents = 'auto'
    h.addEventListener('mousedown', function (e) {
      var me = e as MouseEvent
      if (me.button !== 0 || !ctx.isEditMode()) return
      var sel = ctx.getSelected()
      if (sel.length !== 1) return
      startRotate(sel[0]!, me)
    })
    document.body.appendChild(h)
    rotateHandle = h
    return h
  }

  function startRotate(el: HTMLElement, me: MouseEvent): void {
    me.preventDefault()
    me.stopPropagation()
    ctx.suppressNextClick()
    // 旋转中心 = 当前 AABB 中心(transform-origin 默认即元素中心,首次旋转时二者一致;
    // 已旋转元素的 AABB 中心与元素中心仍重合,旋转是保中心变换)。
    var r = el.getBoundingClientRect()
    var cx = r.left + r.width / 2
    var cy = r.top + r.height / 2
    var startAngle = Math.atan2(me.clientY - cy, me.clientX - cx)
    var baseDeg = rotationOf(el)
    var inline = el.style.transform || ''
    var prefix = inline.replace(ROTATE_RE, '').trim()
    if (!inline) {
      var comp = getComputedStyle(el).transform
      if (comp && comp !== 'none') prefix = comp
    }
    var started = false
    function onMove(ev: Event): void {
      var mv = ev as MouseEvent
      if (!started) {
        started = true
        // 撤销点推迟到确有转动。
        ctx.capture()
        document.body.style.userSelect = 'none'
      }
      var ang = Math.atan2(mv.clientY - cy, mv.clientX - cx)
      var deg = baseDeg + ((ang - startAngle) * 180) / Math.PI
      // Shift 吸附 15°;自由旋转取整到 1°(肉眼分辨极限内,落盘数值干净)。
      deg = mv.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg)
      deg = ((deg % 360) + 360) % 360
      el.style.transform = (prefix ? prefix + ' ' : '') + 'rotate(' + deg + 'deg)'
      // 主脚本手柄感知旋转态(隐藏缩放点),旋转手柄自身跟随 AABB。
      ctx.updateHandles()
      mv.preventDefault()
    }
    function onUp(): void {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      if (started) {
        document.body.style.userSelect = ''
        ctx.postSelection()
        ctx.scheduleSave()
      }
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
  }

  function refreshUi(): void {
    var sel = ctx.getSelected()
    if (!ctx.isEditMode() || sel.length !== 1) {
      if (rotateHandle) rotateHandle.style.display = 'none'
      return
    }
    var r = sel[0]!.getBoundingClientRect()
    var h = ensureRotateHandle()
    h.style.display = 'block'
    h.style.left = Math.round(r.left + r.width / 2 - 6) + 'px'
    h.style.top = Math.round(r.top - 26) + 'px'
  }

  return {
    refreshUi: refreshUi,
    resetUi: function (): void {
      rotateHandle = null
    },
    zOrder: function (els: HTMLElement[], direction: string): boolean {
      var changed = false
      for (var i = 0; i < els.length; i++) {
        if (reorderOne(els[i]!, direction)) changed = true
      }
      return changed
    }
  }
}
/* eslint-enable */
