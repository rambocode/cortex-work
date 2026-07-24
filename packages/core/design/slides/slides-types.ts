// Slides 领域共享类型(bento 化后收敛):只剩「提纲」——AI propose、用户批准的叙事结构。
// 文档本体类型见 ./bento/bento-doc-schema(BentoDoc);slot-HTML 旧体系已随 bento 化移除。

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
