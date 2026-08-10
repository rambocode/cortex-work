import { defaultFrameSizeForDesignTarget, type DesignContext } from '../design-context'
import { buildCodeCanvasTurnPrompt } from '../design-turn-prompt'
import { takeLastCanvasOpErrors } from './apply-shape-ops'
import type { CanvasSnapshot } from './canvas-snapshot'
import type { CanvasDocument, ViewBox } from './canvas-types'
import {
  codeCanvasErrorKey,
  loadCodeCanvasDesignSystemForPrompt,
  snapshotCodeCanvasForPrompt
} from './code-canvas'
import type { DesignSystem } from './design-system-types'
import type { OpError } from './shape-ops'
import type { CanvasFilePort } from './canvas-file-port'

export type CodeCanvasOutboundDeps = {
  snapshotForPrompt?: typeof snapshotCodeCanvasForPrompt
  loadDesignSystemForPrompt?: typeof loadCodeCanvasDesignSystemForPrompt
  takeLastErrors?: (key: string) => OpError[]
}

export type BuildCodeCanvasOutboundTextOptions = CodeCanvasOutboundDeps & {
  baseText: string
  canvasBrief: string
  workspaceRoot: string
  threadId?: string | null
  currentDocument: CanvasDocument
  currentDocumentKey?: string | null
  selectedIds: ReadonlySet<string>
  viewBox: ViewBox
  designContext: DesignContext
  /** Cortex 会话白板的文件端口；快照与设计系统读取必须沿用同一宿主能力。 */
  filePort?: CanvasFilePort
  /** 个人会话使用正文协议块；具备真实 design_* 工具的宿主保留 dedicated-tools。 */
  transport?: 'dedicated-tools' | 'assistant-blocks'
}

async function readCodeCanvasSnapshot(
  options: BuildCodeCanvasOutboundTextOptions
): Promise<CanvasSnapshot | undefined> {
  if (!options.threadId) return undefined
  const snapshotForPrompt = options.snapshotForPrompt ?? snapshotCodeCanvasForPrompt
  return snapshotForPrompt({
    workspaceRoot: options.workspaceRoot,
    threadId: options.threadId,
    currentDocument: options.currentDocument,
    currentDocumentKey: options.currentDocumentKey,
    selectedIds: options.selectedIds,
    viewBox: options.viewBox,
    defaultScreenSize: defaultFrameSizeForDesignTarget(options.designContext.designTarget),
    ...(options.filePort ? { filePort: options.filePort } : {})
  })
}

async function readCodeCanvasDesignSystem(
  options: BuildCodeCanvasOutboundTextOptions
): Promise<DesignSystem | undefined> {
  if (!options.threadId) return undefined
  const loadDesignSystemForPrompt =
    options.loadDesignSystemForPrompt ?? loadCodeCanvasDesignSystemForPrompt
  return loadDesignSystemForPrompt({
    workspaceRoot: options.workspaceRoot,
    threadId: options.threadId,
    ...(options.filePort ? { filePort: options.filePort } : {})
  })
}

export async function buildCodeCanvasOutboundText(
  options: BuildCodeCanvasOutboundTextOptions
): Promise<string> {
  const snapshot = await readCodeCanvasSnapshot(options)
  const canvasFeedbackKey = options.threadId ? codeCanvasErrorKey(options.threadId) : undefined
  const canvasDesignSystem = await readCodeCanvasDesignSystem(options)
  const previousOpErrors = canvasFeedbackKey
    ? (options.takeLastErrors ?? takeLastCanvasOpErrors)(canvasFeedbackKey)
    : undefined
  const canvasPrompt = buildCodeCanvasTurnPrompt({
    workspaceRoot: options.workspaceRoot,
    text: options.canvasBrief,
    designContext: options.designContext,
    ...(previousOpErrors ? { previousOpErrors } : {}),
    ...(canvasFeedbackKey ? { canvasFeedbackKey } : {}),
    ...(canvasDesignSystem ? { canvasDesignSystem } : {}),
    ...(snapshot ? { canvasSnapshot: snapshot } : {}),
    ...(options.transport ? { transport: options.transport } : {})
  })
  return `${options.baseText}\n\n${canvasPrompt}`
}
