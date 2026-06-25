/**
 * node-executors/ai.ts 单元测试（U12）
 *
 * 覆盖：
 *   extractJsonObject：
 *     - 直接 JSON 对象 → 解析成功
 *     - JSON 对象混排文字 → 提取 {...} 成功
 *     - 非法 JSON → 明确抛错（含原始输出片段）
 *     - JSON 数组而非对象 → 抛错
 *
 *   extractCategoryId：
 *     - agent 输出精确 category.id → 匹配
 *     - agent 输出 JSON { "category": "..." } → 匹配
 *     - agent 输出 label（大小写不敏感）→ 匹配
 *     - 无匹配但有兜底 category → 返回兜底 id
 *     - 无匹配无兜底 → 明确抛错
 *
 *   executeAiAgent：
 *     - 正常路径：interpolate prompt → runPromptHeadless → 输出 {json:{text}, text}，threadId=sessionId
 *     - prompt 插值后为空 → 抛错
 *     - workspaceRoot 三级链：config.workspaceRoot → deps → resolveDefaultWorkspaceRoot
 *
 *   executeParameterExtractor：
 *     - 正常路径：mock 返回含 JSON → 解析出字段对象
 *     - 非法 JSON → 明确抛错（不返回空 payload 继续）
 *     - 强制 mode='agent'
 *
 *   executeQuestionClassifier：
 *     - 正常路径：mock 返回类别 id → branch=对应 category.id
 *     - categories 为空 → 抛错
 *     - 无匹配兜底（id='default'）
 *     - 无匹配无兜底 → 抛错
 *     - payload 透传（classifier 不修改 payload）
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunContext } from '../runtime/run-context.js'

// ── Mock 声明 ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  runPromptHeadless: vi.fn(),
  resolveDefaultWorkspaceRoot: vi.fn(() => Promise.resolve('/default/ws')),
}))

vi.mock('../run-prompt-headless.js', () => ({
  runPromptHeadless: mocks.runPromptHeadless,
  resolveDefaultWorkspaceRoot: mocks.resolveDefaultWorkspaceRoot,
}))

// 被测模块
import {
  extractJsonObject,
  extractCategoryId,
  executeAiAgent,
  executeParameterExtractor,
  executeQuestionClassifier,
} from './ai.js'

// ── 测试固件 ──────────────────────────────────────────────────────────────────

/** 最小 RunContext（空，不需要真实行为） */
function makeCtx(cancelled = false): RunContext {
  return {
    nodeOutputs: {},
    runVars: {},
    pendingApprovals: new Map(),
    cancelToken: { cancelled },
    executionBudget: { count: 0 },
    aiProcesses: new Map(),
  }
}

const emptyScope = {}
const p = (json: unknown = null, text = '') => ({ json, text })

// ── extractJsonObject ─────────────────────────────────────────────────────────

describe('extractJsonObject', () => {
  it('直接 JSON 对象 → 解析成功', () => {
    const result = extractJsonObject('{"name":"Alice","age":30}')
    expect(result).toEqual({ name: 'Alice', age: 30 })
  })

  it('JSON 对象前后有文字 → 提取 {...} 成功', () => {
    const result = extractJsonObject('好的，提取结果如下：\n{"name":"Bob"}\n完成。')
    expect(result).toEqual({ name: 'Bob' })
  })

  it('Markdown 代码块包裹 → 提取 {...} 成功', () => {
    const result = extractJsonObject('```json\n{"key":"val"}\n```')
    expect(result).toEqual({ key: 'val' })
  })

  it('非法 JSON → 明确抛错（含原始输出片段）', () => {
    expect(() => extractJsonObject('这不是 JSON')).toThrow('parameter-extractor 解析失败')
  })

  it('JSON 数组 → 抛错（预期对象，非数组）', () => {
    // 整体 parse 得到数组，不符合「对象」条件 → 策略2找不到 {...}，抛错
    expect(() => extractJsonObject('[1,2,3]')).toThrow('parameter-extractor 解析失败')
  })

  it('空输入 → 抛错', () => {
    expect(() => extractJsonObject('')).toThrow('parameter-extractor 解析失败')
  })

  it('嵌套对象 → 解析成功', () => {
    const result = extractJsonObject('{"user":{"name":"Carol"},"score":99}')
    expect(result).toEqual({ user: { name: 'Carol' }, score: 99 })
  })
})

// ── extractCategoryId ─────────────────────────────────────────────────────────

