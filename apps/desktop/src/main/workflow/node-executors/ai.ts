/**
 * AI 节点执行器（U12）。
 *
 * 实现三种 AI 节点：
 *   ai-agent           — 通用 AI 代理（执行 prompt，输出 text）
 *   parameter-extractor — 结构化参数提取（强制 JSON schema 输出）
 *   question-classifier — 问题分类（从 categories 中选出最匹配的 category.id）
 *
 * 三种节点共用 runPromptHeadless（CLI spawn 适配，KTD3）：
 *   1. interpolate 展开 prompt 模板变量
 *   2. 拼装节点特定的结构化 prompt（extractor/classifier）
 *   3. 调 runPromptHeadless → 得到 { text, agentSessionId }
 *   4. 解析输出（extractor: extractJsonObject；classifier: 匹配 category.id）
 *   5. 解析失败明确抛错（不返回空 payload 继续路由，避免下游悄悄走错分支）
 *
 * workspaceRoot 解析链（与 image.ts 对齐）：
 *   node.config.workspaceRoot（interpolate 后）
 *     → deps.workspaceRoot（由 graph-executor 从触发器 config 解析注入）
 *     → resolveDefaultWorkspaceRoot()（getWorkspaceRoot() → homedir()）
 */

import type {
  WorkflowAiAgentConfig,
  WorkflowParameterExtractorConfig,
  WorkflowQuestionClassifierConfig,
} from '../types.js'
import type { WorkflowPayload, InterpScope } from '../runtime/interp.js'
import { interpolate } from '../runtime/interp.js'
import type { RunContext } from '../runtime/run-context.js'
import type { NodeOutcome } from './index.js'
import {
  runPromptHeadless,
  resolveDefaultWorkspaceRoot,
} from '../run-prompt-headless.js'

// ── 内部工具函数 ──────────────────────────────────────────────────────────────

/**
 * 从文本中提取第一个 JSON 对象 {...}。
 *
 * 解析策略（对齐 Kun 的 extractJsonObject）：
 *   1. 尝试直接 JSON.parse 整体（最常见情况：agent 只输出 JSON）。
 *   2. 若失败，用正则找最外层 {...} 块再 parse（agent 在 JSON 前后插了解释文字）。
 *   3. 两者都失败 → 抛错，调用方转化为明确报错（不返回 undefined/null 继续路由）。
 *
 * 为何明确报错而非返回空：
 *   parameter-extractor 下游节点依赖结构化字段（如 name/email），
 *   静默降级会让下游以 undefined 继续，难以调试；明确报错可在运行日志中定位问题。
 */
export function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim()

  // 尝试1：整体 parse
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 继续尝试策略2
  }

  // 尝试2：找最外层 {...} 块
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) {
    const block = trimmed.slice(start, end + 1)
    try {
      const parsed = JSON.parse(block)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // 继续抛错
    }
  }

  throw new Error(
    `parameter-extractor 解析失败：agent 输出不含合法 JSON 对象。` +
    `原始输出（前 300 字符）：${trimmed.slice(0, 300)}`,
  )
}

/**
 * 从 AI 输出文本中解析出 classifier category.id。
 *
 * 解析策略（对齐 Kun question-classifier 语义）：
 *   1. 尝试 JSON parse，取 category / categoryId / id 字段。
 *   2. 遍历 categories，找到 id 或 label（大小写不敏感）与输出匹配的那个。
 *   3. 找不到时：
 *      - 有 fallback（categories 中存在 id='default' 或 label 含 'default'/'其他'/'其它'）→ 返回该 id。
 *      - 无兜底 → 抛错（调用方得到明确失败，不以空 branch 静默继续）。
 *
 * 为何明确报错而非 undefined branch：
 *   question-classifier 分支语义为 branch=category.id，空分支会跳过所有出边，
 *   等同于执行完毕但无下游——如果是配置错误或 prompt 不够清晰，静默丢弃比报错更难排查。
 */
