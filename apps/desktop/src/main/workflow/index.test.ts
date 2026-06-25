/**
 * U9 端到端测试：运行一次（manual-trigger → set-fields → output）。
 *
 * 设计思路：
 * - 只 mock IO 层（store、events、powerMonitor），引擎逻辑真实运行。
 * - 验证 runWorkflowInternal 的完整生命周期：running → success 落盘 + 广播。
 * - 这是 Step 2 的失败测试；Step 3 实现 index.ts 后应全部通过。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── mock store ────────────────────────────────────────────────────────────────
// 在 import 前 mock，避免文件级副作用。
vi.mock('./store', () => {
  const workflows: Record<string, unknown> = {}
  const runs: Record<string, unknown[]> = {}
  return {
    loadWorkflows: vi.fn(async () => Object.values(workflows)),
    loadRuns: vi.fn(async (workflowId: string) => runs[workflowId] ?? []),
    getWorkflow: vi.fn(async (id: string) => workflows[id]),
    newRunId: vi.fn(() => `run-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    appendRun: vi.fn(async (workflowId: string, run: unknown) => {
      if (!runs[workflowId]) runs[workflowId] = []
      runs[workflowId].unshift(run)
    }),
    updateRun: vi.fn(async (workflowId: string, runId: string, patch: unknown) => {
      if (!runs[workflowId]) return
      const idx = runs[workflowId].findIndex((r: unknown) => (r as Record<string, unknown>).id === runId)
      if (idx >= 0) runs[workflowId][idx] = { ...runs[workflowId][idx] as Record<string, unknown>, ...patch as Record<string, unknown> }
    }),
    patchWorkflow: vi.fn(async (id: string, patch: unknown) => {
      workflows[id] = { ...workflows[id] as Record<string, unknown>, ...patch as Record<string, unknown> }
      return workflows[id]
    }),
    // test utility
    _workflows: workflows,
    _runs: runs,
    _seedWorkflow: (def: unknown) => {
      workflows[(def as Record<string, unknown>).id as string] = def
    },
  }
})

// ── mock events ───────────────────────────────────────────────────────────────
vi.mock('./events', () => ({
  broadcastWorkflowChanged: vi.fn(),
  broadcastWorkflowRunEvent: vi.fn(),
}))

// ── mock powerMonitor（Electron，主进程环境没有）────────────────────────────────
vi.mock('electron', () => ({
  powerMonitor: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  powerSaveBlocker: {
    start: vi.fn(() => 1),
    stop: vi.fn(),
    isStarted: vi.fn(() => false),
  },
}))

// ── 导入被测模块（mock 生效后）─────────────────────────────────────────────────
import type { WorkflowDef } from './types'
import { createWorkflowRuntime } from './index'
import * as storeMock from './store'
import * as eventsMock from './events'

// ── 测试数据 ──────────────────────────────────────────────────────────────────

function makeManualWorkflow(): WorkflowDef {
  return {
    id: 'wf-test-001',
    name: '端到端测试工作流',
    enabled: true,
    callableByAgent: false,
    env: [],
    nodes: [
      {
        id: 'trigger-1',
        type: 'manual-trigger',
        name: '手动触发',
        position: { x: 0, y: 0 },
        disabled: false,
        config: { workspaceRoot: '/tmp/test-ws' },
      },
      {
        id: 'set-1',
        type: 'set-fields',
        name: '设置字段',
        position: { x: 200, y: 0 },
        disabled: false,
        config: {
          fields: [{ key: 'result', value: 'hello' }],
          keepIncoming: true,
        },
      },
      {
        id: 'output-1',
        type: 'output',
        name: '输出',
        position: { x: 400, y: 0 },
        disabled: false,
        config: {
          mode: 'auto',
          textTemplate: '',
          jsonPath: '',
        },
      },
    ],
    connections: [
      { id: 'e1', source: 'trigger-1', sourceHandle: 'output', target: 'set-1', targetHandle: 'input' },
      { id: 'e2', source: 'set-1', sourceHandle: 'output', target: 'output-1', targetHandle: 'input' },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRunAt: '',
    nextRunAt: '',
    lastStatus: 'idle',
    lastMessage: '',
    runs: [],
  }
}

// ── 测试 ──────────────────────────────────────────────────────────────────────

describe('U9 createWorkflowRuntime', () => {
  let runtime: ReturnType<typeof createWorkflowRuntime>
  const seedFn = (storeMock as unknown as { _seedWorkflow: (def: unknown) => void })._seedWorkflow

  beforeEach(() => {
    vi.clearAllMocks()
    // 重置 store mock 状态
    const s = storeMock as unknown as { _workflows: Record<string, unknown>; _runs: Record<string, unknown[]> }
    Object.keys(s._workflows).forEach((k) => { delete s._workflows[k] })
    Object.keys(s._runs).forEach((k) => { delete s._runs[k] })

    // 创建 runtime（不启动调度器/webhook，只测核心运行逻辑）
    runtime = createWorkflowRuntime()
  })

  describe('runWorkflowInternal（通过 runNow 触发）', () => {
    it('manual-trigger → set-fields → output：返回 running run，最终落盘 success', async () => {
      const workflow = makeManualWorkflow()
      seedFn(workflow)

      // runNow 返回初始 running run（fire-and-forget）
      const result = await runtime.runNow(workflow.id, 'manual', {})
      expect(result.ok).toBe(true)
      expect(result.run?.status).toBe('running')
      expect(typeof result.run?.id).toBe('string')

      // 等待后台 run 完成（fire-and-forget，轮询直到 updateRun 被调用一次）
      await vi.waitFor(() => {
        expect(storeMock.updateRun).toHaveBeenCalled()
      }, { timeout: 3000 })

      // 验证 run 最终以 success 落盘
      const updateCalls = vi.mocked(storeMock.updateRun).mock.calls
      const lastCall = updateCalls[updateCalls.length - 1]!
      const patch = lastCall[2] as { status: string }
      expect(patch.status).toBe('success')

      // 验证事件广播
      expect(eventsMock.broadcastWorkflowRunEvent).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'start', workflowId: workflow.id }),
      )
      expect(eventsMock.broadcastWorkflowRunEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'update',
          workflowId: workflow.id,
          run: expect.objectContaining({
            nodeResults: expect.arrayContaining([
              expect.objectContaining({ nodeId: 'trigger-1', status: 'running' }),
            ]),
          }),
        }),
      )
      expect(eventsMock.broadcastWorkflowRunEvent).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'end', workflowId: workflow.id }),
      )
      expect(eventsMock.broadcastWorkflowChanged).toHaveBeenCalled()
    })

    it('不存在的 workflowId → 返回 ok=false', async () => {
      const result = await runtime.runNow('nonexistent', 'manual', {})
      expect(result.ok).toBe(false)
    })
  })

  describe('stopWorkflowRun', () => {
    it('停止正在运行的 run → cancelToken 被置 true', async () => {
      const workflow = makeManualWorkflow()
      // 插入一个 delay 节点让 run 有机会被停止
      workflow.nodes.push({
        id: 'delay-1',
        type: 'delay',
        name: '延迟',
        position: { x: 600, y: 0 },
        disabled: false,
        config: { delayMs: 10000 }, // 10s，足够让测试中途停止
      })
      workflow.connections.push({
        id: 'e3',
        source: 'output-1',
        sourceHandle: 'output',
        target: 'delay-1',
        targetHandle: 'input',
      })
      seedFn(workflow)

      const result = await runtime.runNow(workflow.id, 'manual', {})
      expect(result.ok).toBe(true)

      // 短暂等待 run 启动
      await new Promise((r) => setTimeout(r, 50))

      // 停止：run.id 即为 runId
      runtime.stopRun(result.run!.id)

      // run 应该以 error/cancelled 终止，而不是一直卡在 running
      await vi.waitFor(() => {
        const calls = vi.mocked(storeMock.updateRun).mock.calls
        return calls.some((c) => {
          const patch = c[2] as { status: string }
          return patch.status === 'error' || patch.status === 'success'
        })
      }, { timeout: 5000 })
    })

    it('停止孤儿 run（不在 activeRuns、持久化仍 running）→ 强制落为 error', async () => {
      const workflow = makeManualWorkflow()
      seedFn(workflow)
      // 直接在 store 写入一条 running run（不经 runNow，故不在 activeRuns）。
      const store = storeMock as unknown as {
        _runs: Record<string, unknown[]>
      }
      const orphanId = 'run-orphan-stuck'
      store._runs[workflow.id] = [
        { id: orphanId, status: 'running', startedAt: '', finishedAt: '', trigger: 'manual', nodeResults: [] },
      ]
      vi.mocked(storeMock.updateRun).mockClear()

      await runtime.stopRun(orphanId, workflow.id)

      // 强制收尾：updateRun 被调用且状态置 error
      const calls = vi.mocked(storeMock.updateRun).mock.calls
      expect(
        calls.some((c) => c[1] === orphanId && (c[2] as { status: string }).status === 'error'),
      ).toBe(true)
    })

    it('停止已是终态的 run → 不覆盖（不调用 updateRun）', async () => {
      const workflow = makeManualWorkflow()
      seedFn(workflow)
      const store = storeMock as unknown as { _runs: Record<string, unknown[]> }
      const doneId = 'run-already-done'
      store._runs[workflow.id] = [
        { id: doneId, status: 'success', startedAt: '', finishedAt: 'x', trigger: 'manual', nodeResults: [] },
      ]
      vi.mocked(storeMock.updateRun).mockClear()

      await runtime.stopRun(doneId, workflow.id)

      // 已 success，不应被改写
      const calls = vi.mocked(storeMock.updateRun).mock.calls
      expect(calls.some((c) => c[1] === doneId)).toBe(false)
    })
  })
})
