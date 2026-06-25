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
import type { WorkflowNodeRunResult, WorkflowNodeRunStatus, WorkflowRun } from './types'
import {
  loadWorkflows,
  loadRuns,
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
import { killAllHeadlessPrompts } from './run-prompt-headless'
import { registerModule } from './node-executors/modules.js'

// ── 活跃 run 注册表 ────────────────────────────────────────────────────────────

/** 活跃 run 注册表：runId → { ctx, workflowId }。stop 时据此取消 + 级联拒绝 pending。 */
interface ActiveRun {
  workflowId: string
  ctx: ReturnType<typeof createRunContext>
}

const activeRuns = new Map<string, ActiveRun>()

/**
 * 遍历所有活跃 run，找到含指定 token 的 pendingApprovals，调用其 resolve(decision)。
 *
 * 返回 true = 找到并触发；false = token 不存在（已超时/已被 stop 级联 reject）。
 * IPC handler workflow:approval:resolve 调此函数，不再无条件 throw。
 */
export function resolveApproval(token: string, decision: 'approved' | 'rejected'): boolean {
  for (const { ctx } of activeRuns.values()) {
    const entry = ctx.pendingApprovals.get(token)
    if (entry) {
      // settle 函数内部会同时 clearTimeout + 从 Map 移除（flow-control.ts）
      entry.resolve(decision)
      return true
    }
  }
  return false
}

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
/**
 * runWorkflowInternal 返回类型：
 *   ok=true  → run 即初始 running 状态的 WorkflowRun（与 bridge.ts workflowRunNow 契约一致）。
 *   ok=false → null（工作流不存在等错误）。
 *
 * P1 AC-001：IPC 返回完整 WorkflowRun 对象，preload/hook 可直接 upsertRun 到缓存。
 */
async function runWorkflowInternal(
  workflowId: string,
  trigger: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; run: WorkflowRun | null }> {
  // 一次性快照：运行中用户编辑不影响在途 run（KTD2 open question 决定）。
  const allWorkflows = await loadWorkflows()
  const workflow = allWorkflows.find((w) => w.id === workflowId)
  if (!workflow) {
    return { ok: false, run: null }
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

  // P1 Fix-7：将 workflow.modules 注册到内存注册表，使 custom 节点执行时能 getModule。
  // 需在 runGraph 之前完成，否则 custom 节点在第一轮 executeNode 时 getModule 找不到模块。
  if (workflow.modules) {
    for (const mod of workflow.modules) {
      registerModule(mod)
    }
  }

  // P0 Fix-1：human-approval 进入 pending 时，广播 pending-approval 事件让 UI 拿到 token。
  const onPendingApproval = (info: {
    token: string; nodeId: string; nodeName: string; title: string; instruction: string
  }): void => {
    broadcastWorkflowRunEvent({
      workflowId,
      run: { ...run },
      phase: 'pending-approval',
      pendingApproval: info,
    })
  }

  const liveNodeResults = new Map<string, WorkflowNodeRunResult>()
  const onNodeStatus = (nodeId: string, status: WorkflowNodeRunStatus): void => {
    const previous = liveNodeResults.get(nodeId)
    const now = new Date().toISOString()
    liveNodeResults.set(nodeId, {
      nodeId,
      status,
      startedAt: previous?.startedAt || now,
      finishedAt: status === 'running' ? '' : now,
      message: previous?.message ?? '',
      outputJson: previous?.outputJson ?? '',
      inputJson: previous?.inputJson ?? '',
      retries: previous?.retries ?? 0,
      threadId: previous?.threadId ?? '',
      error: previous?.error ?? '',
    })
    broadcastWorkflowRunEvent({
      workflowId,
      run: { ...run, nodeResults: Array.from(liveNodeResults.values()) },
      phase: 'update',
    })
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
          onPendingApproval,
        },
        0,
        { onNodeStatus },
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

  // 返回初始 running run 对象（完整 WorkflowRun），preload/hook 可直接 upsertRun。
  return { ok: true, run: { ...run } }
}

/**
 * 强制收尾某个仍处于 running 的持久化 run（停止 / 孤儿恢复用）。
 * 仅在该 run 仍为 running 时落为 error，避免覆盖真实终态；广播 end 让 UI 立即清除「运行中」。
 */
async function forceFinalizeRunningRun(workflowId: string, runId: string): Promise<void> {
  const runs = await loadRuns(workflowId).catch(() => [] as WorkflowRun[])
  const target = runs.find((r) => r.id === runId)
  if (!target || target.status !== 'running') return
  const finishedAt = new Date().toISOString()
  const finalRun: Partial<WorkflowRun> = { status: 'error', finishedAt, message: '已手动停止' }
  await updateRun(workflowId, runId, finalRun).catch(() => {})
  await patchWorkflow(workflowId, {
    lastRunAt: finishedAt,
    lastStatus: 'error',
    lastMessage: '已手动停止',
  }).catch(() => {})
  broadcastWorkflowRunEvent({
    workflowId,
    run: { ...target, ...finalRun } as WorkflowRun,
    phase: 'end',
  })
  broadcastWorkflowChanged(await loadWorkflows().catch(() => []))
  activeRuns.delete(runId)
}

// ── 对外 API ──────────────────────────────────────────────────────────────────

export interface WorkflowRuntime {
  /**
   * 手动触发一次执行（workflow:runNow IPC → 此方法）。
   * fire-and-forget：立即返回初始 running run 完整对象，执行在后台进行。
   * P1 AC-001：返回 WorkflowRun|null 以统一 bridge.ts 的契约声明。
   */
  runNow: (
    workflowId: string,
    trigger: string,
    input: Record<string, unknown>,
  ) => Promise<{ ok: boolean; run: WorkflowRun | null }>

  /**
   * 停止正在运行的 run（workflow:stop IPC → 此方法）。
   *
   * 级联停止：
   *   1. cancelToken.cancelled = true（runGraph 每轮检查）。
   *   2. 遍历 pendingApprovals 级联拒绝（R11）。
   *   3. 遍历 aiProcesses kill 全部在途 AI 子进程（U12 填充后生效）。
   */
  stopRun: (runId: string, workflowId?: string) => Promise<void>

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
   * P2 Fix-14：result.runId 供 server.ts 加入结构化 data，让 agent 可追踪 run。
   */
  runForTool: (
    idOrName: string,
    input: Record<string, unknown>,
    workspaceOverride?: string,
  ) => Promise<{ ok: boolean; runId?: string; output?: WorkflowPayload; error?: string }>

  /**
   * 解析人工审批：找到 pendingApprovals 中含 token 的 run，调用其 resolve(decision)。
   * P0 Fix-1：IPC workflow:approval:resolve 调此方法，不再无条件 throw。
   *
   * @returns true = 找到并触发；false = token 不存在（已超时/已被 stop 级联拒绝）
   */
  resolveApproval: (token: string, decision: 'approved' | 'rejected') => boolean

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

    async stopRun(runId: string, workflowId?: string) {
      const active = activeRuns.get(runId)

      if (active) {
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
      }

      // 4. 强制收尾：把仍处于 running 的持久化 run 落为 error（"已手动停止"）。
      //    覆盖两类卡死：(a) 孤儿 run —— IIFE 已结束/进程重启致 run 不在 activeRuns，
      //    旧逻辑直接 return 使其永久 running；(b) runGraph 在节点 await 中真正挂起，
      //    cancelToken 无法打断、IIFE 不会收尾。两种情形下若不强制落盘，UI 的「停止」
      //    按钮永远清不掉。已是终态则不覆盖（避免改写真实结果）。
      const wfId = workflowId ?? active?.workflowId
      if (wfId) await forceFinalizeRunningRun(wfId, runId)
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
      // P1 Fix-7：注册 workflow.modules 到内存注册表，确保 custom 节点可用。
      if (workflow.modules) {
        for (const mod of workflow.modules) {
          registerModule(mod)
        }
      }

      // P2 Fix-14（agent 可用性）：含 human-approval 节点的工作流提前返回错误。
      // MCP 工具调用无法交互式解批，继续会导致 agent 调用永久挂起。
      if (workflow.nodes.some((n) => n.type === 'human-approval')) {
        // 已写入的 running run 标记为 error 并广播结束
        const finishedAt = new Date().toISOString()
        const errMsg = '该工作流含人工审批节点，暂不支持 AI 调用'
        await updateRun(workflow.id, run.id, { status: 'error', finishedAt, message: errMsg }).catch(() => {})
        broadcastWorkflowRunEvent({ workflowId: workflow.id, run: { ...run, status: 'error', finishedAt, message: errMsg } as WorkflowRun, phase: 'end' })
        activeRuns.delete(run.id)
        return { ok: false, error: errMsg }
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
          ? { ok: true, runId: run.id, output: result.output }
          : { ok: false, runId: run.id, error: result.errorMessage }
      } catch (err) {
        // P1 Fix-3: catch 内补全 error 状态落盘 + 广播，防止 run 永卡 running 状态。
        const finishedAt = new Date().toISOString()
        const errMsg = err instanceof Error ? err.message : String(err)
        const finalRun: Partial<WorkflowRun> = { status: 'error', finishedAt, message: errMsg }
        await updateRun(workflow.id, run.id, finalRun).catch(() => {})
        await patchWorkflow(workflow.id, { lastRunAt: finishedAt, lastStatus: 'error', lastMessage: errMsg }).catch(() => {})
        broadcastWorkflowRunEvent({ workflowId: workflow.id, run: { ...run, ...finalRun } as WorkflowRun, phase: 'end' })
        broadcastWorkflowChanged(await loadWorkflows().catch(() => []))
        activeRuns.delete(run.id)
        return { ok: false, runId: run.id, error: errMsg }
      }
    },

    resolveApproval,

    async sync(settings) {
      // 重新加载工作流列表，同步调度器 + webhook server。
      const workflows = await loadWorkflows()
      // 调度器：根据 enabled + schedule-trigger 的工作流重建 croner jobs。
      await rescheduleWorkflows(workflows, runWorkflowInternal)
      // Webhook server：服务 webhook-trigger（POST /webhook/...）与本地 API（POST /workflow/run，
      // 触发 manual-trigger）。只要有 enabled 工作流含 webhook 或 manual 触发就启动；
      // 「已启用」开关统一管控所有外部触发，与 matchWebhook/handleWorkflowRun 的 enabled 门控一致。
      const hasServerTrigger = workflows.some(
        (w) =>
          w.enabled &&
          w.nodes.some((n) => n.type === 'webhook-trigger' || n.type === 'manual-trigger'),
      )
      if (hasServerTrigger) {
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
  // 终止所有 AI 节点无头子进程（与 killAllCli 隔离的独立进程注册表，KTD3）。
  killAllHeadlessPrompts()
}
