/**
 * code.ts 单元测试（U11）
 *
 * 覆盖：
 *   code JS  — return 值成 payload；超 2s 超时；$json/$text 注入
 *   code bash — stdin/env 注入、stdout 解析；非零退出报错
 *   bash env 剥离 — spawn env 不含 host 密钥（核心安全测试）
 *   custom $fields — 按声明类型 coerce
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { executeCode, executeCustom } from './code.js'
import { registerModule, unregisterModule } from './modules.js'
import type { WorkflowPayload } from '../runtime/interp.js'

const p = (json: unknown, text = ''): WorkflowPayload => ({ json, text })

// ── JS code 节点 ─────────────────────────────────────────────────────────────

describe('executeCode (javascript)', () => {
  it('return object → 成为 payload.json', async () => {
    const result = await executeCode(
      { language: 'javascript', code: 'return { doubled: $json.x * 2 }' },
      p({ x: 5 })
    )
    expect(result.payload.json).toEqual({ doubled: 10 })
  })

  it('return string → payload.json = { value: str }', async () => {
    const result = await executeCode(
      { language: 'javascript', code: 'return "hello"' },
      p({})
    )
    expect(result.payload.json).toEqual({ value: 'hello' })
    expect(result.payload.text).toBe('hello')
  })

  it('return undefined → payload.json = {}', async () => {
    const result = await executeCode(
      { language: 'javascript', code: '// no return' },
      p({})
    )
    expect(result.payload.json).toEqual({})
  })

  it('$text 注入可读', async () => {
    const result = await executeCode(
      { language: 'javascript', code: 'return { got: $text }' },
      p({}, 'my-text-value')
    )
    expect((result.payload.json as { got: string }).got).toBe('my-text-value')
  })

  it('超 2s 抛 Code error（超时）', async () => {
    await expect(
      executeCode(
        { language: 'javascript', code: 'while(true){}' },
        p({})
      )
    ).rejects.toThrow('Code error')
  }, 6000) // 测试超时宽松一些

  it('语法错误 → 抛 Code error', async () => {
    await expect(
      executeCode(
        { language: 'javascript', code: 'return {{{broken' },
        p({})
      )
    ).rejects.toThrow('Code error')
  })
})

// ── Bash code 节点 ───────────────────────────────────────────────────────────

describe('executeCode (bash)', () => {
  it('echo JSON object → 解析为 json', async () => {
    const result = await executeCode(
      { language: 'bash', code: 'echo \'{"ok":true}\'' },
      p({})
    )
    expect(result.payload.json).toEqual({ ok: true })
  })

  it('echo plain text → payload.json = { text: ... }', async () => {
    const result = await executeCode(
      { language: 'bash', code: 'echo "just text"' },
      p({})
    )
    expect((result.payload.json as { text: string }).text).toContain('just text')
  })

  it('WORKFLOW_JSON env 注入可读', async () => {
    const result = await executeCode(
      { language: 'bash', code: 'echo $WORKFLOW_JSON' },
      p({ foo: 'bar' })
    )
    expect(result.payload.text).toContain('foo')
  })

  it('WORKFLOW_TEXT env 注入可读', async () => {
    const result = await executeCode(
      { language: 'bash', code: 'echo $WORKFLOW_TEXT' },
      p({}, 'the-text')
    )
    expect(result.payload.text).toContain('the-text')
  })

  it('非零退出 → 抛 Error', async () => {
    await expect(
      executeCode(
        { language: 'bash', code: 'exit 1' },
        p({})
      )
    ).rejects.toThrow('bash exited with code 1')
  })

  /**
   * ⚠️ 安全核心测试：env 剥离验证
   *
   * 设置一个假 ANTHROPIC_API_KEY 到 process.env，
   * 然后在 bash 脚本中读取它——应该为空（因为 spawn 不传 process.env）。
   * 这验证了 code.ts 中的安全约束：子进程 env 仅 WORKFLOW_* + PATH。
   */
  it('spawn env 不含 host 密钥（安全隔离验证）', async () => {
    const fakeKey = 'FAKE_SECRET_KEY_DO_NOT_LEAK'
    const originalValue = process.env[fakeKey]
    process.env[fakeKey] = 'super-secret-value-12345'

    try {
      // bash 脚本中 $FAKE_SECRET_KEY_DO_NOT_LEAK 应该为空（因为没传给子进程）
      // 使用独立 bash 直接读 env 变量
      const result2 = await executeCode(
        { language: 'bash', code: `if [ -z "$${fakeKey}" ]; then echo '{"leaked":false}'; else echo '{"leaked":true}'; fi` },
        p({})
      )
      expect((result2.payload.json as { leaked: boolean }).leaked).toBe(false)
    } finally {
      if (originalValue === undefined) {
        delete process.env[fakeKey]
      } else {
        process.env[fakeKey] = originalValue
      }
    }
  })
})

