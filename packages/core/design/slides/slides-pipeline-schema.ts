import { z } from 'zod'
import { isValidDeckId, isValidSlotId } from './slides-paths'
import type { SlidesError } from './slides-types'
import {
  SLIDES_PIPELINE_SCHEMA_VERSION,
  SLIDES_ROLE_ARTIFACT_FILE_NAMES,
  type SlidesPipelineRoleRun,
  type SlidesPipelineRun,
  type SlidesRole,
  type SlidesRoleResult,
  type SlidesRoleResultByRole
} from './slides-pipeline-types'

export const SLIDES_PIPELINE_MAX_ROLE_COUNT = 5
export const SLIDES_PIPELINE_MAX_LIST_ITEMS = 24
export const SLIDES_PIPELINE_MAX_SHORT_TEXT_CHARS = 240
export const SLIDES_PIPELINE_MAX_LONG_TEXT_CHARS = 2_000
export const SLIDES_PIPELINE_MAX_MARKDOWN_CHARS = 12_000
export const SLIDES_PIPELINE_MAX_URL_CHARS = 2_048
export const SLIDES_PIPELINE_MAX_ROLE_RESULT_BYTES = 32 * 1024
export const SLIDES_PIPELINE_MAX_RUN_JSON_BYTES = 32 * 1024

const encoder = new TextEncoder()

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/, 'invalid ISO datetime')
const shortText = z.string().trim().min(1).max(SLIDES_PIPELINE_MAX_SHORT_TEXT_CHARS)
const longText = z.string().trim().min(1).max(SLIDES_PIPELINE_MAX_LONG_TEXT_CHARS)
const markdownText = z.string().trim().min(1).max(SLIDES_PIPELINE_MAX_MARKDOWN_CHARS)
const slideId = z.string().refine(isValidSlotId, 'invalid slide id')
const codeText = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'invalid code')
const runId = z.string().regex(/^run-[a-z0-9][a-z0-9-]{0,63}$/, 'invalid run id')
const urlText = z.string().url().max(SLIDES_PIPELINE_MAX_URL_CHARS)

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict()

function jsonByteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length
}

function withJsonByteLimit<T extends z.ZodTypeAny>(schema: T, maxBytes: number, label: string): T {
  return schema.superRefine((value, ctx) => {
    if (jsonByteLength(value) > maxBytes) {
      ctx.addIssue({ code: 'custom', message: `${label} exceeds ${maxBytes} bytes` })
    }
  }) as T
}

const topicResearchResultSchema = withJsonByteLimit(
  strictObject({
    facts: z.array(shortText).min(1).max(SLIDES_PIPELINE_MAX_LIST_ITEMS),
    sources: z
      .array(
        strictObject({
          title: shortText,
          url: urlText.optional(),
          note: longText.optional()
        })
      )
      .min(1)
      .max(SLIDES_PIPELINE_MAX_LIST_ITEMS),
    claims: z.array(shortText).min(1).max(SLIDES_PIPELINE_MAX_LIST_ITEMS),
    openQuestions: z.array(shortText).min(1).max(SLIDES_PIPELINE_MAX_LIST_ITEMS)
  }),
  SLIDES_PIPELINE_MAX_ROLE_RESULT_BYTES,
  'topic research result'
)

const visualResearchResultSchema = withJsonByteLimit(
  strictObject({
    assetIdeas: z
      .array(
        strictObject({
          slideId: slideId.optional(),
          query: shortText,
          rationale: longText
        })
      )
      .max(SLIDES_PIPELINE_MAX_LIST_ITEMS),
    chartIdeas: z
      .array(
        strictObject({
          slideId: slideId.optional(),
          chartType: codeText,
          rationale: longText
        })
      )
      .max(SLIDES_PIPELINE_MAX_LIST_ITEMS),
    visualRisks: z
      .array(
        strictObject({
          slideId: slideId.optional(),
          message: longText,
          hint: longText.optional()
        })
      )
      .max(SLIDES_PIPELINE_MAX_LIST_ITEMS)
  }),
  SLIDES_PIPELINE_MAX_ROLE_RESULT_BYTES,
  'visual research result'
)

