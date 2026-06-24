// 媒体生成配置解析（主进程）。
// 负责把 MediaGenSettings 中的 providerId（指向 ProviderProfile 或 'custom'）
// 解析为运行期所需的 baseUrl/apiKey/protocol/model 完整配置。
//
// 设计原则（对齐 Kun resolveKunImageGenerationSettings 等）：
//   - providerId 为空串或 'custom'：直接使用模态设置里的自填字段。
//   - providerId 有值：从 ProviderSettings.providers 中找对应 ProviderProfile，
//     继承其 apiKey/baseUrl；protocol/model 若模态设置有值则用，否则回退空串。
//   - 找不到 provider：抛出含诊断信息的 Error。
//   - 安全收口（KTD11）：baseUrl 必须 https://，apiKey 与 model 不可为空。

import type {
  MediaGenSettings,
  ProviderSettings,
  ImageGenSettings,
  SpeechGenSettings,
  MusicGenSettings,
  VideoGenSettings,
  ImageGenProtocol,
  SpeechGenProtocol,
  MusicGenProtocol,
  VideoGenProtocol,
} from "@cortex-work/core/desktop/types";

// ── 已解析的运行期配置 ────────────────────────────────────────────────────────

export interface ResolvedMediaGenConfig {
  baseUrl: string;
  apiKey: string;
  /** 协议标识，例如 'openai-images' | 'minimax-image' | 'minimax-video' 等。*/
  protocol: string;
  model: string;
  timeoutMs: number;
  // 模态特有字段（透传，由各协议实现按需读取）
  [key: string]: unknown;
}

// ── timeoutMs 上限（OQ1/KTD8） ───────────────────────────────────────────────
//
// 用户可在设置里把 timeoutMs 调到任意值，但必须钳制在看门狗阈值以下。
// cli.ts 的主进程看门狗（RUN_STALL_TIMEOUT_MS）默认 300s（inactivityMs），
// 若工具 timeoutMs > 300s，工具 AbortController 还未触发看门狗先把 session 杀掉，
// 之后主进程 poll 循环继续悬挂，导致资源泄漏。
// 留 10s 余量（290s），确保工具超时先于看门狗触发，poll 循环能正常退出。
export const MAX_TIMEOUT_MS = 290_000;

// ── 安全断言 ──────────────────────────────────────────────────────────────────

/**
 * 断言 baseUrl 以 https:// 开头。
 * KTD11：媒体 API baseUrl 必须走 HTTPS，防止凭证在明文信道泄漏。
 */
export function assertHttps(url: string): void {
  if (!url.startsWith("https://")) {
    throw new Error(`安全限制：baseUrl 必须为 https://，当前值: "${url}"`);
  }
}

// ── 内部辅助：从 ProviderSettings 查找 ProviderProfile ──────────────────────

function findProviderById(providerSettings: ProviderSettings, id: string) {
  return providerSettings.providers.find((p) => p.id === id);
}

// ── 各模态解析函数 ────────────────────────────────────────────────────────────

/**
 * 解析图片生成设置。
 *
 * 覆盖规格：
 *   - image 子设置中 providerId 为 '' 或 'custom' → 使用自填字段
 *   - 否则查 providerSettings 并继承 apiKey/baseUrl
 */
export function resolveImageGenConfig(
  imageSettings: ImageGenSettings,
  providerSettings: ProviderSettings,
): ResolvedMediaGenConfig {
  const { providerId, baseUrl, apiKey, protocol, model, timeoutMs, defaultSize } = imageSettings;

  if (!providerId || providerId === "custom") {
    // 自定义：直接用自填字段
    validateConfig(baseUrl, apiKey, model, "image");
    return { baseUrl, apiKey, protocol, model, timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS), defaultSize };
  }

  // 继承供应商
  const provider = findProviderById(providerSettings, providerId);
  if (!provider) {
    throw new Error(
      `找不到图片生成供应商（id="${providerId}"）。` +
      `已配置的供应商：${providerSettings.providers.map((p) => p.id).join(", ") || "（无）"}`,
    );
  }

  const resolvedBaseUrl = provider.baseUrl || baseUrl;
  const resolvedApiKey = provider.apiKey || apiKey;
  const resolvedModel = model || "";
  validateConfig(resolvedBaseUrl, resolvedApiKey, resolvedModel, "image");

  return {
    baseUrl: resolvedBaseUrl,
    apiKey: resolvedApiKey,
    protocol: (protocol as ImageGenProtocol) || "openai-images",
    model: resolvedModel,
    // 夹紧 timeoutMs，防止超过看门狗阈值导致 session 被杀后 poll 循环悬挂（OQ1/KTD8）。
    timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS),
    defaultSize,
  };
}

/**
 * 解析语音生成设置。
 */
