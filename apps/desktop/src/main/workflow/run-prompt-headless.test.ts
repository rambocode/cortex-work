/**
 * run-prompt-headless.ts 单元测试（U12）
 *
 * mock 策略：
 *   - startAgentProcess：返回伪 AgentProcess（可控 stdout 行流、exitHandler、kill）
 *   - pipeStdoutLines：截获 onLine 回调，测试中手动 push 行
 *   - parseLineEvents：根据 mock 行内容返回对应 CliStreamEvent
 *   - getPersistedState / getWorkspaceRoot / writePiExtension / getAgentDef：最小 mock
 *
 * 注意：run-prompt-headless 内部 await getPersistedState()（async），
 * 因此在 startAgentProcess 被调用之前需要 flush 微任务队列，
 * 所有推送 exit/line 前须先 await nextTick()。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliStreamEvent } from '../ipc/types.js'

// ── 跨测试的共享状态（每次 beforeEach 重置）──────────────────────────────────

let _onLine: ((line: string) => void) | null = null
let _onExit: ((code: number | null) => void) | null = null
let _killCount = 0
let _lineEventQueue: CliStreamEvent[][] = []

// ── Mock 声明 ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  startAgentProcess: vi.fn(),
  pipeStdoutLines: vi.fn(),
  spawnEnvForDef: vi.fn(() => ({})),
  assertSpawnCwd: vi.fn(),
  getAgentDef: vi.fn(),
  parseLineEvents: vi.fn(),
  getPersistedState: vi.fn(),
  getWorkspaceRoot: vi.fn(),
  writePiExtension: vi.fn(() => '/tmp/pi-ext.json'),
}))

vi.mock('../ipc/cli.js', () => ({
  startAgentProcess: mocks.startAgentProcess,
  pipeStdoutLines: mocks.pipeStdoutLines,
  spawnEnvForDef: mocks.spawnEnvForDef,
  assertSpawnCwd: mocks.assertSpawnCwd,
}))

vi.mock('../agents/index.js', () => ({
  getAgentDef: mocks.getAgentDef,
  parseLineEvents: mocks.parseLineEvents,
}))

vi.mock('../ipc/store.js', () => ({
  getPersistedState: mocks.getPersistedState,
  getWorkspaceRoot: mocks.getWorkspaceRoot,
}))

vi.mock('../agents/pi-providers.js', () => ({
  writePiExtension: mocks.writePiExtension,
}))

vi.mock('../ipc/mcp-config.js', () => ({
  CODEX_MCP_CLEAR: [],
}))

import {
  runPromptHeadless,
  killAllHeadlessPrompts,
  AI_NODE_RESPONSE_TIMEOUT_MS,
} from './run-prompt-headless.js'

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/**
 * 等待所有 pending 微任务（Promise 链）执行完毕。
 * run-prompt-headless 内部有多个 await（getPersistedState、resolveProvider），
 * 需要 flush 才能让 startAgentProcess 和 onExit 注册完毕。
 */
async function nextTick(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
  }
}

// ── beforeEach：重建 mock proc 状态 ──────────────────────────────────────────

beforeEach(() => {
  _onLine = null
  _onExit = null
  _killCount = 0
  _lineEventQueue = []

  // 每次重建 mock proc，避免跨测试的回调泄漏
  const mockProc = {
    pid: 1234,
    stdout: null,
    stderr: null,
    onExit(cb: (code: number | null) => void) { _onExit = cb },
    onError(_cb: (err: Error) => void) { /* not used in most tests */ },
    kill() { _killCount++ },
  }

  const mockAdapter = {
    buildArgs: vi.fn(() => ({ cmd: 'claude', args: [], stdin: 'test' })),
  }

  mocks.startAgentProcess.mockReturnValue(mockProc)
  mocks.getAgentDef.mockReturnValue(mockAdapter)
  mocks.spawnEnvForDef.mockReturnValue({ PATH: '/usr/bin' })
  mocks.assertSpawnCwd.mockReturnValue(undefined)

  mocks.pipeStdoutLines.mockImplementation(
    (_stdout: unknown, onLine: (line: string) => void) => {
      _onLine = onLine
      return () => {}
    },
  )

  mocks.parseLineEvents.mockImplementation((_adapter: unknown, _line: string) => {
    return _lineEventQueue.shift() ?? []
  })

  mocks.getPersistedState.mockResolvedValue({ providerSettings: { providers: [] } })
  mocks.getWorkspaceRoot.mockResolvedValue('/default/workspace')
})

