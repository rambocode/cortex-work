/**
 * Zod schema + tolerant parser for `deck.json`. Every external input (disk
 * file, IPC payload, MCP tool argument) must go through `parseSlidesManifest`
 * before use — the schema enforces the invariants the rest of the pipeline
 * relies on: unique slot ids, unique orders, fixed 1280×720 canvas, and all
 * paths workspace-relative inside the deck root (no absolute / `..` escapes).
 */
import { z } from 'zod'
import { isPathInsideDeck, isValidDeckId, isValidSlotId } from './slides-paths'
import {
  SLIDES_CANVAS_HEIGHT,
  SLIDES_CANVAS_WIDTH,
  type SlidesDeckManifest,
  type SlidesError
} from './slides-types'

const isoDate = z.string().min(1)

/** CSS hex color (#rrggbb or #rgb) — theme palette contract. */
const hexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'expected hex color')

export const slidesThemeSchema = z.object({
  name: z.string().min(1),
  mood: z.array(z.string()),
  palette: z.object({
    background: hexColor,
    foreground: hexColor,
    primary: hexColor,
    secondary: hexColor,
    accent: hexColor
  }),
  fonts: z.object({
    heading: z.string().min(1),
    body: z.string().min(1),
    mono: z.string().min(1).optional()
  }),
  density: z.enum(['minimal', 'balanced', 'dense']),
  imageStyle: z.string().optional(),
  customInstructions: z.string().optional()
})

export const slidesOutlineItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  purpose: z.string(),
  keyPoints: z.array(z.string()),
  visualIntent: z.string().optional()
})

export const slidesOutlineSchema = z.object({
  version: z.number().int().min(1),
  summary: z.string(),
  audience: z.string().optional(),
  goal: z.string().optional(),
  items: z.array(slidesOutlineItemSchema).superRefine((items, ctx) => {
    const seen = new Set<string>()
    for (const item of items) {
      if (seen.has(item.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate outline item id: ${item.id}` })
      }
      seen.add(item.id)
    }
  }),
  approvedAt: isoDate.optional()
})

export const slidesSlotSchema = z.object({
  id: z.string().refine(isValidSlotId, 'invalid slot id'),
  order: z.number().int().min(0),
  title: z.string(),
  purpose: z.string().optional(),
  htmlPath: z.string().min(1),
  notesPath: z.string().min(1).optional(),
  snapshotPath: z.string().min(1).optional(),
  revision: z.number().int().min(0),
  status: z.enum(['empty', 'generating', 'ready', 'error']),
  updatedAt: isoDate
})

export const slidesDeckManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().refine(isValidDeckId, 'invalid deck id'),
    title: z.string(),
    width: z.literal(SLIDES_CANVAS_WIDTH),
    height: z.literal(SLIDES_CANVAS_HEIGHT),
    status: z.enum(['draft', 'outline-proposed', 'outline-approved', 'generating', 'ready', 'error']),
    revision: z.number().int().min(0),
    theme: slidesThemeSchema,
    outline: slidesOutlineSchema.nullable(),
    slides: z.array(slidesSlotSchema),
    activeSlideId: z.string().nullable(),
    createdAt: isoDate,
    updatedAt: isoDate
  })
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>()
    const orders = new Set<number>()
    for (const slot of manifest.slides) {
      if (ids.has(slot.id)) {
        ctx.addIssue({ code: 'custom', path: ['slides'], message: `duplicate slot id: ${slot.id}` })
      }
      ids.add(slot.id)
      if (orders.has(slot.order)) {
        ctx.addIssue({ code: 'custom', path: ['slides'], message: `duplicate slot order: ${slot.order}` })
      }
      orders.add(slot.order)
      // Path containment: every slot file must live inside this deck's root —
      // absolute paths, `..` escapes and cross-deck references are all rejected here.
      for (const p of [slot.htmlPath, slot.notesPath, slot.snapshotPath]) {
        if (p !== undefined && !isPathInsideDeck(manifest.id, p)) {
          ctx.addIssue({ code: 'custom', path: ['slides'], message: `unsafe path for slot ${slot.id}: ${p}` })
        }
      }
    }
    if (manifest.activeSlideId !== null && !ids.has(manifest.activeSlideId)) {
      ctx.addIssue({ code: 'custom', path: ['activeSlideId'], message: 'activeSlideId not in slides' })
    }
  })

export type SlidesManifestParseResult =
  | { ok: true; manifest: SlidesDeckManifest }
  | { ok: false; error: SlidesError }

/**
 * Parse + validate an untrusted manifest. Accepts a raw JSON string or an
 * already-parsed value; never throws — malformed input yields a structured
 * `invalid_manifest` error so callers can surface recovery UI.
 */
export function parseSlidesManifest(input: unknown): SlidesManifestParseResult {
  let value: unknown = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch {
      return { ok: false, error: { code: 'invalid_manifest', message: 'deck.json 不是合法 JSON' } }
    }
  }
  const parsed = slidesDeckManifestSchema.safeParse(value)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `(${first.path.join('.')}) ` : ''
    return {
      ok: false,
      error: { code: 'invalid_manifest', message: `deck.json 校验失败 ${where}${first?.message ?? ''}`.trim() }
    }
  }
  return { ok: true, manifest: parsed.data as SlidesDeckManifest }
}

/** Serialize a manifest for disk with stable formatting (trailing newline). */
export function serializeSlidesManifest(manifest: SlidesDeckManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}