export function extractCategoryId(
  text: string,
  categories: Array<{ id: string; label: string }>,
): string {
  const trimmed = text.trim()

  // 策略1：agent 可能输出 JSON { "category": "..." }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const picked =
      String(parsed['category'] ?? parsed['categoryId'] ?? parsed['id'] ?? '').trim()
    if (picked) {
      const matched = categories.find(
        (c) => c.id === picked || c.label.toLowerCase() === picked.toLowerCase(),
      )
      if (matched) return matched.id
    }
  } catch {
    // 继续策略2
  }

  // 策略2：在输出中找 category.id 或 category.label 的精确/大小写不敏感匹配
  const lower = trimmed.toLowerCase()
  for (const cat of categories) {
    if (
      lower.includes(cat.id.toLowerCase()) ||
      lower.includes(cat.label.toLowerCase())
    ) {
      return cat.id
    }
  }

  // 策略3：兜底分类（id='default' 或 label 含 'default'/'其他'/'其它'）
  const fallback = categories.find(
    (c) =>
      c.id === 'default' ||
      c.label.toLowerCase().includes('default') ||
      c.label.includes('其他') ||
      c.label.includes('其它'),
  )
  if (fallback) return fallback.id

  throw new Error(
    `question-classifier 解析失败：无法从 agent 输出中识别有效分类。` +
    `可用分类：[${categories.map((c) => `${c.id}(${c.label})`).join(', ')}]。` +
    `原始输出（前 200 字符）：${trimmed.slice(0, 200)}`,
  )
}

// ── workspaceRoot 解析链 ──────────────────────────────────────────────────────

/**
 * 解析 AI 节点的 workspaceRoot（三级解析链）。
 *
 * 优先级（对齐 image.ts + U12 约束）：
 *   1. node.config.workspaceRoot（interpolate 后，用户在节点中明确指定）
 *   2. deps.workspaceRoot（触发器 config 中解析注入，由 graph-executor 维护）
 *   3. resolveDefaultWorkspaceRoot()（getWorkspaceRoot() → homedir() 兜底）
 */
async function resolveWorkspaceRoot(
  configRoot: string | undefined,
  depsRoot: string | undefined,
  scope: InterpScope,
  payload: WorkflowPayload,
): Promise<string> {
  if (configRoot) {
    const expanded = interpolate(configRoot, payload, scope)
    const result = typeof expanded === 'string' ? expanded.trim() : ''
    if (result) return result
  }
  if (depsRoot) return depsRoot
  return resolveDefaultWorkspaceRoot()
}

// ── 三种 AI 节点执行器 ────────────────────────────────────────────────────────

/**
 * ai-agent 节点执行器。
 *
 * 流程：
 *   1. interpolate prompt（展开 $nodes/$env/$run/$loop/$input 等模板变量）
 *   2. 解析 workspaceRoot（三级链）
 *   3. runPromptHeadless → { text, agentSessionId }
 *   4. 输出 payload.json.text = text，payload.text = text；threadId = agentSessionId
 */
