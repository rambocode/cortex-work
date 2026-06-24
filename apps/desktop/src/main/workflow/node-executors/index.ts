/**
 * executeNode 分发表：按节点 type 路由到具体执行器。
 *
 * 本单元（U8）只实现：
 *   - 三种触发器节点（manual/schedule/webhook-trigger）→ 透传 primary payload
 *   - 其余 22 种 → 抛 "待后续单元实现" 占位错误
 *
 * 后续单元填充路线：
 *   U9  → triggers.ts：触发器完整实现（调度接入等）
 *   U10 → flow-control.ts：condition/switch/filter/merge/loop/subworkflow/human-approval/delay
 *   U11 → data.ts + code.ts + http.ts：数据处理 + 代码 + HTTP 请求
 *   U12 → ai.ts：ai-agent/parameter-extractor/question-classifier（CLI spawn）
 *   U13 → image.ts：generate-image（消费 capabilities/media-gen）
 *
 * 不变量：executeNode 不修改 RunContext，所有副作用（写 nodeOutputs、runVars）
 * 由 graph-executor.ts 的 runGraph 统一管理，保证线程安全。
 */

import type { WorkflowNode } from '../types.js'
import type { WorkflowPayload, InterpScope } from '../runtime/interp.js'
import type { RunContext } from '../runtime/run-context.js'

// ── 对外类型契约 ──────────────────────────────────────────────────────────────

/**
 * 节点执行器依赖注入接口。
 * 本单元（U8）留空；后续单元填充时在此追加字段（AI client、HTTP 配置、媒体生成等）。
 */
export interface NodeExecutorDeps {
  /** 工作区根目录（从触发器 config.workspaceRoot 解析）。U9+ 填充。 */
  workspaceRoot?: string
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
 * @param ctx     单次 run 的状态容器（含 nodeOutputs/runVars/cancelToken）
 * @param primary 当前节点的主输入（首条 delivered 入边的 payload，或初始 payload）
 * @param scope   模板变量作用域（含 nodes/env/run/loop/input）
 * @param deps    外部依赖（AI client、HTTP 等）
 */
export async function executeNode(
  node: WorkflowNode,
  ctx: RunContext,
  primary: WorkflowPayload,
  scope: InterpScope,
  deps: NodeExecutorDeps
): Promise<NodeOutcome> {
  // 消除 unused 警告（后续单元会实际使用）
  void ctx
  void scope
  void deps

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
    case 'switch':
    case 'filter':
    case 'merge':
    case 'loop':
    case 'subworkflow':
    case 'human-approval':
    case 'delay':
      throw new Error(`节点类型 ${node.type} 待 U10（流程控制节点）实现`)

    // ── 数据处理节点（U11 实现）────────────────────────────────────────────────
    case 'set-fields':
    case 'sort':
    case 'limit':
    case 'aggregate':
    case 'template':
    case 'json':
    case 'output':
      throw new Error(`节点类型 ${node.type} 待 U11（数据处理节点）实现`)

    // ── 代码节点（U11 实现）────────────────────────────────────────────────────
    case 'code':
    case 'custom':
      throw new Error(`节点类型 ${node.type} 待 U11（代码/自定义节点）实现`)

    // ── HTTP 节点（U11 实现）───────────────────────────────────────────────────
    case 'http-request':
      throw new Error(`节点类型 ${node.type} 待 U11（HTTP 节点）实现`)

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
