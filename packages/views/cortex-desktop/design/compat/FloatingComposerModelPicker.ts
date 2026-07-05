// Kun chat/FloatingComposerModelPicker 的类型垫层：design 树只消费
// ComposerReasoningEffort 类型与 composerReasoningEffortRequestValue 透传函数。
// 模型选择 UI 本体不移植（批5 由 ComposerShell/宿主模型选择接管）。
export const MODEL_REASONING_EFFORTS = ["auto", "off", "low", "medium", "high", "max"] as const;
export type ComposerReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number];

// Kun 语义：把 UI 档位原样作为请求值（'auto' 等由 runtime 解释）。
export function composerReasoningEffortRequestValue(
  value: ComposerReasoningEffort,
): string | undefined {
  return value;
}
