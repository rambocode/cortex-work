/**
 * AI Slides deck domain types. `deck.json` (SlidesDeckManifest) is the single
 * source of truth for deck order/status/theme/outline/revision; per-slide HTML
 * files own the visual content. These types are shared verbatim across core,
 * views and the desktop main process — keep them JSON-serializable and free of
 * Electron/Node dependencies.
 */

/** Fixed slide canvas size (px). Every deck and every slide HTML uses 16:9 1280×720. */
export const SLIDES_CANVAS_WIDTH = 1280
export const SLIDES_CANVAS_HEIGHT = 720

/** Deck lifecycle. Gate: bulk slide generation only allowed after outline approval. */
export type SlidesDeckStatus =
  | 'draft'
  | 'outline-proposed'
  | 'outline-approved'
  | 'generating'
  | 'ready'
  | 'error'

/** Per-slot lifecycle; a failed slot never rolls back its siblings. */
export type SlidesSlotStatus = 'empty' | 'generating' | 'ready' | 'error'

/** Structured deck-wide design constraints (not free-form prompt text). */
export type SlidesTheme = {
  name: string
  mood: string[]
  palette: {
    background: string
    foreground: string
    primary: string
    secondary: string
    accent: string
  }
  fonts: {
    heading: string
    body: string
    mono?: string
  }
  density: 'minimal' | 'balanced' | 'dense'
  imageStyle?: string
  customInstructions?: string
}

/** One planned slide in the outline (narrative contract, approved by the user). */
export type SlidesOutlineItem = {
  id: string
  title: string
  purpose: string
  keyPoints: string[]
  visualIntent?: string
}

/** Agent-proposed, user-approved narrative for the deck. */
export type SlidesOutline = {
  version: number
  summary: string
  audience?: string
  goal?: string
  items: SlidesOutlineItem[]
  /** ISO timestamp set by the approval flow; absent = not yet approved. */
  approvedAt?: string
}

/**
 * A stable, ordered position in the deck. `id` survives reorders and regeneration;
 * the HTML filename carries no business meaning beyond mirroring the slot id.
 * All paths are workspace-relative (under `.cortex-design/<deckId>/`).
 */
export type SlidesSlot = {
  id: string
  order: number
  title: string
  purpose?: string
  htmlPath: string
  notesPath?: string
  snapshotPath?: string
  revision: number
  status: SlidesSlotStatus
  updatedAt: string
  /** 页级动画注解（转场 + 元素入场）；缺省 = 无显式编排。 */
  animation?: SlidesSlotAnimation
}

/** Single source of truth for a deck; persisted as `deck.json` with optimistic revision. */
export type SlidesDeckManifest = {
  schemaVersion: 1
  /** Deck id == owning design document id (one deck per slides document). */
  id: string
  title: string
  width: typeof SLIDES_CANVAS_WIDTH
  height: typeof SLIDES_CANVAS_HEIGHT
  status: SlidesDeckStatus
  /** Optimistic-lock revision; every persisted mutation increments it. */
  revision: number
  theme: SlidesTheme
  outline: SlidesOutline | null
  slides: SlidesSlot[]
  activeSlideId: string | null
  /** 全局动画风格；缺省 = 'none'（旧 deck 静态播放，行为不变）。 */
  animationStyle?: SlidesAnimationStyle
  createdAt: string
  updatedAt: string
}

/**
 * 全局动画风格：挂在 manifest 顶层，决定默认转场、入场 preset 组合与错峰节奏。
 * 缺省视为 'none'（旧 deck 行为不变——静态硬切）。
 */
export type SlidesAnimationStyle = 'none' | 'subtle' | 'lively'

/** 元素入场动画预设 id（与 slides-animation.ts 预设库 key 一一对应）。 */
export type SlidesEntrancePreset =
  | 'fade-in'
  | 'fade-up'
  | 'slide-in-left'
  | 'slide-in-right'
  | 'zoom-in'
  | 'reveal-clip'

/** 翻页转场 id；page-flip / cube-rotate 为 3D（低端环境运行时降级 fade）。 */
export type SlidesTransition =
  | 'none'
  | 'fade'
  | 'push-horizontal'
  | 'push-vertical'
  | 'zoom'
  | 'page-flip'
  | 'cube-rotate'

/**
 * 单元素入场注解。elementId 指向页内 `data-cortex-id`；元素被删除后注解会
 * 「孤儿化」，运行时按「找不到即忽略该条，其余照跑」容错。
 * step：同 step 的元素同时入场；step 0 在切到该页时自动播放，step≥1 需
 * 点击/按键推进（PPT 式分步）。
 */
export type SlidesElementAnimation = {
  elementId: string
  preset: SlidesEntrancePreset
  step: number
  /** 组内错峰微调（毫秒）。 */
  delayMs?: number
  /** 覆盖预设默认时长（毫秒，schema 层夹取上限防病态值）。 */
  durationMs?: number
}

/**
 * 单页动画注解（挂 SlidesSlot）。存 deck.json 而非 slot HTML：
 * slot HTML 永远是「终态全可见」，静态导出（PPTX/PDF/PNG）与页内编辑桥
 * 因此无需感知动画。entrances 缺省 → 播放器走默认编排启发式。
 */
export type SlidesSlotAnimation = {
  /** 进入该页的转场；缺省继承全局风格默认。 */
  transition?: SlidesTransition
  entrances?: SlidesElementAnimation[]
}

