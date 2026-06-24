/**
 * 模板变量解析系统（复刻 Kun workflow-runtime.ts InterpScope/resolveExpr/interpolate）。
 *
 * 支持的命名空间：
 *   $nodes.<id>.json[.dotpath] — 节点输出 JSON 或子路径
 *   $nodes.<id>.text           — 节点输出文本
 *   $input.<key>[.sub]         — 初始触发器输入（manual-trigger inputSchema）
 *   $env.<key>                 — workflow 环境变量
 *   $run.<key>[.sub]           — set-fields scope=run 写入的 run 级别变量
 *   $loop.index/total/item     — 当前 foreach 循环帧
 *   text                       — 当前节点 primary payload 的 text 字段
 *   json[.dotpath]             — 当前节点 primary payload 的 JSON 或子路径
 *
 * 模板替换规则（对齐 Kun）：
 *   - 单 {{expr}} 整体：调用 resolveExpr 返回原始类型（不转字符串）
 *   - 混排（文字 + 多个 {{expr}}）：每个 expr 转字符串后拼接
 */

import type { WorkflowNode, WorkflowEnvVar } from '../types.js'

/** 单次 run 中节点输出的统一载体。 */
export interface WorkflowPayload {
  json: unknown
  text: string
}

/**
 * 跨节点变量作用域，在 runGraph 的整个 run 中共享（除 loop，每帧独立传入）。
 * 各字段含义：
 *   nodes  → 已完成节点的输出，供 $nodes.<id> 访问
 *   env    → workflow env vars 解析结果，供 $env.<key> 访问
 *   run    → set-fields scope=run 写入的 run 变量，供 $run.<key> 访问
 *   loop   → 当前 foreach 帧（index/item/total），供 $loop.* 访问
 *   input  → 当前节点 inputs[] 绑定解析结果，供 {{$input.key}} 访问
 */
export interface InterpScope {
  nodes?: Record<string, WorkflowPayload>
  env?: Record<string, unknown>
  run?: Record<string, unknown>
  loop?: { index: number; item: unknown; total: number }
  input?: Record<string, unknown>
}

// ── 内部辅助函数 ──────────────────────────────────────────────────────────────

/** 把任意值转为字符串（null/undefined→空串；非字符串→JSON）。 */
function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : safeJson(value)
}

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
 * 从 payload 按路径取值：
 *   空/text → payload.text
 *   json    → payload.json
 *   json.a.b → payload.json.a.b（剥去 "json." 前缀后按 dot-path 取）
 */
function readPath(payload: WorkflowPayload, path: string): unknown {
  const trimmed = path.trim()
  if (!trimmed || trimmed === 'text') return payload.text
  if (trimmed === 'json') return payload.json
  const segments = trimmed.replace(/^json\.?/, '').split('.').filter(Boolean)
  let cursor: unknown = payload.json
  for (const segment of segments) {
    if (cursor && typeof cursor === 'object' && segment in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
  }
  return cursor
}

/**
 * 按 dot-path 取任意嵌套值；空路径返回值本身。
 * 用于 $nodes.<id>.json.<path>、$input.<key>.<sub>、$run.<key>.<sub> 等。
 */
function getByPath(value: unknown, path: string): unknown {
  const trimmed = path.trim()
  if (!trimmed) return value
  const segments = trimmed.replace(/^json\.?/, '').split('.').filter(Boolean)
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

// ── 核心导出函数 ──────────────────────────────────────────────────────────────

/**
 * 解析单个模板表达式（不含 {{ }}），返回原始类型。
 * 对齐 Kun resolveExpr —— 按命名空间前缀分发，无命名空间则 readPath。
 */
export function resolveExpr(payload: WorkflowPayload, expr: string, scope?: InterpScope): unknown {
  const t = expr.trim()

  // $nodes.<id>.text / .json[.dotpath]
  if (t.startsWith('$nodes.')) {
    const rest = t.slice('$nodes.'.length)
    const dot = rest.indexOf('.')
    const nodeId = dot === -1 ? rest : rest.slice(0, dot)
    const sub = dot === -1 ? '' : rest.slice(dot + 1)
    const np = scope?.nodes?.[nodeId]
    if (!np) return undefined
    if (!sub || sub === 'json') return np.json
    if (sub === 'text') return np.text
    // sub 形如 "json.a.b" 或 "a.b"
    return getByPath(np.json, sub.replace(/^json\.?/, ''))
  }

  // $input.<key>[.sub] — 当前节点 inputs[] 绑定解析结果
  if (t.startsWith('$input.')) {
    const rest = t.slice('$input.'.length)
    const dot = rest.indexOf('.')
    const key = dot === -1 ? rest : rest.slice(0, dot)
    const sub = dot === -1 ? '' : rest.slice(dot + 1)
    const base = scope?.input?.[key]
    return sub ? getByPath(base, sub) : base
  }

  // $env.<key> — workflow env vars
  if (t.startsWith('$env.')) return scope?.env?.[t.slice('$env.'.length)]

  // $run.<key>[.sub] — run 级别变量（set-fields scope=run）
  if (t.startsWith('$run.')) {
    const rest = t.slice('$run.'.length)
    const dot = rest.indexOf('.')
    const key = dot === -1 ? rest : rest.slice(0, dot)
    const sub = dot === -1 ? '' : rest.slice(dot + 1)
    const base = scope?.run?.[key]
    return sub ? getByPath(base, sub) : base
  }

  // $loop.index / $loop.total / $loop.item[.sub]
  if (t === '$loop.index') return scope?.loop?.index
  if (t === '$loop.total') return scope?.loop?.total
  if (t === '$loop.item' || t.startsWith('$loop.item.')) {
    const item = scope?.loop?.item
    const sub = t === '$loop.item' ? '' : t.slice('$loop.item.'.length)
    return sub ? getByPath(item, sub) : item
  }

  // 裸表达式：text / json[.dotpath]（当前节点 primary payload）
  return readPath(payload, t)
}

/**
 * 对模板字符串进行 {{expr}} 替换，所有 expr 转为字符串拼接（混排模式）。
 * 单 {{expr}} 整体时请用 resolveTemplate 保留原始类型。
 */
export function interpolate(template: string, payload: WorkflowPayload, scope?: InterpScope): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) =>
    stringifyValue(resolveExpr(payload, expr, scope))
  )
}

