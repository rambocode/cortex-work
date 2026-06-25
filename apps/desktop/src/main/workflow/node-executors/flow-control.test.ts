/**
 * flow-control.ts 单元测试（U10）
 *
 * 覆盖：
 *   condition    — branch true/false
 *   switch       — 命中 case-N、fallback、无路由(NO_BRANCH)
 *   filter       — pass(branch=undefined) / block(NO_BRANCH)
 *   merge        — array 模式 / object 模式
 *   loop         — foreach 顺序/并行保序、continueOnError、condition 到 maxIterations 停
 *   subworkflow  — 递归输出、超 depth 报错
 *   human-approval — resolve(approved) / timeout(onTimeout) / stop 级联 rejected
 *   delay        — 透传 payload
 */
import { describe, it, expect, vi } from 'vitest'
import {
  executeCondition,
  executeSwitch,
  executeFilter,
  executeMerge,
  executeLoop,
  executeSubworkflow,
  executeHumanApproval,
  executeDelay,
} from './flow-control.js'
import type { WorkflowPayload } from '../runtime/interp.js'
import { createRunContext } from '../runtime/run-context.js'
import type { WorkflowDef, WorkflowNode, WorkflowHumanApprovalConfig } from '../types.js'
import type { RunGraphFn, RunGraphResult } from './flow-control.js'

/** 创建类型安全的 mock RunGraph 返回值。 */
function mkResult(json: unknown, text = '', status: 'success' | 'error' = 'success'): RunGraphResult {
  return { status, errorMessage: '', nodeResults: [], output: { json, text } }
}
function mkError(msg: string): RunGraphResult {
  return { status: 'error', errorMessage: msg, nodeResults: [], output: { json: null, text: '' } }
}

// ── 辅助构造器 ────────────────────────────────────────────────────────────────

const p = (json: unknown, text = ''): WorkflowPayload => ({ json, text })
const scope = {}

function makeWorkflow(id: string, nodes: WorkflowNode[]): WorkflowDef {
  return {
    id,
    name: id,
    enabled: true,
    callableByAgent: false,
    env: [],
    nodes,
    connections: [],
    createdAt: '',
    updatedAt: '',
    lastRunAt: '',
    nextRunAt: '',
    lastStatus: 'idle',
    lastMessage: '',
    runs: [],
  }
}

function makeTrigger(id = 'trigger'): WorkflowNode {
  return {
    id,
    type: 'manual-trigger',
    name: id,
    position: { x: 0, y: 0 },
    disabled: false,
    config: {},
  } as WorkflowNode
}

// ── condition ──────────────────────────────────────────────────────────────────

describe('executeCondition', () => {
  it('true 分支', () => {
    const result = executeCondition(
      { leftExpr: '', operator: 'equals', rightValue: 'hello', caseSensitive: false },
      p({}, 'hello'),
      scope
    )
    expect(result.branch).toBe('true')
    expect(result.message).toBe('true')
  })

  it('false 分支', () => {
    const result = executeCondition(
      { leftExpr: '', operator: 'equals', rightValue: 'world', caseSensitive: true },
      p({}, 'hello'),
      scope
    )
    expect(result.branch).toBe('false')
  })

  it('payload 透传', () => {
    const input = p({ a: 1 }, 'text')
    const result = executeCondition(
      { leftExpr: '', operator: 'isEmpty', rightValue: '', caseSensitive: true },
      input,
      scope
    )
    expect(result.payload).toBe(input)
  })
})

// ── switch ─────────────────────────────────────────────────────────────────────

describe('executeSwitch', () => {
  it('首个匹配 rule → case-0', () => {
    const result = executeSwitch(
      {
        rules: [
          { leftExpr: '', operator: 'equals', rightValue: 'hit', caseSensitive: true },
          { leftExpr: '', operator: 'equals', rightValue: 'other', caseSensitive: true },
        ],
        fallback: true,
      },
      p({}, 'hit'),
      scope
    )
    expect(result.branch).toBe('case-0')
    expect(result.message).toBe('case 1')
  })

  it('第二个 rule 命中 → case-1', () => {
    const result = executeSwitch(
      {
        rules: [
          { leftExpr: '', operator: 'equals', rightValue: 'no', caseSensitive: true },
          { leftExpr: '', operator: 'equals', rightValue: 'yes', caseSensitive: true },
        ],
        fallback: true,
      },
      p({}, 'yes'),
      scope
    )
    expect(result.branch).toBe('case-1')
  })

  it('无命中 + fallback=true → fallback', () => {
    const result = executeSwitch(
      {
        rules: [{ leftExpr: '', operator: 'equals', rightValue: 'nope', caseSensitive: true }],
        fallback: true,
      },
      p({}, 'other'),
      scope
    )
    expect(result.branch).toBe('fallback')
    expect(result.message).toBe('fallback')
  })

  it('无命中 + fallback=false → __none__', () => {
    const result = executeSwitch(
      {
        rules: [{ leftExpr: '', operator: 'equals', rightValue: 'nope', caseSensitive: true }],
        fallback: false,
      },
      p({}, 'other'),
      scope
    )
    expect(result.branch).toBe('__none__')
    expect(result.message).toBe('no match')
  })
})

