// Kun @shared/kun-gui-api 的 compat 垫层：design 树只消费极小的类型子集。
// ModelProviderModelProfileV1 采用宽松结构版（design 树只透传不构造）。
export type ModelProviderModelProfileV1 = Record<string, unknown>;

// 模型分组（composer 模型选择器的数据形状）。
export type ModelProviderModelGroup = {
  providerId: string;
  label: string;
  modelIds: string[];
  modelProfiles?: Record<string, ModelProviderModelProfileV1>;
};
