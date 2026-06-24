/**
 * 单次 workflow run 的状态容器。
 *
 * 设计原则：
 * - cancelToken 是可变对象（{ cancelled: boolean }），而非 closure 或 boolean 值。
 *   原因：runGraph 递归（subworkflow/loop 体内）需要向上传播取消信号，传引用比传函数
 *   更简单、不需要闭包捕获，且 stop handler 直接修改此对象即可。
 * - pendingApprovals 是 Map，key 为 approvalId，value 含 resolve 函数。
 *   stop workflow 时遍历此 Map，对所有等待项调用 resolve('rejected')，实现级联拒绝（R11）。
 * - runVars 对应 set-fields scope=run 写入的跨节点共享变量（$run.key）。
 * - nodeOutputs 存放每个已完成节点的输出 payload，供 InterpScope $nodes 命名空间查询。
 */

import type { WorkflowPayload } from './interp.js'

export type { WorkflowPayload }

export interface RunContext {
  /** 每个已完成节点的输出 payload（nodeId → payload），供 {{$nodes.<id>.xxx}} 解析。 */
  nodeOutputs: Record<string, WorkflowPayload>

  /** run 级别共享变量（set-fields scope=run 写入），供 {{$run.key}} 解析。 */
  runVars: Record<string, unknown>

  /**
   * 挂起等待人工审批的节点（approvalId → resolve）。
   * stop workflow 时，stop handler 取出 RunContext 后遍历此 Map
   * 对所有 pending 调用 resolve('rejected')，实现级联拒绝（R11）。
   */
  pendingApprovals: Map<string, { resolve: (decision: string) => void }>

  /**
   * 取消令牌 —— 可变对象，不要 closure。
   * stop handler 直接写 cancelToken.cancelled = true，runGraph 每轮循环检查此标志。
   * 传可变对象而非 boolean，确保深层递归（subworkflow/loop 体 runGraph）也能感知取消。
   */
  cancelToken: { cancelled: boolean }

  /**
   * run 期间 spawn 的 AI 子进程注册表（spawnKey → kill 函数）。
   * 与 ipc/cli.ts 的 `running` map 隔离，避免关窗误杀正在运行的 workflow AI 节点（KTD3）。
   * stop workflow 时遍历此 map kill 全部在途进程（U12 填充）。
   */
  aiProcesses: Map<string, { kill: () => void }>
}

/** 创建一个空白的 RunContext，用于 runWorkflowInternal 入口。 */
export function createRunContext(): RunContext {
  return {
    nodeOutputs: {},
    runVars: {},
    pendingApprovals: new Map(),
    cancelToken: { cancelled: false },
    aiProcesses: new Map(),
  }
}
