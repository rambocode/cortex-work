// 工作流 AI 节点的无头 prompt 执行器。
//
// 设计要点（对照 automation/runner.ts 的「黄金参考」）：
//   - 镜像 runner.ts 的 resolveProvider / writePiExtension / startAgentProcess / pipeStdoutLines 流程。
//   - 【独立进程注册表】：模块内 Map<spawnKey, AgentProcess>，spawnKey = per-spawn UUID，
//     绝不加入 cli.ts 的全局 `running` Map，避免 killAllCli/关窗 误杀正在运行的工作流 AI 节点（KTD3）。
//   - 30分钟超时（AI_NODE_RESPONSE_TIMEOUT_MS）；超时 kill 子进程并 reject。
//   - signal 传入时 abort → kill 子进程（RunContext.cancelToken 由调用方封装成 signal）。
//   - text 累加上限 200KB，超出截断（同 runner.ts 的 MAX_OUTPUT 策略）。
//   - 导出 killAllHeadlessPrompts() 供 killAllWorkflows/stopRun 调用。

import { randomUUID } from 'crypto'
import { homedir } from 'os'
import type { AgentProcess } from '../ipc/cli.js'
import {
  assertSpawnCwd,
  pipeStdoutLines,
  spawnEnvForDef,
  startAgentProcess,
} from '../ipc/cli.js'
import { getAgentDef, parseLineEvents } from '../agents/index.js'
import { CODEX_MCP_CLEAR } from '../ipc/mcp-config.js'
import { writePiExtension } from '../agents/pi-providers.js'
import { resolvePiProviderInput } from '../providers/pi-provider-input.js'
import { assertOneShotProviderSupported } from '../providers/custom-provider-runtime.js'
import { getWorkspaceRoot } from '../ipc/store.js'
import type { CliStartRequest, ReasoningEffort } from '../ipc/types.js'

// 30 分钟——AI 节点任务可能远比 oneshot(60s) 长，对齐 automation 的 10min 基础上再放宽
export const AI_NODE_RESPONSE_TIMEOUT_MS = 30 * 60_000

// 单次调用累积文本上限 200KB（防内存无限膨胀）
const MAX_OUTPUT = 200_000

// ── 独立进程注册表 ────────────────────────────────────────────────────────────
// key = 每次 spawn 生成的 UUID（spawnKey），value = AgentProcess。
// 此 Map 与 cli.ts 的 `running` Map 完全隔离：
//   - killAllCli（关窗时触发）不会误杀工作流 AI 子进程；
//   - killAllHeadlessPrompts（真正退出时 / stop-run 时）统一终止本 Map 所有进程。
const headlessProcs = new Map<string, AgentProcess>()

/**
 * 终止所有无头 prompt 子进程（退出时 / stop-run 时调用）。
 * 对齐 killAllAutomations 语义。
 */
export function killAllHeadlessPrompts(): void {
  for (const proc of headlessProcs.values()) {
    proc.kill()
  }
  headlessProcs.clear()
}

// ── Provider 解析 ───────────────────────────────────────────────────────────
// 阶段③ 收编：来源改为「Catalog + provider-prefs + 凭据金库」。旧实现读
// PersistedState.providerSettings —— §5 首启即删除该字段，继续读它会让工作流的每个 AI 节点
// 都解析不到 provider 而失败（后台执行，用户不在场）。与 automation/runner.ts 同源。
async function resolveProvider(providerId: string): Promise<CliStartRequest['provider'] | null> {
  // 自定义 Provider 本阶段只接了聊天 RPC 路径：命中即抛错（同 automation/runner.ts）。
  // 工作流 AI 节点同样是后台执行，静默换 provider 的代价比一次响亮失败大得多。
  await assertOneShotProviderSupported(providerId)
  return (await resolvePiProviderInput(providerId)) ?? null
}

// ── 对外接口 ──────────────────────────────────────────────────────────────────

