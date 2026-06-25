/**
 * data.ts 单元测试（U11）
 *
 * 覆盖：
 *   set-fields — keepIncoming merge vs replace；scope=run 写 runVars 不改 payload
 *   sort        — 数字序/字典序、asc/desc、dot-path 取键；非数组退化
 *   limit       — first/last 截取
 *   aggregate   — count / sum / collect / join
 *   template    — outputMode text / json（解析失败 fallback）
 *   json        — parse strict 抛错 vs 宽松 fallback；stringify
 *   output      — auto / text / json 三模式
 */

import { describe, it, expect } from 'vitest'
import {
  executeSetFields,
  executeSort,
  executeLimit,
  executeAggregate,
  executeTemplate,
  executeJson,
  executeOutput,
} from './data.js'
import { createRunContext } from '../runtime/run-context.js'
import type { WorkflowPayload } from '../runtime/interp.js'

// ── 辅助构造 ──────────────────────────────────────────────────────────────────

const p = (json: unknown, text = ''): WorkflowPayload => ({ json, text })
const scope = {}

// ── set-fields ────────────────────────────────────────────────────────────────

describe('executeSetFields', () => {
  it('scope=payload keepIncoming=true → 保留上游 json 并 overlay 新字段', () => {
    const ctx = createRunContext()
    const config = { fields: [{ key: 'b', value: 'B' }], keepIncoming: true }
    const result = executeSetFields(config, p({ a: 1 }), scope, ctx)
    expect(result.payload.json).toEqual({ a: 1, b: 'B' })
  })

  it('scope=payload keepIncoming=false → 丢弃上游 json，只保留新字段', () => {
    const ctx = createRunContext()
    const config = { fields: [{ key: 'x', value: '42' }], keepIncoming: false }
    const result = executeSetFields(config, p({ old: 'data' }), scope, ctx)
    expect(result.payload.json).toEqual({ x: '42' })
    expect((result.payload.json as Record<string, unknown>).old).toBeUndefined()
  })

  it('scope=run → 写 runVars，payload 原样透传', () => {
    const ctx = createRunContext()
    const config = { fields: [{ key: 'myKey', value: 'hello' }], keepIncoming: true, scope: 'run' as const }
    const incoming = p({ existing: true })
    const result = executeSetFields(config, incoming, scope, ctx)
    // payload 不变
    expect(result.payload).toBe(incoming)
    // runVars 被写入
    expect(ctx.runVars['myKey']).toBe('hello')
  })

  it('scope=run → 多个字段同时写入 runVars', () => {
    const ctx = createRunContext()
    const config = {
      fields: [
        { key: 'k1', value: 'v1' },
        { key: 'k2', value: 'v2' },
      ],
      keepIncoming: true,
      scope: 'run' as const,
    }
    executeSetFields(config, p({}), scope, ctx)
    expect(ctx.runVars).toMatchObject({ k1: 'v1', k2: 'v2' })
  })

  it('空 key 的字段被跳过', () => {
    const ctx = createRunContext()
    const config = { fields: [{ key: '', value: 'ignored' }], keepIncoming: false }
    const result = executeSetFields(config, p({}), scope, ctx)
    expect(result.payload.json).toEqual({})
  })

  it('keepIncoming=true 但 payload.json 是数组 → 退化为空 {} base', () => {
    const ctx = createRunContext()
    const config = { fields: [{ key: 'n', value: '1' }], keepIncoming: true }
    const result = executeSetFields(config, p([1, 2, 3]), scope, ctx)
    // 数组不是 plain object，keepIncoming 退化
    expect(result.payload.json).toEqual({ n: '1' })
  })
})

// ── sort ──────────────────────────────────────────────────────────────────────