export function resolveSpeechGenConfig(
  speechSettings: SpeechGenSettings,
  providerSettings: ProviderSettings,
): ResolvedMediaGenConfig {
  const { providerId, baseUrl, apiKey, protocol, model, timeoutMs, voice, format } = speechSettings;

  if (!providerId || providerId === "custom") {
    validateConfig(baseUrl, apiKey, model, "speech");
    return { baseUrl, apiKey, protocol, model, timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS), voice, format };
  }

  const provider = findProviderById(providerSettings, providerId);
  if (!provider) {
    throw new Error(
      `找不到语音生成供应商（id="${providerId}"）。` +
      `已配置的供应商：${providerSettings.providers.map((p) => p.id).join(", ") || "（无）"}`,
    );
  }

  const resolvedBaseUrl = provider.baseUrl || baseUrl;
  const resolvedApiKey = provider.apiKey || apiKey;
  const resolvedModel = model || "";
  validateConfig(resolvedBaseUrl, resolvedApiKey, resolvedModel, "speech");

  return {
    baseUrl: resolvedBaseUrl,
    apiKey: resolvedApiKey,
    protocol: (protocol as SpeechGenProtocol) || "openai-speech",
    model: resolvedModel,
    timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS),
    voice,
    format,
  };
}

/**
 * 解析音乐生成设置。
 */
export function resolveMusicGenConfig(
  musicSettings: MusicGenSettings,
  providerSettings: ProviderSettings,
): ResolvedMediaGenConfig {
  const { providerId, baseUrl, apiKey, protocol, model, timeoutMs, format } = musicSettings;

  if (!providerId || providerId === "custom") {
    validateConfig(baseUrl, apiKey, model, "music");
    return { baseUrl, apiKey, protocol, model, timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS), format };
  }

  const provider = findProviderById(providerSettings, providerId);
  if (!provider) {
    throw new Error(
      `找不到音乐生成供应商（id="${providerId}"）。` +
      `已配置的供应商：${providerSettings.providers.map((p) => p.id).join(", ") || "（无）"}`,
    );
  }

  const resolvedBaseUrl = provider.baseUrl || baseUrl;
  const resolvedApiKey = provider.apiKey || apiKey;
  const resolvedModel = model || "";
  validateConfig(resolvedBaseUrl, resolvedApiKey, resolvedModel, "music");

  return {
    baseUrl: resolvedBaseUrl,
    apiKey: resolvedApiKey,
    protocol: (protocol as MusicGenProtocol) || "minimax-music",
    model: resolvedModel,
    timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS),
    format,
  };
}

/**
 * 解析视频生成设置。
 */
export function resolveVideoGenConfig(
  videoSettings: VideoGenSettings,
  providerSettings: ProviderSettings,
): ResolvedMediaGenConfig {
  const {
    providerId, baseUrl, apiKey, protocol, model, timeoutMs,
    defaultDuration, defaultResolution, pollIntervalMs,
  } = videoSettings;

  if (!providerId || providerId === "custom") {
    validateConfig(baseUrl, apiKey, model, "video");
    return { baseUrl, apiKey, protocol, model, timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS), defaultDuration, defaultResolution, pollIntervalMs };
  }

  const provider = findProviderById(providerSettings, providerId);
  if (!provider) {
    throw new Error(
      `找不到视频生成供应商（id="${providerId}"）。` +
      `已配置的供应商：${providerSettings.providers.map((p) => p.id).join(", ") || "（无）"}`,
    );
  }

  const resolvedBaseUrl = provider.baseUrl || baseUrl;
  const resolvedApiKey = provider.apiKey || apiKey;
  const resolvedModel = model || "";
  validateConfig(resolvedBaseUrl, resolvedApiKey, resolvedModel, "video");

  return {
    baseUrl: resolvedBaseUrl,
    apiKey: resolvedApiKey,
    protocol: (protocol as VideoGenProtocol) || "minimax-video",
    model: resolvedModel,
    timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS),
    defaultDuration,
    defaultResolution,
    pollIntervalMs,
  };
}

// ── 统一入口 ──────────────────────────────────────────────────────────────────

/**
 * 解析指定模态的媒体生成配置。
 *
 * @param modality - 模态类型：'image' | 'speech' | 'music' | 'video'
 * @param mediaGenSettings - 来自持久化的完整媒体生成设置
 * @param providerSettings - 来自持久化的供应商设置
 */
export function resolveMediaGenSettings(
  modality: "image" | "speech" | "music" | "video",
  mediaGenSettings: MediaGenSettings,
  providerSettings: ProviderSettings,
): ResolvedMediaGenConfig {
  switch (modality) {
    case "image":
      return resolveImageGenConfig(mediaGenSettings.image, providerSettings);
    case "speech":
      return resolveSpeechGenConfig(mediaGenSettings.speech, providerSettings);
    case "music":
      return resolveMusicGenConfig(mediaGenSettings.music, providerSettings);
    case "video":
      return resolveVideoGenConfig(mediaGenSettings.video, providerSettings);
  }
}

// ── 内部校验 ──────────────────────────────────────────────────────────────────

function validateConfig(
  baseUrl: string,
  apiKey: string,
  model: string,
  modality: string,
): void {
  if (!baseUrl || !baseUrl.trim()) {
    throw new Error(`[${modality}] baseUrl 未配置`);
  }
  // KTD11：强制 https://
  assertHttps(baseUrl.trim());

  if (!apiKey || !apiKey.trim()) {
    throw new Error(`[${modality}] apiKey 未配置（unavailable）`);
  }
  if (!model || !model.trim()) {
    throw new Error(`[${modality}] model 未配置（unavailable）`);
  }
}