/** 解析 deck 的有效动画风格：缺省 = 'none'，保证旧 deck 行为不变。 */
export function resolveDeckAnimationStyle(manifest: {
  animationStyle?: SlidesAnimationStyle
}): SlidesAnimationStyle {
  return manifest.animationStyle ?? 'none'
}

/** 该页是否带显式元素入场注解（有则优先于默认启发式）。 */
export function slotHasExplicitEntrances(slot: {
  animation?: SlidesSlotAnimation
}): boolean {
  return (slot.animation?.entrances?.length ?? 0) > 0
}

/** Recoverable structured error codes shared by IPC results and MCP tool results. */
export type SlidesErrorCode =
  | 'invalid_payload'
  | 'invalid_path'
  | 'invalid_manifest'
  | 'not_found'
  | 'already_exists'
  | 'revision_conflict'
  | 'outline_not_approved'
  | 'io_error'
  | 'timeout'
  | 'canceled'
  | 'too_large'
  | 'unsupported_format'

/** Structured error payload; message is human-readable zh-Hans, code is stable. */
export type SlidesError = {
  code: SlidesErrorCode
  message: string
}

/** Check finding severity: blocking findings should be fixed before export. */
export type SlidesFindingSeverity = 'blocking' | 'warning' | 'info'

/** One structured finding from static/render checks; never auto-mutates slides. */
export type SlidesFinding = {
  /** Stable id: `<slideId>:<code>:<n>` so re-runs map to the same finding. */
  id: string
  severity: SlidesFindingSeverity
  slideId: string
  /** `data-cortex-id` of the offending element when known. */
  elementId?: string
  /** Machine-readable rule code, e.g. 'overflow', 'remote-resource', 'min-font-size'. */
  code: string
  message: string
  /** Optional suggested fix, human readable. */
  hint?: string
}

/** Neutral default theme used when a deck is created before the agent sets one. */
export function defaultSlidesTheme(): SlidesTheme {
  return {
    name: 'Cortex Default',
    mood: ['clean', 'modern'],
    palette: {
      background: '#ffffff',
      foreground: '#0f172a',
      primary: '#2563eb',
      secondary: '#64748b',
      accent: '#f59e0b'
    },
    fonts: {
      heading: 'PingFang SC',
      body: 'PingFang SC'
    },
    density: 'balanced'
  }
}

/** Pure factory for a brand-new empty deck manifest (status 'draft', revision 0). */
export function createEmptySlidesDeckManifest(options: {
  id: string
  title: string
  now: string
  theme?: SlidesTheme
}): SlidesDeckManifest {
  return {
    schemaVersion: 1,
    id: options.id,
    title: options.title,
    width: SLIDES_CANVAS_WIDTH,
    height: SLIDES_CANVAS_HEIGHT,
    status: 'draft',
    revision: 0,
    theme: options.theme ?? defaultSlidesTheme(),
    outline: null,
    slides: [],
    activeSlideId: null,
    // 新建 deck 默认「稳重」动画:开箱播放即有入场/转场;存量 deck(无此字段)
    // 仍按 none 处理,行为零回归。用户可在工具栏动画菜单改为无动画/活泼。
    animationStyle: 'subtle',
    createdAt: options.now,
    updatedAt: options.now
  }
}

/** Slots sorted for display/export: order ascending, ties by id for determinism. */
export function sortedSlidesSlots(slots: readonly SlidesSlot[]): SlidesSlot[] {
  return [...slots].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/**
 * Recompute deck status from slot states after a slide-level mutation.
 * Pre-approval states (draft / outline-proposed) are owned by the outline flow
 * and never derived here. Post-approval:
 *   any generating → 'generating'; empty remaining → 'generating' once some page
 *   is ready (mid-generation) else 'outline-approved'; all ready → 'ready';
 *   finished but with failures → 'error'.
 */
export function computeSlidesDeckStatus(
  slides: readonly SlidesSlot[],
  current: SlidesDeckStatus
): SlidesDeckStatus {
  if (current === 'draft' || current === 'outline-proposed') return current
  if (slides.length === 0) return 'outline-approved'
  const counts = { empty: 0, generating: 0, ready: 0, error: 0 }
  for (const slot of slides) counts[slot.status] += 1
  if (counts.generating > 0) return 'generating'
  if (counts.empty > 0) return counts.ready > 0 || counts.error > 0 ? 'generating' : 'outline-approved'
  if (counts.error > 0) return 'error'
  return 'ready'
}

/**
 * Next stable slot id: `slot-NNN` continuing after the highest numeric suffix
 * among existing ids (deleted slots never free their number — ids must stay
 * unique across the deck's whole history so snapshots/notes can't collide).
 */
export function nextSlidesSlotId(existingIds: readonly string[]): string {
  let max = 0
  for (const id of existingIds) {
    const m = /^slot-(\d+)$/.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `slot-${String(max + 1).padStart(3, '0')}`
}

/**
 * Materialize empty slots from an approved outline (one slot per item, order
 * following the outline). Pure: caller supplies the html path builder so this
 * stays platform-free.
 */
export function slotsFromSlidesOutline(options: {
  outline: SlidesOutline
  existingIds: readonly string[]
  now: string
  htmlPathFor: (slotId: string) => string
}): SlidesSlot[] {
  const ids = [...options.existingIds]
  return options.outline.items.map((item, index) => {
    const id = nextSlidesSlotId(ids)
    ids.push(id)
    return {
      id,
      order: index,
      title: item.title,
      purpose: item.purpose,
      htmlPath: options.htmlPathFor(id),
      revision: 0,
      status: 'empty' as const,
      updatedAt: options.now
    }
  })
}
