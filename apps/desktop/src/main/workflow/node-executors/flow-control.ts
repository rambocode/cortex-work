/**
 * 流程控制节点执行器（U10）。
 *
 * 实现以下 8 种节点：
 *   condition    — 条件判断，branch='true'|'false'
 *   switch       — 规则匹配，branch='case-0'..'case-N'|'fallback'|'__none__'
 *   filter       — 过滤，通过→激活出边(branch=undefined)，阻断→NO_BRANCH
 *   merge        — 合并多上游 payload（array/object 两种模式）
 *   loop         — 循环（foreach / condition-loop），支持并发与 continueOnError
 *   subworkflow  — 递归执行子工作流（MAX_SUBWORKFLOW_DEPTH 防无限嵌套）
 *   human-approval — 挂起等待人工审批（timeout 自动决策）
 *   delay        — 等待指定毫秒
 *
 * 与 graph-executor 的契约（重要）：
 *   - merge 节点：graph-executor 传入 inputs[]（全部 delivered 上游 payload），
 *     executeNode 转发此数组供 executeMerge 消费。
 *   - loop/subworkflow：通过 deps.runGraph / deps.allWorkflows 进行递归，
 *     以保持与上层引擎相同的 cancelToken / depth 传播链。
 *   - human-approval：挂起时向 ctx.pendingApprovals 注册 resolve，
 *     stop handler 遍历该 Map 并调用 resolve('rejected') 实现级联拒绝。
 */

import { randomUUID } from 'crypto'
import type { WorkflowPayload, InterpScope } from '../runtime/interp.js'
import { resolveExpr } from '../runtime/interp.js'
import type { RunContext } from '../runtime/run-context.js'
import type { WorkflowDef } from '../types.js'
import type {
  WorkflowConditionConfig,
  WorkflowSwitchConfig,
  WorkflowFilterConfig,
  WorkflowMergeConfig,
  WorkflowLoopConfig,
  WorkflowSubWorkflowConfig,
  WorkflowHumanApprovalConfig,
  WorkflowDelayConfig,
  WorkflowNode,
} from '../types.js'
import { evaluateCondition } from './conditions.js'
import type { NodeOutcome } from './index.js'
// ── 常量 ─────────────────────────────────────────────────────────────────────

/** 子流程递归最大深度（与 graph-executor 一致）。 */
const MAX_SUBWORKFLOW_DEPTH = 5

/**
 * NO_BRANCH sentinel（与 graph-executor 一致）。
 * 表示"剪掉全部出边"。flow-control 内部直接使用字面量，保证与引擎对齐。
 */
const NO_BRANCH = '__none__'

/** delay 节点最长等待时间（24 小时）。 */
const MAX_DELAY_MS = 86_400_000

// ── runGraph 函数类型（由 deps 注入，避免循环依赖）────────────────────────────

/**
 * runGraph 最小返回类型（内联定义，避免从 graph-executor.ts 导入造成循环依赖）。
 * 与 graph-executor.ts WorkflowRunResult 保持结构对齐——修改 WorkflowRunResult 时需同步。
 */
export interface RunGraphResult {
  status: 'success' | 'error'
  errorMessage: string
  nodeResults: unknown[]
  output: WorkflowPayload
}

/**
 * loop/subworkflow 节点需要递归调用 runGraph。
 * 由 NodeExecutorDeps 注入（而非直接 import），避免 node-executors ↔ runtime 循环导入。
 *
 * deps 类型用 Record<string, unknown> 而非 NodeExecutorDeps，同样避免循环依赖；
 * 调用方（graph-executor.ts）传入真实 NodeExecutorDeps，满足结构兼容。
 */
export type RunGraphFn = (
  workflow: WorkflowDef,
  initialPayload: WorkflowPayload,
  ctx: RunContext,
  allWorkflows: WorkflowDef[],
  deps: Record<string, unknown>,
  depth: number,
  callbacks?: unknown,
  loopFrame?: { index: number; item: unknown; total: number }
) => Promise<RunGraphResult>

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

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
 * 限并发映射（复刻 Kun mapWithConcurrency）。
 * 对 items 中每个元素调用 fn，最多 limit 个并发在途，保留结果顺序。
 *
 * 实现思路：启动 min(limit, items.length) 个 worker，共享游标 cursor。
 * 每个 worker 循环取下一个未处理的 index，直到全部处理完，结果按原始 index 写入。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) break
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