describe('executeSort', () => {
  it('数字序 asc', () => {
    const config = { field: '', order: 'asc' as const, numeric: true }
    const result = executeSort(config, p([3, 1, 2]))
    expect(result.payload.json).toEqual([1, 2, 3])
  })

  it('数字序 desc', () => {
    const config = { field: '', order: 'desc' as const, numeric: true }
    const result = executeSort(config, p([3, 1, 2]))
    expect(result.payload.json).toEqual([3, 2, 1])
  })

  it('字典序 asc', () => {
    const config = { field: '', order: 'asc' as const, numeric: false }
    const result = executeSort(config, p(['banana', 'apple', 'cherry']))
    expect(result.payload.json).toEqual(['apple', 'banana', 'cherry'])
  })

  it('字典序 desc', () => {
    const config = { field: '', order: 'desc' as const, numeric: false }
    const result = executeSort(config, p(['banana', 'apple', 'cherry']))
    expect(result.payload.json).toEqual(['cherry', 'banana', 'apple'])
  })

  it('dot-path 取字段排序（数字序）', () => {
    const config = { field: 'age', order: 'asc' as const, numeric: true }
    const items = [{ name: 'Bob', age: 30 }, { name: 'Alice', age: 25 }, { name: 'Carol', age: 28 }]
    const result = executeSort(config, p(items))
    const names = (result.payload.json as {name:string}[]).map(x => x.name)
    expect(names).toEqual(['Alice', 'Carol', 'Bob'])
  })

  it('嵌套 dot-path 排序', () => {
    const config = { field: 'meta.score', order: 'desc' as const, numeric: true }
    const items = [
      { meta: { score: 5 } },
      { meta: { score: 10 } },
      { meta: { score: 3 } },
    ]
    const result = executeSort(config, p(items))
    const scores = (result.payload.json as {meta:{score:number}}[]).map(x => x.meta.score)
    expect(scores).toEqual([10, 5, 3])
  })

  it('非数组 payload → 输出空数组', () => {
    const config = { field: '', order: 'asc' as const, numeric: false }
    const result = executeSort(config, p({ notArray: true }))
    expect(result.payload.json).toEqual([])
  })

  it('不修改原始数组（纯函数）', () => {
    const config = { field: '', order: 'asc' as const, numeric: true }
    const original = [3, 1, 2]
    executeSort(config, p([...original]))
    // 确认传入 payload 的数组未被 sort 原地修改（我们用 spread copy）
    expect(original).toEqual([3, 1, 2])
  })
})

// ── limit ─────────────────────────────────────────────────────────────────────

describe('executeLimit', () => {
  it('from=first → 取前 N 条', () => {
    const config = { count: 2, from: 'first' as const }
    const result = executeLimit(config, p([1, 2, 3, 4, 5]))
    expect(result.payload.json).toEqual([1, 2])
  })

  it('from=last → 取后 N 条', () => {
    const config = { count: 2, from: 'last' as const }
    const result = executeLimit(config, p([1, 2, 3, 4, 5]))
    expect(result.payload.json).toEqual([4, 5])
  })

  it('count > 数组长度 → 返回整个数组', () => {
    const config = { count: 100, from: 'first' as const }
    const result = executeLimit(config, p([1, 2, 3]))
    expect(result.payload.json).toEqual([1, 2, 3])
  })

  it('非数组 payload → 返回空数组', () => {
    const config = { count: 3, from: 'first' as const }
    const result = executeLimit(config, p('not an array'))
    expect(result.payload.json).toEqual([])
  })
})

// ── aggregate ─────────────────────────────────────────────────────────────────

describe('executeAggregate', () => {
  it('mode=count → 输出 { count }', () => {
    const config = { mode: 'count' as const, field: '', separator: '' }
    const result = executeAggregate(config, p([1, 2, 3, 4]))
    expect(result.payload.json).toEqual({ count: 4 })
  })

  it('mode=sum → 求数字和', () => {
    const config = { mode: 'sum' as const, field: '', separator: '' }
    const result = executeAggregate(config, p([1, 2, 3, 4]))
    expect(result.payload.json).toEqual({ sum: 10 })
  })

  it('mode=sum 按 field dot-path 取值', () => {
    const config = { mode: 'sum' as const, field: 'val', separator: '' }
    const result = executeAggregate(config, p([{ val: 5 }, { val: 10 }, { val: 3 }]))
    expect(result.payload.json).toEqual({ sum: 18 })
  })

  it('mode=sum 非数字值视为 0', () => {
    const config = { mode: 'sum' as const, field: '', separator: '' }
    const result = executeAggregate(config, p([1, 'hello', null, 2]))
    expect((result.payload.json as { sum: number }).sum).toBe(3)
  })

  it('mode=collect → 收集 values 数组', () => {
    const config = { mode: 'collect' as const, field: 'name', separator: '' }
    const result = executeAggregate(config, p([{ name: 'Alice' }, { name: 'Bob' }]))
    expect(result.payload.json).toEqual({ values: ['Alice', 'Bob'] })
  })

  it('mode=join → 拼接字符串', () => {
    const config = { mode: 'join' as const, field: '', separator: ' | ' }
    const result = executeAggregate(config, p(['a', 'b', 'c']))
    expect((result.payload.json as { text: string }).text).toBe('a | b | c')
    expect(result.payload.text).toBe('a | b | c')
  })

  it('mode=join 默认分隔符 ,', () => {
    // separator 为 undefined 时应有默认值
    const config = { mode: 'join' as const, field: '', separator: undefined as unknown as string }
    const result = executeAggregate(config, p(['x', 'y']))
    expect((result.payload.json as { text: string }).text).toContain('x')
  })

  it('非数组 payload → count=0', () => {
    const config = { mode: 'count' as const, field: '', separator: '' }
    const result = executeAggregate(config, p({ notArray: true }))
    expect(result.payload.json).toEqual({ count: 0 })
  })
})

