/**
 * 条件求值模块（复刻 Kun evaluateCondition）。
 *
 * 对外导出 evaluateCondition，供 condition/switch/filter/loop 节点使用。
 * 12 种 operator 与 Kun WorkflowConditionOperator 对齐。
 *
 * caseSensitive 处理规则：
 *   - 仅在字符串比较（contains/notContains/equals/notEquals/startsWith/endsWith）时有效。
 *   - isEmpty/isNotEmpty 总是比较原始字符串（大小写无意义）。
 *   - gt/gte/lt/lte 总是数字比较（大小写无意义）。
 */

import type { WorkflowConditionOperator } from '../types.js'
import type { WorkflowPayload, InterpScope } from '../runtime/interp.js'
import { resolveExpr } from '../runtime/interp.js'

/** 条件配置（与 WorkflowConditionConfig/WorkflowSwitchRule 共享同一形状）。 */
export interface ConditionConfig {
  leftExpr: string
  operator: WorkflowConditionOperator
  rightValue: string
  caseSensitive: boolean
}

/** 把任意值转为字符串（null/undefined→空串；非字符串→JSON 序列化）。 */
function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * 对单个条件配置求值，返回 true/false。
 *
 * leftExpr 为空时退化为 payload.text（对齐 Kun：`config.leftExpr.trim() ? resolveExpr(...) : payload.text`）。
 * caseSensitive=false 时对左右值同时 toLowerCase 再比较（数字/isEmpty 类操作除外）。
 */
export function evaluateCondition(
  config: ConditionConfig,
  payload: WorkflowPayload,
  scope?: InterpScope
): boolean {
  // 左值：leftExpr 非空则走 resolveExpr，否则退化为 payload.text
  const leftRaw = config.leftExpr.trim()
    ? resolveExpr(payload, config.leftExpr, scope)
    : payload.text

  const left = stringifyValue(leftRaw)
  const right = config.rightValue

  // caseSensitive=false 时降大写比较（数字比较和 isEmpty 类不受影响）
  const l = config.caseSensitive ? left : left.toLowerCase()
  const r = config.caseSensitive ? right : right.toLowerCase()

  switch (config.operator) {
    case 'contains':
      return l.includes(r)
    case 'notContains':
      return !l.includes(r)
    case 'equals':
      return l === r
    case 'notEquals':
      return l !== r
    case 'startsWith':
      return l.startsWith(r)
    case 'endsWith':
      return l.endsWith(r)
    // isEmpty/isNotEmpty 总是用原始字符串（trim 去空白再判断）
    case 'isEmpty':
      return left.trim() === ''
    case 'isNotEmpty':
      return left.trim() !== ''
    // 数字比较：直接 Number()，与 Kun 行为对齐
    case 'gt':
      return Number(left) > Number(right)
    case 'gte':
      return Number(left) >= Number(right)
    case 'lt':
      return Number(left) < Number(right)
    case 'lte':
      return Number(left) <= Number(right)
    default: {
      // TypeScript exhaustive check
      const _exhaustive: never = config.operator
      void _exhaustive
      return false
    }
  }
}