// ── 各节点执行器 ──────────────────────────────────────────────────────────────

/**
 * condition 节点：evaluateCondition → branch='true'|'false'。
 * payload 透传（不修改数据，只决定路由）。
 */
export function executeCondition(
  config: WorkflowConditionConfig,
  payload: WorkflowPayload,
  scope: InterpScope
): NodeOutcome {
  const matched = evaluateCondition(config, payload, scope)
  return {
    payload,
    message: matched ? 'true' : 'false',
    branch: matched ? 'true' : 'false',
  }
}

/**
 * switch 节点：逐 rule 求值，首个命中 → 'case-0'..'case-N'；
 * 无命中且 fallback=true → 'fallback'；无命中且 fallback=false → NO_BRANCH。
 */
export function executeSwitch(
  config: WorkflowSwitchConfig,
  payload: WorkflowPayload,
  scope: InterpScope
): NodeOutcome {
  for (let index = 0; index < config.rules.length; index++) {
    if (evaluateCondition(config.rules[index], payload, scope)) {
      return {
        payload,
        message: `case ${index + 1}`,
        branch: `case-${index}`,
      }
    }
  }
  // 无命中：fallback=true 走 fallback 边；否则剪掉全部出边
  return {
    payload,
    message: config.fallback ? 'fallback' : 'no match',
    branch: config.fallback ? 'fallback' : NO_BRANCH,
  }
}

/**
 * filter 节点：通过 → branch=undefined（激活出边）；阻断 → NO_BRANCH（剪掉出边）。
 * branch=undefined 表示"无分支节点，激活全部出边"，与引擎不变量 2 对齐。
 */
export function executeFilter(
  config: WorkflowFilterConfig,
  payload: WorkflowPayload,
  scope: InterpScope
): NodeOutcome {
  const pass = evaluateCondition(config, payload, scope)
  return {
    payload,
    message: pass ? 'pass' : 'blocked',
    branch: pass ? undefined : NO_BRANCH,
  }
}

/**
 * merge 节点：汇合多个上游 payload。
 *
 * mode='array'  → 收集所有 delivered 上游的 payload.json 成数组。
 * mode='object' → 对所有 delivered 上游的 payload.json 做浅 Object.assign（后者覆盖前者）。
 *
 * 注意：inputs 是引擎收集的全部 delivered 上游 payload（graph-executor 负责等待 allResolved，
 * 本 executor 直接消费已收到的数组，无需再做等待逻辑）。
 */
export function executeMerge(config: WorkflowMergeConfig, inputs: WorkflowPayload[]): NodeOutcome {
  if (config.mode === 'object') {
    const merged: Record<string, unknown> = {}
    for (const input of inputs) {
      if (input.json && typeof input.json === 'object' && !Array.isArray(input.json)) {
        Object.assign(merged, input.json as Record<string, unknown>)
      }
    }
    return {
      payload: { json: merged, text: safeJson(merged) },
      message: `merged ${inputs.length}`,
    }
  }
  // mode='array'：收集 json 字段成数组，text 字段用换行拼接
  const collected = inputs.map((input) => input.json)
  return {
    payload: {
      json: collected,
      text: inputs
        .map((input) => input.text)
        .filter(Boolean)
        .join('\n'),
    },
    message: `merged ${inputs.length}`,
  }
}

/**
 * loop 节点：支持 foreach 和 condition-loop 两种模式。
 *
 * foreach 模式：
 *   从 arraySource（resolveExpr 解析）取数组，按 execution='sequential'|'parallel' 执行，
 *   并发度 concurrency（1-8），continueOnError 控制错误策略。
 *   每一轮 item 以 workflowId 对应的 body workflow 的触发器为起点运行 runGraph，
 *   $loop.index/item/total 注入 loopFrame 供子流程访问。
 *
 * condition 模式（while 循环）：
 *   每轮运行 body，用 stopCondition 求值，满足则停止；maxIterations 为硬性上限。
 *
 * 递归约定（关键）：
 *   - 传入同一 cancelToken（可变对象引用），确保 stop 信号能传达到子流程。
 *   - depth+1，防止无限嵌套（MAX_SUBWORKFLOW_DEPTH）。
 *   - allWorkflows 快照完整传递，子流程内可再嵌套 subworkflow/loop。
 */
