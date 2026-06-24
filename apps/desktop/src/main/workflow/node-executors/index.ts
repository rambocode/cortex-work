/**
 * executeNode 分发表：按节点 type 路由到具体执行器。
 *
 * 本单元实现：
 *   - 三种触发器节点（manual/schedule/webhook-trigger）→ 透传 primary payload
 *   - U10 流程控制节点（condition/switch/filter/merge/loop/subworkflow/human-approval/delay）
 *   - 其余 → 抛 "待后续单元实现" 占位错误
 *
 * 签名变更（U10）：
 *   新增 inputs 参数（WorkflowPayload[]），携带全部 delivered 上游 payload。
 *   merge 节点需要消费全部上游数组（不仅是 primary）。
 *   graph-executor.ts 在调用 executeNode 时传入已收集的 inputs 数组。
 *
 * 后续单元填充路线：
 *   U11 → data.ts + code.ts + http.ts：数据处理 + 代码 + HTTP 请求
 *   U12 → ai.ts：ai-agent/parameter-extractor/question-classifier（CLI spawn）
 *   U13 → image.ts：generate-image（消费 capabilities/media-gen）
 *
 * 不变量：executeNode 不修改 RunContext，所有副作用（写 nodeOutputs、runVars）
 * 由 graph-executor.ts 的 runGraph 统一管理，保证线程安全。
 */

import type { WorkflowNode, WorkflowDef } from '../types.js'
import type { WorkflowPayload, InterpScope } from '../runtime/interp.js'
import type { RunContext } from '../runtime/run-context.js'
import {
  executeCondition,
  executeSwitch,
  executeFilter,
  executeMerge,
  executeLoop,
  executeSubworkflow,
  executeHumanApproval,
  executeDelay,
  type RunGraphFn,
} from './flow-control.js'
import {
  executeSetFields,
  executeSort,
  executeLimit,
  executeAggregate,
  executeTemplate,
  executeJson,
  executeOutput,
} from './data.js'
import { executeCode, executeCustom } from './code.js'
import { executeHttpRequest } from './http.js'

// ── 对外类型契约 ──────────────────────────────────────────────────────────────

/**
 * 节点执行器依赖注入接口。
 *
 * U10 新增：
 *   runGraph     — loop/subworkflow 节点递归执行子工作流所需的引擎函数引用（避免循环导入）。
 *   allWorkflows — 全量工作流快照，供 loop/subworkflow 查找 body workflow。
 *   depth        — 当前递归深度，由引擎在每次递归调用时递增传入。
 *   noRunRef     — human-approval 测试标记（true 时自动 approved，无需挂起等待）。
 *
 * 后续单元追加字段：AI client（U12）、HTTP 配置（U11）、媒体生成（U13）等。
 */
export interface NodeExecutorDeps {
  /** 工作区根目录（从触发器 config.workspaceRoot 解析）。U9+ 填充。 */
  workspaceRoot?: string

  /**
   * loop/subworkflow 递归调用的引擎函数（由 graph-executor 在调用链顶部注入）。
   * 传函数引用而非直接 import，避免 node-executors ↔ runtime 形成循环依赖。
   */
  runGraph?: RunGraphFn

  /**
   * 全量工作流快照，供 loop/subworkflow 在子流程列表中查找 workflowId。
   * 语义：run 入口一次性快照，运行中编辑不影响在途 run。
   */
  allWorkflows?: WorkflowDef[]

  /**
   * 当前子流程递归深度（由 graph-executor 传入，随递归 +1）。
   * executeNode 本身不递增，由调用方（runGraph）负责维护。
   */
  depth?: number

  /**
   * human-approval 节点的测试模式标记。
   * true → 节点直接返回 approved，不注册 pendingApprovals，不挂起。
   * 用途：单节点测试 / graph-executor mock 场景（对齐 Kun "no runRef → auto-approve"）。
   */
  noRunRef?: boolean
}

/**
 * 节点执行结果。
 *
 * branch 语义（关键不变量，勿混淆）：
 *   undefined          → 无分支节点，激活全部出边（如 set-fields、template 等）
 *   '__none__'         → NO_BRANCH sentinel，剪掉全部出边（如 switch 无匹配且无 fallback）
 *   'true'/'false'     → condition 节点
 *   'case-N'/'fallback' → switch 节点
 *   'approved'/'rejected' → human-approval 节点
 *   '<category.id>'    → question-classifier 节点
 *   undefined（filter pass）→ filter 通过时激活出边（与 undefined 同效）
 *   '__none__'（filter block）→ filter 过滤时剪掉出边
 */
export interface NodeOutcome {
  payload: WorkflowPayload
  /** 分支 handle（见上方语义注释）。undefined = 激活全部出边。 */
  branch?: string
  /** AI 节点返回的会话 ID，用于 threadId 回溯（U12 填充）。 */
  threadId?: string
  /** 节点执行摘要消息（可选，用于运行日志）。 */
  message?: string
}

