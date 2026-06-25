/**
 * interp.ts 模板变量系统单测
 */
import { describe, it, expect } from 'vitest'
import {
  resolveExpr,
  interpolate,
  resolveTemplate,
  resolveNodeInputs,
  resolveEnvVars,
  type WorkflowPayload,
  type InterpScope,
} from './interp.js'
import type { WorkflowNode } from '../types.js'

const emptyPayload: WorkflowPayload = { json: {}, text: '' }

// ── resolveExpr 命名空间测试 ──────────────────────────────────────────────────

describe('resolveExpr', () => {
  describe('裸表达式（当前节点 primary payload）', () => {
    it('text → payload.text', () => {
      const p: WorkflowPayload = { json: { a: 1 }, text: 'hello' }
      expect(resolveExpr(p, 'text')).toBe('hello')
    })

    it('json → payload.json', () => {
      const p: WorkflowPayload = { json: { a: 1 }, text: '' }
      expect(resolveExpr(p, 'json')).toEqual({ a: 1 })
    })

    it('json.a → payload.json.a（dot-path）', () => {
      const p: WorkflowPayload = { json: { a: { b: 42 } }, text: '' }
      expect(resolveExpr(p, 'json.a.b')).toBe(42)
    })

    it('json.missing → undefined', () => {
      const p: WorkflowPayload = { json: { a: 1 }, text: '' }
      expect(resolveExpr(p, 'json.missing')).toBeUndefined()
    })

    it('空表达式 → payload.text', () => {
      const p: WorkflowPayload = { json: {}, text: 'world' }
      expect(resolveExpr(p, '')).toBe('world')
    })
  })

  describe('$nodes 命名空间', () => {
    const scope: InterpScope = {
      nodes: {
        nodeA: { json: { name: 'Alice', age: 30 }, text: 'Alice text' },
      },
    }

    it('$nodes.nodeA.json → 整个 json 对象', () => {
      expect(resolveExpr(emptyPayload, '$nodes.nodeA.json', scope)).toEqual({ name: 'Alice', age: 30 })
    })

    it('$nodes.nodeA.text → 节点 text', () => {
      expect(resolveExpr(emptyPayload, '$nodes.nodeA.text', scope)).toBe('Alice text')
    })

    it('$nodes.nodeA.json.name → dot-path', () => {
      expect(resolveExpr(emptyPayload, '$nodes.nodeA.json.name', scope)).toBe('Alice')
    })

    it('$nodes.nodeA.name → 省略 json. 前缀', () => {
      expect(resolveExpr(emptyPayload, '$nodes.nodeA.name', scope)).toBe('Alice')
    })

    it('$nodes.missing → undefined（节点不存在）', () => {
      expect(resolveExpr(emptyPayload, '$nodes.missing.json', scope)).toBeUndefined()
    })

    it('scope 无 nodes → undefined', () => {
      expect(resolveExpr(emptyPayload, '$nodes.nodeA.json', {})).toBeUndefined()
    })
  })

  describe('$input 命名空间', () => {
    const scope: InterpScope = {
      input: { key1: 'value1', nested: { deep: 99 } },
    }

    it('$input.key1 → value1', () => {
      expect(resolveExpr(emptyPayload, '$input.key1', scope)).toBe('value1')
    })

    it('$input.nested.deep → dot-path', () => {
      expect(resolveExpr(emptyPayload, '$input.nested.deep', scope)).toBe(99)
    })

    it('$input.missing → undefined', () => {
      expect(resolveExpr(emptyPayload, '$input.missing', scope)).toBeUndefined()
    })
  })

  describe('$env 命名空间', () => {
    const scope: InterpScope = {
      env: { API_KEY: 'secret', COUNT: 5 },
    }

    it('$env.API_KEY → 字符串', () => {
      expect(resolveExpr(emptyPayload, '$env.API_KEY', scope)).toBe('secret')
    })

    it('$env.COUNT → 数字', () => {
      expect(resolveExpr(emptyPayload, '$env.COUNT', scope)).toBe(5)
    })

    it('$env.missing → undefined', () => {
      expect(resolveExpr(emptyPayload, '$env.missing', scope)).toBeUndefined()
    })
  })

  describe('$run 命名空间', () => {
    const scope: InterpScope = {
      run: { total: 10, meta: { tag: 'test' } },
    }

    it('$run.total → 数字', () => {
      expect(resolveExpr(emptyPayload, '$run.total', scope)).toBe(10)
    })

    it('$run.meta.tag → dot-path', () => {
      expect(resolveExpr(emptyPayload, '$run.meta.tag', scope)).toBe('test')
    })
  })

  describe('$loop 命名空间', () => {
    const scope: InterpScope = {
      loop: { index: 2, item: { id: 'x' }, total: 5 },
    }

    it('$loop.index → 数字', () => {
      expect(resolveExpr(emptyPayload, '$loop.index', scope)).toBe(2)
    })

    it('$loop.total → 数字', () => {
      expect(resolveExpr(emptyPayload, '$loop.total', scope)).toBe(5)
    })

    it('$loop.item → 整个 item', () => {
      expect(resolveExpr(emptyPayload, '$loop.item', scope)).toEqual({ id: 'x' })
    })

    it('$loop.item.id → dot-path', () => {
      expect(resolveExpr(emptyPayload, '$loop.item.id', scope)).toBe('x')
    })

    it('无 loop scope → undefined', () => {
      expect(resolveExpr(emptyPayload, '$loop.index', {})).toBeUndefined()
    })
  })
})

