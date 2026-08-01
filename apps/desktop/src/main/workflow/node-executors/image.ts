/**
 * 生成图片节点执行器（U13）。
 *
 * generate-image 节点：
 *   - 从 getPersistedState() 读取最新 mediaGenSettings（不缓存，支持用户改设置立即生效）。
 *   - enabled=false → 抛中文诊断错误，不发网络请求。
 *   - 节点 config 的 providerId/model 覆盖全局 mediaGenSettings.image，
 *     经 resolveMediaGenSettings 统一解析为 ResolvedMediaGenConfig。
 *   - 调 generateImage({prompt, size}, resolvedConfig, {workspaceRoot, signal})。
 *   - 产物落盘至 {workspaceRoot}/.cortex/media/images/{ts}-{hex}.png（由 generateImage 负责），
 *     节点从 result.files[0] 取路径写入输出，不另行写盘。
 *   - size 为空/undefined/'auto' 时不传（让 generateImage 使用 resolvedConfig.defaultSize 兜底）。
 *   - 节点层只传 signal，不叠加超时（generateImage 内部已有 AbortController，避免双层超时产生脏文件）。
 *
 * 输出 payload 格式（对齐 Kun generate-image 节点语义）：
 *   json: { imagePath: absolutePath, relativePath, mimeType, byteSize }
 *   text: relativePath
 */

import { getPersistedState } from '../../ipc/store.js'
import { resolveMediaGenSettings } from '../../capabilities/media-gen/resolve.js'
import { generateImage } from '../../capabilities/media-gen/client.js'
import type { ImageGenSettings } from '@cortex-work/core/desktop/types'
import type { WorkflowGenerateImageConfig } from '../types.js'
import type { WorkflowPayload, InterpScope } from '../runtime/interp.js'
import { interpolate } from '../runtime/interp.js'
import type { NodeOutcome } from './index.js'

/**
 * generate-image 节点执行器。
 *
 * @param config        节点配置（prompt / providerId / model / size / outputDir）
 * @param payload       上游 payload（供模板插值用）
 * @param scope         模板变量作用域
 * @param workspaceRoot 工作区根路径（来自 NodeExecutorDeps.workspaceRoot）
 * @param signal        取消信号（来自外部 cancelToken 或 RunContext）
 */
export async function executeGenerateImage(
  config: WorkflowGenerateImageConfig,
  payload: WorkflowPayload,
  scope: InterpScope,
  workspaceRoot: string | undefined,
  signal?: AbortSignal,
): Promise<NodeOutcome> {
  // workspaceRoot 必须存在：generate-image 需要把产物落盘到工作区内
  if (!workspaceRoot) {
    throw new Error(
      'generate-image 节点缺少工作区路径（workspaceRoot）。' +
      '请确保触发器节点已配置 config.workspaceRoot，或在通用设置中设定默认工作区。',
    )
  }

  // 每次节点执行时读最新设置，支持用户在会话中途改设置立即生效
  let state: Awaited<ReturnType<typeof getPersistedState>>
  try {
    state = await getPersistedState()
  } catch (e) {
    throw new Error(`generate-image 节点读取配置失败：${e instanceof Error ? e.message : String(e)}`)
  }

  // enabled 检查：用户未启用图片生成时降级报错，不发网络请求
  if (!state.mediaGenSettings?.image.enabled) {
    throw new Error('图片生成功能未启用，请在「设置 → 媒体生成」中启用「图片生成」后重试。')
  }

  const mediaGenSettings = state.mediaGenSettings

  // provider override 策略（KTD7）：
  // 节点 config 的 providerId/model 覆盖 mediaGenSettings.image，
  // 再经 resolveMediaGenSettings 统一解析（async：apiKey 可能是金库 `${secret:}` 引用），
  // 保留 https 校验与按模态 timeoutMs 钳制。
  const effectiveImageSettings = buildEffectiveImageSettings(config, mediaGenSettings.image)
  const resolvedConfig = await resolveMediaGenSettings(
    'image',
    { ...mediaGenSettings, image: effectiveImageSettings },
  )

  // prompt 经模板插值展开（使上游节点输出可注入 prompt）
  const prompt = interpolate(config.prompt, payload, scope).trim()
  if (!prompt) {
    throw new Error('generate-image 节点：插值后 prompt 为空，请检查节点配置。')
  }

  // size 为空/auto 时不传（generateImage 内部使用 resolvedConfig.defaultSize 兜底）
  const size = config.size && config.size !== 'auto' ? config.size : undefined

  // 节点层只传外部 signal，不叠加超时：generateImage 内部已有 AbortController+setTimeout，
  // 双层超时会导致外层先触发后 generateImage 内部仍在写盘，产生孤立脏文件（KTD8）。
  const result = await generateImage(
    { prompt, size },
    resolvedConfig,
    { workspaceRoot, signal },
  )

  const file = result.files[0]
  if (!file) {
    throw new Error('generate-image 节点：generateImage 返回空文件列表，图片生成失败。')
  }

  // 输出结构对齐 Kun generate-image 节点语义：
  //   json.imagePath  — 供后续节点引用图片的绝对路径（作为参考图、本地预览等）
  //   json.relativePath — 相对工作区的路径（供 Agent 引用、DSL 记录）
  //   json.mimeType / byteSize — 元数据
  //   text — 短路径表示，方便 template 节点直接插值
  const json: Record<string, unknown> = {
    imagePath: file.absolutePath,
    relativePath: file.relativePath,
    mimeType: file.mimeType,
    byteSize: file.byteSize,
  }

  return {
    payload: { json, text: file.relativePath },
    message: `图片生成完成（模型：${result.model}，耗时 ${result.durationMs}ms）：${file.relativePath}`,
  }
}

// ── 内部辅助：节点 config 覆盖全局设置 ──────────────────────────────────────────

/**
 * 用节点 config 的 providerId/model 覆盖全局 mediaGenSettings.image。
 *
 * 覆盖规则（KTD7）：
 *   - config.providerId 不为空 → 覆盖 providerId（走供应商继承路径）
 *   - config.model 不为空 → 覆盖 model
 *   - size 由调用方直接传给 generateImage，不写入设置
 *
 * 返回拷贝，不修改原始 globalImageSettings。
 */
function buildEffectiveImageSettings(
  config: WorkflowGenerateImageConfig,
  globalImageSettings: ImageGenSettings,
): ImageGenSettings {
  const effective: ImageGenSettings = { ...globalImageSettings }
  if (config.providerId && config.providerId.trim()) {
    effective.providerId = config.providerId.trim()
  }
  if (config.model && config.model.trim()) {
    effective.model = config.model.trim()
  }
  return effective
}