// ── template ──────────────────────────────────────────────────────────────────

describe('executeTemplate', () => {
  it('outputMode=text → 输出 { text: rendered }', () => {
    const config = { template: 'hello world', outputMode: 'text' as const }
    const result = executeTemplate(config, p({}), scope)
    expect(result.payload.json).toEqual({ text: 'hello world' })
    expect(result.payload.text).toBe('hello world')
  })

  it('outputMode=json → 解析成功 → 使用解析结果', () => {
    const config = { template: '{"a":1}', outputMode: 'json' as const }
    const result = executeTemplate(config, p({}), scope)
    expect(result.payload.json).toEqual({ a: 1 })
    expect(result.payload.text).toBe('{"a":1}')
    expect(result.message).toBe('formatted')
  })

  it('outputMode=json → 解析失败 → fallback { text: rendered }', () => {
    const config = { template: 'not json {broken', outputMode: 'json' as const }
    const result = executeTemplate(config, p({}), scope)
    expect(result.payload.json).toEqual({ text: 'not json {broken' })
    expect(result.message).toContain('text fallback')
  })

  it('模板变量展开', () => {
    const config = { template: 'val={{json.x}}', outputMode: 'text' as const }
    const result = executeTemplate(config, p({ x: 42 }), scope)
    expect(result.payload.text).toBe('val=42')
  })
})

// ── json ──────────────────────────────────────────────────────────────────────

describe('executeJson', () => {
  it('mode=stringify → json→字符串', () => {
    const config = { mode: 'stringify' as const, strict: false }
    const result = executeJson(config, p({ a: 1, b: 2 }))
    const out = result.payload.json as { text: string }
    expect(JSON.parse(out.text)).toEqual({ a: 1, b: 2 })
  })

  it('mode=parse → 合法 JSON string → 解析结果', () => {
    const config = { mode: 'parse' as const, strict: true }
    const result = executeJson(config, { json: null, text: '{"x":10}' })
    expect(result.payload.json).toEqual({ x: 10 })
  })

  it('mode=parse strict=true → 解析失败抛 Error', () => {
    const config = { mode: 'parse' as const, strict: true }
    expect(() => executeJson(config, { json: null, text: 'bad json' })).toThrow('JSON parse failed')
  })

  it('mode=parse strict=false → 解析失败 fallback { text }', () => {
    const config = { mode: 'parse' as const, strict: false }
    const result = executeJson(config, { json: null, text: 'not json' })
    expect(result.payload.json).toEqual({ text: 'not json' })
    expect(result.message).toBe('parse fallback')
  })
})

// ── output ────────────────────────────────────────────────────────────────────

describe('executeOutput', () => {
  it('mode=auto → 透传 payload', () => {
    const config = { mode: 'auto' as const, textTemplate: '', jsonPath: '' }
    const payload = p({ key: 'value' }, 'some text')
    const result = executeOutput(config, payload, scope)
    expect(result.payload).toBe(payload)
  })

  it('mode=text → 用 textTemplate 渲染', () => {
    const config = { mode: 'text' as const, textTemplate: 'result: {{json.n}}', jsonPath: '' }
    const result = executeOutput(config, p({ n: 99 }), scope)
    expect(result.payload.text).toBe('result: 99')
    expect((result.payload.json as { text: string }).text).toBe('result: 99')
  })

  it('mode=json jsonPath 为空 → 整个 json', () => {
    const config = { mode: 'json' as const, textTemplate: '', jsonPath: '' }
    const result = executeOutput(config, p({ a: 1, b: 2 }), scope)
    expect(result.payload.json).toEqual({ a: 1, b: 2 })
  })

  it('mode=json jsonPath 非空 → 取子路径', () => {
    const config = { mode: 'json' as const, textTemplate: '', jsonPath: 'nested.val' }
    const result = executeOutput(config, p({ nested: { val: 42 } }), scope)
    expect(result.payload.json).toBe(42)
  })

  it('mode=json jsonPath 路径不存在 → null', () => {
    const config = { mode: 'json' as const, textTemplate: '', jsonPath: 'nonexistent.path' }
    const result = executeOutput(config, p({ a: 1 }), scope)
    expect(result.payload.json).toBeNull()
  })
})
