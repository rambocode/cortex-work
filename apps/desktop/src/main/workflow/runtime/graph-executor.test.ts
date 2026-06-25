/**
 * graph-executor.ts 引擎调度逻辑单测
 *
 * 注意：由于 condition/switch/filter 等节点（U10）尚未实现，
 * 分支类测试使用 vi.mock('../node-executors/index.js') mock executeNode，
 * 直接控制节点返回的 branch outcome，专注验证引擎的 settleTarget/pruneNode 逻辑。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runGraph, MAX_NODE_EXECUTIONS } from './graph-executor.js'
import type { WorkflowDef, WorkflowNode, WorkflowConnection } from '../types.js'
import type { WorkflowPayload } from './interp.js'
import { createRunContext } from './run-context.js'
import type { NodeExecutorDeps } from '../node-executors/index.js'

// ── mock executeNode ─────────────────────────────────────────────────────────
vi.mock('../node-executors/index.js', () => ({
  executeNode: vi.fn(),
}))

import { executeNode } from '../node-executors/index.js'
const mockExecuteNode = vi.mocked(executeNode)

// ── 辅助构造器 ────────────────────────────────────────────────────────────────

let nodeCounter = 0
function makeNode(type: WorkflowNode['type'], id?: string): WorkflowNode {
  const nodeId = id ?? `node-${++nodeCounter}`
  return {
    id: nodeId,
    type,
    name: nodeId,
    position: { x: 0, y: 0 },
    disabled: false,
    config: {} as WorkflowNode['config'],
  } as WorkflowNode
}

function makeEdge(source: string, target: string, sourceHandle = 'out', id?: string): WorkflowConnection {
  return {
    id: id ?? `${source}->${target}`,
    source,
    sourceHandle,
    target,
    targetHandle: 'in',
  }
}

function makeWorkflow(nodes: WorkflowNode[], connections: WorkflowConnection[]): WorkflowDef {
  return {
    id: 'wf-test',
    name: '测试工作流',
    enabled: true,
    callableByAgent: false,
    env: [],
    nodes,
    connections,
    createdAt: '',
    updatedAt: '',
    lastRunAt: '',
    nextRunAt: '',
    lastStatus: 'idle',
    lastMessage: '',
    runs: [],
  }
}

const initialPayload: WorkflowPayload = { json: { start: true }, text: 'start' }
const deps: NodeExecutorDeps = {}

// ── 测试套件 ──────────────────────────────────────────────────────────────────

describe('runGraph 线性链', () => {
  beforeEach(() => {
    nodeCounter = 0
    vi.clearAllMocks()
  })

  it('A→B→C 依序执行，$nodes.A.json 在 B 可解析', async () => {
    const nodeA = makeNode('manual-trigger', 'A')
    const nodeB = makeNode('set-fields', 'B')
    const nodeC = makeNode('output', 'C')
    const workflow = makeWorkflow([nodeA, nodeB, nodeC], [makeEdge('A', 'B'), makeEdge('B', 'C')])

    const payloadA: WorkflowPayload = { json: { fromA: 'hello' }, text: 'A text' }
    const payloadB: WorkflowPayload = { json: { fromB: 'world' }, text: 'B text' }
    const payloadC: WorkflowPayload = { json: { fromC: 'done' }, text: 'C text' }

    // 执行顺序记录
    const order: string[] = []
    mockExecuteNode.mockImplementation(async (node, _ctx, _primary, scope) => {
      order.push(node.id)
      if (node.id === 'A') return { payload: payloadA }
      if (node.id === 'B') {
        // 验证 B 可以通过 scope.nodes 访问 A 的输出
        const aJson = scope.nodes?.['A']?.json
        expect(aJson).toEqual({ fromA: 'hello' })
        return { payload: payloadB }
      }
      if (node.id === 'C') return { payload: payloadC }
      throw new Error('unexpected node')
    })

    const ctx = createRunContext()
    const result = await runGraph(workflow, initialPayload, ctx, [], deps)

    expect(result.status).toBe('success')
    expect(order).toEqual(['A', 'B', 'C'])
    // 最终输出为 output 节点（C）的 payload
    expect(result.output).toEqual(payloadC)
  })

  it('节点结果收集到 nodeResults', async () => {
    const nodeA = makeNode('manual-trigger', 'A')
    const workflow = makeWorkflow([nodeA], [])
    const p: WorkflowPayload = { json: {}, text: 'ok' }
    mockExecuteNode.mockResolvedValue({ payload: p })

    const ctx = createRunContext()
    const result = await runGraph(workflow, initialPayload, ctx, [], deps)

    expect(result.nodeResults).toHaveLength(1)
    expect(result.nodeResults[0].nodeId).toBe('A')
    expect(result.nodeResults[0].status).toBe('success')
  })
})

describe('runGraph 分支剪枝（condition）', () => {
  beforeEach(() => {
    nodeCounter = 0
    vi.clearAllMocks()
  })

  it('condition true 分支只走 true 边，false 边及其下游被剪', async () => {
    // 图结构：trigger → condition → [true: nodeTrue, false: nodeFalse]
    const trigger = makeNode('manual-trigger', 'trigger')
    const condition = makeNode('condition', 'cond')
    const nodeTrue = makeNode('output', 'nodeTrue')
    const nodeFalse = makeNode('output', 'nodeFalse')

    const workflow = makeWorkflow(
      [trigger, condition, nodeTrue, nodeFalse],
      [
        makeEdge('trigger', 'cond'),
        makeEdge('cond', 'nodeTrue', 'true', 'cond->true'),
        makeEdge('cond', 'nodeFalse', 'false', 'cond->false'),
      ]
    )

    const executed: string[] = []
    mockExecuteNode.mockImplementation(async (node) => {
      executed.push(node.id)
      if (node.id === 'trigger') return { payload: initialPayload }
      if (node.id === 'cond') {
        // condition 节点：只走 true 边
        return { payload: initialPayload, branch: 'true' }
      }
      return { payload: initialPayload }
    })

    const ctx = createRunContext()
    const result = await runGraph(workflow, initialPayload, ctx, [], deps)

    expect(result.status).toBe('success')
    expect(executed).toContain('trigger')
    expect(executed).toContain('cond')
    expect(executed).toContain('nodeTrue')
    // nodeFalse 及其下游应该被剪枝，不被执行
    expect(executed).not.toContain('nodeFalse')
  })

  it('NO_BRANCH sentinel 剪掉全部出边', async () => {
    // switch 无命中 + fallback=false → 出 '__none__' → 全部出边被剪
    const trigger = makeNode('manual-trigger', 'trigger')
    const sw = makeNode('switch', 'sw')
    const nodeOut = makeNode('output', 'nodeOut')

    const workflow = makeWorkflow(
      [trigger, sw, nodeOut],
      [makeEdge('trigger', 'sw'), makeEdge('sw', 'nodeOut', 'fallback')]
    )

    const executed: string[] = []
    mockExecuteNode.mockImplementation(async (node) => {
      executed.push(node.id)
      if (node.id === 'sw') return { payload: initialPayload, branch: '__none__' }
      return { payload: initialPayload }
    })

    const ctx = createRunContext()
    const result = await runGraph(workflow, initialPayload, ctx, [], deps)

    expect(result.status).toBe('success')
    expect(executed).not.toContain('nodeOut')
  })
})

describe('runGraph merge 节点等待', () => {
  beforeEach(() => {
    nodeCounter = 0
    vi.clearAllMocks()
  })

  it('等两条上游（一 delivered 一 pruned）后执行，只合并 delivered', async () => {
    // 图结构：trigger → condition → [true: nodeA, false: nodeB] → merge
    // condition 走 true，故 false 边 pruned，nodeB 被剪；merge 等到两条边都 resolved 后执行
    const trigger = makeNode('manual-trigger', 'trigger')
    const cond = makeNode('condition', 'cond')
    const nodeA = makeNode('set-fields', 'nodeA')
    const nodeB = makeNode('set-fields', 'nodeB')
    const merge = makeNode('merge', 'merge')

    const workflow = makeWorkflow(
      [trigger, cond, nodeA, nodeB, merge],
      [
        makeEdge('trigger', 'cond'),
        makeEdge('cond', 'nodeA', 'true', 'cond->A'),
        makeEdge('cond', 'nodeB', 'false', 'cond->B'),
        makeEdge('nodeA', 'merge', 'out', 'A->merge'),
        makeEdge('nodeB', 'merge', 'out', 'B->merge'),
      ]
    )

    const executed: string[] = []
    mockExecuteNode.mockImplementation(async (node) => {
      executed.push(node.id)
      if (node.id === 'cond') return { payload: initialPayload, branch: 'true' }
      return { payload: { json: { from: node.id }, text: node.id } }
    })

    const ctx = createRunContext()
    const result = await runGraph(workflow, initialPayload, ctx, [], deps)

    expect(result.status).toBe('success')
    // nodeB 被剪（false 分支）
    expect(executed).not.toContain('nodeB')
    // merge 应该执行（有一条 delivered 来自 nodeA）
    expect(executed).toContain('merge')
    // merge 在 nodeA 之后
    const aIdx = executed.indexOf('nodeA')
    const mergeIdx = executed.indexOf('merge')
    expect(mergeIdx).toBeGreaterThan(aIdx)
  })
})

describe('runGraph 钻石图', () => {
  beforeEach(() => {
    nodeCounter = 0
    vi.clearAllMocks()
  })

  it('分支后汇合，汇合点不重复执行', async () => {
    // 图：trigger → [branch1, branch2] → merge（两条分支都激活）
    const trigger = makeNode('manual-trigger', 'trigger')
    const branch1 = makeNode('set-fields', 'b1')
    const branch2 = makeNode('set-fields', 'b2')
    const merge = makeNode('merge', 'merge')

    const workflow = makeWorkflow(
      [trigger, branch1, branch2, merge],
      [
        makeEdge('trigger', 'b1', 'out', 'e1'),
        makeEdge('trigger', 'b2', 'out', 'e2'),
        makeEdge('b1', 'merge', 'out', 'e3'),
        makeEdge('b2', 'merge', 'out', 'e4'),
      ]
    )

    const executed: string[] = []
    mockExecuteNode.mockImplementation(async (node) => {
      executed.push(node.id)
      return { payload: { json: { from: node.id }, text: node.id } }
    })

    const ctx = createRunContext()
    const result = await runGraph(workflow, initialPayload, ctx, [], deps)

    expect(result.status).toBe('success')
    // merge 只执行一次（不变量 1：settledNodes.add 防重入）
    const mergeCount = executed.filter((id) => id === 'merge').length
    expect(mergeCount).toBe(1)
  })
})

describe('runGraph 早退条件', () => {
  beforeEach(() => {
    nodeCounter = 0
    vi.clearAllMocks()
  })

  it('MAX_NODE_EXECUTIONS 超限早退', async () => {
    // 构造一个超过 MAX_NODE_EXECUTIONS 的线性链
    const nodes: WorkflowNode[] = []
    const connections: WorkflowConnection[] = []

    // 触发器
    nodes.push(makeNode('manual-trigger', 'trigger'))

    // 构造 201 个节点（超过 200 上限）
    for (let i = 0; i < MAX_NODE_EXECUTIONS + 1; i++) {
      nodes.push(makeNode('set-fields', `n${i}`))
    }

    connections.push(makeEdge('trigger', 'n0'))
    for (let i = 0; i < MAX_NODE_EXECUTIONS; i++) {
      connections.push(makeEdge(`n${i}`, `n${i + 1}`))
    }

    const workflow = makeWorkflow(nodes, connections)

    mockExecuteNode.mockImplementation(async (node) => {
      return { payload: { json: { id: node.id }, text: node.id } }
    })

    const ctx = createRunContext()
    const result = await runGraph(workflow, initialPayload, ctx, [], deps)

    expect(result.status).toBe('error')
    expect(result.errorMessage).toMatch(/超过最大节点执行次数/)
  })

  it('cancelToken.cancelled 中断执行', async () => {
    const trigger = makeNode('manual-trigger', 'trigger')
    const nodeA = makeNode('set-fields', 'nodeA')
    const nodeB = makeNode('set-fields', 'nodeB')

    const workflow = makeWorkflow(
      [trigger, nodeA, nodeB],
      [makeEdge('trigger', 'nodeA'), makeEdge('nodeA', 'nodeB')]
    )

    const executed: string[] = []
    mockExecuteNode.mockImplementation(async (node, ctx) => {
      executed.push(node.id)
      if (node.id === 'nodeA') {
        // 执行 nodeA 后设置取消标志
        ctx.cancelToken.cancelled = true
      }
      return { payload: { json: {}, text: '' } }
    })

    const ctx = createRunContext()
    const result = await runGraph(workflow, initialPayload, ctx, [], deps)

    expect(result.status).toBe('error')
    expect(result.errorMessage).toMatch(/取消/)
    // nodeB 不应被执行（取消后 while 循环检查到 cancelled 退出）
    expect(executed).not.toContain('nodeB')
  })
})

describe('runGraph disabled 节点', () => {
  beforeEach(() => {
    nodeCounter = 0
    vi.clearAllMocks()
  })

  it('disabled 节点透传 payload，不调 executeNode，状态为 skipped', async () => {
    const trigger = makeNode('manual-trigger', 'trigger')
    const disabled = { ...makeNode('set-fields', 'disabled'), disabled: true }
    const output = makeNode('output', 'output')

    const workflow = makeWorkflow(
      [trigger, disabled, output],
      [makeEdge('trigger', 'disabled'), makeEdge('disabled', 'output')]
    )

    const executed: string[] = []
    mockExecuteNode.mockImplementation(async (node) => {
      executed.push(node.id)
      return { payload: { json: { from: node.id }, text: '' } }
    })

    const ctx = createRunContext()
    const result = await runGraph(workflow, initialPayload, ctx, [], deps)

    expect(result.status).toBe('success')
    // disabled 节点不调 executeNode
    expect(executed).not.toContain('disabled')
    // output 节点被执行（收到透传的 initialPayload）
    expect(executed).toContain('output')
    // 结果包含 skipped 节点
    const disabledResult = result.nodeResults.find((r) => r.nodeId === 'disabled')
    expect(disabledResult?.status).toBe('skipped')
  })
})

describe('runGraph retry/onError', () => {
  beforeEach(() => {
    nodeCounter = 0
    vi.clearAllMocks()
  })

  it('失败后按 retries 重试，超限 onError=continue 继续执行', async () => {
    const trigger = makeNode('manual-trigger', 'trigger')
    const failNode = {
      ...makeNode('set-fields', 'failNode'),
      retries: 2,
      onError: 'continue' as const,
    }
    const after = makeNode('output', 'after')

    const workflow = makeWorkflow(
      [trigger, failNode, after],
      [makeEdge('trigger', 'failNode'), makeEdge('failNode', 'after')]
    )

    let failCount = 0
    const executed: string[] = []
    mockExecuteNode.mockImplementation(async (node) => {
      executed.push(node.id)
      if (node.id === 'failNode') {
        failCount++
        throw new Error('node failed')
      }
      return { payload: { json: {}, text: 'ok' } }
    })

    const ctx = createRunContext()
    const result = await runGraph(workflow, initialPayload, ctx, [], deps)

    expect(result.status).toBe('success')
    // 重试 2 次（retries=2，共尝试 1+2=3 次）
    expect(failCount).toBe(3)
    // after 节点仍执行（onError=continue）
    expect(executed).toContain('after')
  })

  it('失败 onError=fail 停止 run', async () => {
    const trigger = makeNode('manual-trigger', 'trigger')
    const failNode = makeNode('set-fields', 'failNode')
    const after = makeNode('output', 'after')

    const workflow = makeWorkflow(
      [trigger, failNode, after],
      [makeEdge('trigger', 'failNode'), makeEdge('failNode', 'after')]
    )

    const executed: string[] = []
    mockExecuteNode.mockImplementation(async (node) => {
      executed.push(node.id)
      if (node.id === 'failNode') throw new Error('hard fail')
      return { payload: { json: {}, text: '' } }
    })

    const ctx = createRunContext()
    const result = await runGraph(workflow, initialPayload, ctx, [], deps)

    expect(result.status).toBe('error')
    expect(result.errorMessage).toContain('hard fail')
    expect(executed).not.toContain('after')
  })

  it('fallback 节点失败后返回 fallbackJson', async () => {
    const trigger = makeNode('manual-trigger', 'trigger')
    const fallbackNode = {
      ...makeNode('set-fields', 'fallbackNode'),
      onError: 'fallback' as const,
      fallbackJson: '{"default":true}',
    }

    const workflow = makeWorkflow(
      [trigger, fallbackNode],
      [makeEdge('trigger', 'fallbackNode')]
    )

    mockExecuteNode.mockImplementation(async (node) => {
      if (node.id === 'fallbackNode') throw new Error('fail')
      return { payload: { json: {}, text: '' } }
    })

    const ctx = createRunContext()
    const result = await runGraph(workflow, initialPayload, ctx, [], deps)

    expect(result.status).toBe('success')
    expect(result.output).toEqual({ json: { default: true }, text: '{"default":true}' })
  })
})

describe('runGraph nodeOutputs 共享', () => {
  beforeEach(() => {
    nodeCounter = 0
    vi.clearAllMocks()
  })

  it('执行成功后 ctx.nodeOutputs 更新，供下游 scope.nodes 访问', async () => {
    const nodeA = makeNode('manual-trigger', 'A')
    const nodeB = makeNode('output', 'B')
    const workflow = makeWorkflow([nodeA, nodeB], [makeEdge('A', 'B')])

    const payloadA: WorkflowPayload = { json: { result: 42 }, text: '42' }
    mockExecuteNode.mockImplementation(async (node, _ctx, _primary, scope) => {
      if (node.id === 'A') return { payload: payloadA }
      // B 检查 scope.nodes.A
      expect(scope.nodes?.['A']).toEqual(payloadA)
      return { payload: { json: {}, text: '' } }
    })

    const ctx = createRunContext()
    await runGraph(workflow, initialPayload, ctx, [], deps)

    // run 结束后 ctx.nodeOutputs 中包含 A 的结果
    expect(ctx.nodeOutputs['A']).toEqual(payloadA)
  })
})

describe('runGraph 空工作流', () => {
  it('无节点 → 成功返回初始 payload', async () => {
    const workflow = makeWorkflow([], [])
    const ctx = createRunContext()
    const result = await runGraph(workflow, initialPayload, ctx, [], deps)

    expect(result.status).toBe('success')
    expect(result.nodeResults).toHaveLength(0)
    expect(result.output).toEqual(initialPayload)
  })
})

describe('runGraph 子流程深度检查', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('depth > MAX_SUBWORKFLOW_DEPTH 时立即返回 error', async () => {
    const workflow = makeWorkflow([makeNode('manual-trigger', 'trigger')], [])
    const ctx = createRunContext()
    const result = await runGraph(workflow, initialPayload, ctx, [], deps, 6)

    expect(result.status).toBe('error')
    expect(result.errorMessage).toMatch(/子流程递归超过最大深度/)
  })
})