describe('extractCategoryId', () => {
  const cats = [
    { id: 'tech', label: '技术问题' },
    { id: 'billing', label: '账单问题' },
    { id: 'general', label: '一般咨询' },
  ]

  it('精确 id 匹配（agent 输出 "tech"）', () => {
    expect(extractCategoryId('tech', cats)).toBe('tech')
  })

  it('id 混排文字中 → 仍能匹配', () => {
    expect(extractCategoryId('分类结果是 billing', cats)).toBe('billing')
  })

  it('label 匹配（大小写不敏感）', () => {
    expect(extractCategoryId('技术问题', cats)).toBe('tech')
  })

  it('agent 输出 JSON { "category": "billing" } → 匹配', () => {
    expect(extractCategoryId('{"category":"billing"}', cats)).toBe('billing')
  })

  it('agent 输出 JSON { "categoryId": "general" } → 匹配', () => {
    expect(extractCategoryId('{"categoryId":"general"}', cats)).toBe('general')
  })

  it('无匹配但有 id=default 的兜底分类 → 返回 default', () => {
    const catsWithDefault = [...cats, { id: 'default', label: '其他' }]
    expect(extractCategoryId('无法识别的内容 xyz', catsWithDefault)).toBe('default')
  })

  it('无匹配但有 label 含「其他」的兜底 → 返回其 id', () => {
    const catsWithFallback = [...cats, { id: 'misc', label: '其他问题' }]
    expect(extractCategoryId('完全不匹配的内容', catsWithFallback)).toBe('misc')
  })

  it('无匹配无兜底 → 明确抛错', () => {
    expect(() =>
      extractCategoryId('xyz abc def', cats),
    ).toThrow('question-classifier 解析失败')
  })

  it('categories 匹配时返回 id 而非 label', () => {
    // 确保返回 id，不返回 label
    const result = extractCategoryId('技术问题', cats)
    expect(result).toBe('tech')
    expect(result).not.toBe('技术问题')
  })
})

// ── executeAiAgent ────────────────────────────────────────────────────────────

describe('executeAiAgent', () => {
  const baseConfig = {
    prompt: 'Hello {{text}}',
    workspaceRoot: '',
    providerId: 'claude',
    model: '',
    reasoningEffort: 'auto' as const,
    mode: 'agent' as const,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runPromptHeadless.mockResolvedValue({
      text: 'AI response',
      agentSessionId: 'session-123',
    })
    mocks.resolveDefaultWorkspaceRoot.mockResolvedValue('/default/ws')
  })

  it('正常路径：输出 json.text + payload.text，threadId=agentSessionId', async () => {
    const result = await executeAiAgent(
      baseConfig,
      p({}, 'world'),
      emptyScope,
      makeCtx(),
      '/deps/ws',
    )
    expect(result.payload.text).toBe('AI response')
    expect((result.payload.json as Record<string, unknown>)?.text).toBe('AI response')
    expect(result.threadId).toBe('session-123')
  })

  it('prompt 模板插值（{{text}} 展开为 payload.text）', async () => {
    await executeAiAgent(
      { ...baseConfig, prompt: '分析：{{text}}' },
      p({}, 'sample input'),
      emptyScope,
      makeCtx(),
      '/ws',
    )
    const callOpts = mocks.runPromptHeadless.mock.calls[0][0]
    expect(callOpts.prompt).toBe('分析：sample input')
  })

  it('prompt 插值后为空 → 抛错', async () => {
    await expect(
      executeAiAgent(
        { ...baseConfig, prompt: '   ' },
        p({}),
        emptyScope,
        makeCtx(),
        '/ws',
      ),
    ).rejects.toThrow('prompt 为空')
  })

  it('workspaceRoot 三级链：config.workspaceRoot（非空）优先', async () => {
    await executeAiAgent(
      { ...baseConfig, workspaceRoot: '/config/ws' },
      p({}),
      emptyScope,
      makeCtx(),
      '/deps/ws',
    )
    const callOpts = mocks.runPromptHeadless.mock.calls[0][0]
    expect(callOpts.workspaceRoot).toBe('/config/ws')
  })

  it('workspaceRoot 三级链：config 为空时用 deps.workspaceRoot', async () => {
    await executeAiAgent(
      { ...baseConfig, workspaceRoot: '' },
      p({}),
      emptyScope,
      makeCtx(),
      '/deps/ws',
    )
    const callOpts = mocks.runPromptHeadless.mock.calls[0][0]
    expect(callOpts.workspaceRoot).toBe('/deps/ws')
  })

  it('workspaceRoot 三级链：config 与 deps 均为空时用 resolveDefaultWorkspaceRoot', async () => {
    await executeAiAgent(
      { ...baseConfig, workspaceRoot: '' },
      p({}),
      emptyScope,
      makeCtx(),
      undefined,
    )
    const callOpts = mocks.runPromptHeadless.mock.calls[0][0]
    expect(callOpts.workspaceRoot).toBe('/default/ws')
  })

  it('传入正确的 providerId/model/mode/reasoningEffort', async () => {
    await executeAiAgent(
      {
        ...baseConfig,
        prompt: 'test',
        providerId: 'codex',
        model: 'gpt-4',
        mode: 'plan',
        reasoningEffort: 'high',
      },
      p({}),
      emptyScope,
      makeCtx(),
      '/ws',
    )
    const callOpts = mocks.runPromptHeadless.mock.calls[0][0]
    expect(callOpts.providerId).toBe('codex')
    expect(callOpts.model).toBe('gpt-4')
    expect(callOpts.mode).toBe('plan')
    expect(callOpts.reasoningEffort).toBe('high')
  })

  it('runPromptHeadless 抛错 → 透传', async () => {
    mocks.runPromptHeadless.mockRejectedValue(new Error('spawn 失败'))
    await expect(
      executeAiAgent(baseConfig, p({}), emptyScope, makeCtx(), '/ws'),
    ).rejects.toThrow('spawn 失败')
  })
})

