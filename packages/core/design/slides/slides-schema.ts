// 提纲的 zod 校验(bento 化后收敛):propose_outline 工具入参与 deck.meta.json 中
// 暂存草案的唯一结构合同。文档本体校验见 ./bento/bento-doc-schema。
import { z } from 'zod'

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
    // 提纲项 id 是页与项的对齐锚,重复会让后续生成/修订指代混乱,前置拦截。
    const seen = new Set<string>()
    for (const item of items) {
      if (seen.has(item.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate outline item id: ${item.id}` })
      }
      seen.add(item.id)
    }
  }),
  approvedAt: z.string().min(1).optional()
})
