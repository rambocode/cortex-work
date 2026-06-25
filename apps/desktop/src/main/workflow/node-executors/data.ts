/**
 * 数据处理节点执行器（U11）。
 *
 * 实现以下 7 种节点：
 *   set-fields  — 设置字段（scope=payload 改输出 / scope=run 写 runVars）
 *   sort        — 数组排序（按 dot-path / 数字序 / 字典序 / asc/desc）
 *   limit       — 截取数组前 N / 后 N
 *   aggregate   — 聚合（count / sum / collect / join）
 *   template    — 模板渲染（outputMode text/json，json 解析失败 fallback {text}）
 *   json        — JSON parse / stringify（strict=true 解析失败抛错 vs 宽松 fallback）
 *   output      — 终态输出节点（auto / text / json 三种模式，pickRunOutput 取为规范输出）
 */

import type {
  WorkflowSetFieldsConfig,
  WorkflowSortConfig,
  WorkflowLimitConfig,
  WorkflowAggregateConfig,
  WorkflowTemplateConfig,
  WorkflowJsonConfig,
  WorkflowOutputConfig,
} from '../types.js'
import type { WorkflowPayload, InterpScope } from '../runtime/interp.js'
import { interpolate } from '../runtime/interp.js'
import type { RunContext } from '../runtime/run-context.js'
import type { NodeOutcome } from './index.js'

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
 * 按 dot-path 从任意对象取值；空路径返回值本身。
 * 与 interp.ts 中的 getByPath 同语义，避免跨文件 import 私有函数。
 */