export async function executeLoop(
  _node: WorkflowNode & { type: 'loop' },
  config: WorkflowLoopConfig,
  payload: WorkflowPayload,
  scope: InterpScope,
  ctx: RunContext,
  allWorkflows: WorkflowDef[],
  deps: Record<string, unknown>,
  depth: number,
  runGraph: RunGraphFn
): Promise<NodeOutcome> {
  if (depth >= MAX_SUBWORKFLOW_DEPTH) {
    throw new Error('Loop 嵌套超过最大深度。')
  }

  // 查找 body workflow
  const target = allWorkflows.find((wf) => wf.id === config.workflowId)
  if (!target) throw new Error(`Loop body 工作流未找到（id=${config.workflowId}）。`)

  // body workflow 必须有触发器节点
  const trigger =
    target.nodes.find((n) => n.type === 'manual-trigger') ??
    target.nodes.find((n) => n.type === 'schedule-trigger') ??
    target.nodes.find((n) => n.type === 'webhook-trigger')
  if (!trigger) throw new Error('Loop body 工作流没有触发器节点。')

  // ── foreach 模式 ────────────────────────────────────────────────────────────
  if (config.mode === 'foreach' || !config.mode) {
    const source = config.arraySource?.trim()
    // arraySource 为空时取 payload.json 本身（期望是数组）
    const raw = source ? resolveExpr(payload, source, scope) : payload.json
    // 非数组时退化为空（对齐 Kun），maxIterations 作为额外安全上限
    const items = (Array.isArray(raw) ? raw : []).slice(0, config.maxIterations)
    const total = items.length

    /**
     * fail-fast 标志：非 continueOnError 模式下，首个失败后设 aborted=true，
     * 后续 worker 检测到后立即抛错而不再启动新的子 run。
     */
    let aborted = false

    const runItem = async (item: unknown, index: number): Promise<unknown> => {
      if (aborted) throw new Error('Loop 已因先前的错误中止。')

      const itemPayload: WorkflowPayload = {
        json: item,
        text: typeof item === 'string' ? item : safeJson(item),
      }

      try {
        const result = await runGraph(
          target,
          itemPayload,
          ctx, // 同一 RunContext，cancelToken 共享
          allWorkflows,
          deps,
          depth + 1,
          undefined, // callbacks（不传，子流程不需要 live status）
          { index, item, total } // $loop.index/item/total
        )
        if (result.status === 'error') {
          throw new Error(result.errorMessage || 'Loop item 执行失败。')
        }
        return result.output.json
      } catch (error) {
        if (config.continueOnError) {
          // continueOnError：记录错误，继续下一个 item
          return { error: error instanceof Error ? error.message : String(error) }
        }
        aborted = true
        throw error
      }
    }

    let outputs: unknown[]
    const concurrency = Math.max(1, Math.min(config.concurrency ?? 4, 8))

    if (config.execution === 'parallel') {
      // 并行执行，mapWithConcurrency 保证结果顺序
      outputs = await mapWithConcurrency(items, concurrency, runItem)
    } else {
      // 顺序执行（sequential，默认）
      outputs = []
      for (let i = 0; i < items.length; i++) {
        outputs.push(await runItem(items[i], i))
      }
    }

    // 统计成功/失败数量（error 对象含 error 字段视为失败）
    const failures = outputs.filter(
      (v) => v && typeof v === 'object' && 'error' in (v as Record<string, unknown>)
    ).length
    const label = config.execution === 'parallel' ? ` (parallel)` : ''

    return {
      payload: { json: outputs, text: safeJson(outputs) },
      message: `foreach ${total - failures}/${total}${label}`,
    }
  }

  // ── condition 模式（while 循环）─────────────────────────────────────────────
  const stopCondition = {
    leftExpr: config.leftExpr,
    operator: config.operator,
    rightValue: config.rightValue,
    caseSensitive: config.caseSensitive,
  }

  let current = payload
  let iterations = 0
  let done = false

  while (iterations < config.maxIterations) {
    // cancelToken 检查（深层循环也需响应取消）
    if (ctx.cancelToken.cancelled) break

    const result = await runGraph(
      target,
      current,
      ctx,
      allWorkflows,
      deps,
      depth + 1,
      undefined,
      { index: iterations, item: current.json, total: config.maxIterations }
    )
    iterations++

    if (result.status === 'error') {
      throw new Error(result.errorMessage || 'Loop body 执行失败。')
    }
    current = result.output

    // 判断停止条件
    if (evaluateCondition(stopCondition, current, scope)) {
      done = true
      break
    }
  }

  // 输出结果：合并最后一轮 json + 元数据字段（对齐 Kun）
  const baseJson =
    current.json && typeof current.json === 'object' && !Array.isArray(current.json)
      ? { ...(current.json as Record<string, unknown>) }
      : { value: current.json }

  return {
    payload: {
      json: { ...baseJson, _iterations: iterations, _done: done },
      text: current.text,
    },
    message: `looped ${iterations}${done ? ' (done)' : ' (max)'}`,
  }
}

