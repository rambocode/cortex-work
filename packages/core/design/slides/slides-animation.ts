/**
 * 动画预设库——slides 动画系统的单一事实源。presenter 运行时、编辑器
 * 「预览动画」与未来 UI 全部 import 这里，保证同名 preset 在所有场景表现
 * 一致。core 平台无关：只导出纯数据与字符串拼接函数，不含任何 DOM 依赖。
 * 全部动画只用 transform + opacity（合成器友好，不触发 layout）。
 */
import type {
  SlidesAnimationStyle,
  SlidesEntrancePreset,
  SlidesSlotAnimation,
  SlidesTransition
} from './slides-types'

/** 入场动画运行时使用的 class 前缀；注入样式与打 class 必须同源于此。 */
export const ENTRANCE_HIDDEN_CLASS = 'cortex-anim-hidden'
export const ENTRANCE_ENTER_CLASS_PREFIX = 'cortex-anim-enter-'

export type SlidesEntranceSpec = {
  nameZh: string
  /** @keyframes 主体（from/to 块），运行时包上名字注入。 */
  keyframes: string
  defaultDurationMs: number
  defaultEasing: string
  /** 入场前的静止态（必须含 opacity:0，保证元素隐藏但仍占位）。 */
  initial: string
}

export type SlidesTransitionSpec = {
  nameZh: string
  kind: '2d' | '3d'
  /** 出页/入页两帧的 transform/opacity 终态（起始态为页面常态）。 */
  outgoing: string
  incoming: string
  durationMs: number
  defaultEasing: string
  /** 3D 转场需要外层 wrapper 提供 perspective。 */
  needsPerspective: boolean
}

/** 入场预设：key 与 SlidesEntrancePreset 一一对应，测试有完整性校验。 */
export const ENTRANCE_PRESETS: Record<SlidesEntrancePreset, SlidesEntranceSpec> = {
  'fade-in': {
    nameZh: '淡入',
    keyframes: 'from { opacity: 0; } to { opacity: 1; }',
    defaultDurationMs: 500,
    defaultEasing: 'ease-out',
    initial: 'opacity: 0;'
  },
  'fade-up': {
    nameZh: '上浮淡入',
    keyframes:
      'from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); }',
    defaultDurationMs: 550,
    defaultEasing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    initial: 'opacity: 0; transform: translateY(24px);'
  },
  'slide-in-left': {
    nameZh: '左滑入',
    keyframes:
      'from { opacity: 0; transform: translateX(-48px); } to { opacity: 1; transform: translateX(0); }',
    defaultDurationMs: 550,
    defaultEasing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    initial: 'opacity: 0; transform: translateX(-48px);'
  },
  'slide-in-right': {
    nameZh: '右滑入',
    keyframes:
      'from { opacity: 0; transform: translateX(48px); } to { opacity: 1; transform: translateX(0); }',
    defaultDurationMs: 550,
    defaultEasing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    initial: 'opacity: 0; transform: translateX(48px);'
  },
  'zoom-in': {
    nameZh: '缩放入场',
    keyframes:
      'from { opacity: 0; transform: scale(0.85); } to { opacity: 1; transform: scale(1); }',
    defaultDurationMs: 500,
    defaultEasing: 'cubic-bezier(0.34, 1.3, 0.64, 1)',
    initial: 'opacity: 0; transform: scale(0.85);'
  },
  'reveal-clip': {
    nameZh: '揭示',
    // clip-path 与 transform/opacity 一样走合成器,不触发 layout。
    keyframes:
      'from { opacity: 0; clip-path: inset(0 100% 0 0); } to { opacity: 1; clip-path: inset(0 0 0 0); }',
    defaultDurationMs: 600,
    defaultEasing: 'cubic-bezier(0.65, 0, 0.35, 1)',
    initial: 'opacity: 0; clip-path: inset(0 100% 0 0);'
  }
}