// ── executeParameterExtractor ─────────────────────────────────────────────────

describe('executeParameterExtractor', () => {
  const baseConfig = {
    source: '',
    instruction: '',
    fields: [
      { key: 'name', label: '姓名', type: 'text' as const, required: true, options: [], defaultValue: '', description: '' },
      { key: 'age', label: '年龄', type: 'number' as const, required: false, options: [], defaultValue: '', description: '' },
    ],
    providerId: 'claude',
    model: '',
    reasoningEffort: 'auto' as const,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveDefaultWorkspaceRoot.mockResolvedValue('/default/ws')
  })

  it('正常路径：mock 返回含 JSON → 解析出字段对象', async () => {
    mocks.runPromptHeadless.mockResolvedValue({
      text: '{"name":"Alice","age":30}',
      agentSessionId: 'sess-456',
    })

    const result = await executeParameterExtractor(
      baseConfig,
      p({}, 'Alice is 30 years old'),
      emptyScope,
      makeCtx(),
      '/ws',
    )
    expect(result.payload.json).toEqual({ name: 'Alice', age: 30 })
    expect(result.threadId).toBe('sess-456')
  })

  it('解析出的 json 以 JSON.stringify 形式写入 payload.text', async () => {
    mocks.runPromptHeadless.mockResolvedValue({
      text: '{"name":"Bob"}',
    })

    const result = await executeParameterExtractor(
      baseConfig,
      p({}),
      emptyScope,
      makeCtx(),
      '/ws',
    )
    expect(typeof result.payload.text).toBe('string')
    expect(JSON.parse(result.payload.text)).toEqual({ name: 'Bob' })
  })

  it('非法 JSON → 明确抛错（不返回空 payload）', async () => {
    mocks.runPromptHeadless.mockResolvedValue({
      text: '我无法提取结构化数据',
    })

    await expect(
      executeParameterExtractor(baseConfig, p({}), emptyScope, makeCtx(), '/ws'),
    ).rejects.toThrow('parameter-extractor 解析失败')
  })

  it('强制 mode="agent"（不管 config 是否有 mode 字段）', async () => {
    mocks.runPromptHeadless.mockResolvedValue({ text: '{"name":"test"}' })

    await executeParameterExtractor(baseConfig, p({}), emptyScope, makeCtx(), '/ws')
    const callOpts = mocks.runPromptHeadless.mock.calls[0][0]
    expect(callOpts.mode).toBe('agent')
  })

  it('source 字段展开为上游 payload.text（当 source 为空时）', async () => {
    mocks.runPromptHeadless.mockResolvedValue({ text: '{"name":"Carol"}' })

    await executeParameterExtractor(
      { ...baseConfig, source: '' },
      p({}, 'Carol is a test name'),
      emptyScope,
      makeCtx(),
      '/ws',
    )
    const callOpts = mocks.runPromptHeadless.mock.calls[0][0]
    // prompt 中应含 payload.text
    expect(callOpts.prompt).toContain('Carol is a test name')
  })

  it('fields schema 出现在 prompt 中（key/label/required）', async () => {
    mocks.runPromptHeadless.mockResolvedValue({ text: '{"name":"x"}' })

    await executeParameterExtractor(baseConfig, p({}), emptyScope, makeCtx(), '/ws')
    const callOpts = mocks.runPromptHeadless.mock.calls[0][0]
    expect(callOpts.prompt).toContain('name')
    expect(callOpts.prompt).toContain('age')
    expect(callOpts.prompt).toContain('必填')
  })
})

