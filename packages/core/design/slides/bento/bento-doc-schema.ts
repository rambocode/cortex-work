// BentoDoc 的结构性 zod 校验 —— set_deck_doc(AI 整份写文档)的前置守门。
// 取舍:**宽松 + passthrough**。bento 运行时自身的 parseDoc 只要求 format 与非空 slides,
// 细粒度渲染容错由 bento 兜底;这里只拦「AI 大错」(错 format、空 deck、坐标非数、未知元素
// 类型、缺必需内容字段),未知字段一律透传,避免与上游 model.ts 演进逐字段赛跑。
// 类型细节的权威在 vendor/bento/src/model.ts;prompt 合同摘要见 slides-prompt.ts。
import { z } from 'zod'

export const BENTO_FORMAT = 'bento/slides'
export const BENTO_CANVAS_WIDTH = 1280
export const BENTO_CANVAS_HEIGHT = 720

/** 全元素共有的几何/基础字段(上游 ElementBase 的结构性子集)。 */
const elementBase = {
  id: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite(),
  h: z.number().finite(),
  rotation: z.number().finite().optional().default(0),
  opacity: z.number().finite().optional().default(1),
}

// 按 type 判别的元素 union:每个变体只校验「缺了必坏」的内容字段,其余透传。
const textElement = z.object({ ...elementBase, type: z.literal('text'), html: z.string() }).passthrough()
const shapeElement = z.object({ ...elementBase, type: z.literal('shape'), shape: z.string() }).passthrough()
const imageElement = z.object({ ...elementBase, type: z.literal('image'), src: z.string() }).passthrough()
const svgElement = z.object({ ...elementBase, type: z.literal('svg') }).passthrough()
const chartElement = z.object({ ...elementBase, type: z.literal('chart'), option: z.record(z.string(), z.unknown()) }).passthrough()
const tableElement = z.object({ ...elementBase, type: z.literal('table'), rows: z.array(z.unknown()), columns: z.array(z.unknown()) }).passthrough()
const mediaElement = z.object({ ...elementBase, type: z.literal('media'), kind: z.enum(['video', 'audio']), src: z.string() }).passthrough()

const slideElement = z.discriminatedUnion('type', [
  textElement,
  shapeElement,
  imageElement,
  svgElement,
  chartElement,
  tableElement,
  mediaElement,
])

const slideSchema = z
  .object({
    id: z.string().min(1),
    background: z.string(),
    transition: z.enum(['none', 'fade', 'slide', 'zoom', 'morph']).optional().default('fade'),
    elements: z.array(slideElement),
    notes: z.string().optional().default(''),
  })
  .passthrough()

const themeSchema = z
  .object({
    background: z.string(),
    color: z.string(),
    accent: z.string(),
    fontFamily: z.string(),
  })
  .passthrough()

export const bentoDocSchema = z
  .object({
    format: z.literal(BENTO_FORMAT),
    version: z.number().optional().default(1),
    docId: z.string().optional(),
    title: z.string(),
    size: z.object({ width: z.number().positive(), height: z.number().positive() }).passthrough(),
    theme: themeSchema,
    assets: z.record(z.string(), z.string()).optional(),
    slides: z.array(slideSchema).min(1),
    modified: z.string().optional(),
  })
  .passthrough()

export type BentoDoc = z.infer<typeof bentoDocSchema>
export type BentoSlide = z.infer<typeof slideSchema>

export type ParseBentoDocResult = { ok: true; doc: BentoDoc } | { ok: false; error: string }

/** 校验(带 default 归一化);失败时给出含路径的紧凑错误信息,便于回传给 AI 自纠。 */
export function parseBentoDoc(value: unknown): ParseBentoDocResult {
  const res = bentoDocSchema.safeParse(value)
  if (res.success) return { ok: true, doc: res.data }
  const issues = res.error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, '')
    return `${path || '(root)'}: ${issue.message}`
  })
  return { ok: false, error: issues.join('; ') }
}

/**
 * 新建 deck 的起始文档:单页标题页(深底冷蓝 accent,与应用视觉一致)。
 * docId 刻意省略 —— bento 首次 parseDoc 会自动铸造并在下次保存时固化。
 */
export function buildStarterBentoDoc(title: string): BentoDoc {
  const safeTitle = title.trim() || 'Untitled'
  const doc = {
    format: BENTO_FORMAT,
    version: 1,
    title: safeTitle,
    size: { width: BENTO_CANVAS_WIDTH, height: BENTO_CANVAS_HEIGHT },
    theme: { background: '#0e1116', color: '#f2f5f9', accent: '#3b82d8', fontFamily: "'Helvetica Neue', 'PingFang SC', sans-serif" },
    slides: [
      {
        id: 'slide-1',
        background: '#0e1116',
        transition: 'fade' as const,
        elements: [
          {
            id: 'title-1',
            type: 'text' as const,
            x: 96,
            y: 280,
            w: 1088,
            h: 120,
            rotation: 0,
            opacity: 1,
            html: safeTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;'),
            fontSize: 56,
            fontFamily: "'Helvetica Neue', 'PingFang SC', sans-serif",
            fontWeight: 700,
            color: '#f2f5f9',
            align: 'left',
            valign: 'middle',
            lineHeight: 1.15,
          },
        ],
        notes: '',
      },
    ],
  }
  const res = parseBentoDoc(doc)
  // 起始文档由本文件静态构造,校验失败只可能是 schema 与构造脱节 —— fail fast。
  if (!res.ok) throw new Error(`starter doc 未通过自家 schema: ${res.error}`)
  return res.doc
}
