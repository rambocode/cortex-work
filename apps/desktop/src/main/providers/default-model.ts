// 「全局默认模型」的主进程读取点（阶段③·4.1）。
//
// 收编后，Reply / Research / 做梦蒸馏在没有各自专属选择时，都要落到同一个「全局默认模型」。
// 现在它是 `PersistedState.defaultModelRef`（Catalog 引用 `{providerId, modelId}`，由设置页写入）。
//
// 收编前它是 `providerSettings.defaultProviderId / defaultModel`。按计划 §5，整个
// `providerSettings` 字段会在新版本首启时被**删除**（含全部明文 apiKey，不迁移、不备份），
// 所以这里**刻意不回落到旧字段**：旧的 providerId 是「用户自己起名的供应商」，与 Catalog 的
// 内建 Provider id 不是同一套命名，回落只会解析出一个必然无效的引用，
// 还会掩盖「该去设置里重新选模型」这条真正的引导（§5 的阻断态）。
//
// 集中在这一个函数而不是让三个调用方各读一次：它们的回退链语义必须完全一致，
// 否则「Reply 有默认、做梦没有」这类不一致极难被发现。

import { getPersistedState } from "../ipc/store";
import type { ModelRef } from "./contract";

/**
 * 取全局默认模型引用；未配置返回 null（调用方据此进「未配置模型」阻断态并给设置入口）。
 *
 * 两段必须成套：模型 id 属于某个供应商，只有 providerId 而没有 modelId 时**不猜**
 * 「该供应商的第一个模型」—— 悄悄换一个用户没选过的模型等于把他的正文发给他没同意过的地方。
 */
export async function getDefaultModelRef(): Promise<ModelRef | null> {
  const ref = (await getPersistedState()).defaultModelRef;
  const providerId = ref?.providerId?.trim();
  const modelId = ref?.modelId?.trim();
  return providerId && modelId ? { providerId, modelId } : null;
}