/**
 * 对模板字符串进行类型感知解析：
 *   - 单 {{expr}} 整体（无其他文字）→ 返回 resolveExpr 的原始类型（保留 number/boolean/object）
 *   - 其他（混排 或 无 {{}}）→ 返回 interpolate 的字符串结果
 *
 * 对齐 Kun resolveNodeInputs 中的「single match」逻辑。
 */
export function resolveTemplate(template: string, payload: WorkflowPayload, scope?: InterpScope): unknown {
  const trimmed = template.trim()
  // 检查是否整体是单个 {{expr}}
  const single = trimmed.match(/^\{\{\s*([^}]+?)\s*\}\}$/)
  if (single) {
    return resolveExpr(payload, single[1], scope)
  }
  return interpolate(template, payload, scope)
}

/**
 * 对节点 inputs[] 绑定进行解析，返回 { key → 解析后的值 }，供 $input 命名空间使用。
 * 若节点无 inputs 绑定则返回 undefined。
 */
export function resolveNodeInputs(
  node: WorkflowNode,
  payload: WorkflowPayload,
  scope: InterpScope
): Record<string, unknown> | undefined {
  const bindings = node.inputs
  if (!bindings || bindings.length === 0) return undefined
  const out: Record<string, unknown> = {}
  for (const binding of bindings) {
    const key = binding.key.trim()
    if (!key) continue
    // 单 {{expr}} 保留原始类型；混排转字符串（对齐 Kun resolveNodeInputs）
    const raw = resolveTemplate(binding.source, payload, scope)
    out[key] = coerceNodeInputValue(binding.type, raw)
  }
  return out
}

/**
 * 把解析后的原始值按节点 input 声明类型进行强制转换。
 * 对齐 Kun coerceNodeInputValue。
 */
function coerceNodeInputValue(type: string, value: unknown): unknown {
  switch (type) {
    case 'number': {
      const n = Number(value)
      return Number.isFinite(n) ? n : 0
    }
    case 'boolean':
      if (typeof value === 'boolean') return value
      if (value === 'true' || value === '1') return true
      if (value === 'false' || value === '0') return false
      return Boolean(value)
    case 'json':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value)
        } catch {
          return value
        }
      }
      return value
    case 'text':
    default:
      return stringifyValue(value)
  }
}

/**
 * 解析 workflow env vars 数组为 { key → value } 字典，供 InterpScope.env 使用。
 * secret 类型在此保留明文，由上层脱敏处理（不在 interp 层处理）。
 */
export function resolveEnvVars(env: WorkflowEnvVar[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const entry of env) {
    if (!entry.key) continue
    out[entry.key] =
      entry.type === 'number'
        ? Number(entry.value) || 0
        : entry.type === 'boolean'
          ? entry.value === 'true'
          : entry.value
  }
  return out
}
