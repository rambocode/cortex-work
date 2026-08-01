// 媒体生成设置的数据层：媒体供应商目录（MEDIA_PROVIDER_DIRECTORY）× Provider 认证快照。
//
// 职责边界：
//   · 目录（core/desktop/media-provider-directory.ts）是纯静态数据——每模态的下拉候选、
//     capability（protocol/baseUrl/models）与密钥来源（catalog credential vs standalone Secret）。
//   · 认证态经 useProviderAuth（provider/useProviderData.ts）取主进程快照，
//     只有布尔与枚举，永不含明文/密文（渲染端红线）。
// 四张模态卡共用本 hook；React Query 会对 providerAuthKey 去重，多处调用无额外请求。

import { useTranslation } from "@cortex-work/core/i18n";
import {
  findMediaProvider,
  mediaCapabilityOf,
  mediaProvidersForModality,
  type MediaCapability,
  type MediaModality,
  type MediaProviderEntry,
} from "@cortex-work/core/desktop/media-provider-directory";
import type { CredentialStoreHealth } from "@cortex-work/core/desktop/provider-catalog";

import { useProviderAuth } from "../provider/useProviderData";

// 「自定义」供应商占位 id；空串（历史默认值）等价视作自定义。
export const CUSTOM_PROVIDER_ID = "custom";

/** providerId 是否为「自定义」路径（空串或 "custom"）。*/
export function isCustomProvider(providerId: string): boolean {
  return !providerId || providerId === CUSTOM_PROVIDER_ID;
}

/** 选中目录供应商后的解析结果：条目 + 该模态的能力（可能缺失，见 useMediaGenProviders 注释）。*/
export interface ResolvedMediaProvider {
  entry: MediaProviderEntry;
  capability: MediaCapability | undefined;
}

/** catalog 型供应商的认证视图（standalone 型不走这里，key 走内联 Secret 字段）。*/
export interface MediaProviderAuthView {
  configured: boolean;
  /** 凭据是 OAuth——媒体生成只支持 API Key，UI 需警示引导改配。*/
  oauth: boolean;
}

/**
 * 每模态的供应商下拉数据源 + 认证态查询。
 * 返回的 resolve() 对「providerId 在目录里但该模态无能力」返回 capability=undefined——
 * 调用方应将其按自定义态渲染（防旧档残留串模态的 providerId 导致表单错乱）。
 */
export function useMediaGenProviders(modality: MediaModality): {
  entries: MediaProviderEntry[];
  options: { label: string; value: string }[];
  resolve: (providerId: string) => ResolvedMediaProvider | undefined;
  authFor: (entry: MediaProviderEntry) => MediaProviderAuthView;
  vault: CredentialStoreHealth;
  /** 桥方法缺失（Web 端/旧壳）——认证态未知，调用方不渲染配置状态提示。*/
  authUnsupported: boolean;
} {
  const { t } = useTranslation("settings");
  const { snapshot, unsupported } = useProviderAuth();

  const entries = mediaProvidersForModality(modality);
  const options = [
    ...entries.map((e) => ({ label: e.name, value: e.id })),
    { label: t("mediaGen.providerCustom"), value: CUSTOM_PROVIDER_ID },
  ];

  const resolve = (providerId: string): ResolvedMediaProvider | undefined => {
    if (isCustomProvider(providerId)) return undefined;
    const entry = findMediaProvider(providerId);
    if (!entry) return undefined;
    return { entry, capability: mediaCapabilityOf(entry, modality) };
  };

  const authFor = (entry: MediaProviderEntry): MediaProviderAuthView => {
    const status = snapshot.statuses.find((s) => s.providerId === entry.id);
    return { configured: !!status?.configured, oauth: status?.type === "oauth" };
  };

  return { entries, options, resolve, authFor, vault: snapshot.health, authUnsupported: unsupported };
}