// ── filter ─────────────────────────────────────────────────────────────────────

describe('executeFilter', () => {
  it('条件通过 → branch=undefined（激活出边）', () => {
    const result = executeFilter(
      { leftExpr: '', operator: 'isNotEmpty', rightValue: '', caseSensitive: true },
      p({}, 'something'),
      scope
    )
    expect(result.branch).toBeUndefined()
    expect(result.message).toBe('pass')
  })

  it('条件不通过 → branch=__none__（剪掉出边）', () => {
    const result = executeFilter(
      { leftExpr: '', operator: 'isNotEmpty', rightValue: '', caseSensitive: true },
      p({}, ''),
      scope
    )
    expect(result.branch).toBe('__none__')
    expect(result.message).toBe('blocked')
  })
})

// ── merge ──────────────────────────────────────────────────────────────────────

describe('executeMerge', () => {
  it('mode=array：收集 json 成数组', () => {
    const inputs = [
      p({ a: 1 }, 'A'),
      p({ b: 2 }, 'B'),
    ]
    const result = executeMerge({ mode: 'array' }, inputs)
    expect(result.payload.json).toEqual([{ a: 1 }, { b: 2 }])
    expect(result.message).toBe('merged 2')
  })

  it('mode=array：text 换行拼接（忽略空串）', () => {
    const inputs = [p({ a: 1 }, 'A'), p({ b: 2 }, '')]
    const result = executeMerge({ mode: 'array' }, inputs)
    expect(result.payload.text).toBe('A')
  })

  it('mode=object：浅 assign，后者覆盖前者', () => {
    const inputs = [
      p({ a: 1, common: 'first' }, ''),
      p({ b: 2, common: 'second' }, ''),
    ]
    const result = executeMerge({ mode: 'object' }, inputs)
    expect(result.payload.json).toEqual({ a: 1, b: 2, common: 'second' })
  })

  it('mode=object：非对象 json 跳过', () => {
    const inputs = [p([1, 2], ''), p({ a: 1 }, '')]
    const result = executeMerge({ mode: 'object' }, inputs)
    // 数组不是 object，跳过；只合并第二个
    expect(result.payload.json).toEqual({ a: 1 })
  })

  it('inputs 为空时 array 返回空数组', () => {
    const result = executeMerge({ mode: 'array' }, [])
    expect(result.payload.json).toEqual([])
    expect(result.message).toBe('merged 0')
  })
})

// ── loop ───────────────────────────────────────────────────────────────────────