export async function executeAiAgent(
  config: WorkflowAiAgentConfig,
  payload: WorkflowPayload,
  scope: InterpScope,
  ctx: RunContext,
  depsWorkspaceRoot: string | undefined,
): Promise<NodeOutcome> {
  const promptValue = interpolate(config.prompt, payload, scope)
  const prompt = typeof promptValue === 'string' ? promptValue.trim() : String(promptValue ?? '').trim()
  if (!prompt) {
    throw new Error('ai-agent 节点 prompt 为空（interpolate 后）。请检查模板变量绑定。')
  }

  const workspaceRoot = await resolveWorkspaceRoot(
    config.workspaceRoot,
    depsWorkspaceRoot,
    scope,
    payload,
  )

  // signal 来自 ctx.cancelToken：取消时 abort 子进程（RunContext 无 AbortSignal，此处派生）
  // 采用轮询模式：cancelToken.cancelled 触发后，在 runPromptHeadless 内部通过 signal abort。
  // 注意：ctx.aiProcesses 由 runPromptHeadless 内部的独立 Map 维护（headlessProcs），
  // 不注入 ctx.aiProcesses —— 见 run-prompt-headless.ts 的 KTD3 注释。
  // stopRun 时调 killAllHeadlessPrompts()（在 index.ts 的 stopRun handler 中接线）。
  const controller = new AbortController()
  // cancelToken 轮询：启动一个微任务监测取消标志
  const pollCancel = setInterval(() => {
    if (ctx.cancelToken.cancelled && !controller.signal.aborted) {
      controller.abort()
    }
  }, 200)

  let result: Awaited<ReturnType<typeof runPromptHeadless>>
  try {
    result = await runPromptHeadless({
      prompt,
      workspaceRoot,
      providerId: config.providerId,
      model: config.model || undefined,
      mode: config.mode,
      reasoningEffort: config.reasoningEffort,
      signal: controller.signal,
    })
  } finally {
    clearInterval(pollCancel)
  }

  const { text, agentSessionId } = result

  return {
    payload: {
      json: { text },
      text,
    },
    threadId: agentSessionId,
    message: `ai-agent 完成（${text.length} 字符${agentSessionId ? `，sessionId=${agentSessionId}` : ''}）`,
  }
}

/**
 * parameter-extractor 节点执行器。
 *
 * 流程：
 *   1. 拼装结构化 prompt（含 fields schema + instruction）
 *   2. 强制 mode='agent'（结构化提取须在 agent 模式下执行）
 *   3. runPromptHeadless → text
 *   4. extractJsonObject(text) → 解析字段对象
 *   5. 解析失败 → 明确抛错（不返回空 payload 静默继续路由）
 *
 * 结构化 prompt 格式（对齐 Kun parameter-extractor 语义）：
 *   - 来源文本（source 字段，支持 interpolate）
 *   - JSON schema 描述每个待提取字段（key/type/description/required）
 *   - 指令（instruction 字段）
 *   - 强制输出格式要求：仅输出单个 JSON 对象，不加额外说明
 */
export async function executeParameterExtractor(
  config: WorkflowParameterExtractorConfig,
  payload: WorkflowPayload,
  scope: InterpScope,
  ctx: RunContext,
  depsWorkspaceRoot: string | undefined,
): Promise<NodeOutcome> {
  // 展开 source 表达式（可以是 {{text}} 或 {{$nodes.xxx.text}} 等）
  const sourceValue = config.source
    ? interpolate(config.source, payload, scope)
    : null
  const sourceText =
    typeof sourceValue === 'string'
      ? sourceValue
      : sourceValue != null
        ? JSON.stringify(sourceValue)
        : payload.text

  // 拼装结构化 prompt
  const schemaLines = config.fields.map((f) => {
    const required = f.required ? '（必填）' : '（可选）'
    return `  - ${f.key}（${f.type}）${required}：${f.label}${f.description ? `，${f.description}` : ''}`
  })

  const structuredPrompt = [
    '从以下文本中提取指定字段，以 JSON 对象格式返回。只输出 JSON，不加解释。',
    '',
    '## 待提取文本',
    sourceText || '（空）',
    '',
    '## 字段 Schema',
    ...schemaLines,
    '',
    ...(config.instruction ? ['## 额外指令', config.instruction, ''] : []),
    '## 输出格式要求',
    '仅输出一个合法 JSON 对象（{...}），包含所有字段。不加 Markdown 代码块、不加注释、不加额外说明。',
  ].join('\n')

  const workspaceRoot = await resolveWorkspaceRoot(
    undefined,
    depsWorkspaceRoot,
    scope,
    payload,
  )

  const controller = new AbortController()
  const pollCancel = setInterval(() => {
    if (ctx.cancelToken.cancelled && !controller.signal.aborted) {
      controller.abort()
    }
  }, 200)

  let result: Awaited<ReturnType<typeof runPromptHeadless>>
  try {
    result = await runPromptHeadless({
      prompt: structuredPrompt,
      workspaceRoot,
      providerId: config.providerId,
      model: config.model || undefined,
      // 结构化提取强制 agent 模式（与 Kun 对齐）
      mode: 'agent',
      reasoningEffort: config.reasoningEffort,
      signal: controller.signal,
    })
  } finally {
    clearInterval(pollCancel)
  }

  // 解析失败明确抛错（不静默返回空对象）
  const extracted = extractJsonObject(result.text)

  return {
    payload: {
      json: extracted,
      text: JSON.stringify(extracted),
    },
    threadId: result.agentSessionId,
    message: `parameter-extractor 完成，提取字段：[${Object.keys(extracted).join(', ')}]`,
  }
}

