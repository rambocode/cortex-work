// 由 providerId 解析出喂给 `writePiExtension` 的 `PiProviderInput`（阶段③ 收编的配套件）。
//
// 为什么需要它：旧链路是**渲染端**拍平出 `{id, baseUrl, apiKey, models}` 经
// `CliStartRequest.provider` 传进来，源头是已废弃且含明文 apiKey 的 `PersistedState.providerSettings`。
// §5 清理掉那份配置后，渲染端既没有 baseUrl 也没有 apiKey，只能给一个 providerId；
// 真正的三份事实分别在主进程手里：
//   · Catalog（`catalog.ts`）        —— Provider 是否内建、官方 baseUrl
//   · provider-prefs（`prefs.ts`）   —— 用户的自建网关 baseUrl 覆盖
//   · 凭据金库（`credentials.ts`）   —— safeStorage 加密的 API Key
// 于是解析必须发生在主进程，而不是让渲染端重新持有一份明文。
//
// ⚠️ 返回值里带明文 apiKey，**仅供主进程内部**流向 `spawnEnvFor`（注入 CORTEX_PI_KEY 环境变量）
// 与 `writePiExtension`（只写 `$CORTEX_PI_KEY` 占位，不落明文）。绝不得经 IPC 外泄、进日志或 argv。

import { safeId } from "../agents/pi-providers";
import type { PiProviderInput } from "../ipc/types";
import { getProviderCatalog } from "./catalog";
import { readStoredCredential } from "./credentials";
import { getBaseUrlOverride } from "./prefs";

/**
 * 解析 providerId → PiProviderInput。找不到 Provider 时返回 undefined，
 * 调用方应据此进阻断态（计划 §5：不自动回退到「裸 pi」或任何其它模型）。
 *
 * `models` 恒为空数组：内建 Provider 的注册配置**绝不含 models**（保留 pi 内置目录，
 * 见 `pi-providers.ts` 的核心不变量），`builtinProviderConfig` 根本不读这个字段。
 */
export async function resolvePiProviderInput(providerId: string): Promise<PiProviderInput | undefined> {
  const id = safeId(providerId);
  const catalogProvider = getProviderCatalog()?.providers.find((p) => p.id === id);
  // Catalog 不可用时不能一口咬定「Provider 不存在」——那会把一次目录加载失败放大成
  // 「日报永远不可用」。此时仍按 id 继续解析：pi-providers 的 unclassified 降级路径
  // 会把它当内建处理（同样不下发 models），最坏结果是 pi 侧报一次响亮的「provider 未知」。
  if (!catalogProvider && getProviderCatalog()) return undefined;

  const credential = await readStoredCredential(id);
  // 只有 api-key 型凭据需要经环境变量注入；OAuth 凭据由 pi 自己从金库（CredentialStore）取，
  // 这里不碰、也不该把 token 塞进 argv/env。
  const apiKey = credential?.type === "api_key" ? credential.key : undefined;

  return {
    id,
    baseUrl: getBaseUrlOverride(id) ?? catalogProvider?.baseUrl ?? "",
    apiKey,
    models: [],
  };
}
