/**
 * Pure path builders + safety predicates for the bento slides deck layout:
 *
 *   .cortex-design/<deckId>/
 *   ├── deck.bento.html   ── 自包含 bento 单文件(存储即交付物,唯一权威)
 *   └── deck.meta.json    ── 宿主 sidecar(revision 乐观锁 / 提纲 gate 阶段 / 提纲草案)
 *
 * All builders return workspace-relative POSIX paths. No Node `path`/fs imports
 * here — packages/core stays platform-free; the desktop main process
 * re-validates with realpath before touching disk.
 */

const DESIGN_DIR = '.cortex-design'

/** Deck id / document id: short alnum id, optionally with hyphens (never path-y). */
const DECK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

export function isValidDeckId(id: string): boolean {
  return DECK_ID_PATTERN.test(id)
}

export function slidesDeckRootPath(deckId: string): string {
  return `${DESIGN_DIR}/${deckId}`
}

/** bento 化 deck 的权威文件:自包含 .bento.html(存储即交付物)。 */
export function bentoDeckHtmlPath(deckId: string): string {
  return `${slidesDeckRootPath(deckId)}/deck.bento.html`
}

/** bento deck 的 sidecar 元数据(revision 乐观锁),见 desktop bento-workspace。 */
export function bentoDeckMetaPath(deckId: string): string {
  return `${slidesDeckRootPath(deckId)}/deck.meta.json`
}

/**
 * 研究来源清单（写作检索 / 演示文稿检索的产物落点，spec §15.3）。
 *
 * 与 deck 正文分开存放的理由：`deck.bento.html` 是「存储即交付物」的自包含单文件，
 * 任何非展示内容混进去都会跟着导出给观众。来源清单是**制作期的溯源材料**——
 * 演讲者需要它核对数据出处，观众不需要看到它。
 */
export function slidesSourcesManifestPath(deckId: string): string {
  return `${slidesDeckRootPath(deckId)}/drafts/research/manifest.json`
}