function getByPath(value: unknown, path: string): unknown {
  const trimmed = path.trim()
  if (!trimmed) return value
  const segments = trimmed.split('.').filter(Boolean)
  let cursor: unknown = value
  for (const segment of segments) {
    if (cursor && typeof cursor === 'object' && segment in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
  }
  return cursor
}

// ── 各节点执行器 ──────────────────────────────────────────────────────────────

/**
 * set-fields 节点：对 payload 的 JSON 字段进行添加/覆盖。
 *
 * scope='payload'（默认）：
 *   keepIncoming=true  → 保留上游 payload.json（object 类型），再 overlay fields
 *   keepIncoming=false → 从空 {} 开始，只输出 fields 设定的值
 *   field.value 经 interpolate 展开模板变量
 *
 * scope='run'：
 *   把 fields 写入 ctx.runVars（对应 $run.key），payload 原样透传（不改 json）
 *   这是跨节点共享变量的机制，不会污染当前 payload
 */
export function executeSetFields(
  config: WorkflowSetFieldsConfig,
  payload: WorkflowPayload,
  scope: InterpScope,
  ctx: RunContext
): NodeOutcome {
  if (config.scope === 'run') {
    // scope=run：写入 run 级别共享变量，payload 透传
    for (const field of config.fields) {
      const key = field.key.trim()
      if (key) ctx.runVars[key] = interpolate(field.value, payload, scope)
    }
    return { payload, message: `set ${config.fields.length} run var(s)` }
  }

  // scope=payload（默认）：构建新 json
  const base: Record<string, unknown> =
    config.keepIncoming &&
    payload.json &&
    typeof payload.json === 'object' &&
    !Array.isArray(payload.json)
      ? { ...(payload.json as Record<string, unknown>) }
      : {}

  for (const field of config.fields) {
    const key = field.key.trim()
    if (key) base[key] = interpolate(field.value, payload, scope)
  }

  return {
    payload: { json: base, text: safeJson(base) },
    message: `${config.fields.length} fields`,
  }
}

/**
 * sort 节点：对数组 payload 排序。
 *
 * field    — dot-path 取排序键；空则用 item 本身
 * numeric  — true=数字比较（NaN→0）；false=字典序 localeCompare
 * order    — 'asc'（升序，默认） / 'desc'（降序）
 *
 * 非数组 payload 视作空数组处理（对齐 Kun）。
 */
export function executeSort(config: WorkflowSortConfig, payload: WorkflowPayload): NodeOutcome {
  const items = Array.isArray(payload.json) ? [...(payload.json as unknown[])] : []
  const { field, order, numeric } = config

  items.sort((a, b) => {
    const av = field ? getByPath(a, field) : a
    const bv = field ? getByPath(b, field) : b
    const cmp = numeric
      ? (Number(av) || 0) - (Number(bv) || 0)
      : String(av ?? '').localeCompare(String(bv ?? ''))
    return order === 'desc' ? -cmp : cmp
  })

  return {
    payload: { json: items, text: safeJson(items) },
    message: `sorted ${items.length}`,
  }
}

/**
 * limit 节点：截取数组的前 N 或后 N 条。
 *
 * from='first'（默认）— 取前 count 条（slice(0, count)）
 * from='last'         — 取后 count 条（slice(-count)）
 *
 * 非数组 payload 视作空数组处理。
 */
export function executeLimit(config: WorkflowLimitConfig, payload: WorkflowPayload): NodeOutcome {
  const items = Array.isArray(payload.json) ? (payload.json as unknown[]) : []
  const out =
    config.from === 'last' ? items.slice(-config.count) : items.slice(0, config.count)
  return {
    payload: { json: out, text: safeJson(out) },
    message: `${out.length} items`,
  }
}

/**
 * aggregate 节点：对数组进行聚合计算。
 *
 * field — dot-path 取值字段；空则用 item 本身
 *
 * mode='count'   → 输出 { count: N }
 * mode='sum'     → 输出 { sum: N }（NaN 视为 0）
 * mode='collect' → 输出 { values: [...] }（按 field 取值）
 * mode='join'    → 输出 { text: "..." }，separator 默认 ', '
 */
export function executeAggregate(
  config: WorkflowAggregateConfig,
  payload: WorkflowPayload
): NodeOutcome {
  const items = Array.isArray(payload.json) ? (payload.json as unknown[]) : []
  const valueOf = (item: unknown): unknown =>
    config.field ? getByPath(item, config.field) : item

  if (config.mode === 'sum') {
    const sum = items.reduce<number>(
      (acc, item) => acc + (Number(valueOf(item)) || 0),
      0
    )
    return {
      payload: { json: { sum }, text: safeJson({ sum }) },
      message: `sum ${sum}`,
    }
  }

  if (config.mode === 'join') {
    const sep = config.separator ?? ', '
    const text = items
      .map((item) => {
        const v = valueOf(item)
        if (v === undefined || v === null) return ''
        return typeof v === 'string' ? v : safeJson(v)
      })
      .join(sep)
    return {
      payload: { json: { text }, text },
      message: `joined ${items.length}`,
    }
  }

  if (config.mode === 'collect') {
    const values = items.map((item) => valueOf(item))
    return {
      payload: { json: { values }, text: safeJson({ values }) },
      message: `collected ${values.length}`,
    }
  }

  // mode='count'（默认）
  const count = items.length
  return {
    payload: { json: { count }, text: safeJson({ count }) },
    message: `count ${count}`,
  }
}

/**
 * template 节点：渲染模板字符串，输出文本或 JSON。
 *
 * outputMode='text'（默认）：
 *   → { json: { text: rendered }, text: rendered }
 *
 * outputMode='json'：
 *   尝试 JSON.parse(rendered)；成功 → 以解析结果为 json，rendered 为 text
 *   失败 → fallback { text: rendered }（不抛错，对齐 Kun 行为）
 */
export function executeTemplate(
  config: WorkflowTemplateConfig,
  payload: WorkflowPayload,
  scope: InterpScope
): NodeOutcome {
  const rendered = interpolate(config.template, payload, scope)

  if (config.outputMode === 'json') {
    let parsed: unknown
    let parsedOk = true
    try {
      parsed = JSON.parse(rendered)
    } catch {
      parsed = { text: rendered }
      parsedOk = false
    }
    return {
      payload: { json: parsed, text: rendered },
      message: parsedOk ? 'formatted' : 'formatted (text fallback)',
    }
  }

  // outputMode='text'
  return {
    payload: { json: { text: rendered }, text: rendered },
    message: 'formatted',
  }
}

/**
 * json 节点：parse 或 stringify JSON。
 *
 * mode='stringify'：把 payload.json 序列化为字符串，输出 { json: { text }, text }
 * mode='parse'：
 *   strict=true  → 解析失败抛 Error（graph-executor 的 onError 处理）
 *   strict=false → 解析失败 fallback { text: payload.text }（宽松模式，不中断流程）
 */
export function executeJson(config: WorkflowJsonConfig, payload: WorkflowPayload): NodeOutcome {
  if (config.mode === 'stringify') {
    const text = safeJson(payload.json)
    return {
      payload: { json: { text }, text },
      message: 'stringified',
    }
  }

  // mode='parse'
  try {
    const parsed: unknown = JSON.parse(payload.text)
    return {
      payload: { json: parsed, text: payload.text },
      message: 'parsed',
    }
  } catch (error) {
    if (config.strict) {
      throw new Error(
        `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    // 宽松模式：fallback，不中断流程
    return {
      payload: { json: { text: payload.text }, text: payload.text },
      message: 'parse fallback',
    }
  }
}

/**
 * output 节点：终态输出节点，决定 run 的 canonical 输出（由 pickRunOutput 使用）。
 *
 * mode='auto'（默认）：直接透传 payload（graph-executor 的 pickRunOutput 取最后一个 output 节点输出）
 * mode='text'：用 textTemplate 渲染，输出 { json: { text }, text }
 * mode='json'：按 jsonPath dot-path 从 payload.json 取值；空 path → 整个 json；缺失值→ null
 *
 * 注意：本节点是「终态」节点，但 graph-executor 不会因为到达 output 节点而停止；
 * 引擎执行完全部可达节点后，pickRunOutput 按节点 id 或最后执行顺序取 output 节点的结果。
 */
export function executeOutput(
  config: WorkflowOutputConfig,
  payload: WorkflowPayload,
  scope: InterpScope
): NodeOutcome {
  if (config.mode === 'text') {
    const text = interpolate(config.textTemplate, payload, scope)
    return {
      payload: { json: { text }, text },
      message: 'output',
    }
  }

  if (config.mode === 'json') {
    const path = config.jsonPath.trim()
    // path 为空→整个 json；取值缺失→ null（对齐 Kun，避免 undefined 污染输出）
    const value = (path ? getByPath(payload.json, path) : payload.json) ?? null
    return {
      payload: { json: value, text: safeJson(value) },
      message: 'output',
    }
  }

  // mode='auto'：透传
  return { payload, message: 'output' }
}