// ── 分发入口 ──────────────────────────────────────────────────────────────────

/**
 * 执行单个节点，返回 NodeOutcome。
 *
 * @param node    当前节点定义
 * @param ctx     单次 run 的状态容器（含 nodeOutputs/runVars/cancelToken/pendingApprovals）
 * @param primary 当前节点的主输入（首条 delivered 入边的 payload，或初始 payload）
 * @param scope   模板变量作用域（含 nodes/env/run/loop/input）
 * @param deps    外部依赖（runGraph 函数引用、allWorkflows 快照、depth、AI client 等）
 * @param inputs  全部 delivered 上游 payload 数组（merge 节点消费；其他节点只用 primary）
 *                U10 新增此参数，graph-executor 从 incoming(nodeId).filter(delivered) 收集并传入。
 */
export async function executeNode(
  node: WorkflowNode,
  ctx: RunContext,
  primary: WorkflowPayload,
  scope: InterpScope,
  deps: NodeExecutorDeps,
  inputs?: WorkflowPayload[]
): Promise<NodeOutcome> {
  switch (node.type) {
    // ── 触发器节点（U8 实现：透传初始 payload）────────────────────────────────
    // 触发器是图执行的起点，自身无需变换 payload；直接透传 primary。
    // U9 会在此完善触发器语义（如记录触发来源、解析 webhook body 等）。
    case 'manual-trigger':
    case 'schedule-trigger':
    case 'webhook-trigger':
      return { payload: primary, message: `触发器 ${node.type} 透传初始 payload` }

    // ── 流程控制节点（U10 实现）────────────────────────────────────────────────
    case 'condition':
      return executeCondition(node.config, primary, scope)

    case 'switch':
      return executeSwitch(node.config, primary, scope)

    case 'filter':
      return executeFilter(node.config, primary, scope)

    case 'merge':
      // merge 消费全部 delivered 上游（inputs[]），primary 仅是第一个
      return executeMerge(node.config, inputs ?? [primary])

    case 'loop': {
      // loop/subworkflow 需要 runGraph 函数引用和 allWorkflows
      const runGraphFn = deps.runGraph
      if (!runGraphFn) throw new Error('loop 节点缺少 deps.runGraph（引擎注入缺失）。')
      return executeLoop(
        node,
        node.config,
        primary,
        scope,
        ctx,
        deps.allWorkflows ?? [],
        deps as Record<string, unknown>, // NodeExecutorDeps 满足 Record<string,unknown> 结构
        deps.depth ?? 0,
        runGraphFn
      )
    }

    case 'subworkflow': {
      const runGraphFn = deps.runGraph
      if (!runGraphFn) throw new Error('subworkflow 节点缺少 deps.runGraph（引擎注入缺失）。')
      return executeSubworkflow(
        node.config,
        primary,
        ctx,
        deps.allWorkflows ?? [],
        deps as Record<string, unknown>, // NodeExecutorDeps 满足 Record<string,unknown> 结构
        deps.depth ?? 0,
        runGraphFn
      )
    }

    case 'human-approval':
      return executeHumanApproval(node.config, primary, scope, ctx, deps.noRunRef)

    case 'delay':
      return executeDelay(node.config, primary)

    // ── 数据处理节点（U11 实现）────────────────────────────────────────────────
    case 'set-fields':
      return executeSetFields(node.config, primary, scope, ctx)

    case 'sort':
      return executeSort(node.config, primary)

    case 'limit':
      return executeLimit(node.config, primary)

    case 'aggregate':
      return executeAggregate(node.config, primary)

    case 'template':
      return executeTemplate(node.config, primary, scope)

    case 'json':
      return executeJson(node.config, primary)

    case 'output':
      return executeOutput(node.config, primary, scope)

    // ── 代码节点（U11 实现）────────────────────────────────────────────────────
    case 'code':
      return executeCode(node.config, primary)

    case 'custom':
      return executeCustom(node.config, primary)

    // ── HTTP 节点（U11 实现）───────────────────────────────────────────────────
    case 'http-request':
      return executeHttpRequest(node.config, primary, scope)

    // ── AI 节点（U12 实现）─────────────────────────────────────────────────────
    case 'ai-agent':
    case 'parameter-extractor':
    case 'question-classifier':
      throw new Error(`节点类型 ${node.type} 待 U12（AI 节点 CLI spawn 适配）实现`)

    // ── 图片生成节点（U13 实现）────────────────────────────────────────────────
    case 'generate-image':
      throw new Error(`节点类型 ${node.type} 待 U13（生成图片节点）实现`)

    default: {
      // TypeScript exhaustive check：如果新增了 WorkflowNodeKind 但未加 case，此处会报错
      const _exhaustive: never = node
      throw new Error(`未知节点类型: ${(_exhaustive as WorkflowNode).type}`)
    }
  }
}

// 重导出供外部引用（避免直接依赖 flow-control.ts）
export type { RunGraphFn }