const narrativeReviewResultSchema = withJsonByteLimit(
  strictObject({
    deckFindings: z
      .array(
        strictObject({
          code: codeText,
          message: longText,
          hint: longText.optional()
        })
      )
      .max(SLIDES_PIPELINE_MAX_LIST_ITEMS),
    slideFindings: z
      .array(
        strictObject({
          slideId,
          code: codeText,
          message: longText,
          hint: longText.optional()
        })
      )
      .max(SLIDES_PIPELINE_MAX_LIST_ITEMS),
    suggestedOrder: z.array(slideId).max(SLIDES_PIPELINE_MAX_LIST_ITEMS)
  }),
  SLIDES_PIPELINE_MAX_ROLE_RESULT_BYTES,
  'narrative review result'
)

const renderReviewResultSchema = withJsonByteLimit(
  strictObject({
    findings: z
      .array(
        strictObject({
          severity: z.enum(['blocking', 'warning', 'info']),
          slideId,
          elementId: shortText.optional(),
          code: codeText,
          message: longText,
          hint: longText.optional()
        })
      )
      .max(SLIDES_PIPELINE_MAX_LIST_ITEMS)
  }),
  SLIDES_PIPELINE_MAX_ROLE_RESULT_BYTES,
  'render review result'
)

const notesWriterResultSchema = withJsonByteLimit(
  strictObject({
    slots: z
      .array(
        strictObject({
          slotId: z.string().refine(isValidSlotId, 'invalid slot id'),
          markdown: markdownText
        })
      )
      .min(1)
      .max(SLIDES_PIPELINE_MAX_LIST_ITEMS)
      .superRefine((slots, ctx) => {
        const seen = new Set<string>()
        for (const slot of slots) {
          if (seen.has(slot.slotId)) {
            ctx.addIssue({ code: 'custom', message: `duplicate slot id: ${slot.slotId}` })
          }
          seen.add(slot.slotId)
        }
      })
  }),
  SLIDES_PIPELINE_MAX_ROLE_RESULT_BYTES,
  'notes writer result'
)

export const slidesRoleResultSchemaByRole = {
  'topic-researcher': topicResearchResultSchema,
  'visual-researcher': visualResearchResultSchema,
  'narrative-reviewer': narrativeReviewResultSchema,
  'render-reviewer': renderReviewResultSchema,
  'notes-writer': notesWriterResultSchema
} as const

const roleRunBase = {
  status: z.enum(['queued', 'running', 'awaiting-approval', 'accepted', 'rejected', 'failed', 'canceled']),
  updatedAt: isoDate,
  summary: shortText.optional(),
  rawSummary: longText.optional(),
  errorMessage: longText.optional()
}

export const slidesPipelineRoleRunSchema = z.discriminatedUnion('role', [
  strictObject({
    role: z.literal('topic-researcher'),
    artifactFile: z.literal(SLIDES_ROLE_ARTIFACT_FILE_NAMES['topic-researcher']),
    ...roleRunBase
  }),
  strictObject({
    role: z.literal('visual-researcher'),
    artifactFile: z.literal(SLIDES_ROLE_ARTIFACT_FILE_NAMES['visual-researcher']),
    ...roleRunBase
  }),
  strictObject({
    role: z.literal('narrative-reviewer'),
    artifactFile: z.literal(SLIDES_ROLE_ARTIFACT_FILE_NAMES['narrative-reviewer']),
    ...roleRunBase
  }),
  strictObject({
    role: z.literal('render-reviewer'),
    artifactFile: z.literal(SLIDES_ROLE_ARTIFACT_FILE_NAMES['render-reviewer']),
    ...roleRunBase
  }),
  strictObject({
    role: z.literal('notes-writer'),
    artifactFile: z.literal(SLIDES_ROLE_ARTIFACT_FILE_NAMES['notes-writer']),
    ...roleRunBase
  })
]) as z.ZodType<SlidesPipelineRoleRun>

