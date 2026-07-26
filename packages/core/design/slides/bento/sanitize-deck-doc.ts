/**
 * deck 文档落盘前的字段剥离(纯函数)。
 *
 * 为什么存在(用户实测 + 磁盘取证):vendored bento 在打开任何一份没有 `collab` 的文档时会
 * **自动铸造**一套在线协作凭据(`sync/session.ts` 的 ensureCollab → `sync/online.ts` 的
 * mintCollab:`on:true`、room 指向公共中继 `wss://sync.bento.page`),并随编辑器 autosave
 * 写进 deck 文件。此后每次打开都会:
 *   1. 连中继、从头全量重放房间历史 → `sync/crdt.ts` 的 mergeSnapshot 把历史世代的页/元素
 *      **push 回当前文档**(元素级并集),AI 经磁盘写入的元素没有 CRDT register,逐字段全输
 *      —— 这正是「新内容和旧内容重贴在一起」;
 *   2. 把 deck 内容推给第三方中继(内容外泄)。
 * Cortex 的 deck 是本地工作区里的单文件、AI 走磁盘写入,这套协作机制没有任何用处,
 * 因此在宿主的每一条写路径上剥掉它。
 *
 * **刻意做成白名单**:只删 `collab`。`bentoDocSchema` 是 `.passthrough()`,上游随时会加新
 * 字段,「删掉我不认识的字段」会静默丢掉用户的内容。
 */

export const STRIPPED_DECK_DOC_KEYS = ['collab'] as const

export type SanitizeDeckDocResult<T> = {
  /** 剥离后的文档;未命中任何 key 时是**原对象引用**(调用方据此跳过一次无意义的写盘)。 */
  doc: T
  /** 实际被剥掉的 key(便于日志与「要不要 bump revision」的判断)。 */
  stripped: string[]
}

export function sanitizeDeckDoc<T>(doc: T): SanitizeDeckDocResult<T> {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { doc, stripped: [] }
  const record = doc as Record<string, unknown>
  const stripped = STRIPPED_DECK_DOC_KEYS.filter((key) => key in record)
  if (!stripped.length) return { doc, stripped: [] }
  const next = { ...record }
  for (const key of stripped) delete next[key]
  return { doc: next as T, stripped: [...stripped] }
}
