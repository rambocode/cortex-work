/**
 * image.ts 单元测试（U13）
 *
 * 覆盖：
 *   - 正常路径：generateImage 返回文件 → 输出 json.imagePath/relativePath/mimeType/byteSize，text=relativePath
 *   - enabled=false → 抛「未启用」错误
 *   - workspaceRoot 缺失 → 抛错
 *   - getPersistedState 失败 → 抛包装错误
 *   - resolveMediaGenSettings 抛错（apiKey 未配置）→ 透传 e.message
 *   - 节点 config providerId/model 覆盖全局 mediaGenSettings.image
 *   - size='auto'/'' → 不传 size 给 generateImage（传 undefined）
 *   - size 有值 → 透传给 generateImage
 *   - prompt 支持模板插值（{{$input.text}}）
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerateMediaResult } from '../../capabilities/media-gen/client.js'
import type { WorkflowGenerateImageConfig } from '../types.js'
import type { WorkflowPayload } from '../runtime/interp.js'

// ── Mock 声明（vi.hoisted 确保变量在 vi.mock 工厂之前可用） ──────────────────────

const mocks = vi.hoisted(() => ({
  getPersistedState: vi.fn(),
  resolveMediaGenSettings: vi.fn(),
  generateImage: vi.fn(),
}))

vi.mock('../../ipc/store.js', () => ({
  getPersistedState: mocks.getPersistedState,
}))

vi.mock('../../capabilities/media-gen/resolve.js', () => ({
  resolveMediaGenSettings: mocks.resolveMediaGenSettings,
}))

vi.mock('../../capabilities/media-gen/client.js', () => ({
  generateImage: mocks.generateImage,
}))

// 被测模块在 mock 之后导入（Vitest 静态 hoisting 保证 mock 先注册）
import { executeGenerateImage } from './image.js'

// ── 测试固件 ───────────────────────────────────────────────────────────────────

const WORKSPACE = '/test/workspace'

const mockFile = {
  relativePath: '.cortex/media/images/123-ab.png',
  absolutePath: '/test/workspace/.cortex/media/images/123-ab.png',
  mimeType: 'image/png',
  byteSize: 1024,
}

const mockGenerateResult: GenerateMediaResult = {
  files: [mockFile],
  model: 'dall-e-3',
  durationMs: 500,
}

// 基础 mediaGenSettings（image.enabled=true）
const baseMediaGenSettings = {
  image: {
    enabled: true,
    providerId: '',
    protocol: 'openai-images',
    baseUrl: 'https://api.openai.com',
    apiKey: 'sk-global',
    model: 'dall-e-3',
    defaultSize: '1024x1024',
    timeoutMs: 180_000,
  },
  speech: {} as never,
  music: {} as never,
  video: {} as never,
}

const mockResolvedConfig = {
  baseUrl: 'https://api.openai.com',
  apiKey: 'sk-global',
  protocol: 'openai-images',
  model: 'dall-e-3',
  timeoutMs: 180_000,
  defaultSize: '1024x1024',
}

// 辅助：构造空作用域
const emptyScope = {}

// 辅助：构造 payload
const p = (json: unknown, text = ''): WorkflowPayload => ({ json, text })

// 辅助：最小合法 config
const baseConfig = (override?: Partial<WorkflowGenerateImageConfig>): WorkflowGenerateImageConfig => ({
  prompt: 'a cat on a cloud',
  providerId: '',
  model: '',
  size: '',
  outputDir: '',
  ...override,
})

// ── beforeEach：重置所有 mock ──────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()

  mocks.getPersistedState.mockResolvedValue({
    mediaGenSettings: baseMediaGenSettings,
    providerSettings: { providers: [] },
  })
  mocks.resolveMediaGenSettings.mockReturnValue(mockResolvedConfig)
  mocks.generateImage.mockResolvedValue(mockGenerateResult)
})

// ── 正常路径 ───────────────────────────────────────────────────────────────────

describe('executeGenerateImage 正常路径', () => {
  it('返回正确的 payload（imagePath/relativePath/mimeType/byteSize/text）', async () => {
    const result = await executeGenerateImage(
      baseConfig(),
      p({}),
      emptyScope,
      WORKSPACE,
    )
    expect(result.payload.json).toEqual({
      imagePath: mockFile.absolutePath,
      relativePath: mockFile.relativePath,
      mimeType: mockFile.mimeType,
      byteSize: mockFile.byteSize,
    })
    expect(result.payload.text).toBe(mockFile.relativePath)
  })

  it('message 包含模型名与耗时', async () => {
    const result = await executeGenerateImage(baseConfig(), p({}), emptyScope, WORKSPACE)
    expect(result.message).toContain('dall-e-3')
    expect(result.message).toContain('500ms')
    expect(result.message).toContain(mockFile.relativePath)
  })

  it('调用 generateImage 时传入正确的 prompt 与 workspaceRoot', async () => {
    await executeGenerateImage(baseConfig({ prompt: 'a red fox' }), p({}), emptyScope, WORKSPACE)
    expect(mocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a red fox' }),
      mockResolvedConfig,
      expect.objectContaining({ workspaceRoot: WORKSPACE }),
    )
  })
})

// ── size 参数 ─────────────────────────────────────────────────────────────────

describe('size 参数处理', () => {
  it("size='' 时不传 size（传 undefined 给 generateImage）", async () => {
    await executeGenerateImage(baseConfig({ size: '' }), p({}), emptyScope, WORKSPACE)
    const [args] = mocks.generateImage.mock.calls[0]
    expect(args.size).toBeUndefined()
  })

  it("size='auto' 时不传 size（传 undefined 给 generateImage）", async () => {
    await executeGenerateImage(baseConfig({ size: 'auto' }), p({}), emptyScope, WORKSPACE)
    const [args] = mocks.generateImage.mock.calls[0]
    expect(args.size).toBeUndefined()
  })

  it("size='1024x1024' 时透传 size", async () => {
    await executeGenerateImage(baseConfig({ size: '1024x1024' }), p({}), emptyScope, WORKSPACE)
    const [args] = mocks.generateImage.mock.calls[0]
    expect(args.size).toBe('1024x1024')
  })
})

// ── prompt 模板插值 ────────────────────────────────────────────────────────────

describe('prompt 模板插值', () => {
  it('{{text}} 插值为上游 payload.text（裸路径表达式）', async () => {
    // {{text}} 读取 payload.text（不需要 scope.input）
    const payload = p({}, 'a moonlit lake')
    await executeGenerateImage(
      baseConfig({ prompt: '{{text}} at sunset' }),
      payload,
      emptyScope,
      WORKSPACE,
    )
    const [args] = mocks.generateImage.mock.calls[0]
    expect(args.prompt).toBe('a moonlit lake at sunset')
  })

  it('$input.key 插值需要 scope.input', async () => {
    // 通过 scope.input 注入，用于 node inputs 绑定场景
    const scopeWithInput = { input: { desc: 'a dragon in fog' } }
    await executeGenerateImage(
      baseConfig({ prompt: '{{$input.desc}}' }),
      p({}),
      scopeWithInput,
      WORKSPACE,
    )
    const [args] = mocks.generateImage.mock.calls[0]
    expect(args.prompt).toBe('a dragon in fog')
  })
})

// ── provider override ─────────────────────────────────────────────────────────

describe('provider override', () => {
  it('节点 config.providerId 覆盖全局 mediaGenSettings.image.providerId', async () => {
    await executeGenerateImage(
      baseConfig({ providerId: 'my-provider' }),
      p({}),
      emptyScope,
      WORKSPACE,
    )
    // resolveMediaGenSettings 第二参数的 image.providerId 应已被覆盖
    const [, callMediaGenSettings] = mocks.resolveMediaGenSettings.mock.calls[0]
    expect(callMediaGenSettings.image.providerId).toBe('my-provider')
  })

  it('节点 config.model 覆盖全局 mediaGenSettings.image.model', async () => {
    await executeGenerateImage(
      baseConfig({ model: 'dall-e-2' }),
      p({}),
      emptyScope,
      WORKSPACE,
    )
    const [, callMediaGenSettings] = mocks.resolveMediaGenSettings.mock.calls[0]
    expect(callMediaGenSettings.image.model).toBe('dall-e-2')
  })

  it('覆盖 providerId 后，全局其他字段（apiKey/baseUrl）保持不变', async () => {
    await executeGenerateImage(
      baseConfig({ providerId: 'override-id' }),
      p({}),
      emptyScope,
      WORKSPACE,
    )
    const [, callMediaGenSettings] = mocks.resolveMediaGenSettings.mock.calls[0]
    // apiKey 和 baseUrl 来自全局 mediaGenSettings.image（未被覆盖）
    expect(callMediaGenSettings.image.apiKey).toBe('sk-global')
    expect(callMediaGenSettings.image.baseUrl).toBe('https://api.openai.com')
  })

  it('resolveMediaGenSettings 使用 modality="image" 调用', async () => {
    await executeGenerateImage(baseConfig(), p({}), emptyScope, WORKSPACE)
    const [modality] = mocks.resolveMediaGenSettings.mock.calls[0]
    expect(modality).toBe('image')
  })
})

// ── 错误路径 ───────────────────────────────────────────────────────────────────

describe('错误路径', () => {
  it('workspaceRoot 缺失 → 抛错', async () => {
    await expect(
      executeGenerateImage(baseConfig(), p({}), emptyScope, undefined),
    ).rejects.toThrow('workspaceRoot')
  })

  it('image.enabled=false → 抛「未启用」错误', async () => {
    mocks.getPersistedState.mockResolvedValue({
      mediaGenSettings: {
        ...baseMediaGenSettings,
        image: { ...baseMediaGenSettings.image, enabled: false },
      },
      providerSettings: { providers: [] },
    })
    await expect(
      executeGenerateImage(baseConfig(), p({}), emptyScope, WORKSPACE),
    ).rejects.toThrow('未启用')
  })

  it('mediaGenSettings 不存在 → 抛「未启用」错误', async () => {
    mocks.getPersistedState.mockResolvedValue({ providerSettings: { providers: [] } })
    await expect(
      executeGenerateImage(baseConfig(), p({}), emptyScope, WORKSPACE),
    ).rejects.toThrow('未启用')
  })

  it('getPersistedState 抛错 → 包装后透传', async () => {
    mocks.getPersistedState.mockRejectedValue(new Error('disk read error'))
    await expect(
      executeGenerateImage(baseConfig(), p({}), emptyScope, WORKSPACE),
    ).rejects.toThrow('disk read error')
  })

  it('resolveMediaGenSettings 抛错（apiKey 未配置）→ 透传 e.message', async () => {
    mocks.resolveMediaGenSettings.mockImplementation(() => {
      throw new Error('[image] apiKey 未配置（unavailable）')
    })
    await expect(
      executeGenerateImage(baseConfig(), p({}), emptyScope, WORKSPACE),
    ).rejects.toThrow('[image] apiKey 未配置（unavailable）')
  })

  it('generateImage 抛错 → 透传', async () => {
    mocks.generateImage.mockRejectedValue(new Error('network timeout'))
    await expect(
      executeGenerateImage(baseConfig(), p({}), emptyScope, WORKSPACE),
    ).rejects.toThrow('network timeout')
  })

  it('prompt 插值后为空 → 抛「prompt 为空」错误', async () => {
    // 用一个不会展开的表达式但 trim 后是空
    await expect(
      executeGenerateImage(baseConfig({ prompt: '   ' }), p({}), emptyScope, WORKSPACE),
    ).rejects.toThrow('prompt 为空')
  })
})