/** 转场预设：key 与 SlidesTransition 一一对应（none 也占位，便于穷举）。 */
export const TRANSITIONS: Record<SlidesTransition, SlidesTransitionSpec> = {
  none: {
    nameZh: '无',
    kind: '2d',
    outgoing: '',
    incoming: '',
    durationMs: 0,
    defaultEasing: 'linear',
    needsPerspective: false
  },
  fade: {
    nameZh: '淡入淡出',
    kind: '2d',
    outgoing: 'opacity: 0;',
    incoming: 'opacity: 1;',
    durationMs: 400,
    defaultEasing: 'ease-in-out',
    needsPerspective: false
  },
  'push-horizontal': {
    nameZh: '左右推入',
    kind: '2d',
    outgoing: 'transform: translateX(-100%);',
    incoming: 'transform: translateX(0);',
    durationMs: 500,
    defaultEasing: 'cubic-bezier(0.65, 0, 0.35, 1)',
    needsPerspective: false
  },
  'push-vertical': {
    nameZh: '上下推入',
    kind: '2d',
    outgoing: 'transform: translateY(-100%);',
    incoming: 'transform: translateY(0);',
    durationMs: 500,
    defaultEasing: 'cubic-bezier(0.65, 0, 0.35, 1)',
    needsPerspective: false
  },
  zoom: {
    nameZh: '缩放',
    kind: '2d',
    outgoing: 'opacity: 0; transform: scale(1.1);',
    incoming: 'opacity: 1; transform: scale(1);',
    durationMs: 450,
    defaultEasing: 'ease-in-out',
    needsPerspective: false
  },
  'page-flip': {
    nameZh: '3D 翻页',
    kind: '3d',
    // 出页绕左缘向后翻走,入页从右侧翻进;仅 transform,GPU 合成。
    outgoing: 'transform: rotateY(-100deg); transform-origin: left center; opacity: 0;',
    incoming: 'transform: rotateY(0); transform-origin: right center; opacity: 1;',
    durationMs: 700,
    defaultEasing: 'cubic-bezier(0.45, 0, 0.25, 1)',
    needsPerspective: true
  },
  'cube-rotate': {
    nameZh: '3D 立方体',
    kind: '3d',
    outgoing: 'transform: translateX(-50%) rotateY(-90deg); opacity: 0.4;',
    incoming: 'transform: translateX(0) rotateY(0);',
    durationMs: 700,
    defaultEasing: 'cubic-bezier(0.45, 0, 0.25, 1)',
    needsPerspective: true
  }
}

/**
 * 3D / 高开销转场的降级映射：prefers-reduced-motion、全局风格 none、
 * 低端探测（hardwareConcurrency<=4）时运行时按此表降级。
 */
export const TRANSITION_FALLBACK: Record<SlidesTransition, SlidesTransition> = {
  none: 'none',
  fade: 'fade',
  'push-horizontal': 'push-horizontal',
  'push-vertical': 'push-vertical',
  zoom: 'fade',
  'page-flip': 'fade',
  'cube-rotate': 'fade'
}

/** 各风格的组内错峰间隔（毫秒）；none 为 0（不入场）。 */
export const STAGGER_DEFAULT_MS: Record<SlidesAnimationStyle, number> = {
  none: 0,
  subtle: 80,
  lively: 140
}

/** 各风格对预设默认时长的缩放（稳重略慢、活泼略快）。 */
export const STYLE_DURATION_SCALE: Record<SlidesAnimationStyle, number> = {
  none: 0,
  subtle: 1,
  lively: 0.9
}

/** 默认启发式错峰的硬上限（与 slides-heuristics.ts 的自包含实现保持一致）。 */
export const DEFAULT_HEURISTIC_STAGGER_CAP_MS = 1_500

/**
 * 无显式 entrances 时 step 0 的保守完成时长。主进程无法读取 iframe 的实际元素数，
 * 因此按「最大错峰 + 该风格可能使用的最长 preset」门控下一步，确保动画不会被立即跳过。
 */
export function defaultHeuristicEntranceDurationMs(style: SlidesAnimationStyle): number {
  if (style === 'none') return 0
  const presets: SlidesEntrancePreset[] =
    style === 'subtle' ? ['fade-in', 'fade-up'] : ['reveal-clip', 'zoom-in', 'fade-up']
  const longest = Math.max(
    ...presets.map((preset) => Math.round(ENTRANCE_PRESETS[preset].defaultDurationMs * STYLE_DURATION_SCALE[style]))
  )
  return DEFAULT_HEURISTIC_STAGGER_CAP_MS + longest
}

/** 各风格未显式指定转场时的默认转场。 */
export const STYLE_DEFAULT_TRANSITION: Record<SlidesAnimationStyle, SlidesTransition> = {
  none: 'none',
  subtle: 'fade',
  lively: 'push-horizontal'
}