// ── interpolate 混排测试 ──────────────────────────────────────────────────────

describe('interpolate', () => {
  it('无模板 → 原样返回', () => {
    expect(interpolate('hello world', emptyPayload)).toBe('hello world')
  })

  it('单 {{expr}} → 转字符串', () => {
    const p: WorkflowPayload = { json: { n: 42 }, text: '' }
    expect(interpolate('{{json.n}}', p)).toBe('42')
  })

  it('混排 → 拼接字符串', () => {
    const p: WorkflowPayload = { json: { name: 'Bob' }, text: 'hi' }
    expect(interpolate('Hello {{json.name}}, {{text}}!', p)).toBe('Hello Bob, hi!')
  })

  it('null 值 → 空串', () => {
    const scope: InterpScope = { env: { val: null as unknown as string } }
    expect(interpolate('prefix-{{$env.val}}-suffix', emptyPayload, scope)).toBe('prefix--suffix')
  })

  it('对象值 → JSON 字符串', () => {
    const scope: InterpScope = { nodes: { n: { json: { a: 1 }, text: '' } } }
    expect(interpolate('data:{{$nodes.n.json}}', emptyPayload, scope)).toBe('data:{"a":1}')
  })
})

// ── resolveTemplate 类型保留测试 ──────────────────────────────────────────────

describe('resolveTemplate（单 {{expr}} 保留原始类型）', () => {
  it('单 {{json}} → 返回原始对象（非字符串）', () => {
    const p: WorkflowPayload = { json: { a: 1 }, text: '' }
    const result = resolveTemplate('{{json}}', p)
    expect(result).toEqual({ a: 1 })
    expect(typeof result).not.toBe('string')
  })

  it('单 {{json.n}} 数字 → 返回数字', () => {
    const p: WorkflowPayload = { json: { n: 42 }, text: '' }
    expect(resolveTemplate('{{json.n}}', p)).toBe(42)
  })

  it('单 {{expr}} 带空格 → 仍保留类型', () => {
    const p: WorkflowPayload = { json: { flag: true }, text: '' }
    expect(resolveTemplate('{{ json.flag }}', p)).toBe(true)
  })

  it('混排（文字 + {{}}）→ 返回字符串', () => {
    const p: WorkflowPayload = { json: { n: 42 }, text: '' }
    const result = resolveTemplate('value is {{json.n}}', p)
    expect(typeof result).toBe('string')
    expect(result).toBe('value is 42')
  })

  it('无 {{}} → 原样返回字符串', () => {
    expect(resolveTemplate('plain text', emptyPayload)).toBe('plain text')
  })

  it('$nodes 命名空间单 {{expr}} 保留原始类型', () => {
    const scope: InterpScope = {
      nodes: { n: { json: [1, 2, 3], text: '' } },
    }
    const result = resolveTemplate('{{$nodes.n.json}}', emptyPayload, scope)
    expect(result).toEqual([1, 2, 3])
    expect(Array.isArray(result)).toBe(true)
  })
})

