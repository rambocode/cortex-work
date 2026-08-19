// 把用户保存的自定义供应商同步进主进程 pi-ai 注册表。
//
// Provider 的实际构造位于 custom-provider-builder.ts，并由主进程与 pi-host worker 共用；
// 本文件只负责读取主进程持久化状态、执行 Catalog 优先规则，以及维护删除差集。

import { safeId } from "../agents/pi-providers";
import { createLogger } from "../log";
import { getProviderCatalog } from "./catalog";
import { buildCustomProvider } from "./custom-provider-builder";
import { readSecrets } from "./credentials";
import { listCustomProviders } from "./custom-providers";
import { safeErrorMessage } from "./secrets";

const log = createLogger("custom-provider-registry");

/** 上一轮注册进去的 id；用户删掉定义后据此摘除，避免残留成幽灵供应商。 */
let registeredIds = new Set<string>();

/**
 * 把全部自定义供应商同步进给定的 pi-ai 注册表（幂等，可重复调用）。
 *
 * 泛型让主进程的 Models 与 coding-agent 的 ModelRuntime 都能复用本函数，而不把纯 ESM 的
 * pi-ai 实体类型拖进静态依赖图。内建 Catalog 始终优先，同 id 的自定义定义绝不覆盖内建模型。
 */
export async function syncCustomProvidersInto<TProvider>(models: {
  setProvider: (provider: TProvider) => void;
  deleteProvider: (id: string) => void;
}): Promise<void> {
  let definitions: { id: string; json: string }[];
  try {
    definitions = await listCustomProviders();
  } catch (err) {
    log.warn("读取自定义供应商失败，本轮不同步:", safeErrorMessage(err));
    return;
  }

  let builtinIds: Set<string>;
  try {
    builtinIds = new Set(getProviderCatalog()?.providers.map((provider) => provider.id) ?? []);
  } catch {
    builtinIds = new Set();
  }

  const next = new Set<string>();
  for (const definition of definitions) {
    const id = safeId(definition.id);
    if (builtinIds.has(id)) {
      log.warn(`自定义供应商「${definition.id}」与内建供应商同名，已跳过（不覆盖内建目录）`);
      continue;
    }
    try {
      const built = await buildCustomProvider(definition, {
        // builder 会把 apiKey 的读取留到真实认证时；这里的调用只服务于静态 Header。
        readSecrets: async () => readSecrets(),
        onMissingHeaderSecrets: (providerId, header, missing) => {
          log.warn(
            `自定义供应商 ${providerId} 的 header "${header}" 引用了不存在的 Secret（${missing.join(", ")}），该 header 已丢弃`,
          );
        },
      });
      if (!built) continue;
      models.setProvider(built.provider as TProvider);
      next.add(built.id);
    } catch (err) {
      // 单条坏定义不拖垮整批同步，其余供应商仍然可用。
      log.warn(`自定义供应商「${definition.id}」注册失败:`, safeErrorMessage(err));
    }
  }

  for (const id of registeredIds) if (!next.has(id)) models.deleteProvider(id);
  registeredIds = next;
}

/** 单测用：清掉「上一轮登记了哪些」的进程内状态。 */
export function resetCustomProviderRegistryForTests(): void {
  registeredIds = new Set<string>();
}