/**
 * 生成注入进每页文档 <head> 的入场样式表文本（纯字符串，无 DOM）。
 * 包含:隐藏初态 class、每个 preset 的 @keyframes 与 enter class。
 * 入场 class 用 animation-fill-mode: both,播放前保持 initial、播完停在终态。
 */
export function buildEntranceStylesheet(style: SlidesAnimationStyle): string {
  if (style === 'none') return ''
  const scale = STYLE_DURATION_SCALE[style]
  const parts: string[] = []
  for (const [preset, spec] of Object.entries(ENTRANCE_PRESETS)) {
    parts.push(`.${ENTRANCE_HIDDEN_CLASS}[data-cortex-anim="${preset}"] { ${spec.initial} }`)
    parts.push(`@keyframes cortex-anim-${preset} { ${spec.keyframes} }`)
    parts.push(
      `.${ENTRANCE_ENTER_CLASS_PREFIX}${preset} { animation: cortex-anim-${preset} ` +
        `${Math.round(spec.defaultDurationMs * scale)}ms ${spec.defaultEasing} both; }`
    )
  }
  // 兜底:无 preset 标记的 hidden 元素也必须隐藏(启发式打标后、播放前的间隙)。
  parts.push(`.${ENTRANCE_HIDDEN_CLASS} { opacity: 0 !important; }`)
  // 打印红线:presenter 内直接打印时,尚未入场的元素必须全可见(PDF 不能缺内容)。
  parts.push(
    `@media print { .${ENTRANCE_HIDDEN_CLASS} { opacity: 1 !important; transform: none !important; clip-path: none !important; animation: none !important; } }`
  )
  return parts.join('\n')
}

/**
 * 该页的分步总数（点击推进的档位数）：显式 entrances 取 max(step)+1；
 * 无显式注解为 1（默认启发式全归 step 0）。主进程双屏翻页权威与播放器
 * 运行时都用本函数,保证两侧 step 状态机口径一致。
 */
export function entranceStepCount(animation: SlidesSlotAnimation | undefined): number {
  const entrances = animation?.entrances
  if (!entrances || entrances.length === 0) return 1
  let max = 0
  for (const e of entrances) max = Math.max(max, e.step)
  return max + 1
}

/**
 * 生成 presenter 父页的转场样式表（作用于 .slide 容器与 3D wrapper）。
 * class 约定:转场期间出页加 .cortex-trans-out-<id>、入页加 .cortex-trans-in-<id>,
 * 出入两页同时 display:block,结束后由运行时移除 class 复位单页堆叠。
 */
export function buildTransitionStylesheet(): string {
  const parts: string[] = [
    // 3D 转场的舞台 wrapper:perspective 常驻无害,preserve-3d 仅转场期间由运行时加。
    '.cortex-trans-stage-3d { perspective: 1600px; }'
  ]
  for (const [id, spec] of Object.entries(TRANSITIONS)) {
    if (id === 'none') continue
    const t = `transition: transform ${spec.durationMs}ms ${spec.defaultEasing}, opacity ${spec.durationMs}ms ${spec.defaultEasing};`
    parts.push(`.cortex-trans-out-${id} { ${t} ${spec.outgoing} will-change: transform; }`)
    parts.push(`.cortex-trans-in-${id} { ${t} ${spec.incoming} will-change: transform; }`)
    // 入页的起始态 = 出页终态的镜像(由运行时先打 prep class 再下一帧切 in class)。
    if (id === 'fade') parts.push(`.cortex-trans-prep-${id} { opacity: 0; }`)
    if (id === 'push-horizontal') parts.push(`.cortex-trans-prep-${id} { transform: translateX(100%); }`)
    if (id === 'push-vertical') parts.push(`.cortex-trans-prep-${id} { transform: translateY(100%); }`)
    if (id === 'zoom') parts.push(`.cortex-trans-prep-${id} { opacity: 0; transform: scale(0.9); }`)
    if (id === 'page-flip')
      parts.push(
        `.cortex-trans-prep-${id} { transform: rotateY(100deg); transform-origin: right center; opacity: 0.4; }`
      )
    if (id === 'cube-rotate')
      parts.push(`.cortex-trans-prep-${id} { transform: translateX(50%) rotateY(90deg); opacity: 0.4; }`)
  }
  return parts.join('\n')
}