afterEach(() => {
  killAllHeadlessPrompts()
  vi.clearAllMocks()
})

// ── 测试辅助 ──────────────────────────────────────────────────────────────────

function enqueueEvents(events: CliStreamEvent[]): void {
  _lineEventQueue.push(events)
}

function pushLine(line = 'line'): void {
  _onLine?.(line)
}

function exit(code: number | null = 0): void {
  _onExit?.(code)
}

function pushText(delta: string): void {
  enqueueEvents([{ type: 'text', delta } as CliStreamEvent])
  pushLine()
}

function pushResult(ok: boolean, error?: string, text?: string): void {
  enqueueEvents([{ type: 'result', ok, error, text } as CliStreamEvent])
  pushLine()
}

function pushInit(sessionId: string): void {
  enqueueEvents([{ type: 'init', sessionId } as CliStreamEvent])
  pushLine()
}

const DEFAULT_OPTS = {
  prompt: 'test prompt',
  workspaceRoot: '/test/workspace',
  providerId: 'claude',
}

// ── 正常路径 ──────────────────────────────────────────────────────────────────

describe('正常路径', () => {
  it('聚合多段 text 并返回 agentSessionId', async () => {
    const promise = runPromptHeadless(DEFAULT_OPTS)
    await nextTick()  // 等待 getPersistedState 等 async 步骤完成，onExit 已注册

    pushInit('session-abc')
    pushText('Hello ')
    pushText('world')
    pushResult(true)
    exit(0)

    const result = await promise
    expect(result.text).toBe('Hello world')
    expect(result.agentSessionId).toBe('session-abc')
  })

  it('无 init 事件时 agentSessionId 为 undefined', async () => {
    const promise = runPromptHeadless(DEFAULT_OPTS)
    await nextTick()

    pushText('some output')
    pushResult(true)
    exit(0)

    const result = await promise
    expect(result.agentSessionId).toBeUndefined()
  })

  it('streaming text 非空时取 out，忽略 result.text', async () => {
    const promise = runPromptHeadless(DEFAULT_OPTS)
    await nextTick()

    pushText('stream output')
    enqueueEvents([{ type: 'result', ok: true, text: 'result-text' } as CliStreamEvent])
    pushLine()
    exit(0)

    const result = await promise
    expect(result.text).toBe('stream output')
  })

  it('streaming text 为空时取 result.text', async () => {
    const promise = runPromptHeadless(DEFAULT_OPTS)
    await nextTick()

    enqueueEvents([{ type: 'result', ok: true, text: 'fallback-text' } as CliStreamEvent])
    pushLine()
    exit(0)

    const result = await promise
    expect(result.text).toBe('fallback-text')
  })

  it('调用 assertSpawnCwd 与 startAgentProcess（含 cwd）', async () => {
    const promise = runPromptHeadless(DEFAULT_OPTS)
    await nextTick()

    pushResult(true)
    exit(0)
    await promise

    expect(mocks.assertSpawnCwd).toHaveBeenCalledWith('/test/workspace')
    expect(mocks.startAgentProcess).toHaveBeenCalledWith(
      'claude',
      expect.any(Array),
      expect.objectContaining({ cwd: '/test/workspace' }),
    )
  })
})

// ── text 超 200KB 截断 ────────────────────────────────────────────────────────

describe('200KB 截断', () => {
  it('text 累积达 200KB 后不再追加更多内容', async () => {
    const promise = runPromptHeadless(DEFAULT_OPTS)
    await nextTick()

    // 第一块：正好 200_000 字节，触发上限（out.length < MAX_OUTPUT 为 false）
    enqueueEvents([{ type: 'text', delta: 'a'.repeat(200_000) } as CliStreamEvent])
    pushLine()
    // 第二块：应被完全丢弃（out.length === 200_000，不 < MAX_OUTPUT）
    enqueueEvents([{ type: 'text', delta: 'b'.repeat(1000) } as CliStreamEvent])
    pushLine()

    pushResult(true)
    exit(0)

    const result = await promise
    expect(result.text.length).toBe(200_000)
    expect(result.text).not.toContain('b')
  })
})

