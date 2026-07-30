// 构建期 Provider Catalog 的运行时加载与校验（阶段①·2.1）。
//
// ⚠️ 骨架占位 —— 待实现（实现计划 §2.1）。当前返回「目录不可用」，调用方走降级分支。
// 实现要点：
//   · 从 `resources/pi/provider-catalog.json` 读（dev 与 packaged 两种路径，仿 pi-locate.ts）。
//   · 校验 schemaVersion / piVersion 与随包 pi 二进制一致 / hash 与内容一致，任一不符即失败。
//   · 结果进程内缓存，只读冻结，绝不写回。

import type { ProviderCatalog, ProviderCatalogResult } from "./contract";

/** 读取并校验随包 Catalog。失败时返回结构化错误，不抛异常（调用方需降级而非崩溃）。 */
export function getProviderCatalogResult(): ProviderCatalogResult {
  return { ok: false, error: "provider catalog not implemented" };
}

/** 便捷取值：Catalog 不可用时返回 undefined。主进程内部消费方用这个。 */
export function getProviderCatalog(): ProviderCatalog | undefined {
  const result = getProviderCatalogResult();
  return result.ok ? result.catalog : undefined;
}