export const slidesPipelineRunSchema = withJsonByteLimit(
  strictObject({
    schemaVersion: z.literal(SLIDES_PIPELINE_SCHEMA_VERSION),
    id: runId,
    deckId: z.string().refine(isValidDeckId, 'invalid deck id'),
    kind: z.enum(['research', 'review', 'notes']),
    deckRevisionAtStart: z.number().int().min(0),
    status: z.enum(['running', 'awaiting-approval', 'completed', 'failed', 'canceled']),
    roles: z.array(slidesPipelineRoleRunSchema).min(1).max(SLIDES_PIPELINE_MAX_ROLE_COUNT),
    createdAt: isoDate,
    updatedAt: isoDate
  }).superRefine((run, ctx) => {
    const seen = new Set<SlidesRole>()
    for (const role of run.roles) {
      if (seen.has(role.role)) {
        ctx.addIssue({ code: 'custom', path: ['roles'], message: `duplicate role: ${role.role}` })
      }
      seen.add(role.role)
    }
  }),
  SLIDES_PIPELINE_MAX_RUN_JSON_BYTES,
  'pipeline run'
) as z.ZodType<SlidesPipelineRun>

export type SlidesPipelineRunParseResult = { ok: true; run: SlidesPipelineRun } | { ok: false; error: SlidesError }
export type SlidesRoleResultParseResult<R extends SlidesRole = SlidesRole> =
  | { ok: true; result: SlidesRoleResult<R> }
  | { ok: false; error: SlidesError }

function firstIssueMessage(error: z.ZodError, label: string): string {
  const first = error.issues[0]
  const where = first?.path?.length ? `(${first.path.join('.')}) ` : ''
  return `${label} 校验失败 ${where}${first?.message ?? ''}`.trim()
}

function parseJsonInput(input: unknown, code: SlidesError['code'], label: string): { ok: true; value: unknown } | { ok: false; error: SlidesError } {
  if (typeof input !== 'string') return { ok: true, value: input }
  try {
    return { ok: true, value: JSON.parse(input) }
  } catch {
    return { ok: false, error: { code, message: `${label} 不是合法 JSON` } }
  }
}

export function parseSlidesPipelineRun(input: unknown): SlidesPipelineRunParseResult {
  const decoded = parseJsonInput(input, 'invalid_manifest', 'run.json')
  if (!decoded.ok) return decoded
  const parsed = slidesPipelineRunSchema.safeParse(decoded.value)
  if (!parsed.success) {
    return { ok: false, error: { code: 'invalid_manifest', message: firstIssueMessage(parsed.error, 'run.json') } }
  }
  return { ok: true, run: parsed.data }
}

export function serializeSlidesPipelineRun(run: SlidesPipelineRun): string {
  return `${JSON.stringify(run, null, 2)}\n`
}

export function parseSlidesRoleResult<R extends SlidesRole>(role: R, input: unknown): SlidesRoleResultParseResult<R> {
  const decoded = parseJsonInput(input, 'invalid_payload', `${role} result`)
  if (!decoded.ok) return decoded
  const schema = slidesRoleResultSchemaByRole[role] as unknown as z.ZodType<SlidesRoleResultByRole[R]>
  const parsed = schema.safeParse(decoded.value)
  if (!parsed.success) {
    return { ok: false, error: { code: 'invalid_payload', message: firstIssueMessage(parsed.error, `${role} result`) } }
  }
  return { ok: true, result: parsed.data }
}

export function serializeSlidesRoleResult<R extends SlidesRole>(role: R, result: SlidesRoleResult<R>): string {
  const parsed = parseSlidesRoleResult(role, result)
  if (!parsed.ok) throw new Error(parsed.error.message)
  return `${JSON.stringify(parsed.result, null, 2)}\n`
}
