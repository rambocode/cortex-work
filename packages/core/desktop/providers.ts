// Provider 数据模型的纯函数 helper：规范化、旧 PiChannel→Provider 迁移、预置实例化。
// store hydrate（向后兼容迁移）与设置 UI（新增/规范化）共用，保持 types.ts 为纯类型。

import type {
  EndpointFormat,
  ProviderModelOption,
  ProviderPreset,
  ProviderProfile,
  ProviderSettings,
} from "./types";

const ENDPOINT_FORMATS: EndpointFormat[] = ["chat_completions", "responses", "messages", "custom"];

function normalizeEndpointFormat(value: unknown): EndpointFormat {
  return ENDPOINT_FORMATS.includes(value as EndpointFormat)
    ? (value as EndpointFormat)
    : "chat_completions";
}

// 模型列表去重（按 id，保留首个的 label）+ 按 id 升序排序。
function normalizeModels(models: unknown): ProviderModelOption[] {
  if (!Array.isArray(models)) return [];
  const byId = new Map<string, ProviderModelOption>();
  for (const m of models) {
    const id = typeof m?.id === "string" ? m.id.trim() : "";
    if (!id || byId.has(id)) continue;
    const opt: ProviderModelOption = { id };
    if (typeof m?.label === "string" && m.label.trim()) opt.label = m.label;
    if (typeof m?.contextTokens === "number" && m.contextTokens > 0) opt.contextTokens = m.contextTokens;
    if (m?.reasoning === true) opt.reasoning = true;
    if (m?.vision === true) opt.vision = true;
    byId.set(id, opt);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// 把任意（可能残缺的）provider 形状规范化为完整 ProviderProfile：
// 缺 endpointFormat 回退 chat_completions，缺 name 回退 id，models 去重排序，缺 enabled 视为 true。
export function normalizeProviderProfile(input: { id: string } & Partial<ProviderProfile>): ProviderProfile {
  const id = input.id;
  return {
    id,
    name: typeof input.name === "string" && input.name.trim() ? input.name : id,
    baseUrl: typeof input.baseUrl === "string" ? input.baseUrl : "",
    apiKey: typeof input.apiKey === "string" ? input.apiKey : undefined,
    endpointFormat: normalizeEndpointFormat(input.endpointFormat),
    models: normalizeModels(input.models),
    enabled: input.enabled !== false,
  };
}

// 旧 PiChannel（{id,label,baseUrl,apiKey,models,enabled}）→ ProviderProfile。
// label→name，补默认 endpointFormat=chat_completions（旧通道全是 OpenAI 兼容）。
export function migratePiChannelToProvider(ch: {
  id: string;
  label?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: { id: string; label?: string }[];
  enabled?: boolean;
}): ProviderProfile {
  return normalizeProviderProfile({
    id: ch.id,
    name: ch.label,
    baseUrl: ch.baseUrl,
    apiKey: ch.apiKey,
    endpointFormat: "chat_completions",
    models: ch.models,
    enabled: ch.enabled,
  });
}

// 旧 PiSettings（{channels,defaultChannelId,defaultModel}）→ ProviderSettings。
// 用于 hydrate 旧档；新档已是 ProviderSettings 形状直接走 normalize 兜底。
export function migratePiSettings(old: {
  channels?: { id: string; label?: string; baseUrl?: string; apiKey?: string; models?: { id: string; label?: string }[]; enabled?: boolean }[];
  defaultChannelId?: string;
  defaultModel?: string;
}): ProviderSettings {
  return {
    providers: Array.isArray(old.channels) ? old.channels.map(migratePiChannelToProvider) : [],
    defaultProviderId: old.defaultChannelId,
    defaultModel: old.defaultModel,
  };
}

// 由预置模板实例化一个新 provider（用户点「添加」时）。id 由调用方分配唯一值。
export function providerFromPreset(preset: ProviderPreset, id: string): ProviderProfile {
  return normalizeProviderProfile({
    id,
    name: preset.name,
    baseUrl: preset.baseUrl,
    endpointFormat: preset.endpointFormat,
    models: preset.models,
    enabled: true,
  });
}
