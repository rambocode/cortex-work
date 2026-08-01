// 媒体生成配置解析（主进程）。
// 把 MediaGenSettings 中的 providerId 解析为运行期所需的 baseUrl/apiKey/protocol/model 完整配置。
//
// 解析优先级（设计 §4.1/4.2，对齐 Kun resolveKunImageGenerationSettings 语义）：
//   - providerId 为空串或 'custom'（自定义路径）：protocol/baseUrl/model 用自填字段；
//     apiKey 若是 `${secret:NAME}` 引用则从 safeStorage 金库解密，历史明文直用（迁移窗口期兼容）。
//   - providerId 命中媒体供应商目录（目录路径）：protocol **以目录 capability 为准**（设置里的
//     protocol 字段忽略——UI 会同步写但目录是权威）；baseUrl 自填非空可覆盖端点，否则用目录值；
//     model 自填优先、空则回落 capability.models[0]；apiKey 按目录条目 kind 取金库
//     credential（catalog）或命名 Secret（standalone）。
//   - 找不到目录条目 / 条目无该模态能力：抛含引导信息的 Error。
//   - 安全收口（KTD11）：baseUrl 必须 https://，apiKey 与 model 不可为空。
//
// ⚠️ 错误文案红线：resolve 抛出的 Error message 会经 MCP tool result 透传给模型与 UI，
// **绝不允许拼入 apiKey / secret 真值**；包装底层异常时一律过 safeErrorMessage 清洗。

import type { MediaGenSettings } from "../../ipc/types";
import { MAX_TIMEOUT_MS_BY_MODALITY } from "../../ipc/types";
import {
  findMediaProvider,
  mediaCapabilityOf,
  type MediaModality,
  type MediaProviderEntry,
} from "@cortex-work/core/desktop/media-provider-directory";
import { readSecrets, readStoredCredential } from "../../providers/credentials";
import { collectSecretRefs, resolveSecretRefs, safeErrorMessage } from "../../providers/secrets";

// ── 已解析的运行期配置 ────────────────────────────────────────────────────────

export interface ResolvedMediaGenConfig {
  baseUrl: string;
  /** 已解密明文；仅主进程内存活，绝不过桥 / 进日志 / 拼进错误信息。*/
  apiKey: string;
  /** 协议标识，例如 'openai-images' | 'minimax-image' | 'volcengine-ark-video' 等。*/
  protocol: string;
  model: string;
  /** 已按 MAX_TIMEOUT_MS_BY_MODALITY 钳制。*/
  timeoutMs: number;
  // 模态特有字段（透传，由各协议实现按需读取）
  [key: string]: unknown;
}

/** 错误文案里的模态中文名。*/
const MODALITY_LABEL: Record<MediaModality, string> = {
  image: "图片",
  speech: "语音",
  music: "音乐",
  video: "视频",
};

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

// ── 密钥解析 ──────────────────────────────────────────────────────────────────

/** 金库读取失败的统一包装：底层异常可能含系统细节，过 safeErrorMessage 后再外泄。*/
async function readSecretsSafe(modality: MediaModality): Promise<Record<string, string>> {
  try {
    return await readSecrets();
  } catch (err) {
    throw new Error(`[${modality}] 读取密钥金库失败：${safeErrorMessage(err)}`);
  }
}

/**
 * 自定义路径的 apiKey 解密。
 *
 * 历史明文兼容（迁移窗口期）：首启迁移 migrateMediaGenPlaintextKeys 尚未跑完
 * （或 safeStorage 不可用被跳过）时，持久化里可能仍是明文 key——直接使用、不报错，
 * 保证老用户升级后媒体生成不断档；迁移收敛后此分支只剩「空串」与「引用」两态。
 */
async function resolveCustomApiKey(rawApiKey: string, modality: MediaModality): Promise<string> {
  // 无 `${secret:}` 引用 → 明文（或空串）直用，不触碰金库。
  if (collectSecretRefs(rawApiKey).length === 0) return rawApiKey;
  const secrets = await readSecretsSafe(modality);
  const { text, missing } = resolveSecretRefs(rawApiKey, secrets);
  if (missing.length > 0) {
    throw new Error(
      `[${modality}] 密钥引用 ${missing.join("、")} 未在金库中定义，` +
        "请在「设置 → 媒体生成」中重新输入密钥。",
    );
  }
  return text;
}

/**
 * 目录路径的 apiKey 取用，按条目 kind 分流：
 *   - catalog：复用「Provider 设置」页配置的金库 credential（与文本侧同一把 key）。
 *     OAuth 拒绝原因：媒体 API 走的是各家开放平台的 API Key 鉴权，OAuth token 属 pi 文本
 *     授权域（如 grok-subscription 仅覆盖 chat），跨域复用既不可行也涉合规灰区（设计 §2.3）。
 *   - standalone：pi 目录没有的媒体专用供应商（volcengine），key 存金库命名 Secret，
 *     由媒体生成设置页内联输入。
 */