// ── custom 节点 ──────────────────────────────────────────────────────────────

describe('executeCustom', () => {
  const MODULE_ID = 'test-module-001'

  beforeEach(() => {
    registerModule({
      id: MODULE_ID,
      name: 'Test Module',
      description: 'test',
      icon: '',
      language: 'javascript',
      fields: [
        { key: 'strField', label: 'String', type: 'text', defaultValue: 'default', options: [], placeholder: '' },
        { key: 'numField', label: 'Number', type: 'number', defaultValue: '0', options: [], placeholder: '' },
        { key: 'boolField', label: 'Boolean', type: 'boolean', defaultValue: 'false', options: [], placeholder: '' },
      ],
      code: 'return { str: $fields.strField, num: $fields.numField, bool: $fields.boolField }',
    })
  })

  afterEach(() => {
    unregisterModule(MODULE_ID)
  })

  it('$fields 正确注入 JS 沙箱', async () => {
    const result = await executeCustom(
      {
        moduleId: MODULE_ID,
        values: { strField: 'hello', numField: '42', boolField: 'true' },
      },
      p({})
    )
    expect(result.payload.json).toEqual({ str: 'hello', num: 42, bool: true })
  })

  it('$fields number coerce 字符串 → number', async () => {
    const result = await executeCustom(
      { moduleId: MODULE_ID, values: { strField: '', numField: '3.14', boolField: 'false' } },
      p({})
    )
    expect((result.payload.json as { num: number }).num).toBeCloseTo(3.14)
  })

  it('$fields boolean coerce "1" → true', async () => {
    const result = await executeCustom(
      { moduleId: MODULE_ID, values: { strField: '', numField: '0', boolField: '1' } },
      p({})
    )
    expect((result.payload.json as { bool: boolean }).bool).toBe(true)
  })

  it('$fields 缺失 value → 用 defaultValue', async () => {
    const result = await executeCustom(
      { moduleId: MODULE_ID, values: {} },  // 不传任何 values
      p({})
    )
    // strField defaultValue='default', numField defaultValue='0', boolField defaultValue='false'
    expect((result.payload.json as { str: string }).str).toBe('default')
    expect((result.payload.json as { num: number }).num).toBe(0)
    expect((result.payload.json as { bool: boolean }).bool).toBe(false)
  })

  it('moduleId 不存在 → 抛 Error', async () => {
    await expect(
      executeCustom({ moduleId: 'nonexistent-module', values: {} }, p({}))
    ).rejects.toThrow('自定义模块未找到')
  })
})

// ── custom bash 模块 ─────────────────────────────────────────────────────────

describe('executeCustom (bash module)', () => {
  const BASH_MODULE_ID = 'test-bash-module'

  beforeEach(() => {
    registerModule({
      id: BASH_MODULE_ID,
      name: 'Bash Module',
      description: '',
      icon: '',
      language: 'bash',
      fields: [
        { key: 'greeting', label: 'Greeting', type: 'text', defaultValue: 'hello', options: [], placeholder: '' },
      ],
      code: 'FIELDS="$WORKFLOW_FIELDS"; echo "{\\"msg\\":\\"done\\"}"',
    })
  })

  afterEach(() => {
    unregisterModule(BASH_MODULE_ID)
  })

  it('bash 模块执行成功', async () => {
    const result = await executeCustom(
      { moduleId: BASH_MODULE_ID, values: { greeting: 'hi' } },
      p({})
    )
    expect(result.payload.json).toEqual({ msg: 'done' })
  })

  /**
   * bash custom 模块的 env 剥离测试：
   * WORKFLOW_FIELDS 包含 $fields，但不应包含 process.env 中的任意密钥。
   */
  it('bash custom 模块 env 也不含 host 密钥', async () => {
    const fakeKey = 'FAKE_CUSTOM_MODULE_SECRET'
    const original = process.env[fakeKey]
    process.env[fakeKey] = 'should-not-leak'

    try {
      registerModule({
        id: 'test-env-leak',
        name: 'env leak test',
        description: '',
        icon: '',
        language: 'bash',
        fields: [],
        code: `if [ -z "$${fakeKey}" ]; then echo '{"ok":true}'; else echo '{"ok":false}'; fi`,
      })

      const result = await executeCustom(
        { moduleId: 'test-env-leak', values: {} },
        p({})
      )
      expect((result.payload.json as { ok: boolean }).ok).toBe(true)
    } finally {
      unregisterModule('test-env-leak')
      if (original === undefined) {
        delete process.env[fakeKey]
      } else {
        process.env[fakeKey] = original
      }
    }
  })
})