export interface RunPromptHeadlessOptions {
  /** 要执行的 prompt 文本（已由调用方完成模板插值）。 */
  prompt: string
  /** 工作区根路径（AI 节点 cwd）。 */
  workspaceRoot: string
  /**
   * AI provider/agent id（如 'claude'、'codex'、'pi'、或派生 id）。
   * 对应 WorkflowAiAgentConfig.providerId 语义：内置 agent 直接命名；
   * pi 自定义供应商则 providerId 是持久化 providerSettings 中的 id。
   */
  providerId: string
  /** 模型 id（可选；空则由 adapter/provider 使用默认值）。 */
  model?: string
  /** agent 工作模式（claude 的 --mode flag；其余 agent 忽略）。 */
  mode?: 'agent' | 'plan'
  /**
   * 推理力度（claude/pi 的 reasoning effort；codex 忽略）。
   * 工作流 config 支持 auto/off/low/medium/high/max，
   * CliStartRequest.effort 只接受 low/medium/high，此处做映射：
   *   auto/off → undefined（让 adapter 用默认值）
   *   max → high（最接近的上限）
   */
  reasoningEffort?: 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max'
  /** 取消信号：abort 时 kill 子进程并 reject。 */
  signal?: AbortSignal
}

export interface RunPromptHeadlessResult {
  /** 聚合后的文本输出（最多 200KB）。 */
  text: string
  /** agent 会话 ID（init 事件携带；供 threadId 回溯）。 */
  agentSessionId?: string
}

/**
 * 无头启动一次 agent prompt 执行，等待完成后返回 { text, agentSessionId }。
 *
 * 镜像 runner.ts runAutomation 的核心流程，但：
 *   1. 同步返回 Promise（调用方 await，阻塞直到完成）。
 *   2. 使用独立进程注册表（headlessProcs），不进 cli.ts 的 running Map。
 *   3. 30分钟超时（更长，AI 节点可能执行复杂任务）。
 *   4. 支持 AbortSignal 取消。
 */
