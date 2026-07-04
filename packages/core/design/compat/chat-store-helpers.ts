// Kun store/chat-store-helpers 的裁剪版：design 树仅消费 providerIdForComposerModel。
import type { ModelProviderModelGroup } from "./kun-gui-api";

function modelGroupHasModel(group: ModelProviderModelGroup, modelId: string): boolean {
  return group.modelIds.includes(modelId);
}

// 按模型 id 反查其所属供应商 id（composer 模型选择器用）。
export function providerIdForComposerModel(
  modelGroups: readonly ModelProviderModelGroup[],
  modelId: string,
): string {
  const model = modelId.trim();
  if (!model) return "";
  return modelGroups.find((group) => modelGroupHasModel(group, model))?.providerId ?? "";
}