/**
 * subworkflow 节点：递归执行目标工作流，输出 result.output。
 *
 * 递归约定（与 loop 一致）：depth+1、同一 cancelToken、完整 allWorkflows 快照传递。
 * 超过 MAX_SUBWORKFLOW_DEPTH 时抛错（在 graph-executor 层被 onError 捕获）。
 */
export async function executeSubworkflow(
  config: WorkflowSubWorkflowConfig,
  payload: WorkflowPayload,
  ctx: RunContext,
  allWorkflows: WorkflowDef[],
  deps: Record<string, unknown>,
  depth: number,
  runGraph: RunGraphFn
): Promise<NodeOutcome> {
  if (depth >= MAX_SUBWORKFLOW_DEPTH) {
    throw new Error('子流程嵌套超过最大深度。')
  }

  const target = allWorkflows.find((wf) => wf.id === config.workflowId)
  if (!target) throw new Error(`子流程工作流未找到（id=${config.workflowId}）。`)

  // 子流程必须有触发器节点（manual 或 schedule）
  const trigger =
    target.nodes.find((n) => n.type === 'manual-trigger') ??
    target.nodes.find((n) => n.type === 'schedule-trigger')
  if (!trigger) throw new Error('子流程没有触发器节点。')

  const result = await runGraph(
    target,
    payload,
    ctx,
    allWorkflows,
    deps,
    depth + 1
  )

  if (result.status === 'error') {
    throw new Error(result.errorMessage || '子流程执行失败。')
  }

  return {
    payload: result.output,
    message: `ran ${target.name || 'sub-workflow'}`,
  }
}

/**
 * human-approval 节点：挂起 run，等待人工审批决策。
 *
 * 机制（关键）：
 *   1. 生成唯一 token，向 ctx.pendingApprovals 注册 { resolve } 条目。
 *   2. await 等待 resolve 被外部调用（来自 IPC approve/reject handler）。
 *   3. timeoutMs > 0 时自动超时，按 onTimeout 决策并清理定时器。
 *   4. stop workflow 时，stop handler 遍历 ctx.pendingApprovals 对全部 pending 调用
 *      resolve('rejected')，实现级联拒绝（R11，run-context.ts 中有注释）。
 *
 * 单节点测试场景（runRef 不存在）：
 *   graph-executor 不传 runRef 给 executor，因此 ctx 中没有 runId/workflowId。
 *   对齐 Kun 行为：直接返回 approved（test 模式），避免挂起无法 resolve 导致测试卡住。
 *   判断依据：ctx.pendingApprovals 传入但当前节点不处于真实 run 时（通过第三方参数标记）——
 *   本实现简化为：若 ctx.runId 不存在（RunContext 无此字段）则自动 approved。
 *   实际上，只要 ctx.pendingApprovals Map 正常传入就走正常流程；
 *   测试时使用 noRunRef=true 参数显式跳过挂起。
 */