/**
 * question-classifier 节点执行器。
 *
 * 流程：
 *   1. 拼装分类 prompt（含 source 文本 + categories 列表 + instruction）
 *   2. 强制 mode='agent'
 *   3. runPromptHeadless → text
 *   4. extractCategoryId(text, categories) → category.id
 *   5. 无匹配时：有兜底则用兜底，否则明确抛错
 *   6. branch = category.id，payload 透传（对齐 Kun 语义：classifier 不变换 payload）
 */
export async function executeQuestionClassifier(
  config: WorkflowQuestionClassifierConfig,
  payload: WorkflowPayload,
  scope: InterpScope,
  ctx: RunContext,
  depsWorkspaceRoot: string | undefined,
): Promise<NodeOutcome> {
  if (!config.categories || config.categories.length === 0) {
    throw new Error('question-classifier 节点缺少分类列表（categories 为空）。')
  }

  // 展开 source 表达式
  const sourceValue = config.source
    ? interpolate(config.source, payload, scope)
    : null
  const sourceText =
    typeof sourceValue === 'string'
      ? sourceValue
      : sourceValue != null
        ? JSON.stringify(sourceValue)
        : payload.text

  // 分类列表文字
  const categoryLines = config.categories.map(
    (c, i) => `  ${i + 1}. id="${c.id}" — ${c.label}`,
  )

  const structuredPrompt = [
    '将以下问题或文本归类到最匹配的分类中，只输出分类 id。',
    '',
    '## 待分类文本',
    sourceText || '（空）',
    '',
    '## 可用分类',
    ...categoryLines,
    '',
    ...(config.instruction ? ['## 额外指令', config.instruction, ''] : []),
    '## 输出格式要求',
    '只输出分类 id（字符串），不加引号、不加解释。例如：general',
  ].join('\n')

  const workspaceRoot = await resolveWorkspaceRoot(
    undefined,
    depsWorkspaceRoot,
    scope,
    payload,
  )

  const controller = new AbortController()
  const pollCancel = setInterval(() => {
    if (ctx.cancelToken.cancelled && !controller.signal.aborted) {
      controller.abort()
    }
  }, 200)

  let result: Awaited<ReturnType<typeof runPromptHeadless>>
  try {
    result = await runPromptHeadless({
      prompt: structuredPrompt,
      workspaceRoot,
      providerId: config.providerId,
      model: config.model || undefined,
      mode: 'agent',
      reasoningEffort: config.reasoningEffort,
      signal: controller.signal,
    })
  } finally {
    clearInterval(pollCancel)
  }

  // 解析分类 id（无匹配且无兜底时明确抛错）
  const categoryId = extractCategoryId(result.text, config.categories)

  return {
    // payload 透传（classifier 不变换输入，只路由分支）
    payload,
    branch: categoryId,
    threadId: result.agentSessionId,
    message: `question-classifier 分类结果：${categoryId}`,
  }
}
