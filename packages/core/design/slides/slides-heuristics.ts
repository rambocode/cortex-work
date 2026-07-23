/**
 * 默认入场编排启发式：页面没有显式 entrances 注解时，播放器按「标题先、
 * 正文逐个、图表/图片次之」自动编排。本模块的函数会被 presenter 运行时经
 * `Function.prototype.toString()` 序列化注入浏览器执行（同 slide-edit-bridge
 * 范式），因此**必须自包含**：函数体内不得引用模块级 import 或常量；
 * `planDefaultEntrances` 依赖 `inferElementRole`，注入方需把两个函数一起
 * 注入同一作用域（函数声明名字即引用名）。
 */
import type { SlidesAnimationStyle, SlidesElementAnimation } from './slides-types'

/** 运行时在页内采集的元素描述符（布局信息来自 getBoundingClientRect）。 */
export type SlideElementDescriptor = {
  /** data-cortex-id */
  elementId: string
  /** 小写标签名 */
  tag: string
  top: number
  left: number
  /** 元素面积（px²），用于识别「顶部大字 = 标题」。 */
  area: number
  /** 是否图表容器（含 data-cortex-chart-spec / canvas / svg）。 */
  isChart?: boolean
}

export type SlideElementRole = 'title' | 'body' | 'chart' | 'image' | 'other'

/**
 * 推断元素角色。规则（按优先级）：图表标记→chart；img→image；h1/h2 或
 * 「位于画布上部 1/3 且面积占比 >3%」的大块文字→title；其余→body。
 * 自包含：不引用任何模块级符号。
 */
export function inferElementRole(
  el: { tag: string; top: number; area: number; isChart?: boolean },
  canvasWidth: number,
  canvasHeight: number
): 'title' | 'body' | 'chart' | 'image' | 'other' {
  if (el.isChart) return 'chart'
  if (el.tag === 'img' || el.tag === 'picture' || el.tag === 'video') return 'image'
  if (el.tag === 'h1' || el.tag === 'h2') return 'title'
  const canvasArea = canvasWidth * canvasHeight
  if (el.top < canvasHeight / 3 && canvasArea > 0 && el.area / canvasArea > 0.03) return 'title'
  return 'body'
}

/**
 * 生成默认入场编排：role 优先级 title→body→chart/image，同 role 内按
 * top→left 排序；全部归 step 0（默认整页自动入场，不分点击步）；preset 与
 * 错峰间隔按风格选取。style='none' 返回空数组（不做任何入场）。
 * 自包含：错峰/preset 表内联在函数体里，不引用 STAGGER_DEFAULT_MS 等模块常量。
 * inferRole 以参数注入（默认取本模块的 inferElementRole）：注入方用
 * `(${planDefaultEntrances.toString()})(els, style, w, h, (${inferElementRole.toString()}))`
 * 显式传入,避免打包器重命名顶层符号后 toString 源码里的自由引用失联。
 */
export function planDefaultEntrances(
  els: readonly {
    elementId: string
    tag: string
    top: number
    left: number
    area: number
    isChart?: boolean
  }[],
  style: SlidesAnimationStyle,
  canvasWidth: number,
  canvasHeight: number,
  inferRole: typeof inferElementRole = inferElementRole
): SlidesElementAnimation[] {
  if (style === 'none') return []
  // 与 slides-animation.ts 的 STAGGER_DEFAULT_MS 保持一致(自包含要求,无法 import)。
  const stagger = style === 'lively' ? 140 : 80
  const roleRank: Record<string, number> = { title: 0, body: 1, chart: 2, image: 2, other: 3 }
  const withRole = els.map((el) => ({
    el,
    role: inferRole(el, canvasWidth, canvasHeight)
  }))
  withRole.sort((a, b) => {
    const rank = (roleRank[a.role] ?? 3) - (roleRank[b.role] ?? 3)
    if (rank !== 0) return rank
    return a.el.top - b.el.top || a.el.left - b.el.left
  })
  return withRole.map(({ el, role }, index) => {
    let preset: SlidesElementAnimation['preset']
    if (style === 'subtle') {
      preset = role === 'title' ? 'fade-in' : 'fade-up'
    } else {
      // lively:标题揭示、图表缩放、图片缩放、正文上浮,富于变化但不混乱。
      if (role === 'title') preset = 'reveal-clip'
      else if (role === 'chart' || role === 'image') preset = 'zoom-in'
      else preset = 'fade-up'
    }
    // 错峰上限 1500ms:元素很多时尾部并批入场,避免观众等一条长瀑布。
    return { elementId: el.elementId, preset, step: 0, delayMs: Math.min(index * stagger, 1500) }
  })
}