async function resolveDirectoryApiKey(entry: MediaProviderEntry, modality: MediaModality): Promise<string> {
  if (entry.kind === "catalog") {
    let credential;
    try {
      credential = await readStoredCredential(entry.id);
    } catch (err) {
      throw new Error(`[${modality}] 读取密钥金库失败：${safeErrorMessage(err)}`);
    }
    if (!credential) {
      throw new Error(
        `[${modality}] Provider「${entry.name}」未配置密钥，请到「设置 → Provider」中配置 API Key。`,
      );
    }
    // pi Credential 的 key 理论上必填；空值兜成空串，由 validateConfig 统一报「apiKey 未配置」。
    if (credential.type === "api_key") return credential.key ?? "";
    throw new Error(
      `[${modality}] Provider「${entry.name}」当前以 OAuth 登录，媒体生成暂只支持 API Key，` +
        "请在「设置 → Provider」中改用 API Key。",
    );
  }
  // standalone：secretName 是目录数据契约（media-provider-directory.ts），缺失属数据错误。
  const secretName = entry.secretName;
  if (!secretName) {
    throw new Error(`[${modality}] 媒体供应商目录条目「${entry.id}」缺少 secretName（目录数据错误）`);
  }
  const secrets = await readSecretsSafe(modality);
  const value = secrets[secretName];
  if (!value) {
    throw new Error(
      `[${modality}] 供应商「${entry.name}」未配置密钥，请在「设置 → 媒体生成」中填写 API Key。`,
    );
  }
  return value;
}

// ── 模态特有字段透传 ──────────────────────────────────────────────────────────

/** 各模态透传给协议实现的特有字段（image 的尺寸/画质优先级由 MCP 层执行，见 §4.4）。*/
function extraFieldsOf(modality: MediaModality, settings: MediaGenSettings): Record<string, unknown> {
  switch (modality) {
    case "image": {
      const { quality, defaultResolution, defaultSize } = settings.image;
      return { quality, defaultResolution, defaultSize };
    }
    case "speech": {
      const { voice, format } = settings.speech;
      return { voice, format };
    }
    case "music":
      return { format: settings.music.format };
    case "video": {
      const { defaultDuration, defaultResolution, pollIntervalMs } = settings.video;
      return { defaultDuration, defaultResolution, pollIntervalMs };
    }
  }
}

// ── 统一入口 ──────────────────────────────────────────────────────────────────

/**
 * 解析指定模态的媒体生成配置（async：apiKey 需从 safeStorage 金库解密）。
 *
 * @param modality - 模态类型：'image' | 'speech' | 'music' | 'video'
 * @param mediaGenSettings - 来自持久化的完整媒体生成设置
 */
export async function resolveMediaGenSettings(
  modality: MediaModality,
  mediaGenSettings: MediaGenSettings,
): Promise<ResolvedMediaGenConfig> {
  const settings = mediaGenSettings[modality];
  // 夹紧 timeoutMs：按模态上限钳制（表与 normalize / 设置 UI 共用，防止超过渲染端
  // 看门狗阈值导致 session 被杀后 poll 循环悬挂——依据见 ipc/types.ts 表头注释）。
  const timeoutMs = Math.min(settings.timeoutMs, MAX_TIMEOUT_MS_BY_MODALITY[modality]);
  const extras = extraFieldsOf(modality, mediaGenSettings);

  // 自定义路径：全部用自填字段。
  if (!settings.providerId || settings.providerId === "custom") {
    const apiKey = await resolveCustomApiKey(settings.apiKey, modality);
    const baseUrl = settings.baseUrl.trim();
    validateConfig(baseUrl, apiKey, settings.model, modality);
    return { baseUrl, apiKey, protocol: settings.protocol, model: settings.model, timeoutMs, ...extras };
  }

  // 目录路径：providerId 必须命中媒体供应商目录。
  const entry = findMediaProvider(settings.providerId);
  if (!entry) {
    // 旧 ProviderProfile id / 手改档：normalize 会把未知 id 归 "custom"，这里是运行期双保险。
    throw new Error(
      `[${modality}] 找不到媒体供应商（id="${settings.providerId}"）。` +
        "请在「设置 → 媒体生成」中重新选择供应商，或改用「自定义」。",
    );
  }
  const capability = mediaCapabilityOf(entry, modality);
  if (!capability) {
    throw new Error(
      `[${modality}] 供应商「${entry.name}」不支持${MODALITY_LABEL[modality]}生成，请更换供应商。`,
    );
  }
  const baseUrl = settings.baseUrl.trim() || capability.baseUrl;
  const model = settings.model || capability.models[0] || "";
  const apiKey = await resolveDirectoryApiKey(entry, modality);
  validateConfig(baseUrl, apiKey, model, modality);
  // protocol 以目录 capability 为准（见文件头「解析优先级」）。
  return { baseUrl, apiKey, protocol: capability.protocol, model, timeoutMs, ...extras };
}

// ── 内部校验 ──────────────────────────────────────────────────────────────────

/** 三项必填 + https 收口。注意报错信息不得含 apiKey 值本身。*/
function validateConfig(baseUrl: string, apiKey: string, model: string, modality: string): void {
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