// ── resolveNodeInputs 测试 ────────────────────────────────────────────────────

describe('resolveNodeInputs', () => {
  it('无 inputs → 返回 undefined', () => {
    const node = { inputs: [] } as unknown as WorkflowNode
    expect(resolveNodeInputs(node, emptyPayload, {})).toBeUndefined()
  })

  it('inputs 为 undefined → 返回 undefined', () => {
    const node = {} as WorkflowNode
    expect(resolveNodeInputs(node, emptyPayload, {})).toBeUndefined()
  })

  it('type=text：单 {{}} 仍强转为字符串', () => {
    const p: WorkflowPayload = { json: { n: 42 }, text: '' }
    const node = {
      inputs: [{ key: 'k', type: 'text', source: '{{json.n}}' }],
    } as unknown as WorkflowNode
    const result = resolveNodeInputs(node, p, {})
    expect(result).toEqual({ k: '42' })
  })

  it('type=number：字符串数字 → 数字', () => {
    const p: WorkflowPayload = { json: { n: '10' }, text: '' }
    const node = {
      inputs: [{ key: 'count', type: 'number', source: '{{json.n}}' }],
    } as unknown as WorkflowNode
    const result = resolveNodeInputs(node, p, {})
    expect(result).toEqual({ count: 10 })
  })

  it('type=boolean："true" → true', () => {
    const node = {
      inputs: [{ key: 'flag', type: 'boolean', source: 'true' }],
    } as unknown as WorkflowNode
    const result = resolveNodeInputs(node, emptyPayload, {})
    expect(result).toEqual({ flag: true })
  })

  it('type=json：JSON 字符串 → 解析后对象', () => {
    const node = {
      inputs: [{ key: 'data', type: 'json', source: '{"a":1}' }],
    } as unknown as WorkflowNode
    const result = resolveNodeInputs(node, emptyPayload, {})
    expect(result).toEqual({ data: { a: 1 } })
  })

  it('key 为空串 → 跳过', () => {
    const node = {
      inputs: [
        { key: '', type: 'text', source: 'val' },
        { key: 'ok', type: 'text', source: 'yes' },
      ],
    } as unknown as WorkflowNode
    const result = resolveNodeInputs(node, emptyPayload, {})
    expect(result).toEqual({ ok: 'yes' })
  })
})

// ── resolveEnvVars 测试 ───────────────────────────────────────────────────────

describe('resolveEnvVars', () => {
  it('字符串类型', () => {
    const result = resolveEnvVars([{ key: 'A', value: 'hello', type: 'string' }])
    expect(result).toEqual({ A: 'hello' })
  })

  it('number 类型', () => {
    const result = resolveEnvVars([{ key: 'N', value: '42', type: 'number' }])
    expect(result).toEqual({ N: 42 })
  })

  it('boolean 类型', () => {
    const result = resolveEnvVars([
      { key: 'T', value: 'true', type: 'boolean' },
      { key: 'F', value: 'false', type: 'boolean' },
    ])
    expect(result).toEqual({ T: true, F: false })
  })

  it('key 为空串 → 跳过', () => {
    const result = resolveEnvVars([{ key: '', value: 'x' }])
    expect(result).toEqual({})
  })

  it('无效数字 → 0', () => {
    const result = resolveEnvVars([{ key: 'X', value: 'not-a-number', type: 'number' }])
    expect(result).toEqual({ X: 0 })
  })
})
