/**
 * runGraph —— 工作流图执行引擎（数据流调度器）。
 *
 * 复刻 Kun workflow-runtime.ts runGraph（L1550-1807），适配 cortex-work：
 *   - 不依赖 AppSettingsV1，改为接收 allWorkflows 快照（KTD2 / Open Questions）
 *   - 取消信号通过可变 cancelToken 传递（不用 class 实例 this.cancelRequested）
 *   - live status 回调由 onNodeStatus 依赖注入（不直接调 this.setLive）
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条关键不变量（来自 Open Questions 引擎语义节，必须严格遵守）
 * ══════════════════════════════════════════════════════════════════
 *
 * 不变量 1：settledNodes.add 必须在 executeNode 调用之前
 *   目的：防止重入（当两个分支汇合到同一节点时，readyQueue 可能短时含重复 nodeId）。
 *   位置：shift 取 nodeId 后，检查 settledNodes.has 通过后立即 add，再进入 executeNode。
 *
 * 不变量 2：branch === undefined 与 NO_BRANCH sentinel 语义不同
 *   branch === undefined → "无分支节点"（set-fields/template 等），激活全部出边
 *   branch === '__none__' → "NO_BRANCH sentinel"，剪掉全部出边
 *     （switch 无规则命中且 fallback=false、filter 过滤、condition 对应的非选中边）
 *   handleActive 函数实现此区分：undefined 时恒返回 true，'__none__' 时恒返回 false。
 *
 * 不变量 3：已 delivered 的边不可再被剪
 *   pruneEdge 函数检查 delivered.has(edge.id)，若已 delivered 则直接 return 不改为 pruned。
 *   原因：边的状态转换是单向的（pending → delivered 或 pending → pruned），
 *   避免并行激活后被误剪导致下游节点无法执行。
 */

import type { WorkflowDef, WorkflowConnection, WorkflowNodeRunStatus } from '../types.js'
import type { WorkflowPayload, InterpScope } from './interp.js'
import { resolveEnvVars, resolveNodeInputs, interpolate } from './interp.js'
import type { RunContext } from './run-context.js'
import type { NodeExecutorDeps } from '../node-executors/index.js'
import { executeNode } from '../node-executors/index.js'
import type { WorkflowNodeRunResult } from '../types.js'

// ── 常量（对齐 Kun）────────────────────────────────────────────────────────────

/** 单次 run 最多执行的节点次数（防无限循环）。 */
const MAX_NODE_EXECUTIONS = 200

/** 单次 run 最长持续时间（30 分钟）。 */
const MAX_RUN_DURATION_MS = 30 * 60_000

/**
 * NO_BRANCH sentinel：表示"剪掉全部出边"。
 * 注意与 branch === undefined（激活全部出边）的区别（不变量 2）。
 */
const NO_BRANCH = '__none__'

/** 子流程递归最大深度（防无限递归）。 */
const MAX_SUBWORKFLOW_DEPTH = 5

// ── 对外类型 ──────────────────────────────────────────────────────────────────

export interface WorkflowRunResult {
  status: 'success' | 'error'
  errorMessage: string
  nodeResults: WorkflowNodeRunResult[]
  /** 最终输出 payload：优先取 output 节点的 payload，否则取最后执行节点的 payload。 */
  output: WorkflowPayload
}

/** runGraph 可选的生命周期回调（供 live status 刷新 UI，不影响引擎逻辑）。 */
export interface RunGraphCallbacks {
  onNodeStatus?: (nodeId: string, status: WorkflowNodeRunStatus) => void
}

// ── 内部辅助 ──────────────────────────────────────────────────────────────────