// ── executeQuestionClassifier ─────────────────────────────────────────────────

describe('executeQuestionClassifier', () => {
  const categories = [
    { id: 'tech', label: '技术问题' },
    { id: 'billing', label: '账单问题' },
    { id: 'general', label: '一般咨询' },
  ]

  const baseConfig = {
    source: '',
    instruction: '',
    categories,
    providerId: 'claude',
    model: '',
    reasoningEffort: 'auto' as const,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveDefaultWorkspaceRoot.mockResolvedValue('/default/ws')
  })

  it('正常路径：mock 返回 "tech" → branch="tech"', async () => {
    mocks.runPromptHeadless.mockResolvedValue({ text: 'tech', agentSessionId: 'cls-001' })

    const result = await executeQuestionClassifier(
      baseConfig,
      p({}, 'I have a technical issue'),
      emptyScope,
      makeCtx(),
      '/ws',
    )
    expect(result.branch).toBe('tech')
    expect(result.threadId).toBe('cls-001')
  })

  it('payload 透传（classifier 不修改 payload）', async () => {
    mocks.runPromptHeadless.mockResolvedValue({ text: 'billing' })

    const inputPayload = p({ original: 'data' }, 'payment question')
    const result = await executeQuestionClassifier(
      baseConfig,
      inputPayload,
      emptyScope,
      makeCtx(),
      '/ws',
    )
    // payload 与输入完全相同（不修改）
    expect(result.payload).toBe(inputPayload)
  })

  it('categories 为空 → 抛错', async () => {
    await expect(
      executeQuestionClassifier(
        { ...baseConfig, categories: [] },
        p({}),
        emptyScope,
        makeCtx(),
        '/ws',
      ),
    ).rejects.toThrow('categories 为空')
  })

  it('无匹配兜底（id="default"）→ 返回 "default"', async () => {
    const catsWithDefault = [...categories, { id: 'default', label: '其他' }]
    mocks.runPromptHeadless.mockResolvedValue({ text: '完全无法识别的分类 xyz' })

    const result = await executeQuestionClassifier(
      { ...baseConfig, categories: catsWithDefault },
      p({}),
      emptyScope,
      makeCtx(),
      '/ws',
    )
    expect(result.branch).toBe('default')
  })

  it('无匹配无兜底 → 明确抛错', async () => {
    mocks.runPromptHeadless.mockResolvedValue({ text: '完全不存在的类别 xyz' })

    await expect(
      executeQuestionClassifier(baseConfig, p({}), emptyScope, makeCtx(), '/ws'),
    ).rejects.toThrow('question-classifier 解析失败')
  })

  it('强制 mode="agent"', async () => {
    mocks.runPromptHeadless.mockResolvedValue({ text: 'general' })

    await executeQuestionClassifier(baseConfig, p({}), emptyScope, makeCtx(), '/ws')
    const callOpts = mocks.runPromptHeadless.mock.calls[0][0]
    expect(callOpts.mode).toBe('agent')
  })

  it('categories 列表出现在 prompt 中', async () => {
    mocks.runPromptHeadless.mockResolvedValue({ text: 'tech' })

    await executeQuestionClassifier(baseConfig, p({}), emptyScope, makeCtx(), '/ws')
    const callOpts = mocks.runPromptHeadless.mock.calls[0][0]
    expect(callOpts.prompt).toContain('tech')
    expect(callOpts.prompt).toContain('技术问题')
    expect(callOpts.prompt).toContain('billing')
  })

  it('agentSessionId 映射到 threadId', async () => {
    mocks.runPromptHeadless.mockResolvedValue({ text: 'general', agentSessionId: 'sess-cls' })

    const result = await executeQuestionClassifier(
      baseConfig,
      p({}),
      emptyScope,
      makeCtx(),
      '/ws',
    )
    expect(result.threadId).toBe('sess-cls')
  })
})
