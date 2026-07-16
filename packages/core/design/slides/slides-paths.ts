/**
 * Pure path builders + safety predicates for the slides deck workspace layout:
 *
 *   .cortex-design/<deckId>/
 *   ├── deck.json            ── manifest (single source of truth)
 *   ├── slides/slot-*.html   ── one file per slide slot
 *   ├── assets/{source,generated}/
 *   ├── snapshots/slot-*.png ── thumbnails, filename mirrors slot id
 *   ├── notes/slot-*.md      ── speaker notes
 *   ├── drafts/outline.json  ── un-approved outline drafts
 *   ├── exports/             ── explicitly retained intermediates only
 *   └── .trash/              ── soft-deleted slides awaiting async cleanup
 *
 * All builders return workspace-relative POSIX paths (the manifest contract).
 * No Node `path`/fs imports here — packages/core stays platform-free; the
 * desktop main process re-validates with realpath before touching disk.
 */

const DESIGN_DIR = '.cortex-design'

/** Deck id / document id: short alnum id, optionally with hyphens (never path-y). */
const DECK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

/** Slot id: `slot-` prefix + lowercase alnum/hyphen tail, e.g. `slot-001`, `slot-a1b2`. */
const SLOT_ID_PATTERN = /^slot-[a-z0-9][a-z0-9-]{0,63}$/

/** Asset file name: conservative charset, must keep an extension, no path tricks. */
const ASSET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.[a-zA-Z0-9]{1,8}$/

export function isValidDeckId(id: string): boolean {
  return DECK_ID_PATTERN.test(id)
}

export function isValidSlotId(id: string): boolean {
  return SLOT_ID_PATTERN.test(id)
}

export function isValidAssetFileName(name: string): boolean {
  return ASSET_NAME_PATTERN.test(name) && !name.includes('..')
}

/**
 * Workspace-relative path safety: rejects absolute paths (posix + windows),
 * backslashes, `..` segments, empty segments and control characters. This is
 * the *string-shape* gate; the main process still realpath-verifies on disk.
 */
export function isSafeWorkspaceRelativePath(p: string): boolean {
  if (!p || p.length > 1024) return false
  if (p.startsWith('/') || p.startsWith('\\')) return false
  if (/^[a-zA-Z]:/.test(p)) return false
  if (p.includes('\\')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(p)) return false
  const segments = p.split('/')
  return segments.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..')
}

export function slidesDeckRootPath(deckId: string): string {
  return `${DESIGN_DIR}/${deckId}`
}

export function slidesManifestPath(deckId: string): string {
  return `${slidesDeckRootPath(deckId)}/deck.json`
}

export function slidesSlideHtmlPath(deckId: string, slotId: string): string {
  return `${slidesDeckRootPath(deckId)}/slides/${slotId}.html`
}

export function slidesSnapshotPath(deckId: string, slotId: string): string {
  return `${slidesDeckRootPath(deckId)}/snapshots/${slotId}.png`
}

export function slidesNotesPath(deckId: string, slotId: string): string {
  return `${slidesDeckRootPath(deckId)}/notes/${slotId}.md`
}

export function slidesAssetPath(deckId: string, kind: 'source' | 'generated', fileName: string): string {
  return `${slidesDeckRootPath(deckId)}/assets/${kind}/${fileName}`
}

export function slidesDraftOutlinePath(deckId: string): string {
  return `${slidesDeckRootPath(deckId)}/drafts/outline.json`
}

export function slidesExportsDirPath(deckId: string): string {
  return `${slidesDeckRootPath(deckId)}/exports`
}

export function slidesTrashDirPath(deckId: string): string {
  return `${slidesDeckRootPath(deckId)}/.trash`
}

/** Directories that must exist for a freshly created deck workspace. */
export function slidesDeckDirectories(deckId: string): string[] {
  const root = slidesDeckRootPath(deckId)
  return [
    root,
    `${root}/slides`,
    `${root}/assets/source`,
    `${root}/assets/generated`,
    `${root}/snapshots`,
    `${root}/notes`,
    `${root}/drafts`,
    `${root}/exports`
  ]
}

/**
 * True when `p` is a safe workspace-relative path *inside* the given deck root.
 * Used by the manifest schema to reject absolute paths and `..` escapes, and by
 * write paths to keep every file access under `.cortex-design/<deckId>/`.
 */
export function isPathInsideDeck(deckId: string, p: string): boolean {
  if (!isValidDeckId(deckId) || !isSafeWorkspaceRelativePath(p)) return false
  return p === slidesDeckRootPath(deckId) || p.startsWith(`${slidesDeckRootPath(deckId)}/`)
}
