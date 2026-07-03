// reply 生成模型解析（KTD3）：把 reply 专属选择 + 全局默认，按回退链解析成一个可直连的
// OpenAI 兼容 chat_completions 目标（含 baseUrl/apiKey/model）。纯函数，不依赖 electron，便于单测。
//
// 回退链（严格顺序，任一候选校验失败即落下一级）：
//   1. settings.providerId（reply 专属选择）→ 供应商须「存在 + enabled + endpointFormat==="chat_completions"」，
//      model 取 settings.model?.trim() 或该供应商 models[0]?.id；取不到 model 视为本候选失败。
//   2. providerSettings.defaultProviderId（全局默认 agent 供应商）→ 同样校验，model 取 defaultModel?.trim()
//      或 models[0]?.id。
//   3. 两级都不成立 → 返回 null（controller 据此推「未配置生成模型」气泡错误态，引导去设置）。
//
// 仅支持 chat_completions：reply 直连走 /v1/chat/completions（见 draft-generator），其余 endpointFormat
// （responses/messages/custom）本期不支持，视为候选不可用（宁可回退/报错，也不发错格式请求）。

import type { ProviderSettings, ProviderProfile } from "../ipc/types";

/// 解析后的直连目标：draft-generator 据此构造 chat completions 请求。
export interface ResolvedReplyModel {
  providerId: string;
  providerName: string;
  baseUrl: string;
  /// 可选凭据（本地供应商可无 key，authHeaders 会兜底本地 omlx 密钥）。
  apiKey?: string;
  model: string;
}

/// reply 设置分片中与模型解析相关的最小子集（避免耦合整个 ReplySettings 形状）。
interface ReplyModelSelection {
  providerId?: string;
  model?: string;
}

/**
 * 校验单个候选供应商并解析出 model：供应商缺失 / 未启用 / 非 chat_completions / 无可用 model → 返回 null
 * （视为本候选失败，由调用方落下一级）。preferredModel 为该级偏好模型（专属 model 或全局 defaultModel）。
 */
function tryResolve(
  provider: ProviderProfile | undefined,
  preferredModel: string | undefined,
): ResolvedReplyModel | null {
  if (!provider || !provider.enabled) return null;
  if (provider.endpointFormat !== "chat_completions") return null;
  // model 优先取显式偏好，否则回落供应商首个模型；两者都空则本候选不可用。
  const model = preferredModel?.trim() || provider.models[0]?.id?.trim();
  if (!model) return null;
  return {
    providerId: provider.id,
    providerName: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
  };
}

/**
 * 按回退链把 reply 设置 + 全局 providerSettings 解析成可直连的生成目标；全部候选不成立返回 null。
 * settings 为 null（快照缺失）时跳过专属级，直接走默认链。
 */
export function resolveReplyModel(
  settings: ReplyModelSelection | null | undefined,
  providerSettings: ProviderSettings | null | undefined,
): ResolvedReplyModel | null {
  const providers = providerSettings?.providers ?? [];
  const byId = (id: string | undefined): ProviderProfile | undefined =>
    id ? providers.find((p) => p.id === id) : undefined;

  // 1. reply 专属选择（settings.providerId）。
  const explicitId = settings?.providerId?.trim();
  if (explicitId) {
    const resolved = tryResolve(byId(explicitId), settings?.model);
    if (resolved) return resolved;
  }

  // 2. 全局默认供应商（providerSettings.defaultProviderId）。
  const defaultId = providerSettings?.defaultProviderId?.trim();
  if (defaultId) {
    const resolved = tryResolve(byId(defaultId), providerSettings?.defaultModel);
    if (resolved) return resolved;
  }

  // 3. 均缺失 / 均不可用 → null（气泡引导去设置）。
  return null;
}