describe('executeLoop — foreach 顺序', () => {
  it('foreach sequential：按序处理，保持结果顺序', async () => {
    const order: number[] = []
    const mockRunGraph: RunGraphFn = vi.fn(async (_wf, payload, _ctx, _all, _deps, _depth, _cb, loopFrame) => {
      order.push(loopFrame!.index)
      return mkResult((payload.json as { val: number }).val * 2)
    })

    const bodyWf = makeWorkflow('body', [makeTrigger()])
    const ctx = createRunContext()
    const node: WorkflowNode = {
      id: 'loop1',
      type: 'loop',
      name: 'loop',
      position: { x: 0, y: 0 },
      disabled: false,
      config: {
        workflowId: 'body',
        mode: 'foreach',
        arraySource: 'json',
        execution: 'sequential',
        concurrency: 1,
        continueOnError: false,
        maxIterations: 100,
        leftExpr: '',
        operator: 'equals',
        rightValue: '',
        caseSensitive: true,
      },
    }
    const payload: WorkflowPayload = { json: [{ val: 1 }, { val: 2 }, { val: 3 }], text: '' }

    const result = await executeLoop(node, node.config, payload, scope, ctx, [bodyWf], {}, 0, mockRunGraph)

    expect(order).toEqual([0, 1, 2])
    expect(result.payload.json).toEqual([2, 4, 6])
    expect(result.message).toContain('foreach 3/3')
  })

  it('foreach parallel：并发执行，结果保序', async () => {
    const mockRunGraph: RunGraphFn = vi.fn(async (_wf, _payload, _ctx, _all, _deps, _depth, _cb, loopFrame) => {
      return mkResult(loopFrame!.index)
    })

    const bodyWf = makeWorkflow('body', [makeTrigger()])
    const ctx = createRunContext()
    const node: WorkflowNode = {
      id: 'loop1',
      type: 'loop',
      name: 'loop',
      position: { x: 0, y: 0 },
      disabled: false,
      config: {
        workflowId: 'body',
        mode: 'foreach',
        arraySource: '',
        execution: 'parallel',
        concurrency: 4,
        continueOnError: false,
        maxIterations: 100,
        leftExpr: '',
        operator: 'equals',
        rightValue: '',
        caseSensitive: true,
      },
    }
    const payload: WorkflowPayload = { json: ['a', 'b', 'c', 'd', 'e'], text: '' }

    const result = await executeLoop(node, node.config, payload, scope, ctx, [bodyWf], {}, 0, mockRunGraph)

    // 结果顺序必须与 input 一致（即使并行）
    expect(result.payload.json).toEqual([0, 1, 2, 3, 4])
    expect(result.message).toContain('(parallel)')
  })

  it('foreach parallel：每个迭代使用隔离的 nodeOutputs/runVars，但共享取消与预算', async () => {
    const seenContexts: Parameters<RunGraphFn>[2][] = []
    const mockRunGraph: RunGraphFn = vi.fn(async (_wf, _payload, itemCtx, _all, _deps, _depth, _cb, loopFrame) => {
      itemCtx.nodeOutputs.sharedNode = { json: loopFrame!.index, text: String(loopFrame!.index) }
      itemCtx.runVars.sharedVar = loopFrame!.index
      seenContexts.push(itemCtx)
      return mkResult(loopFrame!.index)
    })

    const bodyWf = makeWorkflow('body', [makeTrigger()])
    const ctx = createRunContext()
    const node: WorkflowNode = {
      id: 'loop1',
      type: 'loop',
      name: 'loop',
      position: { x: 0, y: 0 },
      disabled: false,
      config: {
        workflowId: 'body',
        mode: 'foreach',
        arraySource: '',
        execution: 'parallel',
        concurrency: 3,
        continueOnError: false,
        maxIterations: 100,
        leftExpr: '',
        operator: 'equals',
        rightValue: '',
        caseSensitive: true,
      },
    }
    const payload: WorkflowPayload = { json: ['a', 'b', 'c'], text: '' }

    await executeLoop(node, node.config, payload, scope, ctx, [bodyWf], {}, 0, mockRunGraph)

    expect(seenContexts).toHaveLength(3)
    expect(new Set(seenContexts.map((c) => c.nodeOutputs)).size).toBe(3)
    expect(new Set(seenContexts.map((c) => c.runVars)).size).toBe(3)
    for (const itemCtx of seenContexts) {
      expect(itemCtx).not.toBe(ctx)
      expect(itemCtx.cancelToken).toBe(ctx.cancelToken)
      expect(itemCtx.executionBudget).toBe(ctx.executionBudget)
      expect(itemCtx.pendingApprovals).toBe(ctx.pendingApprovals)
      expect(itemCtx.aiProcesses).toBe(ctx.aiProcesses)
    }
    expect(ctx.nodeOutputs.sharedNode).toBeUndefined()
    expect(ctx.runVars.sharedVar).toBeUndefined()
  })

  it('foreach parallel：continueOnError=false 时等待已启动迭代 settle 后再抛错', async () => {
    const settled: number[] = []
    const mockRunGraph: RunGraphFn = vi.fn(async (_wf, _payload, _ctx, _all, _deps, _depth, _cb, loopFrame) => {
      if (loopFrame!.index === 0) {
        throw new Error('boom')
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
      settled.push(loopFrame!.index)
      return mkResult(loopFrame!.index)
    })

    const bodyWf = makeWorkflow('body', [makeTrigger()])
    const ctx = createRunContext()
    const node: WorkflowNode = {
      id: 'loop1',
      type: 'loop',
      name: 'loop',
      position: { x: 0, y: 0 },
      disabled: false,
      config: {
        workflowId: 'body',
        mode: 'foreach',
        arraySource: '',
        execution: 'parallel',
        concurrency: 2,
        continueOnError: false,
        maxIterations: 100,
        leftExpr: '',
        operator: 'equals',
        rightValue: '',
        caseSensitive: true,
      },
    }
    const payload: WorkflowPayload = { json: ['a', 'b', 'c'], text: '' }

    await expect(
      executeLoop(node, node.config, payload, scope, ctx, [bodyWf], {}, 0, mockRunGraph)
    ).rejects.toThrow('boom')
    expect(settled).toEqual([1])
    expect(vi.mocked(mockRunGraph).mock.calls.length).toBe(2)
  })

  it('continueOnError=true：单 item 失败不中止，错误记录在 result', async () => {
    let callCount = 0
    const mockRunGraph: RunGraphFn = vi.fn(async (_wf, _payload, _ctx, _all, _deps, _depth, _cb, loopFrame) => {
      callCount++
      if (loopFrame!.index === 1) {
        return mkError('item failed')
      }
      return mkResult('ok')
    })

    const bodyWf = makeWorkflow('body', [makeTrigger()])
    const ctx = createRunContext()
    const node: WorkflowNode = {
      id: 'loop1',
      type: 'loop',
      name: 'loop',
      position: { x: 0, y: 0 },
      disabled: false,
      config: {
        workflowId: 'body',
        mode: 'foreach',
        arraySource: '',
        execution: 'sequential',
        concurrency: 1,
        continueOnError: true,
        maxIterations: 100,
        leftExpr: '',
        operator: 'equals',
        rightValue: '',
        caseSensitive: true,
      },
    }
    const payload: WorkflowPayload = { json: ['a', 'b', 'c'], text: '' }

    const result = await executeLoop(node, node.config, payload, scope, ctx, [bodyWf], {}, 0, mockRunGraph)

    expect(callCount).toBe(3) // 全部执行（不中止）
    const outputs = result.payload.json as unknown[]
    expect(outputs).toHaveLength(3)
    // index=1 的位置有 error 对象
    expect((outputs[1] as { error: string }).error).toContain('item failed')
  })
})

describe('executeLoop — condition 模式', () => {
  it('condition loop：满足 stopCondition 后停止', async () => {
    let iterations = 0
    const mockRunGraph: RunGraphFn = vi.fn(async () => {
      iterations++
      return mkResult({ count: iterations }, String(iterations))
    })

    const bodyWf = makeWorkflow('body', [makeTrigger()])
    const ctx = createRunContext()
    const node: WorkflowNode = {
      id: 'loop1',
      type: 'loop',
      name: 'loop',
      position: { x: 0, y: 0 },
      disabled: false,
      config: {
        workflowId: 'body',
        mode: 'condition',
        arraySource: '',
        execution: 'sequential',
        concurrency: 1,
        continueOnError: false,
        maxIterations: 10,
        leftExpr: '',
        operator: 'equals',  // 停止条件：text === '3'
        rightValue: '3',
        caseSensitive: true,
      },
    }
    const payload: WorkflowPayload = { json: { count: 0 }, text: '0' }

    const result = await executeLoop(node, node.config, payload, scope, ctx, [bodyWf], {}, 0, mockRunGraph)

    expect(iterations).toBe(3)
    const json = result.payload.json as Record<string, unknown>
    expect(json._iterations).toBe(3)
    expect(json._done).toBe(true)
    expect(result.message).toContain('(done)')
  })

  it('condition loop：达到 maxIterations 上限停止', async () => {
    const mockRunGraph: RunGraphFn = vi.fn(async () => {
      return mkResult({ count: 99 }, 'never-stop')
    })

    const bodyWf = makeWorkflow('body', [makeTrigger()])
    const ctx = createRunContext()
    const node: WorkflowNode = {
      id: 'loop1',
      type: 'loop',
      name: 'loop',
      position: { x: 0, y: 0 },
      disabled: false,
      config: {
        workflowId: 'body',
        mode: 'condition',
        arraySource: '',
        execution: 'sequential',
        concurrency: 1,
        continueOnError: false,
        maxIterations: 5,
        leftExpr: '',
        operator: 'equals',
        rightValue: 'stop',
        caseSensitive: true,
      },
    }
    const payload: WorkflowPayload = { json: {}, text: 'start' }

    const result = await executeLoop(node, node.config, payload, scope, ctx, [bodyWf], {}, 0, mockRunGraph)

    expect(vi.mocked(mockRunGraph).mock.calls.length).toBe(5)
    const json = result.payload.json as Record<string, unknown>
    expect(json._iterations).toBe(5)
    expect(json._done).toBe(false)
    expect(result.message).toContain('(max)')
  })
})

describe('executeLoop — 深度超限', () => {
  it('depth >= MAX_SUBWORKFLOW_DEPTH 时抛错', async () => {
    const mockRunGraph: RunGraphFn = vi.fn()
    const bodyWf = makeWorkflow('body', [makeTrigger()])
    const ctx = createRunContext()
    const node: WorkflowNode = {
      id: 'loop1',
      type: 'loop',
      name: 'loop',
      position: { x: 0, y: 0 },
      disabled: false,
      config: {
        workflowId: 'body',
        mode: 'foreach',
        arraySource: '',
        execution: 'sequential',
        concurrency: 1,
        continueOnError: false,
        maxIterations: 10,
        leftExpr: '',
        operator: 'equals',
        rightValue: '',
        caseSensitive: true,
      },
    }
    const payload: WorkflowPayload = { json: [1], text: '' }

    // depth=5 已是 MAX_SUBWORKFLOW_DEPTH，应立即抛错
    await expect(
      executeLoop(node, node.config, payload, scope, ctx, [bodyWf], {}, 5, mockRunGraph)
    ).rejects.toThrow('Loop 嵌套超过最大深度')
  })
})

// ── subworkflow ────────────────────────────────────────────────────────────────

describe('executeSubworkflow', () => {
  it('成功递归执行，返回子工作流 output', async () => {
    const mockRunGraph: RunGraphFn = vi.fn(async () => mkResult({ result: 'sub-output' }, 'done'))

    const subWf = makeWorkflow('sub1', [makeTrigger()])
    const ctx = createRunContext()
    const payload: WorkflowPayload = { json: { input: 'data' }, text: '' }

    const result = await executeSubworkflow(
      { workflowId: 'sub1' },
      payload,
      ctx,
      [subWf],
      {},
      0,
      mockRunGraph
    )

    expect(result.payload.json).toEqual({ result: 'sub-output' })
    expect(result.message).toContain('sub1')
  })

  it('子工作流不存在时抛错', async () => {
    const mockRunGraph: RunGraphFn = vi.fn()
    const ctx = createRunContext()
    const payload: WorkflowPayload = { json: {}, text: '' }

    await expect(
      executeSubworkflow(
        { workflowId: 'nonexistent' },
        payload,
        ctx,
        [],
        {},
        0,
        mockRunGraph
      )
    ).rejects.toThrow('子流程工作流未找到')
  })

  it('超过 MAX_SUBWORKFLOW_DEPTH 时抛错', async () => {
    const mockRunGraph: RunGraphFn = vi.fn()
    const subWf = makeWorkflow('sub1', [makeTrigger()])
    const ctx = createRunContext()
    const payload: WorkflowPayload = { json: {}, text: '' }

    await expect(
      executeSubworkflow(
        { workflowId: 'sub1' },
        payload,
        ctx,
        [subWf],
        {},
        5, // depth=5 = MAX_SUBWORKFLOW_DEPTH
        mockRunGraph
      )
    ).rejects.toThrow('子流程嵌套超过最大深度')
  })

  it('子工作流执行失败时抛错', async () => {
    const mockRunGraph: RunGraphFn = vi.fn(async () => mkError('sub failed'))

    const subWf = makeWorkflow('sub1', [makeTrigger()])
    const ctx = createRunContext()
    const payload: WorkflowPayload = { json: {}, text: '' }

    await expect(
      executeSubworkflow({ workflowId: 'sub1' }, payload, ctx, [subWf], {}, 0, mockRunGraph)
    ).rejects.toThrow('sub failed')
  })
})

// ── human-approval ────────────────────────────────────────────────────────────

describe('executeHumanApproval', () => {
  // P0 Fix-1：executeHumanApproval 新增 node 参数，测试用最小 WorkflowNode 存根。
  // as unknown as WorkflowNode 是有意为之：测试只关心 node.id/name（供 onPendingApproval 回调），
  // 不需要完整的 config union，强制转换避免在测试中补全所有 required fields。
  const node = {
    id: 'node-approval-1',
    type: 'human-approval' as const,
    name: 'Test Approval Node',
    config: {} as WorkflowHumanApprovalConfig,
    position: { x: 0, y: 0 },
    disabled: false,
  } as WorkflowNode
  const config = {
    title: 'Test Approval',
    instruction: 'Please review',
    timeoutMs: 0,
    onTimeout: 'rejected' as const,
  }
  const payload: WorkflowPayload = { json: { data: 1 }, text: '' }

  it('noRunRef=true 时自动 approved（单节点测试模式）', async () => {
    const ctx = createRunContext()
    const result = await executeHumanApproval(node, config, payload, scope, ctx, true)
    expect(result.branch).toBe('approved')
    expect(result.message).toContain('test')
  })

  it('resolve(approved)：branch=approved，payload.json 附加 _approved', async () => {
    const ctx = createRunContext()
    // 设置延迟 resolve：在 executeHumanApproval 注册 pendingApprovals 后 resolve
    const approvePromise = executeHumanApproval(node, config, payload, scope, ctx)

    // 等一个 microtask 让 pendingApprovals 完成注册
    await Promise.resolve()

    // 找到并触发 resolve
    const entries = [...ctx.pendingApprovals.values()]
    expect(entries).toHaveLength(1)
    entries[0].resolve('approved')

    const result = await approvePromise
    expect(result.branch).toBe('approved')
    expect((result.payload.json as { _approved: boolean })._approved).toBe(true)
    // 注册完成后 Map 应清空
    expect(ctx.pendingApprovals.size).toBe(0)
  })

  it('resolve(rejected)：branch=rejected，payload 原样透传', async () => {
    const ctx = createRunContext()
    const approvePromise = executeHumanApproval(node, config, payload, scope, ctx)

    await Promise.resolve()
    ;[...ctx.pendingApprovals.values()][0].resolve('rejected')

    const result = await approvePromise
    expect(result.branch).toBe('rejected')
    expect(result.payload.json).toEqual({ data: 1 }) // 无 _approved 字段
  })

  it('timeout → onTimeout 自动决策', async () => {
    vi.useFakeTimers()
    const ctx = createRunContext()
    const timeoutConfig = {
      ...config,
      timeoutMs: 1000,
      onTimeout: 'rejected' as const,
    }

    const approvePromise = executeHumanApproval(node, timeoutConfig, payload, scope, ctx)
    // 推进时间
    vi.advanceTimersByTime(1001)

    const result = await approvePromise
    expect(result.branch).toBe('rejected')
    vi.useRealTimers()
  })

  it('timeout onTimeout=approved 时自动 approve', async () => {
    vi.useFakeTimers()
    const ctx = createRunContext()
    const timeoutConfig = {
      ...config,
      timeoutMs: 500,
      onTimeout: 'approved' as const,
    }

    const approvePromise = executeHumanApproval(node, timeoutConfig, payload, scope, ctx)
    vi.advanceTimersByTime(501)

    const result = await approvePromise
    expect(result.branch).toBe('approved')
    vi.useRealTimers()
  })

  it('stop 级联 rejected：遍历 pendingApprovals 调用 resolve(rejected)', async () => {
    const ctx = createRunContext()
    const approvePromise = executeHumanApproval(node, config, payload, scope, ctx)

    await Promise.resolve()
    // 模拟 stop handler：遍历 pendingApprovals 级联 reject
    for (const entry of ctx.pendingApprovals.values()) {
      entry.resolve('rejected')
    }

    const result = await approvePromise
    expect(result.branch).toBe('rejected')
  })
})

// ── delay ─────────────────────────────────────────────────────────────────────

describe('executeDelay', () => {
  it('等待指定毫秒后透传 payload', async () => {
    vi.useFakeTimers()
    const payload: WorkflowPayload = { json: { x: 1 }, text: 'hello' }
    let resolved = false

    const p = executeDelay({ delayMs: 100 }, payload).then((r) => {
      resolved = true
      return r
    })

    expect(resolved).toBe(false)
    vi.advanceTimersByTime(100)
    const result = await p

    expect(result.payload).toBe(payload)
    expect(result.message).toContain('100ms')
    vi.useRealTimers()
  })

  it('delayMs=0 时不等待', async () => {
    vi.useFakeTimers()
    const payload: WorkflowPayload = { json: {}, text: '' }
    const p = executeDelay({ delayMs: 0 }, payload)
    vi.advanceTimersByTime(0)
    const result = await p
    expect(result.payload).toBe(payload)
    vi.useRealTimers()
  })
})
