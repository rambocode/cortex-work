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
  createdAt: string
  updatedAt: string
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
    createdAt: options.now,
    updatedAt: options.now
  }
}

/** Slots sorted for display/export: order ascending, ties by id for determinism. */
export function sortedSlidesSlots(slots: readonly SlidesSlot[]): SlidesSlot[] {
  return [...slots].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
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
