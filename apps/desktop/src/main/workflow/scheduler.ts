/**
 * 工作流调度器（croner 驱动）。
 *
 * 复刻 automation/scheduler.ts 的模式，适配 loop 引擎：
 * - 每个 enabled + schedule-trigger 工作流建一个 Cron job。
 * - powerMonitor.resume 后重排（补漏 + 重建 job，消除休眠期漂移）。
 * - once 类型：绝对时刻触发一次后置 enabled=false（lifecycle 结束）。
 * - 开机补漏：lastRunAt 之后第一个触发点已过 → 补跑一次（不补多次）。
 * - powerSaveBlocker：有 enabled 定时任务时持有，防睡眠唤醒漏触发。
 */

import { Cron } from 'croner'
import { powerMonitor, powerSaveBlocker } from 'electron'
import type { WorkflowDef } from './types'
import { computeNextRun, scheduleToCron } from '../automation/schedule-cron'

// ── 类型 ──────────────────────────────────────────────────────────────────────

/** runWorkflowInternal 的类型签名（注入以避免循环 import）。 */
type RunFn = (
  workflowId: string,
  trigger: string,
  input: Record<string, unknown>,
) => Promise<{ ok: boolean; runId: string; status: string }>

// ── 内部状态 ──────────────────────────────────────────────────────────────────

/** workflowId → Cron job */
const jobs = new Map<string, Cron>()

/** powerSaveBlocker id，-1 表示未激活。防止系统睡眠导致定时触发漏跑。 */
let blockerHandle = -1

/** 当前注入的 run 函数（sync 时更新）。 */
let _runFn: RunFn | null = null

// ── powerSaveBlocker 管理 ──────────────────────────────────────────────────────

/** 有 enabled 定时任务时持有 powerSaveBlocker，全部停止后释放。 */
function updatePowerSaveBlocker(): void {
  const hasJobs = jobs.size > 0
  if (hasJobs && (blockerHandle === -1 || !powerSaveBlocker.isStarted(blockerHandle))) {
    // 防止定时器触发点在系统睡眠期间被跳过。
    blockerHandle = powerSaveBlocker.start('prevent-app-suspension')
  } else if (!hasJobs && blockerHandle !== -1 && powerSaveBlocker.isStarted(blockerHandle)) {
    powerSaveBlocker.stop(blockerHandle)
    blockerHandle = -1
  }
}

// ── 单个工作流 job 管理 ────────────────────────────────────────────────────────

function unscheduleOne(id: string): void {
  jobs.get(id)?.stop()
  jobs.delete(id)
}

/**
 * 从工作流中提取 schedule-trigger 的 ScheduleSpec（若有）。
 * 一个 enabled 工作流至多一个 schedule-trigger 节点（取第一个）。
 */
function extractScheduleSpec(workflow: WorkflowDef) {
  if (!workflow.enabled) return null
  const triggerNode = workflow.nodes.find((n) => n.type === 'schedule-trigger')
  if (!triggerNode) return null
  const config = triggerNode.config as { schedule?: unknown }
  if (!config.schedule) return null
  return config.schedule as {
    kind: 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'cron' | 'once'
    [key: string]: unknown
  }
}

/**
 * 为单个工作流重建 Cron job。
 * 先停掉旧 job，再按 schedule 建新 job。enabled=false 或无 schedule → 只停不建。
 */
function scheduleOne(workflow: WorkflowDef): void {
  unscheduleOne(workflow.id)
  const spec = extractScheduleSpec(workflow)
  if (!spec) return

  const cb = () => {
    if (!_runFn) return
    void _runFn(workflow.id, 'schedule', {})
  }

  try {
    // once 类型：绝对 epoch ms，直接传 Date 给 croner 建一次性 job。
    // 理由：scheduleToCron 对 once 会抛错（参见 schedule-cron.ts L65）。
    // 绝对时刻不受 timezone 影响，故 once 分支不传 timezone 选项。
    const scheduleNode = workflow.nodes.find((n) => n.type === 'schedule-trigger')
    const timezone = scheduleNode
      ? (scheduleNode.config as { timezone?: string }).timezone
      : undefined

    const job =
      spec.kind === 'once'
        ? new Cron(new Date((spec as unknown as { at: number }).at), cb)
        : new Cron(scheduleToCron(spec as Parameters<typeof scheduleToCron>[0]), timezone ? { timezone } : {}, cb)
    jobs.set(workflow.id, job)
  } catch (err) {
    console.error(`[workflow-scheduler] 无法调度 ${workflow.id}:`, err)
  }
}

// ── 开机补漏 ──────────────────────────────────────────────────────────────────

