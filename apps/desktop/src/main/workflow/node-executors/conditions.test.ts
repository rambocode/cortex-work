/**
 * conditions.ts 单元测试
 *
 * 覆盖 12 种 operator 的真值表，含 caseSensitive 处理。
 */
import { describe, it, expect } from 'vitest'
import { evaluateCondition } from './conditions.js'
import type { WorkflowPayload } from '../runtime/interp.js'

const payload: WorkflowPayload = { json: { num: 42, name: 'Hello' }, text: 'Hello World' }
const emptyPayload: WorkflowPayload = { json: {}, text: '' }

describe('evaluateCondition — contains / notContains', () => {
  it('contains：l.includes(r) → true', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'contains', rightValue: 'Hello', caseSensitive: true },
        payload
      )
    ).toBe(true)
  })

  it('contains：不含 → false', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'contains', rightValue: 'Bye', caseSensitive: true },
        payload
      )
    ).toBe(false)
  })

  it('contains caseSensitive=false：大小写不敏感', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'contains', rightValue: 'hello', caseSensitive: false },
        payload
      )
    ).toBe(true)
  })

  it('contains caseSensitive=true：大小写敏感', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'contains', rightValue: 'hello', caseSensitive: true },
        payload
      )
    ).toBe(false)
  })

  it('notContains：不含 → true', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'notContains', rightValue: 'Bye', caseSensitive: true },
        payload
      )
    ).toBe(true)
  })

  it('notContains：含 → false', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'notContains', rightValue: 'Hello', caseSensitive: true },
        payload
      )
    ).toBe(false)
  })
})

describe('evaluateCondition — equals / notEquals', () => {
  it('equals：完全匹配 → true', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'equals', rightValue: 'Hello World', caseSensitive: true },
        payload
      )
    ).toBe(true)
  })

  it('equals caseSensitive=false：小写匹配 → true', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'equals', rightValue: 'hello world', caseSensitive: false },
        payload
      )
    ).toBe(true)
  })

  it('equals caseSensitive=true：大小写不匹配 → false', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'equals', rightValue: 'hello world', caseSensitive: true },
        payload
      )
    ).toBe(false)
  })

  it('notEquals：不等 → true', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'notEquals', rightValue: 'other', caseSensitive: true },
        payload
      )
    ).toBe(true)
  })
})

describe('evaluateCondition — startsWith / endsWith', () => {
  it('startsWith → true', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'startsWith', rightValue: 'Hello', caseSensitive: true },
        payload
      )
    ).toBe(true)
  })

  it('startsWith caseSensitive=false → true', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'startsWith', rightValue: 'hello', caseSensitive: false },
        payload
      )
    ).toBe(true)
  })

  it('endsWith → true', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'endsWith', rightValue: 'World', caseSensitive: true },
        payload
      )
    ).toBe(true)
  })

  it('endsWith caseSensitive=false → true', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'endsWith', rightValue: 'world', caseSensitive: false },
        payload
      )
    ).toBe(true)
  })
})

describe('evaluateCondition — isEmpty / isNotEmpty', () => {
  it('isEmpty：空 text → true', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'isEmpty', rightValue: '', caseSensitive: true },
        emptyPayload
      )
    ).toBe(true)
  })

  it('isEmpty：非空 text → false', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'isEmpty', rightValue: '', caseSensitive: true },
        payload
      )
    ).toBe(false)
  })

  it('isNotEmpty：非空 → true', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'isNotEmpty', rightValue: '', caseSensitive: true },
        payload
      )
    ).toBe(true)
  })

  it('isNotEmpty：空 → false', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'isNotEmpty', rightValue: '', caseSensitive: true },
        emptyPayload
      )
    ).toBe(false)
  })
})

describe('evaluateCondition — gt / gte / lt / lte', () => {
  const numPayload: WorkflowPayload = { json: {}, text: '10' }

  it('gt 10 > 5 → true', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'gt', rightValue: '5', caseSensitive: true },
        numPayload
      )
    ).toBe(true)
  })

  it('gt 10 > 10 → false', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'gt', rightValue: '10', caseSensitive: true },
        numPayload
      )
    ).toBe(false)
  })

  it('gte 10 >= 10 → true', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'gte', rightValue: '10', caseSensitive: true },
        numPayload
      )
    ).toBe(true)
  })

  it('lt 10 < 20 → true', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'lt', rightValue: '20', caseSensitive: true },
        numPayload
      )
    ).toBe(true)
  })

  it('lt 10 < 5 → false', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'lt', rightValue: '5', caseSensitive: true },
        numPayload
      )
    ).toBe(false)
  })

  it('lte 10 <= 10 → true', () => {
    expect(
      evaluateCondition(
        { leftExpr: '', operator: 'lte', rightValue: '10', caseSensitive: true },
        numPayload
      )
    ).toBe(true)
  })
})

describe('evaluateCondition — leftExpr 解析', () => {
  it('leftExpr 为 $nodes.A.json 解析字段', () => {
    const p: WorkflowPayload = { json: {}, text: '' }
    const scope = {
      nodes: { A: { json: { score: 90 }, text: '90' } },
    }
    expect(
      evaluateCondition(
        { leftExpr: '$nodes.A.json.score', operator: 'gt', rightValue: '80', caseSensitive: true },
        p,
        scope
      )
    ).toBe(true)
  })

  it('leftExpr 非空时优先使用 resolveExpr', () => {
    const p: WorkflowPayload = { json: {}, text: 'wrong' }
    const scope = {
      env: { STATUS: 'active' },
    }
    expect(
      evaluateCondition(
        { leftExpr: '$env.STATUS', operator: 'equals', rightValue: 'active', caseSensitive: true },
        p,
        scope
      )
    ).toBe(true)
  })
})