export async function runPromptHeadless(
  opts: RunPromptHeadlessOptions,
): Promise<RunPromptHeadlessResult> {
  const { prompt, workspaceRoot, providerId, model, mode, reasoningEffort, signal } = opts

  // signal 已触发时直接拒绝，避免无谓 spawn
  if (signal?.aborted) {
    throw new Error('runPromptHeadless: 调用前 signal 已取消')
  }

  // 确定实际 agent（pi 通过 providerId 在 providerSettings 中找，非 pi 则 providerId 就是 agent id）
  // 约定：如果 providerId 能在持久化 providers 列表中找到，则 agent='pi'；否则 agent=providerId
  let agent: string = providerId
  let provider: CliStartRequest['provider'] | undefined
  let piExtensionPath: string | undefined

  // 尝试从 providerSettings 解析（pi 自定义供应商路径）
  const resolved = await resolveProvider(providerId)
  if (resolved) {
    // providerId 是一个 pi 自定义供应商 id
    agent = 'pi'
    provider = resolved
    piExtensionPath = writePiExtension({
      id: resolved.id,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      models: resolved.models,
    })
  }
  // 否则 agent = providerId（内置 claude/codex/pi 或 M3-A 派生 id）

  const adapter = getAgentDef(agent)

  // 构造 CliStartRequest（复用 adapter.buildArgs，与 runner.ts 对齐）
  const spawnKey = randomUUID()
  // 映射 reasoningEffort：工作流扩展值 → CliStartRequest.effort（low/medium/high）
  const effortMap: Record<string, ReasoningEffort | undefined> = {
    auto: undefined,
    off: undefined,
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'high', // max 映射到最高支持级别
  }
  const effort: ReasoningEffort | undefined = reasoningEffort
    ? effortMap[reasoningEffort]
    : undefined

  const req: CliStartRequest = {
    runId: spawnKey,
    sessionId: spawnKey,
    agent,
    cwd: workspaceRoot,
    prompt,
    model: model ?? undefined,
    effort,
    provider,
    piExtensionPath,
  } as CliStartRequest

  // mode 字段：仅 claude adapter 消费（plan/agent 模式），其余 agent 的 buildArgs 忽略
  // CliStartRequest 类型声明中 mode 可能不存在，用扩展赋值兼容（先转 unknown 再转 Record）
  if (mode) {
    ;(req as unknown as Record<string, unknown>)['mode'] = mode
  }

  assertSpawnCwd(workspaceRoot)

  const { cmd, args, stdin } = adapter.buildArgs(req, CODEX_MCP_CLEAR)
  const proc = startAgentProcess(cmd, args, {
    cwd: workspaceRoot,
    env: spawnEnvForDef(req, adapter),
    stdin,
  })

  // 注册到独立进程表（不进 cli.ts 的 running Map）
  headlessProcs.set(spawnKey, proc)

  return new Promise<RunPromptHeadlessResult>((resolve, reject) => {
    let out = ''
    let resultText = ''
    let agentSessionId: string | undefined
    let failed: string | null = null
    let stderrTail = ''
    let settled = false

    // 30 分钟超时：超出后 kill 子进程并 reject
    const timer = setTimeout(() => {
      if (!settled) {
        proc.kill()
        // onExit 会触发 settle，在 settle 中判定 timedOut
        timedOut = true
      }
    }, AI_NODE_RESPONSE_TIMEOUT_MS)
    let timedOut = false

    // signal 取消：abort 事件 → kill 子进程
    const onAbort = () => {
      if (!settled) {
        proc.kill()
        // onExit 后走 settle reject
      }
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      headlessProcs.delete(spawnKey)
      fn()
    }

    const handleLine = (line: string) => {
      if (!line) return
      // 一行可携带多个事件（usage + result），逐个处理。
      // 只关心 init/text/result，其余忽略。
      for (const ev of parseLineEvents(adapter, line)) {
        if (ev.type === 'init') {
          agentSessionId = ev.sessionId
        } else if (ev.type === 'text') {
          // 上限 200KB 截断（防内存膨胀）
          if (out.length < MAX_OUTPUT) {
            out += ev.delta
          }
        } else if (ev.type === 'result') {
          if (!ev.ok) {
            failed = ev.error ?? '执行失败'
          } else if (ev.text) {
            resultText = ev.text
          }
        }
      }
    }

    // 行缓冲 stdout（复用 pipeStdoutLines）
    const flushStdout = pipeStdoutLines(proc.stdout, handleLine)

    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000)
    })

    proc.onError((err) => {
      settle(() => {
        reject(new Error(`runPromptHeadless: spawn 失败 — ${err.message}`))
      })
    })

    proc.onExit((code) => {
      // 冲刷无换行结尾的最后一行（pi 末行 message_end 在此）
      flushStdout()

      settle(() => {
        // signal 取消
        if (signal?.aborted) {
          reject(new Error('runPromptHeadless: 已取消（AbortSignal）'))
          return
        }
        // 超时
        if (timedOut) {
          reject(
            new Error(
              `runPromptHeadless: 超时（${Math.round(AI_NODE_RESPONSE_TIMEOUT_MS / 60000)} 分钟），已终止`,
            ),
          )
          return
        }
        // agent 报告失败
        if (failed) {
          reject(new Error(`runPromptHeadless: agent 执行失败 — ${failed}`))
          return
        }
        // 非零退出
        if (code !== 0 && code !== null) {
          const reason = stderrTail.trim() || `退出码 ${code}`
          reject(new Error(`runPromptHeadless: ${agent} 异常退出 — ${reason}`))
          return
        }
        // 正常结束：取 streaming text 与 result text 中较长的（对齐 runner.ts）
        const text = (out || resultText).trim()
        resolve({ text, agentSessionId })
      })
    })
  })
}

/**
 * 获取默认工作区路径（供 AI 节点 workspaceRoot 兜底链调用）。
 * 对齐 automation/runner.ts 的 cwd 解析链：节点 config → ctx.workspaceRoot → getWorkspaceRoot() → homedir()。
 * 此函数负责最后两级。
 */
export async function resolveDefaultWorkspaceRoot(): Promise<string> {
  return (await getWorkspaceRoot()) ?? homedir()
}
