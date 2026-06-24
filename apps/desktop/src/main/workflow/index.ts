/**
 * 工作流运行时入口：createWorkflowRuntime + sync。
 *
 * 设计要点：
 * - runWorkflowInternal：fire-and-forget 执行引擎。
 *   进入后立即返回 { ok, runId, status:'running' }，执行在后台进行。
 *   理由：UI 不应等待最长 30min 的 run 完成，改为事件推送最终结果。
 * - allWorkflows 快照：run 入口一次性 await loadWorkflows() 建快照。
 *   语义：运行中用户编辑工作流不影响在途 run（KTD2 Open Questions 决定）。
 * - activeRuns：Map<runId, { ctx, workflowId }>，供 stop 遍历。
 * - sync：根据 settings 启停 scheduler + webhook server（settings 变更时由 main 重调）。
 */

import { getWorkspaceRoot } from '../ipc/store'
import { homedir } from 'os'
import type { WorkflowRun } from './types'
import {
  loadWorkflows,
  newRunId,
  appendRun,
  updateRun,
  patchWorkflow,
} from './store'
import { broadcastWorkflowChanged, broadcastWorkflowRunEvent } from './events'
import { runGraph } from './runtime/graph-executor'
import { createRunContext } from './runtime/run-context'
import type { WorkflowPayload } from './runtime/interp'
import { stopWorkflowScheduler, rescheduleWorkflows } from './scheduler'
import { startWebhookServer, stopWebhookServer } from './webhook-server'

// ── 活跃 run 注册表 ────────────────────────────────────────────────────────────

/** 活跃 run 注册表：runId → { ctx, workflowId }。stop 时据此取消 + 级联拒绝 pending。 */
interface ActiveRun {
  workflowId: string
  ctx: ReturnType<typeof createRunContext>
}

const activeRuns = new Map<string, ActiveRun>()

// ── 内部工具 ──────────────────────────────────────────────────────────────────

/** 构造 WorkflowRun 初始记录（running 状态）。 */
function makeRun(trigger: string): WorkflowRun {
  const now = new Date().toISOString()
  return {
    id: newRunId(),
    trigger,
    status: 'running',
    startedAt: now,
    finishedAt: '',
    message: '',
    nodeResults: [],
  }
}

// ── 核心引擎 ──────────────────────────────────────────────────────────────────

/**
 * 执行一个工作流（fire-and-forget 异步）。
 *
 * 调用方获得初始 run 记录后立即返回；后台执行完成后：
 *   1. 以 success/error 更新 run 落盘。
 *   2. 更新 workflow.lastRunAt/lastStatus。
 *   3. 广播 broadcastWorkflowRunEvent(end) + broadcastWorkflowChanged。
 *
 * @param workflowId 工作流 ID
 * @param trigger    触发来源（'manual' | 'schedule' | 'webhook'）
 * @param input      触发器初始 payload（manual 手动输入 / webhook body）
 */
async function runWorkflowInternal(
  workflowId: string,
  trigger: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; runId: string; status: 'running' | 'error' }> {
  // 一次性快照：运行中用户编辑不影响在途 run（KTD2 open question 决定）。
  const allWorkflows = await loadWorkflows()
  const workflow = allWorkflows.find((w) => w.id === workflowId)
  if (!workflow) {
    return { ok: false, runId: '', status: 'error' }
  }

  const run = makeRun(trigger)

  // 立即落盘 running 状态 + 广播 start 事件，让 UI 即时看到「运行中」。
  await appendRun(workflowId, run)
  broadcastWorkflowRunEvent({ workflowId, run: { ...run }, phase: 'start' })

  // 构造 RunContext（cancelToken、pendingApprovals、nodeOutputs 等）。
  const ctx = createRunContext()
  activeRuns.set(run.id, { workflowId, ctx })

  // 工作区根目录：取触发器 config.workspaceRoot，缺省全局设置，再退 homedir。
  const triggerNode = workflow.nodes.find(
    (n) => n.type === 'manual-trigger' || n.type === 'schedule-trigger' || n.type === 'webhook-trigger',
  )
  const triggerWorkspace =
    triggerNode && typeof (triggerNode.config as { workspaceRoot?: unknown }).workspaceRoot === 'string'
      ? (triggerNode.config as { workspaceRoot: string }).workspaceRoot
      : ''
  const workspaceRoot = triggerWorkspace || (await getWorkspaceRoot()) || homedir()

  // 初始 payload。
  const initialPayload: WorkflowPayload = {
    json: Object.keys(input).length > 0 ? input : null,
    text: '',
  }

  // fire-and-forget：后台执行引擎，不 await。
  void (async () => {
    try {
      const result = await runGraph(
        workflow,
        initialPayload,
        ctx,
        allWorkflows,
        {
          workspaceRoot,
          // runGraph（loop/subworkflow）需要 runGraph 函数引用以避免循环 import。
          runGraph: runGraph as Parameters<typeof runGraph>[4]['runGraph'],
          depth: 0,
        },
        0,
      )

      const finishedAt = new Date().toISOString()
      const finalRun: Partial<WorkflowRun> = {
        status: result.status === 'success' ? 'success' : 'error',
        finishedAt,
        message: result.status === 'error' ? result.errorMessage : '',
        nodeResults: result.nodeResults,
      }

      // 落盘最终状态。
      await updateRun(workflowId, run.id, finalRun)

      // 更新 workflow 的 lastRunAt/lastStatus。
      await patchWorkflow(workflowId, {
        lastRunAt: finishedAt,
        lastStatus: finalRun.status,
        lastMessage: finalRun.message,
      })

      // 广播 end 事件 + changed。
      broadcastWorkflowRunEvent({
        workflowId,
        run: { ...run, ...finalRun } as WorkflowRun,
        phase: 'end',
      })
      broadcastWorkflowChanged(await loadWorkflows())
    } catch (err) {
      const finishedAt = new Date().toISOString()
      const errMsg = err instanceof Error ? err.message : String(err)
      const finalRun: Partial<WorkflowRun> = {
        status: 'error',
        finishedAt,
        message: errMsg,
      }
      await updateRun(workflowId, run.id, finalRun)
      await patchWorkflow(workflowId, {
        lastRunAt: finishedAt,
        lastStatus: 'error',
        lastMessage: errMsg,
      })
      broadcastWorkflowRunEvent({
        workflowId,
        run: { ...run, ...finalRun } as WorkflowRun,
        phase: 'end',
      })
      broadcastWorkflowChanged(await loadWorkflows())
      console.error(`[workflow] run ${run.id} 异常退出:`, err)
    } finally {
      // 清理活跃 run 注册表。
      activeRuns.delete(run.id)
    }
  })()

  return { ok: true, runId: run.id, status: 'running' }
}