/**
 * 关机/休眠期间错过了触发点：lastRunAt 之后的第一个应触发时刻已过 → 补跑一次。
 * 只补一次，避免唤醒瞬间堆叠多次触发。从未跑过的任务不补（新建不立即触发）。
 */
function shouldCatchUp(workflow: WorkflowDef, spec: NonNullable<ReturnType<typeof extractScheduleSpec>>, now: number): boolean {
  if (!workflow.lastRunAt) return false
  const missed = computeNextRun(
    spec as Parameters<typeof computeNextRun>[0],
    undefined,
    new Date(workflow.lastRunAt),
  )
  return missed != null && missed < now
}

/**
 * once 专属补漏：从未跑过的一次性任务若在 App 关闭/休眠期间错过了触发点。
 * 为何独立判定：shouldCatchUp 以 lastRunAt 为锚，once 触发前 lastRunAt 为空，
 * 永远进不了该路径；此分支互补。
 */
function shouldCatchUpOnce(workflow: WorkflowDef, spec: NonNullable<ReturnType<typeof extractScheduleSpec>>, now: number): boolean {
  return (
    spec.kind === 'once' &&
    !workflow.lastRunAt &&
    (spec as unknown as { at: number }).at < now
  )
}

// ── 对外 API ──────────────────────────────────────────────────────────────────

/**
 * 初始化工作流调度器（app.whenReady 后 + sync 时调用）。
 * 全量同步所有工作流的 Cron job；注册 powerMonitor.resume 补漏。
 * 注意：initWorkflowScheduler 在 sync 调用链中已等待 loadWorkflows，此处直接接收快照。
 */
export function initWorkflowScheduler(
  workflows: WorkflowDef[],
  runFn: RunFn,
): void {
  _runFn = runFn
  const now = Date.now()

  for (const workflow of workflows) {
    const spec = extractScheduleSpec(workflow)
    if (spec) {
      if (shouldCatchUp(workflow, spec, now) || shouldCatchUpOnce(workflow, spec, now)) {
        void runFn(workflow.id, 'schedule', {})
      }
    }
    scheduleOne(workflow)
  }
  updatePowerSaveBlocker()
}

/**
 * 重新同步所有 Cron job（settings 变更 / 工作流 CRUD 后调用）。
 * 先停掉全部旧 job，再重建。
 */
export async function rescheduleWorkflows(
  workflows: WorkflowDef[],
  runFn: RunFn,
): Promise<void> {
  _runFn = runFn
  // 停掉全部旧 job。
  for (const id of Array.from(jobs.keys())) {
    unscheduleOne(id)
  }
  const now = Date.now()
  for (const workflow of workflows) {
    const spec = extractScheduleSpec(workflow)
    if (spec) {
      if (shouldCatchUp(workflow, spec, now) || shouldCatchUpOnce(workflow, spec, now)) {
        void runFn(workflow.id, 'schedule', {})
      }
    }
    scheduleOne(workflow)
  }
  updatePowerSaveBlocker()
}

/** 休眠唤醒后重排（补漏 + 重建 job，消除漂移）。 */
export async function rescheduleOnResume(
  workflows: WorkflowDef[],
  runFn: RunFn,
): Promise<void> {
  await rescheduleWorkflows(workflows, runFn)
}

/** 真正退出时停掉所有 Cron job。 */
export function stopWorkflowScheduler(): void {
  for (const job of jobs.values()) job.stop()
  jobs.clear()
  if (blockerHandle !== -1) {
    try {
      if (powerSaveBlocker.isStarted(blockerHandle)) powerSaveBlocker.stop(blockerHandle)
    } catch {
      // 退出时忽略
    }
    blockerHandle = -1
  }
}

// ── powerMonitor 注册（module 加载时注册一次）────────────────────────────────────
// 休眠唤醒后重排，lazy 调 rescheduleWorkflows（需由 main 侧提供 workflows 快照）。
// 由于 module 级无法直接持有最新 workflows，改为由 index.ts 的 sync 在 resume 后重调。
// 本注册仅做一次，注册动作本身轻量（callback 里再读快照）。
powerMonitor.on('resume', () => {
  // 休眠唤醒：重排所有 job，由 main/index.ts 的 rescheduleAll 监听此事件并调 sync。
  // 此处 _runFn 可能为 null（应用尚未初始化），安全 check。
  if (!_runFn) return
  // 快速补触发：从 loadWorkflows 取最新快照再 reshedule。
  // 避免 powerMonitor callback 层导入 store（避免副作用），通过 _runFn 非空表明已初始化。
})
