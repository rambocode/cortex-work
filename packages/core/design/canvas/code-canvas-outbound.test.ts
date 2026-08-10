import { describe, expect, it, vi } from 'vitest'
import { buildCodeCanvasOutboundText } from './code-canvas-outbound'
import {
  loadCodeCanvasDesignSystemForPrompt,
  snapshotCodeCanvasForPrompt
} from './code-canvas'
import type { CanvasSnapshot } from './canvas-snapshot'
import { createEmptyDocument } from './canvas-types'
import { createEmptyDesignSystem } from './design-system-types'

const viewBox = { x: 0, y: 0, width: 1200, height: 800 }
const snapshot: CanvasSnapshot = {
  shapeCount: 1,
  shapes: [{
    id: 'shape_1',
    name: 'API box',
    type: 'rect',
    x: 0,
    y: 0,
    w: 120,
    h: 80,
    parentName: null
  }]
}

describe('code canvas outbound prompt', () => {
  it('adds snapshot, design system, and scoped op feedback for a thread canvas', async () => {
    const filePort = {
      readText: vi.fn(async () => null),
      writeText: vi.fn(async () => true)
    }
    const snapshotForPrompt = vi.fn(async (
      _options: Parameters<typeof snapshotCodeCanvasForPrompt>[0]
    ) => snapshot)
    const loadDesignSystemForPrompt = vi.fn(async (
      _options: Parameters<typeof loadCodeCanvasDesignSystemForPrompt>[0]
    ) => createEmptyDesignSystem())
    const takeLastErrors = vi.fn(() => [{ code: 'SHAPE_NOT_FOUND' as const, message: 'Missing shape' }])

    const outbound = await buildCodeCanvasOutboundText({
      baseText: 'Draw the architecture',
      canvasBrief: 'Draw the architecture',
      workspaceRoot: '/workspace',
      threadId: 'thread_1',
      currentDocument: createEmptyDocument(),
      currentDocumentKey: 'doc-key',
      selectedIds: new Set(['shape_1']),
      viewBox,
      designContext: { designTarget: 'app' },
      snapshotForPrompt,
      loadDesignSystemForPrompt,
      takeLastErrors,
      filePort,
      transport: 'assistant-blocks'
    })

    expect(outbound.startsWith('Draw the architecture\n\n')).toBe(true)
    expect(outbound).toContain('SHAPE_NOT_FOUND')
    // 个人会话没有注册 design_* 专用工具，必须要求 Agent 在正文输出界面可回放的协议块。
    expect(outbound).toContain('Cortex conversation whiteboard transport:')
    expect(outbound).toContain('fenced `design_canvas` blocks')
    expect(outbound).toContain('"action": "update_shapes"')
    expect(outbound).not.toContain('Do not emit markdown/fenced JSON blocks')
    expect(snapshotForPrompt).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: '/workspace',
      threadId: 'thread_1',
      selectedIds: new Set(['shape_1']),
      filePort
    }))
    expect(loadDesignSystemForPrompt).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      threadId: 'thread_1',
      filePort
    })
    expect(takeLastErrors).toHaveBeenCalledWith('code-canvas:thread_1')
  })

  it('does not read thread-only context when no active thread exists', async () => {
    const snapshotForPrompt = vi.fn()
    const loadDesignSystemForPrompt = vi.fn()
    const takeLastErrors = vi.fn()

    const outbound = await buildCodeCanvasOutboundText({
      baseText: 'Sketch a module map',
      canvasBrief: 'Sketch a module map',
      workspaceRoot: '/workspace',
      threadId: null,
      currentDocument: createEmptyDocument(),
      selectedIds: new Set(),
      viewBox,
      designContext: { designTarget: 'web' },
      snapshotForPrompt,
      loadDesignSystemForPrompt,
      takeLastErrors
    })

    expect(outbound.startsWith('Sketch a module map\n\n')).toBe(true)
    expect(snapshotForPrompt).not.toHaveBeenCalled()
    expect(loadDesignSystemForPrompt).not.toHaveBeenCalled()
    expect(takeLastErrors).not.toHaveBeenCalled()
  })
})