// ── 对外 API ──────────────────────────────────────────────────────────────────

export interface WorkflowRuntime {
  /**
   * 手动触发一次执行（workflow:runNow IPC → 此方法）。
   * fire-and-forget：立即返回初始 running run，执行在后台进行。
   */
  runNow: (
    workflowId: string,
    trigger: string,
    input: Record<string, unknown>,
  ) => Promise<{ ok: boolean; runId: string; status: 'running' | 'error' }>

  /**
   * 停止正在运行的 run（workflow:stop IPC → 此方法）。
   *
   * 级联停止：
   *   1. cancelToken.cancelled = true（runGraph 每轮检查）。
   *   2. 遍历 pendingApprovals 级联拒绝（R11）。
   *   3. 遍历 aiProcesses kill 全部在途 AI 子进程（U12 填充后生效）。
   */
  stopRun: (runId: string) => void

  /**
   * 单节点执行（workflow:node:run / node:test IPC → 此方法）。
   * 用于画布「运行节点」按钮；返回单个节点的 output payload。
   */
  runSingleNode: (
    workflowId: string,
    nodeId: string,
    inputPayload: WorkflowPayload,
  ) => Promise<{ ok: boolean; output?: WorkflowPayload; error?: string }>

  /**
   * MCP 工具层调用（U14 run_workflow）：同步等待完成后返回结果。
   * 与 runNow 不同，此方法 await 整个执行完成再返回（供 MCP tool 同步响应）。
   */
  runForTool: (
    idOrName: string,
    input: Record<string, unknown>,
    workspaceOverride?: string,
  ) => Promise<{ ok: boolean; output?: WorkflowPayload; error?: string }>

  /**
   * 同步调度器与 webhook server（settings 变更时重调）。
   * 根据当前 workflows 的 enabled+schedule 状态启停 croner jobs 和 webhook server。
   */
  sync: (settings?: { webhookPort?: number }) => Promise<void>
}

/**
 * 创建工作流运行时实例。
 *
 * main/index.ts 在 app.whenReady 后调用一次，得到全局单例；
 * 通过 ipc.ts 的 handler 注入（setter 模式，避免循环 import）。
 */
