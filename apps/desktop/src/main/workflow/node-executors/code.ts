/**
 * 代码/自定义节点执行器（U11）。
 *
 * ⚠️ 安全声明（必读）：
 *   node:vm.runInNewContext 不是安全沙箱。
 *   它与主进程共享同一个 V8 堆，攻击者可通过原型链逃逸访问 process、
 *   require、env 中的 API key，以及 spawn 任意子进程。
 *   code / custom 节点以主进程完整权限运行，唯一限制是 timeout（CPU 时间）。
 *   这是已知限制，对齐 Kun 设计（用户本机信任边界，参见计划 Open Questions 安全小节）。
 *   如需真正隔离，应改用 utilityProcess.fork 或 worker_threads（首版不做）。
 *
 * 实现：
 *   code 节点（JS / Python / Bash）：
 *     - JavaScript → node:vm runInNewContext（2s 超时，沙箱 $json/$text）
 *     - Python / Bash → child_process.spawn（30s 超时，stdin 传 {json,text}，
 *       env 注入 WORKFLOW_JSON / WORKFLOW_TEXT / WORKFLOW_FIELDS）
 *
 *   custom 节点：
 *     - 在 code 基础上额外注入 $fields（从 module 字段声明 coerce 后的值）
 *     - JS 沙箱额外有 $fields；python/bash 额外有 env WORKFLOW_FIELDS
 *
 * ⚠️ 子进程环境变量安全（重要）：
 *   spawn 时 env 必须 **仅传** { WORKFLOW_JSON, WORKFLOW_TEXT, WORKFLOW_FIELDS, PATH }，
 *   绝对不能使用 { ...process.env, ... }，否则会把 ANTHROPIC_API_KEY、数据库凭证等
 *   主进程密钥泄漏给用户的任意脚本。PATH 从 process.env.PATH 取，用于 python3/bash 寻路。
 */

import { runInNewContext } from 'node:vm'
import { spawn } from 'node:child_process'
import type { WorkflowCodeConfig, WorkflowCustomConfig } from '../types.js'
import type { WorkflowPayload } from '../runtime/interp.js'
import { getModule, coerceModuleFields } from './modules.js'
import type { NodeOutcome } from './index.js'

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** JS vm 沙箱超时（毫秒），与 Kun CODE_TIMEOUT_MS 对齐。 */
const CODE_TIMEOUT_MS = 2_000

/**
 * python / bash 子进程超时（毫秒），比 JS 沙箱宽松，允许网络/文件操作。
 * 与 Kun COMMAND_TIMEOUT_MS 对齐。
 */
const COMMAND_TIMEOUT_MS = 30_000

/**
 * Python 解释器二进制路径。
 * 优先从 WORKFLOW_PYTHON_BIN 环境变量读取（CI / 自定义路径），否则用 python3。
 */
const PYTHON_BIN = process.env.WORKFLOW_PYTHON_BIN?.trim() || 'python3'

// ── 内部辅助函数 ──────────────────────────────────────────────────────────────

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
 * 把 JS vm 返回值转换为 NodeOutcome。
 * 对齐 Kun runCodeNode：
 *   undefined/null → { json: {}, text: '' }
 *   string         → { json: { value: out }, text: out }
 *   object         → { json: out, text: safeJson(out) }
 *   其他原始值      → { json: { value: out }, text: String(out) }
 */
function vmResultToOutcome(out: unknown): NodeOutcome {
  if (out === undefined || out === null) {
    return { payload: { json: {}, text: '' }, message: 'ok' }
  }
  if (typeof out === 'string') {
    return { payload: { json: { value: out }, text: out }, message: 'ok' }
  }
  if (typeof out === 'object') {
    return { payload: { json: out, text: safeJson(out) }, message: 'ok' }
  }
  // number, boolean 等
  const json = { value: out }
  return { payload: { json, text: safeJson(json) }, message: 'ok' }
}

/**
 * 解析子进程 stdout 为 NodeOutcome。
 * 对齐 Kun runCommandNode：
 *   stdout 为合法 JSON object/array → 以解析结果为 json
 *   其他 → { text: stdout }
 */
function commandOutputToOutcome(stdout: string): NodeOutcome {
  const out = stdout.trim()
  let parsed: unknown
  try {
    parsed = out ? JSON.parse(out) : undefined
  } catch {
    parsed = undefined
  }

  if (parsed !== null && typeof parsed === 'object') {
    return { payload: { json: parsed, text: out }, message: 'ok' }
  }
  return { payload: { json: out ? { text: out } : {}, text: out }, message: 'ok' }
}

/**
 * 执行 Python / Bash 子进程。
 *
 * ⚠️ 环境变量安全隔离（关键）：
 *   子进程 env 只包含 { WORKFLOW_JSON, WORKFLOW_TEXT, WORKFLOW_FIELDS, PATH }。
 *   不使用 { ...process.env } 展开，避免把 ANTHROPIC_API_KEY 等主进程密钥
 *   透传给用户提供的任意脚本（参见文件顶部安全声明）。
 *
 * stdin 格式：JSON { json, text }（脚本可通过 json.loads(sys.stdin.read()) 读取）
 */