/** 安全 JSON.stringify，失败返回空串。 */
function safeJson(value: unknown): string {
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/**
 * 从工作流触发器节点中解析 workspaceRoot，供后续单元（U9+）使用。
 * 当前 U8 占位，结果由 NodeExecutorDeps.workspaceRoot 传入（U9 填充）。
 * @internal 供 runGraph 及 U9 调度入口使用
 */
export function resolveWorkspaceRoot(
  workflow: WorkflowDef,
  triggerNodeId: string | undefined,
  payload: WorkflowPayload,
  scope: InterpScope
): string {
  const triggers = workflow.nodes.filter(
    (n) => n.type === 'manual-trigger' || n.type === 'schedule-trigger' || n.type === 'webhook-trigger'
  )
  const trigger =
    (triggerNodeId ? triggers.find((n) => n.id === triggerNodeId) : undefined) ?? triggers[0]
  const rawWorkspace =
    trigger && typeof (trigger.config as { workspaceRoot?: unknown }).workspaceRoot === 'string'
      ? (trigger.config as { workspaceRoot: string }).workspaceRoot
      : ''
  return interpolate(rawWorkspace, payload, scope).trim()
}

/**
 * 决定某条出边对于当前 outcome 是否应该激活（true）还是剪掉（false）。
 *
 * 实现不变量 2：
 *   outcome.branch === undefined  → 无分支节点，激活全部出边（返回 true）
 *   outcome.branch === '__none__' → 剪掉全部出边（返回 false）
 *   其他值                         → 仅激活 sourceHandle 匹配的出边
 */
function isHandleActive(branchOrUndefined: string | undefined, sourceHandle: string): boolean {
  if (branchOrUndefined === undefined) return true
  if (branchOrUndefined === NO_BRANCH) return false
  return sourceHandle === branchOrUndefined
}

// ── 主函数 ───────────────────────────────────────────────────────────────────

/**
 * 执行一个工作流图，返回运行结果。
 *
 * @param workflow       当前工作流定义
 * @param initialPayload 触发器初始 payload（来自 manual 输入/schedule 空 payload/webhook body）
 * @param ctx            单次 run 状态容器（nodeOutputs/runVars/cancelToken/pendingApprovals）
 * @param allWorkflows   全量工作流快照（用于 loop/subworkflow 查找 body，U10 填充时使用）
 *                       语义：run 入口一次性快照，运行中编辑不影响在途 run。
 * @param deps           节点执行器外部依赖（AI client、媒体生成等，后续单元填充）
 * @param depth          子流程递归深度，超过 MAX_SUBWORKFLOW_DEPTH 报错（U10 使用）
 * @param callbacks      可选生命周期回调（live status 刷新）
 * @param loopFrame      当前 foreach 帧（U10 loop 节点传入，暴露 $loop.*）
 */
export async function runGraph(
  workflow: WorkflowDef,
  initialPayload: WorkflowPayload,
  ctx: RunContext,
  allWorkflows: WorkflowDef[],
  deps: NodeExecutorDeps,
  depth = 0,
  callbacks?: RunGraphCallbacks,
  loopFrame?: { index: number; item: unknown; total: number }
): Promise<WorkflowRunResult> {
  // 子流程递归深度检查（防止 subworkflow 无限嵌套）
  if (depth > MAX_SUBWORKFLOW_DEPTH) {
    return {
      status: 'error',
      errorMessage: `子流程递归超过最大深度 ${MAX_SUBWORKFLOW_DEPTH}`,
      nodeResults: [],
      output: initialPayload,
    }
  }

  // ── 构建图索引 ────────────────────────────────────────────────────────────
  const nodeById = new Map(workflow.nodes.map((n) => [n.id, n]))

  // 出边索引：nodeId → 该节点的所有出边
  const outEdges = new Map<string, WorkflowConnection[]>()
  // 入边索引：nodeId → 该节点的所有入边
  const inEdges = new Map<string, WorkflowConnection[]>()
  for (const edge of workflow.connections) {
    const outList = outEdges.get(edge.source) ?? []
    outList.push(edge)
    outEdges.set(edge.source, outList)
    const inList = inEdges.get(edge.target) ?? []
    inList.push(edge)
    inEdges.set(edge.target, inList)
  }

  // ── 查找触发器节点（图执行起点）──────────────────────────────────────────
  const triggerNode = workflow.nodes.find(
    (n) => n.type === 'manual-trigger' || n.type === 'schedule-trigger' || n.type === 'webhook-trigger'
  )
  const triggerNodeId = triggerNode?.id

  // ── 解析环境变量与初始 scope ──────────────────────────────────────────────
  const env = resolveEnvVars(workflow.env)
  // 初始 scope（$nodes/$env/$run/$loop），在 run 中通过闭包动态引用 ctx.nodeOutputs/ctx.runVars
  const scopeFor = (): InterpScope => ({
    nodes: ctx.nodeOutputs,
    env,
    run: ctx.runVars,
    loop: loopFrame,
  })

  // ── 数据结构（对齐 Kun）──────────────────────────────────────────────────
  /** 已激活（delivered）的边 ID 集合。*/
  const delivered = new Set<string>()
  /** 已剪枝（pruned）的边 ID 集合。*/
  const prunedEdges = new Set<string>()
  /** 每条 delivered 边携带的 payload。*/
  const payloadByEdge = new Map<string, WorkflowPayload>()
  /**
   * 已 settled 的节点 ID 集合。
   * 不变量 1：节点进入 settled 状态后不再被二次执行（幂等）。
   * 关键：settledNodes.add(nodeId) 必须在 executeNode 调用之前。
   */
  const settledNodes = new Set<string>()
  /** FIFO 就绪队列（可执行的节点 ID）。 */
  const readyQueue: string[] = []

  const deadline = Date.now() + MAX_RUN_DURATION_MS
  let executions = 0
  let status: 'success' | 'error' = 'success'
  let errorMessage = ''
  let output = initialPayload
  const nodeResults: WorkflowNodeRunResult[] = []

  // ── 辅助函数 ──────────────────────────────────────────────────────────────

  const incoming = (nodeId: string): WorkflowConnection[] => inEdges.get(nodeId) ?? []
  const edgeResolved = (edge: WorkflowConnection): boolean =>
    delivered.has(edge.id) || prunedEdges.has(edge.id)
  const allResolved = (nodeId: string): boolean => incoming(nodeId).every(edgeResolved)
  const hasLiveInput = (nodeId: string): boolean => incoming(nodeId).some((e) => delivered.has(e.id))

  /** 把节点加入就绪队列（幂等：已 settled 或已在队列中不重复加）。 */
  const markReady = (nodeId: string): void => {
    if (!settledNodes.has(nodeId) && !readyQueue.includes(nodeId)) {
      readyQueue.push(nodeId)
    }
  }

  /**
   * 剪掉某条边（pruned）。
   * 不变量 3：已 delivered 的边不可再被剪。
   */
  const pruneEdge = (edge: WorkflowConnection): void => {
    // 不变量 3：delivered 优先，不可降级为 pruned
    if (delivered.has(edge.id) || prunedEdges.has(edge.id)) return
    prunedEdges.add(edge.id)
    settleTarget(edge.target)
  }

  /**
   * 级联剪枝：把节点的所有出边都剪掉，并对其下游递归 settleTarget。
   * 当某节点的全部入边都被剪时触发。
   */
  const pruneNode = (nodeId: string): void => {
    if (settledNodes.has(nodeId)) return
    settledNodes.add(nodeId)
    for (const edge of outEdges.get(nodeId) ?? []) pruneEdge(edge)
  }

  /**
   * 尝试 settle 某个节点（判断是否可以入队或需要级联剪枝）。
   *
   * 逻辑：
   *   1. 已 settled → 跳过（幂等）
   *   2. 入边未全部 resolved（delivered ∪ pruned）→ 等待（不入队）
   *   3. 有 delivered 入边 → markReady（入 readyQueue）
   *   4. 全部入边都是 pruned（无 delivered）→ pruneNode（级联剪枝）
   *
   * merge 节点靠这里的通用 allResolved 等待，无特例处理。
   */
  function settleTarget(nodeId: string): void {
    if (settledNodes.has(nodeId)) return
    if (!allResolved(nodeId)) return // 等待更多上游
    if (hasLiveInput(nodeId)) markReady(nodeId)
    else pruneNode(nodeId)
  }

  // ── 初始化：触发器节点入队 ────────────────────────────────────────────────
  if (triggerNodeId) {
    markReady(triggerNodeId)
  } else if (workflow.nodes.length > 0) {
    // 无触发器时从第一个节点开始（兼容 subworkflow body 等场景）
    markReady(workflow.nodes[0].id)
  }

  // ── 主执行循环 ────────────────────────────────────────────────────────────
  try {
    while (readyQueue.length > 0) {
      // 早退检查 1：取消令牌
      if (ctx.cancelToken.cancelled) {
        status = 'error'
        errorMessage = '工作流已取消。'
        break
      }

      // 早退检查 2：超时
      if (Date.now() > deadline) {
        status = 'error'
        errorMessage = '工作流超过最大运行时长（30 分钟）。'
        break
      }

      // 早退检查 3：执行次数上限（防无限 loop）
      if (executions >= MAX_NODE_EXECUTIONS) {
        status = 'error'
        errorMessage = `工作流超过最大节点执行次数（${MAX_NODE_EXECUTIONS}）。`
        break
      }

      // 取队头（FIFO）
      const nodeId = readyQueue.shift()
      if (!nodeId) continue

      // 不变量 1 的前置检查：已 settled 跳过（幂等）
      if (settledNodes.has(nodeId)) continue

      const node = nodeById.get(nodeId)
      if (!node) {
        // 图定义不一致（节点被删但边仍存），安全跳过
        settledNodes.add(nodeId)
        continue
      }

      // 不变量 1：settledNodes.add 必须在 executeNode 调用之前（防重入）
      settledNodes.add(nodeId)
      executions += 1

      // 收集该节点所有 delivered 入边的 payload
      const inputs = incoming(nodeId)
        .filter((e) => delivered.has(e.id))
        .map((e) => payloadByEdge.get(e.id))
        .filter((v): v is WorkflowPayload => v !== undefined)

      // primary = 首条 delivered 入边 payload，或初始 payload（触发器节点）
      const primary = inputs[0] ?? (nodeId === triggerNodeId ? initialPayload : { json: {}, text: '' })

      callbacks?.onNodeStatus?.(nodeId, 'running')

      const nodeStartedAt = new Date()
      let outcome: { payload: WorkflowPayload; branch?: string; threadId?: string; message?: string } | null = null
      let lastError = ''
      let attempt = 0

      if (node.disabled) {
        // disabled 节点：透传上游 payload，不计入 executions（已 +1，但语义上不算执行）
        executions -= 1
        callbacks?.onNodeStatus?.(nodeId, 'skipped')
        outcome = { payload: primary }
        nodeResults.push({
          nodeId: node.id,
          status: 'skipped',
          startedAt: nodeStartedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          message: '节点已禁用，透传上游 payload',
          outputJson: safeJson(primary.json),
          inputJson: safeJson(primary.json),
          retries: 0,
          threadId: '',
          error: '',
        })
      } else {
        // 正常执行节点（含 retry/onError 逻辑）
        const maxRetries = node.retries ?? 0

        while (true) {
          try {
            const baseScope = scopeFor()
            const nodeInputs = resolveNodeInputs(node, primary, baseScope)
            const resolvedScope: InterpScope = nodeInputs ? { ...baseScope, input: nodeInputs } : baseScope

            outcome = await executeNode(node, ctx, primary, resolvedScope, deps)
            break
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)

            if (attempt < maxRetries) {
              attempt += 1
              // 有 retryDelayMs 时等待后重试
              if (node.retryDelayMs && node.retryDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, node.retryDelayMs))
              }
              continue
            }

            // 超过重试次数，按 onError 处理
            const mode = node.onError ?? 'fail'
            if (mode === 'continue' || mode === 'fallback') {
              let fallback: unknown = null
              if (mode === 'fallback' && node.fallbackJson) {
                try {
                  fallback = JSON.parse(node.fallbackJson)
                } catch {
                  fallback = node.fallbackJson
                }
              }
              outcome = {
                payload: { json: fallback, text: mode === 'fallback' ? safeJson(fallback) : '' },
                message: `错误已处理（${mode}）: ${lastError}`,
              }
            }
            // mode === 'fail' 时 outcome 保持 null，下方走 error 路径
            break
          }
        }

        if (outcome) {
          callbacks?.onNodeStatus?.(nodeId, 'success')
          nodeResults.push({
            nodeId: node.id,
            status: 'success',
            startedAt: nodeStartedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            message: outcome.message ?? '',
            outputJson: safeJson(outcome.payload.json),
            inputJson: safeJson(primary.json),
            retries: attempt,
            threadId: outcome.threadId ?? '',
            error: lastError,
          })
          // 更新共享 nodeOutputs（供后续节点 $nodes 解析）
          ctx.nodeOutputs[node.id] = outcome.payload
          output = outcome.payload
        } else {
          // 节点执行失败（onError='fail'）：终止 run
          callbacks?.onNodeStatus?.(nodeId, 'error')
          nodeResults.push({
            nodeId: node.id,
            status: 'error',
            startedAt: nodeStartedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            message: '',
            outputJson: '',
            inputJson: safeJson(primary.json),
            retries: attempt,
            threadId: '',
            error: lastError,
          })
          status = 'error'
          errorMessage = lastError
          break
        }
      }

      // ── 传播 payload 到下游 ───────────────────────────────────────────────
      const outPayload = outcome ? outcome.payload : primary
      const branch = outcome?.branch

      const edges = outEdges.get(node.id) ?? []
      for (const edge of edges) {
        const sourceHandle = edge.sourceHandle || 'out'
        if (isHandleActive(branch, sourceHandle)) {
          // 激活此边：delivered
          // 不变量 3 保证：已 delivered 的边不会因另一路径再被剪
          delivered.add(edge.id)
          payloadByEdge.set(edge.id, outPayload)
        } else {
          // 剪掉此边：pruned（pruneEdge 内部也检查不变量 3）
          pruneEdge(edge)
        }
      }

      // settle 所有下游节点（可能 markReady 或 pruneNode）
      for (const edge of edges) settleTarget(edge.target)
    }
  } catch (error) {
    status = 'error'
    errorMessage = error instanceof Error ? error.message : String(error)
  }

  // ── 选取 run 最终输出 ─────────────────────────────────────────────────────
  // 优先取 output 节点的 payload（canonical），否则 output 已是最后执行节点的 payload
  const outputNodeResult = nodeResults.find((r) => {
    const node = nodeById.get(r.nodeId)
    return node?.type === 'output' && r.status === 'success'
  })
  if (outputNodeResult) {
    const outputNode = nodeById.get(outputNodeResult.nodeId)
    if (outputNode && ctx.nodeOutputs[outputNode.id]) {
      output = ctx.nodeOutputs[outputNode.id]
    }
  }

  void allWorkflows // 供 U10 subworkflow/loop 节点使用，此处预留参数

  return { status, errorMessage, nodeResults, output }
}

// 导出常量供测试和后续单元使用
export { MAX_NODE_EXECUTIONS, MAX_RUN_DURATION_MS, MAX_SUBWORKFLOW_DEPTH, NO_BRANCH }
