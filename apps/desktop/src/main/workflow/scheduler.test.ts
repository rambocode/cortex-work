/**
 * scheduler.ts 单元测试。
 *
 * 测试场景：
 * 1. schedule-trigger 工作流到点触发（使用 once 类型快速验证）
 * 2. 已禁用工作流不建 Cron job
 * 3. once 触发后（开机补漏：at < now 且 !lastRunAt）→ 立即补触发
 * 4. 休眠唤醒后 reschedule（shouldCatchUp：lastRunAt 后错过触发点）
 * 5. 无 schedule-trigger 的工作流不建 job
 *
 * 注意：croner 在测试环境（vitest/Node.js）中正常工作；
 * once 类型传 past Date 会立即触发（croner 行为：过去的时刻被视为「立即」）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── mock electron ─────────────────────────────────────────────────────────────
vi.mock('electron', () => ({
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  powerSaveBlocker: {
    start: vi.fn(() => 42),
    stop: vi.fn(),
    isStarted: vi.fn((h: number) => h === 42),
  },
}))

import type { WorkflowDef, WorkflowScheduleTriggerConfig } from './types'
import {
  initWorkflowScheduler,
  rescheduleWorkflows,
  stopWorkflowScheduler,
} from './scheduler'

// RunFn 类型与 scheduler.ts 内定义一致。
type RunFn = (
  workflowId: string,
  trigger: string,
  input: Record<string, unknown>,
) => Promise<{ ok: boolean; runId: string; status: string }>

// ── 测试数据 ──────────────────────────────────────────────────────────────────

function makeScheduleWorkflow(opts: {
  id?: string
  enabled?: boolean
  kind: 'once' | 'daily' | 'cron'
  atMs?: number   // once 类型用
  lastRunAt?: string
}): WorkflowDef {
  const id = opts.id ?? `wf-sched-${Math.random().toString(36).slice(2)}`
  const scheduleNode = {
    id: 'sched-1',
    type: 'schedule-trigger' as const,
    name: '定时触发',
    position: { x: 0, y: 0 },
    disabled: false,
    config: (
      opts.kind === 'once'
        ? { schedule: { kind: 'once', at: opts.atMs ?? Date.now() + 50 } }
        : opts.kind === 'cron'
        ? { schedule: { kind: 'cron', expression: '* * * * *' } }
        : { schedule: { kind: 'daily', hour: 23, minute: 59 } }
    ) as WorkflowScheduleTriggerConfig,
  }
  return {
    id,
    name: id,
    enabled: opts.enabled ?? true,
    callableByAgent: false,
    env: [],
    nodes: [scheduleNode],
    connections: [],
    createdAt: '',
    updatedAt: '',
    lastRunAt: opts.lastRunAt ?? '',
    nextRunAt: '',
    lastStatus: 'idle',
    lastMessage: '',
    runs: [],
  }
}

// ── 测试 ──────────────────────────────────────────────────────────────────────

describe('workflow scheduler', () => {
  let runFn: RunFn

  beforeEach(() => {
    runFn = vi.fn(async () => ({ ok: true, runId: 'run-x', status: 'running' })) as unknown as RunFn
  })

  afterEach(() => {
    stopWorkflowScheduler()
    vi.clearAllMocks()
  })

  it('once 类型：future at → 到点触发 runFn', async () => {
    const atMs = Date.now() + 100 // 100ms 后触发
    const workflow = makeScheduleWorkflow({ kind: 'once', atMs })

    initWorkflowScheduler([workflow], runFn)
    expect(runFn).not.toHaveBeenCalled()

    // 等待 croner 触发（200ms 足够）
    await new Promise((r) => setTimeout(r, 300))
    expect(runFn).toHaveBeenCalledWith(workflow.id, 'schedule', {})
  })

  it('enabled=false 的工作流不建 Cron job，不触发', async () => {
    const workflow = makeScheduleWorkflow({ kind: 'once', atMs: Date.now() + 100, enabled: false })
    initWorkflowScheduler([workflow], runFn)
    await new Promise((r) => setTimeout(r, 300))
    expect(runFn).not.toHaveBeenCalled()
  })

  it('开机补漏（once：at < now && !lastRunAt）→ 立即补触发', () => {
    const pastAt = Date.now() - 5000 // 5s 前应触发，但 lastRunAt 为空
    const workflow = makeScheduleWorkflow({ kind: 'once', atMs: pastAt, lastRunAt: '' })
    initWorkflowScheduler([workflow], runFn)
    // 补触发是同步 void，tick 一次让 promise 跑
    expect(runFn).toHaveBeenCalledWith(workflow.id, 'schedule', {})
  })

  it('shouldCatchUp（lastRunAt 之后的触发点已过）→ 补触发', () => {
    // daily 23:59 → 应在明天触发，若 lastRunAt 是昨天，shouldCatchUp 应触发
    // 用 cron 每分钟，lastRunAt = 2 分钟前 → 必有一个触发点已过
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    const workflow = makeScheduleWorkflow({ kind: 'cron', lastRunAt: twoMinAgo })
    initWorkflowScheduler([workflow], runFn)
    // shouldCatchUp 会检测到 lastRunAt 后第一个触发点已过
    expect(runFn).toHaveBeenCalledWith(workflow.id, 'schedule', {})
  })

  it('无 schedule-trigger 节点的工作流不建 job', async () => {
    const workflow: WorkflowDef = {
      id: 'wf-no-sched',
      name: 'no-sched',
      enabled: true,
      callableByAgent: false,
      env: [],
      nodes: [
        { id: 't1', type: 'manual-trigger', name: 'manual', position: { x: 0, y: 0 }, disabled: false, config: {} },
      ],
      connections: [],
      createdAt: '',
      updatedAt: '',
      lastRunAt: '',
      nextRunAt: '',
      lastStatus: 'idle',
      lastMessage: '',
      runs: [],
    }
    initWorkflowScheduler([workflow], runFn)
    await new Promise((r) => setTimeout(r, 200))
    expect(runFn).not.toHaveBeenCalled()
  })

  it('rescheduleWorkflows 停旧 job 建新 job', async () => {
    const workflow = makeScheduleWorkflow({ kind: 'once', atMs: Date.now() + 10000 })
    initWorkflowScheduler([workflow], runFn)
    // 替换为立即触发的新 job
    const updatedWorkflow = makeScheduleWorkflow({
      id: workflow.id,
      kind: 'once',
      atMs: Date.now() + 100,
    })
    await rescheduleWorkflows([updatedWorkflow], runFn)
    await new Promise((r) => setTimeout(r, 300))
    expect(runFn).toHaveBeenCalledWith(workflow.id, 'schedule', {})
  })
})