/** 采集到的入场目标描述符:布局字段供 planDefaultEntrances 排序,el 供运行时打 class。 */
export type CollectedEntranceDescriptor = SlideElementDescriptor & { el: unknown }

/**
 * 在页面文档上采集默认编排的入场目标(自包含,供 presenter/speaker/编辑器预览三端
 * 经 toString 注入共用 —— 函数体不引用任何模块符号)。
 *
 * 钻取规则(解决「AI 把 data-cortex-id 打在整页根容器上 → 整页一个单元入场」):
 * 从「无标注祖先」的顶层标注元素出发,若某层是包装容器 —— 覆盖 ≥80% 画布,或布局
 * 不可测(display:none 下 rect 全 0)时的唯一根 —— 且拥有 ≥2 个直接标注子元素,
 * 则用子元素替代它,最多下钻 3 层,直到得到一组内容级元素。
 * 布局不可测时保留全部元素按文档序编排(稳定排序保证同 role 组内 DOM 顺序)。
 */
export function collectSlideEntranceDescriptors(
  doc: {
    querySelectorAll(selector: string): ArrayLike<{
      parentElement: unknown
      hasAttribute(name: string): boolean
      getAttribute(name: string): string | null
      getBoundingClientRect(): { top: number; left: number; width: number; height: number }
      querySelector(selector: string): unknown
      tagName: string
    }>
  },
  canvasWidth: number,
  canvasHeight: number
): CollectedEntranceDescriptor[] {
  type El = {
    parentElement: unknown
    hasAttribute(name: string): boolean
    getAttribute(name: string): string | null
    getBoundingClientRect(): { top: number; left: number; width: number; height: number }
    querySelector(selector: string): unknown
    tagName: string
  }
  const all: El[] = Array.prototype.slice.call(doc.querySelectorAll('[data-cortex-id]'))
  if (all.length === 0) return []

  function nearestAnnotatedAncestor(el: El): El | null {
    let p = el.parentElement as El | null
    while (p) {
      if (p.hasAttribute && p.hasAttribute('data-cortex-id')) return p
      p = p.parentElement as El | null
    }
    return null
  }

  // 标注树:顶层元素 + 每个标注元素的「直接标注子元素」表。
  const roots: El[] = []
  const childrenMap = new Map<El, El[]>()
  all.forEach((el) => {
    const anc = nearestAnnotatedAncestor(el)
    if (!anc) {
      roots.push(el)
      return
    }
    const list = childrenMap.get(anc) ?? []
    list.push(el)
    childrenMap.set(anc, list)
  })

  const canvasArea = canvasWidth * canvasHeight
  let level = roots
  for (let depth = 0; depth < 3; depth++) {
    let expanded = false
    const next: El[] = []
    level.forEach((el) => {
      const r = el.getBoundingClientRect()
      const area = r.width * r.height
      const kids = childrenMap.get(el) ?? []
      const isWrapper =
        kids.length >= 2 && (area >= canvasArea * 0.8 || (area === 0 && level.length === 1))
      if (isWrapper) {
        kids.forEach((k) => next.push(k))
        expanded = true
      } else {
        next.push(el)
      }
    })
    level = next
    if (!expanded) break
  }

  const descriptors = level.map((el) => {
    const r = el.getBoundingClientRect()
    const tag = el.tagName.toLowerCase()
    return {
      el: el as unknown,
      elementId: el.getAttribute('data-cortex-id') ?? '',
      tag,
      top: r.top,
      left: r.left,
      area: r.width * r.height,
      isChart: !!(el.querySelector('canvas,svg,[data-cortex-chart-spec]') || tag === 'canvas' || tag === 'svg')
    }
  })
  // 布局可测时过滤零面积(隐藏元素);全不可测(非激活页)保留全部,走文档序回退。
  const measured = descriptors.some((d) => d.area > 0)
  return measured ? descriptors.filter((d) => d.area > 0) : descriptors
}