export function createWorkflowRuntime(): WorkflowRuntime {
  return {
    runNow: runWorkflowInternal,

    stopRun(runId: string) {
      const active = activeRuns.get(runId)
      if (!active) return
      const { ctx } = active

      // 1. 置取消标志，runGraph 会在下一轮循环提前退出。
      ctx.cancelToken.cancelled = true

      // 2. 级联拒绝所有挂起的 human-approval 节点（R11）。
      for (const [, approval] of ctx.pendingApprovals) {
        approval.resolve('rejected')
      }
      ctx.pendingApprovals.clear()

      // 3. kill 所有在途 AI 子进程（U12 填充后生效；U9 阶段为空 Map）。
      for (const [, proc] of ctx.aiProcesses) {
        proc.kill()
      }
      ctx.aiProcesses.clear()
    },

    async runSingleNode(workflowId, nodeId, inputPayload) {
      const allWorkflows = await loadWorkflows()
      const workflow = allWorkflows.find((w) => w.id === workflowId)
      if (!workflow) return { ok: false, error: `工作流 ${workflowId} 不存在` }
      const node = workflow.nodes.find((n) => n.id === nodeId)
      if (!node) return { ok: false, error: `节点 ${nodeId} 不存在` }

      try {
        const ctx = createRunContext()
        const { executeNode } = await import('./node-executors/index.js')
        const { resolveEnvVars } = await import('./runtime/interp.js')
        const env = resolveEnvVars(workflow.env)
        const scope = {
          nodes: ctx.nodeOutputs,
          env,
          run: ctx.runVars,
        }
        const outcome = await executeNode(node, ctx, inputPayload, scope, {
          noRunRef: true, // 单节点测试模式：human-approval 自动 approved
        })
        return { ok: true, output: outcome.payload }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    async runForTool(idOrName, input, _workspaceOverride) {
      // U14 占位：MCP 层调用，同步等待 run 完成。
      // workspace 取自 per-session cwd（由 MCP host 注入），不接受 workspaceOverride 参数
      // 以消除任意路径注入风险（Open Questions 安全节，已由 U14 范式消除）。
      const allWorkflows = await loadWorkflows()
      const workflow = allWorkflows.find(
        (w) => w.id === idOrName || w.name.toLowerCase() === idOrName.toLowerCase(),
      )
      if (!workflow) return { ok: false, error: `工作流 "${idOrName}" 不存在` }
      if (!workflow.callableByAgent) return { ok: false, error: '该工作流不允许 AI 调用' }

      // 与 runNow 类似，但等待完成。
      const run = makeRun('mcp')
      await appendRun(workflow.id, run)
      broadcastWorkflowRunEvent({ workflowId: workflow.id, run: { ...run }, phase: 'start' })
      const ctx = createRunContext()
      activeRuns.set(run.id, { workflowId: workflow.id, ctx })
      const initialPayload: WorkflowPayload = {
        json: Object.keys(input).length > 0 ? input : null,
        text: '',
      }
      try {
        const result = await runGraph(
          workflow,
          initialPayload,
          ctx,
          allWorkflows,
          {
            workspaceRoot: _workspaceOverride || (await getWorkspaceRoot()) || homedir(),
            runGraph: runGraph as Parameters<typeof runGraph>[4]['runGraph'],
            depth: 0,
          },
          0,
        )
        const finishedAt = new Date().toISOString()
        const status = result.status === 'success' ? 'success' : 'error'
        const finalRun: Partial<WorkflowRun> = { status, finishedAt, nodeResults: result.nodeResults }
        await updateRun(workflow.id, run.id, finalRun)
        await patchWorkflow(workflow.id, { lastRunAt: finishedAt, lastStatus: status })
        broadcastWorkflowRunEvent({ workflowId: workflow.id, run: { ...run, ...finalRun } as WorkflowRun, phase: 'end' })
        broadcastWorkflowChanged(await loadWorkflows())
        activeRuns.delete(run.id)
        return result.status === 'success'
          ? { ok: true, output: result.output }
          : { ok: false, error: result.errorMessage }
      } catch (err) {
        activeRuns.delete(run.id)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    async sync(settings) {
      // 重新加载工作流列表，同步调度器 + webhook server。
      const workflows = await loadWorkflows()
      // 调度器：根据 enabled + schedule-trigger 的工作流重建 croner jobs。
      await rescheduleWorkflows(workflows, runWorkflowInternal)
      // Webhook server：根据含 enabled webhook-trigger 的工作流启停。
      const hasWebhook = workflows.some(
        (w) => w.enabled && w.nodes.some((n) => n.type === 'webhook-trigger'),
      )
      if (hasWebhook) {
        await startWebhookServer(settings?.webhookPort ?? 18765, runWorkflowInternal)
      } else {
        stopWebhookServer()
      }
    },
  }
}

// ── 全局单例（main/index.ts 持有，由 ipc.ts 读取）────────────────────────────────

/** 全局运行时实例（main 进程单例）。ipc.ts 通过 getWorkflowRuntime 获取。 */
let _runtime: WorkflowRuntime | null = null

export function getWorkflowRuntime(): WorkflowRuntime {
  if (!_runtime) throw new Error('工作流运行时尚未初始化，请先调用 initWorkflowRuntime()')
  return _runtime
}

export function initWorkflowRuntime(): WorkflowRuntime {
  _runtime = createWorkflowRuntime()
  return _runtime
}

/**
 * killAllWorkflows：真正退出时调用（main/index.ts onRealQuit + ipc/register.ts 导出）。
 *
 * 停止所有活跃 run + 调度器 + webhook server。
 */
export function killAllWorkflows(): void {
  // 取消所有活跃 run。
  for (const [runId] of activeRuns) {
    _runtime?.stopRun(runId)
  }
  activeRuns.clear()
  // 停止调度器。
  stopWorkflowScheduler()
  // 停止 webhook server。
  stopWebhookServer()
}