// ── 超时 30min ────────────────────────────────────────────────────────────────

describe('超时', () => {
  it('30min 超时后 kill 进程并 reject', async () => {
    vi.useFakeTimers()

    try {
      const promise = runPromptHeadless(DEFAULT_OPTS)

      // fake timers 下无法用 await，改用 vi.advanceTimersByTimeAsync 推进微任务队列
      // 先推进微任务（确保 getPersistedState 等 async 步骤完成，onExit 已注册）
      await vi.advanceTimersByTimeAsync(0)

      // 再推进到超时阈值
      vi.advanceTimersByTime(AI_NODE_RESPONSE_TIMEOUT_MS + 100)

      // 超时触发 proc.kill()，再触发 exit（模拟进程被 kill 后退出）
      exit(null)

      await expect(promise).rejects.toThrow('超时')
      expect(_killCount).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── AbortSignal 取消 ──────────────────────────────────────────────────────────

describe('AbortSignal 取消', () => {
  it('signal 已触发时立即 reject（不 spawn）', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      runPromptHeadless({ ...DEFAULT_OPTS, signal: controller.signal }),
    ).rejects.toThrow('已取消')
  })

  it('运行中 abort → kill 并 reject', async () => {
    const controller = new AbortController()
    const promise = runPromptHeadless({ ...DEFAULT_OPTS, signal: controller.signal })
    await nextTick()

    pushText('partial output')
    controller.abort()
    exit(null)

    await expect(promise).rejects.toThrow('已取消')
    expect(_killCount).toBeGreaterThan(0)
  })
})

// ── agent 报告失败 ────────────────────────────────────────────────────────────

describe('agent 报告失败', () => {
  it('result.ok=false 且有 error 字段 → reject 明确错误', async () => {
    const promise = runPromptHeadless(DEFAULT_OPTS)
    await nextTick()

    pushResult(false, '内部错误: 超出 token 限制')
    exit(0)

    await expect(promise).rejects.toThrow('内部错误: 超出 token 限制')
  })

  it('result.ok=false 但无 error 字段 → reject 默认「执行失败」', async () => {
    const promise = runPromptHeadless(DEFAULT_OPTS)
    await nextTick()

    enqueueEvents([{ type: 'result', ok: false } as CliStreamEvent])
    pushLine()
    exit(0)

    await expect(promise).rejects.toThrow('执行失败')
  })
})

// ── 非零退出码 ────────────────────────────────────────────────────────────────

describe('非零退出码', () => {
  it('code=1 → reject 含退出码信息', async () => {
    const promise = runPromptHeadless(DEFAULT_OPTS)
    await nextTick()

    exit(1)

    await expect(promise).rejects.toThrow('退出码 1')
  })
})

// ── 独立进程表隔离 ────────────────────────────────────────────────────────────

describe('独立进程表隔离', () => {
  it('run 完成后 headlessProcs 清空，killAll 不影响已完成 run', async () => {
    const promise = runPromptHeadless(DEFAULT_OPTS)
    await nextTick()

    pushResult(true)
    exit(0)
    await promise

    const killCountBefore = _killCount
    killAllHeadlessPrompts()
    // 已完成（settled）的 run 已从 headlessProcs 删除，kill 不影响
    expect(_killCount).toBe(killCountBefore)
  })

  it('killAllHeadlessPrompts 能 kill 进行中的 run', async () => {
    const promise = runPromptHeadless(DEFAULT_OPTS)
    await nextTick()  // 等待 startAgentProcess 被调用并注册到 headlessProcs

    killAllHeadlessPrompts()
    expect(_killCount).toBeGreaterThan(0)

    exit(null)
    await promise.catch(() => { /* allowed */ })
  })
})