/**
 * human-approval 节点的待审批通知回调类型（P0 Fix-1）。
 * index.ts 注入的实现调 broadcastWorkflowRunEvent(pending-approval) 把 token 推给 UI。
 */
type OnPendingApprovalFn = (info: {
  token: string
  nodeId: string
  nodeName: string
  title: string
  instruction: string
}) => void

export async function executeHumanApproval(
  node: WorkflowNode,
  config: WorkflowHumanApprovalConfig,
  payload: WorkflowPayload,
  _scope: InterpScope,
  ctx: RunContext,
  noRunRef?: boolean,
  onPendingApproval?: OnPendingApprovalFn
): Promise<NodeOutcome> {
  // 单节点测试/无 runRef 时自动 approved（对齐 Kun "Single-node test / validation: cannot pause"）
  if (noRunRef) {
    return { payload, message: 'approved (test)', branch: 'approved' }
  }

  const token = randomUUID()

  const decision = await new Promise<string>((resolvePromise) => {
    let timer: ReturnType<typeof setTimeout> | undefined

    // 包装 resolve：同时清理定时器并从 Map 移除（避免 stop handler 重复调用）
    const settle = (value: string): void => {
      if (timer) clearTimeout(timer)
      ctx.pendingApprovals.delete(token)
      resolvePromise(value)
    }

    // 超时自动决策
    if (config.timeoutMs > 0) {
      timer = setTimeout(() => settle(config.onTimeout), config.timeoutMs)
    }

    // 注册到 pendingApprovals，供外部 IPC handler 或 stop handler 调用
    ctx.pendingApprovals.set(token, { resolve: settle })

    // P0 Fix-1：注册完成后立即广播 pending-approval 事件，让 UI 能拿到 token。
    // 通知在 set 之后发出，确保 IPC 侧 resolveApproval 收到时 token 已在 Map 中。
    onPendingApproval?.({
      token,
      nodeId: node.id,
      nodeName: node.name,
      title: config.title,
      instruction: config.instruction,
    })
  })

  if (decision === 'rejected') {
    return { payload, message: 'rejected', branch: 'rejected' }
  }

  // approved：在 json 中附加 _approved 标记（对齐 Kun）
  const approvedJson =
    payload.json && typeof payload.json === 'object' && !Array.isArray(payload.json)
      ? { ...(payload.json as Record<string, unknown>), _approved: true }
      : payload.json

  return {
    payload: { json: approvedJson, text: payload.text },
    message: 'approved',
    branch: 'approved',
  }
}

/**
 * delay 节点：等待指定毫秒后透传 payload。
 * delayMs 上限 86400000（24 小时），避免超长 await 阻塞引擎线程。
 *
 * P1 Fix-8：响应 cancelToken，stop 后快速退出（不再等待最长 24h）。
 * 实现：Promise.race([delay, cancelPoll])，cancelPoll 每 50ms 检查 cancelToken.cancelled。
 */
export async function executeDelay(
  config: WorkflowDelayConfig,
  payload: WorkflowPayload,
  ctx?: RunContext
): Promise<NodeOutcome> {
  const ms = Math.max(0, Math.min(config.delayMs, MAX_DELAY_MS))

  // 若无 ctx（单节点测试等场景），退化为原始实现。
  if (!ctx) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms))
    return { payload, message: `Waited ${ms}ms` }
  }

  // cancelToken 轮询（对齐 ai.ts 的轮询模式）：每 50ms 检查一次，取消后立即退出。
  const POLL_INTERVAL = 50
  const cancelled = await new Promise<boolean>((resolve) => {
    const deadline = Date.now() + ms
    const timer = setTimeout(() => resolve(false), ms)
    const poll = setInterval(() => {
      if (ctx.cancelToken.cancelled) {
        clearTimeout(timer)
        clearInterval(poll)
        resolve(true)
      } else if (Date.now() >= deadline) {
        clearInterval(poll)
        resolve(false)
      }
    }, POLL_INTERVAL)
  })

  if (cancelled) {
    // 取消时抛错，让 runGraph 捕获并记录 cancelled 状态（对齐 cancelToken 语义）。
    throw new Error('工作流已取消。')
  }

  return { payload, message: `Waited ${ms}ms` }
}
