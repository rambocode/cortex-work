import type { SlidesFindingSeverity } from './slides-types'

export const SLIDES_PIPELINE_SCHEMA_VERSION = 1 as const

export type SlidesRole =
  | 'topic-researcher'
  | 'visual-researcher'
  | 'narrative-reviewer'
  | 'render-reviewer'
  | 'notes-writer'

export type SlidesRoleRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting-approval'
  | 'accepted'
  | 'rejected'
  | 'failed'
  | 'canceled'

export type SlidesPipelineRunStatus = 'running' | 'awaiting-approval' | 'completed' | 'failed' | 'canceled'

export type SlidesPipelineRunKind = 'research' | 'review' | 'notes'

export const SLIDES_PIPELINE_RECOVERABLE_RUN_STATUSES = ['running', 'awaiting-approval'] as const satisfies readonly SlidesPipelineRunStatus[]

export const SLIDES_ROLE_ARTIFACT_FILE_NAMES = {
  'topic-researcher': 'topic-research.json',
  'visual-researcher': 'visual-research.json',
  'narrative-reviewer': 'narrative-review.json',
  'render-reviewer': 'render-review.json',
  'notes-writer': 'notes-draft.json'
} as const satisfies Record<SlidesRole, string>

export type SlidesRoleArtifactFileName = (typeof SLIDES_ROLE_ARTIFACT_FILE_NAMES)[keyof typeof SLIDES_ROLE_ARTIFACT_FILE_NAMES]

export function slidesRoleArtifactFileName(role: SlidesRole): SlidesRoleArtifactFileName {
  return SLIDES_ROLE_ARTIFACT_FILE_NAMES[role]
}

export type SlidesTopicResearchSource = {
  title: string
  url?: string
  note?: string
}

export type SlidesTopicResearchResult = {
  facts: string[]
  sources: SlidesTopicResearchSource[]
  claims: string[]
  openQuestions: string[]
}

export type SlidesVisualAssetIdea = {
  slideId?: string
  query: string
  rationale: string
}

export type SlidesVisualChartIdea = {
  slideId?: string
  chartType: string
  rationale: string
}

export type SlidesVisualRisk = {
  slideId?: string
  message: string
  hint?: string
}

export type SlidesVisualResearchResult = {
  assetIdeas: SlidesVisualAssetIdea[]
  chartIdeas: SlidesVisualChartIdea[]
  visualRisks: SlidesVisualRisk[]
}

export type SlidesNarrativeDeckFinding = {
  code: string
  message: string
  hint?: string
}

export type SlidesNarrativeSlideFinding = {
  slideId: string
  code: string
  message: string
  hint?: string
}

export type SlidesNarrativeReviewResult = {
  deckFindings: SlidesNarrativeDeckFinding[]
  slideFindings: SlidesNarrativeSlideFinding[]
  suggestedOrder: string[]
}

export type SlidesRenderReviewFinding = {
  severity: SlidesFindingSeverity
  slideId: string
  elementId?: string
  code: string
  message: string
  hint?: string
}

export type SlidesRenderReviewResult = {
  findings: SlidesRenderReviewFinding[]
}

export type SlidesNotesSlotDraft = {
  slotId: string
  markdown: string
}

export type SlidesNotesWriterResult = {
  slots: SlidesNotesSlotDraft[]
}

export type SlidesRoleResultByRole = {
  'topic-researcher': SlidesTopicResearchResult
  'visual-researcher': SlidesVisualResearchResult
  'narrative-reviewer': SlidesNarrativeReviewResult
  'render-reviewer': SlidesRenderReviewResult
  'notes-writer': SlidesNotesWriterResult
}

export type SlidesRoleResult<R extends SlidesRole = SlidesRole> = SlidesRoleResultByRole[R]

export type SlidesPipelineRoleRun = {
  role: SlidesRole
  status: SlidesRoleRunStatus
  artifactFile: SlidesRoleArtifactFileName
  updatedAt: string
  summary?: string
  rawSummary?: string
  errorMessage?: string
}

export type SlidesPipelineRun = {
  schemaVersion: typeof SLIDES_PIPELINE_SCHEMA_VERSION
  id: string
  deckId: string
  kind: SlidesPipelineRunKind
  deckRevisionAtStart: number
  status: SlidesPipelineRunStatus
  roles: SlidesPipelineRoleRun[]
  createdAt: string
  updatedAt: string
}