function runCommandNode(
  language: 'python' | 'bash',
  code: string,
  payload: WorkflowPayload,
  fields: Record<string, unknown> = {}
): Promise<NodeOutcome> {
  const bin = language === 'python' ? PYTHON_BIN : 'bash'

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-c', code], {
      env: {
        // ⚠️ 仅传必要变量，严禁 ...process.env（防止 ANTHROPIC_API_KEY 等泄漏给用户脚本）
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        WORKFLOW_TEXT: payload.text ?? '',
        WORKFLOW_JSON: safeJson(payload.json),
        WORKFLOW_FIELDS: safeJson(fields),
      },
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (run: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      run()
    }

    // 超时：SIGKILL 子进程
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() =>
        reject(new Error(`${language} script timed out after ${COMMAND_TIMEOUT_MS}ms`))
      )
    }, COMMAND_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += String(chunk)
    })

    child.on('error', (error: NodeJS.ErrnoException) => {
      const reason =
        error.code === 'ENOENT'
          ? `${bin} was not found on this machine`
          : error.message
      finish(() => reject(new Error(`${language} error: ${reason}`)))
    })

    child.on('close', (exitCode: number | null) => {
      finish(() => {
        if (exitCode !== 0) {
          reject(
            new Error(
              `${language} exited with code ${exitCode}: ${(stderr || stdout).trim().slice(0, 500)}`
            )
          )
          return
        }
        resolve(commandOutputToOutcome(stdout))
      })
    })

    // 脚本不读 stdin 时写 stdin 会产生 EPIPE，忽略
    child.stdin.on('error', () => {})
    child.stdin.write(JSON.stringify({ json: payload.json, text: payload.text }))
    child.stdin.end()
  })
}

// ── 公开执行器 ────────────────────────────────────────────────────────────────

/**
 * code 节点执行器。
 *
 * JS：node:vm runInNewContext，注入 $json / $text（$fields={}）
 *   - 函数体用 return 返回输出值
 *   - 超时 2s（CODE_TIMEOUT_MS），超时错误包装为 "Code error: ..."
 *
 * Python / Bash：child_process.spawn，30s 超时
 *   - stdin 传 { json, text }
 *   - env 注入 WORKFLOW_JSON / WORKFLOW_TEXT / WORKFLOW_FIELDS（{}）
 *   - stdout 解析为输出
 */
export async function executeCode(
  config: WorkflowCodeConfig,
  payload: WorkflowPayload
): Promise<NodeOutcome> {
  if (config.language === 'javascript') {
    const sandbox: Record<string, unknown> = {
      $json: payload.json,
      $text: payload.text,
      $fields: {},
      __result: undefined,
    }

    try {
      runInNewContext(`__result = (function(){\n${config.code}\n})()`, sandbox, {
        timeout: CODE_TIMEOUT_MS,
        displayErrors: true,
      })
    } catch (error) {
      throw new Error(
        `Code error: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    return vmResultToOutcome(sandbox.__result)
  }

  // python / bash
  return runCommandNode(config.language, config.code, payload, {})
}

/**
 * custom 节点执行器。
 *
 * 与 code 节点相同，额外注入 $fields（来自 module 字段声明，经 coerceModuleFields 强制类型转换）。
 *
 * 模块 ID 从 config.moduleId 读取，经 getModule() 查找；未找到时抛 Error。
 * 字段值经 coerceModuleFields 按声明类型（text/number/boolean/select）强制转换，
 * 再注入为 JS 沙箱 $fields 或 env WORKFLOW_FIELDS。
 */
export async function executeCustom(
  config: WorkflowCustomConfig,
  payload: WorkflowPayload
): Promise<NodeOutcome> {
  // 查找自定义模块（U15 ModuleManager 完善前用 getModule stub）
  const module = getModule(config.moduleId)
  if (!module) {
    throw new Error(`自定义模块未找到（moduleId=${config.moduleId}）。`)
  }

  // 按模块字段声明 coerce values
  const fields = coerceModuleFields(module, config.values)

  if (module.language === 'javascript') {
    const sandbox: Record<string, unknown> = {
      $json: payload.json,
      $text: payload.text,
      $fields: fields,
      __result: undefined,
    }

    try {
      runInNewContext(`__result = (function(){\n${module.code}\n})()`, sandbox, {
        timeout: CODE_TIMEOUT_MS,
        displayErrors: true,
      })
    } catch (error) {
      throw new Error(
        `Code error: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    return vmResultToOutcome(sandbox.__result)
  }

  // python / bash：$fields 通过 WORKFLOW_FIELDS env 注入
  return runCommandNode(module.language, module.code, payload, fields)
}

// 导出辅助函数供测试使用
export { runCommandNode }
