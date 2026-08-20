import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceFileChangePayload, WorkspaceFileWatchResult } from './compat/workspace-file'
import {
  buildDesignPreviewSkeleton,
  designPreviewRenderState,
  isDesignPreviewSkeleton,
  prepareDesignPreviewFile,
  startDesignHtmlPreviewWatch
} from './design-preview-file'

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function createWatchApi(result: WorkspaceFileWatchResult | Promise<WorkspaceFileWatchResult>) {
  let handler: ((payload: WorkspaceFileChangePayload) => void) | null = null
  const off = vi.fn()
  const api = {
    watchWorkspaceFile: vi.fn(async () => result),
    unwatchWorkspaceFile: vi.fn(async () => true),
    onWorkspaceFileChanged: vi.fn((nextHandler: (payload: WorkspaceFileChangePayload) => void) => {
      handler = nextHandler
      return off
    })
  }
  return {
    api,
    off,
    emit: (payload: WorkspaceFileChangePayload) => handler?.(payload)
  }
}

describe('design preview file helpers', () => {
  it('recognizes only Cortex preview skeleton content', () => {
    expect(isDesignPreviewSkeleton(buildDesignPreviewSkeleton('.cortex-design/new/v1.html'))).toBe(true)
    expect(isDesignPreviewSkeleton('<!doctype html><html><body><h1>Real page</h1></body></html>')).toBe(false)
  })

  it('classifies skeleton, stable HTML, and transient partial writes separately', () => {
    expect(designPreviewRenderState(buildDesignPreviewSkeleton('.cortex-design/new/v1.html'))).toBe('skeleton')
    expect(designPreviewRenderState('<!doctype html><html><body><h1>Real page</h1></body></html>')).toBe('renderable')
    expect(designPreviewRenderState('<!doctype html><html><body><h1>Half written')).toBe('transient')
    expect(designPreviewRenderState('```html\n<html><body>oops')).toBe('transient')
  })

  // fs:readFile 有 2MB 截断线,bento deck 实测 1.5MB 且随保存世代增长。被截断的内容
  // 一定没有 </html>,拿关闭标签当「写完了」的证据会让 deck 恒判 transient → webview
  // 永不挂载 → revision 永不推进(用户实测:AI 改完中间画布毫无变化)。
  it('treats truncated reads with an open HTML shell as renderable', () => {
    const openOnly = `<!doctype html><html><head><title>Deck</title></head><body><div id="bento-doc">${'x'.repeat(64)}`

    expect(designPreviewRenderState(openOnly, { truncated: true })).toBe('renderable')
    // 同样内容未被截断 → 仍是「写到一半」,不能挂载。
    expect(designPreviewRenderState(openOnly, { truncated: false })).toBe('transient')
    expect(designPreviewRenderState(openOnly)).toBe('transient')
    // 截断也不能把 markdown 代码块伪装成 HTML 文档。
    expect(designPreviewRenderState('```html\n<html><body>oops', { truncated: true })).toBe('transient')
    // skeleton 判定与 truncated 无关(骨架文件极小,不会触到截断线)。
    expect(designPreviewRenderState(buildDesignPreviewSkeleton('a.html'), { truncated: true })).toBe('skeleton')
  })

  it('forwards the truncated flag from both the initial watch read and change events', async () => {
    const bigOpenShell = `<!doctype html><html><body><div id="bento-doc">${'x'.repeat(32)}`
    const { api, emit } = createWatchApi({
      ok: true,
      watchId: 'watch-1',
      path: '/workspace/.cortex-design/d7b7/deck.bento.html',
      content: bigOpenShell,
      size: 2 * 1024 * 1024,
      truncated: true,
      startedAt: '2026-06-21T00:00:00.000Z'
    })
    const onRevision = vi.fn()
    const onPreviewStateChange = vi.fn()
    const dispose = startDesignHtmlPreviewWatch({
      api,
      workspaceRoot: '/workspace',
      path: '.cortex-design/d7b7/deck.bento.html',
      onRevision,
      onPreviewStateChange,
      onError: vi.fn(),
      revisionDebounceMs: 0
    })
    await flushPromises()

    expect(onPreviewStateChange).toHaveBeenCalledWith('renderable')
    expect(onRevision).toHaveBeenCalledTimes(1)

    emit({
      ok: true,
      watchId: 'watch-1',
      workspaceRoot: '/workspace',
      path: '/workspace/.cortex-design/d7b7/deck.bento.html',
      content: bigOpenShell,
      size: 2 * 1024 * 1024,
      truncated: true,
      changedAt: '2026-06-21T00:00:02.000Z'
    })

    expect(onPreviewStateChange).toHaveBeenLastCalledWith('renderable')
    expect(onRevision).toHaveBeenCalledTimes(2)
    expect(onRevision).toHaveBeenNthCalledWith(2, 2)

    dispose()
  })

  it('creates a visible skeleton for a new HTML turn before sending', async () => {
    const writeWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      path: '/workspace/.cortex-design/new/v1.html',
      savedAt: '2026-06-21T00:00:00.000Z'
    }))

    const result = await prepareDesignPreviewFile(
      '/workspace',
      '.cortex-design/new/v1.html',
      undefined,
      { writeWorkspaceFile }
    )

    expect(result).toEqual({ ok: true, source: 'skeleton' })
    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: '.cortex-design/new/v1.html',
      workspaceRoot: '/workspace',
      content: expect.stringContaining('Generating design...')
    })
    const [payload] = writeWorkspaceFile.mock.calls[0] as unknown as [{ content: string }]
    expect(payload.content).toContain('.cortex-design/new/v1.html')
  })

  it('keeps the skeleton preview compact and non-scrollable inside small canvas frames', () => {
    const skeleton = buildDesignPreviewSkeleton('.cortex-design/new/v1.html')

    expect(skeleton).toContain('overflow: hidden')
    expect(skeleton).toContain('height: 100%')
    expect(skeleton).toContain('@media (max-height: 230px)')
    expect(skeleton).not.toContain('min-height: 100vh')
  })

  it('copies the previous HTML version into an iteration preview file', async () => {
    const readWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      path: '/workspace/.cortex-design/screen/v1.html',
      content: '<!doctype html><html><body>Previous</body></html>',
      size: 48,
      truncated: false
    }))
    const writeWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      path: '/workspace/.cortex-design/screen/v2.html',
      savedAt: '2026-06-21T00:00:00.000Z'
    }))

    const result = await prepareDesignPreviewFile(
      '/workspace',
      '.cortex-design/screen/v2.html',
      '.cortex-design/screen/v1.html',
      { readWorkspaceFile, writeWorkspaceFile }
    )

    expect(result).toEqual({ ok: true, source: 'base' })
    expect(readWorkspaceFile).toHaveBeenCalledWith({
      path: '.cortex-design/screen/v1.html',
      workspaceRoot: '/workspace'
    })
    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: '.cortex-design/screen/v2.html',
      workspaceRoot: '/workspace',
      content: '<!doctype html><html><body>Previous</body></html>'
    })
  })

  it('increments preview revision when the watched HTML file changes', async () => {
    const { api, emit, off } = createWatchApi({
      ok: true,
      watchId: 'watch-1',
      path: '/workspace/.cortex-design/screen/v1.html',
      content: buildDesignPreviewSkeleton('.cortex-design/screen/v1.html'),
      size: buildDesignPreviewSkeleton('.cortex-design/screen/v1.html').length,
      truncated: false,
      startedAt: '2026-06-21T00:00:00.000Z'
    })
    const onRevision = vi.fn()
    const onSkeletonChange = vi.fn()
    const dispose = startDesignHtmlPreviewWatch({
      api,
      workspaceRoot: '/workspace',
      path: '.cortex-design/screen/v1.html',
      onRevision,
      onSkeletonChange,
      onError: vi.fn(),
      revisionDebounceMs: 0
    })
    await flushPromises()

    emit({
      ok: true,
      watchId: 'watch-other',
      workspaceRoot: '/workspace',
      path: '/workspace/.cortex-design/screen/v1.html',
      content: 'ignored',
      size: 7,
      truncated: false,
      changedAt: '2026-06-21T00:00:01.000Z'
    })
    emit({
      ok: true,
      watchId: 'watch-1',
      workspaceRoot: '/workspace',
      path: '/workspace/.cortex-design/screen/v1.html',
      content: '<html><body>Changed</body></html>',
      size: 33,
      truncated: false,
      changedAt: '2026-06-21T00:00:02.000Z'
    })

    expect(onRevision).toHaveBeenCalledTimes(2)
    expect(onRevision).toHaveBeenNthCalledWith(1, 1)
    expect(onRevision).toHaveBeenNthCalledWith(2, 2)
    expect(onSkeletonChange).toHaveBeenCalledTimes(2)
    expect(onSkeletonChange).toHaveBeenNthCalledWith(1, true)
    expect(onSkeletonChange).toHaveBeenNthCalledWith(2, false)

    dispose()
    expect(off).toHaveBeenCalled()
    expect(api.unwatchWorkspaceFile).toHaveBeenCalledWith('watch-1')
  })

  it('does not bump revision when the initial watched file is only a transient partial HTML', async () => {
    const { api, emit, off } = createWatchApi({
      ok: true,
      watchId: 'watch-1',
      path: '/workspace/.cortex-design/screen/v1.html',
      content: '<!doctype html><html><body><main><h1>Loading',
      size: 44,
      truncated: false,
      startedAt: '2026-06-21T00:00:00.000Z'
    })
    const onRevision = vi.fn()
    const onSkeletonChange = vi.fn()
    const onPreviewStateChange = vi.fn()
    const dispose = startDesignHtmlPreviewWatch({
      api,
      workspaceRoot: '/workspace',
      path: '.cortex-design/screen/v1.html',
      onRevision,
      onSkeletonChange,
      onPreviewStateChange,
      onError: vi.fn(),
      revisionDebounceMs: 0
    })
    await flushPromises()

    expect(onRevision).not.toHaveBeenCalled()
    expect(onSkeletonChange).toHaveBeenCalledWith(true)
    expect(onPreviewStateChange).toHaveBeenCalledWith('transient')

    emit({
      ok: true,
      watchId: 'watch-1',
      workspaceRoot: '/workspace',
      path: '/workspace/.cortex-design/screen/v1.html',
      content: '<!doctype html><html><body><main><h1>Done</h1></main></body></html>',
      size: 70,
      truncated: false,
      changedAt: '2026-06-21T00:00:02.000Z'
    })

    expect(onRevision).toHaveBeenCalledTimes(1)
    expect(onRevision).toHaveBeenNthCalledWith(1, 1)
    expect(onSkeletonChange).toHaveBeenLastCalledWith(false)
    expect(onPreviewStateChange).toHaveBeenLastCalledWith('renderable')

    dispose()
    expect(off).toHaveBeenCalled()
    expect(api.unwatchWorkspaceFile).toHaveBeenCalledWith('watch-1')
  })

  it('coalesces rapid streaming writes into a single debounced revision bump', async () => {
    vi.useFakeTimers()
    try {
      const { api, emit, off } = createWatchApi({
        ok: true,
        watchId: 'watch-1',
        path: '/workspace/.cortex-design/screen/v1.html',
        content: buildDesignPreviewSkeleton('.cortex-design/screen/v1.html'),
        size: buildDesignPreviewSkeleton('.cortex-design/screen/v1.html').length,
        truncated: false,
        startedAt: '2026-06-21T00:00:00.000Z'
      })
      const onRevision = vi.fn()
      const onSkeletonChange = vi.fn()
      const dispose = startDesignHtmlPreviewWatch({
        api,
        workspaceRoot: '/workspace',
        path: '.cortex-design/screen/v1.html',
        onRevision,
        onSkeletonChange,
        onError: vi.fn(),
        revisionDebounceMs: 200
      })
      await vi.runOnlyPendingTimersAsync()

      // Initial watch establishment bumps once immediately for the first paint.
      expect(onRevision).toHaveBeenCalledTimes(1)
      expect(onRevision).toHaveBeenNthCalledWith(1, 1)

      const emitWrite = (content: string): void =>
        emit({
          ok: true,
          watchId: 'watch-1',
          workspaceRoot: '/workspace',
          path: '/workspace/.cortex-design/screen/v1.html',
          content,
          size: content.length,
          truncated: false,
          changedAt: '2026-06-21T00:00:01.000Z'
        })

      emitWrite('<!doctype html><html><body><main>')
      emitWrite('<!doctype html><html><body><main><h1>Almost</h1>')

      // Partial writes keep the placeholder treatment active and must not trigger
      // a reload into a half-written document.
      expect(onSkeletonChange).toHaveBeenLastCalledWith(true)
      expect(onRevision).toHaveBeenCalledTimes(1)

      emitWrite('<!doctype html><html><body><main><h1>Ready</h1></main></body></html>')
      expect(onSkeletonChange).toHaveBeenLastCalledWith(false)

      vi.advanceTimersByTime(200)
      expect(onRevision).toHaveBeenCalledTimes(2)
      expect(onRevision).toHaveBeenNthCalledWith(2, 2)

      dispose()
      expect(off).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
