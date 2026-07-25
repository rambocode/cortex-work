// 「这次研究会用哪个模型」的展示层解析。
//
// 存在的意义是让**设置页与新建表单显示同一句话**：两处都调本文件，本文件只调 core 的
// selectResearchModel。若各自拼一遍（比如设置页显示用户选的 id、表单显示首个可用供应商），
// 用户会在两个界面看到不同的答案，而真正生效的是第三种——编排层自己算的那个。
//
// 这里也是「数据出站说明」的唯一来源：出站范围由所选模型是否在本机决定
// （见 core 的 describeModelEgress），不再有独立的出站策略枚举可选。
import type { ProviderSettings } from "@cortex-work/core/desktop/types";
import {
  describeModelEgress,
  selectResearchModel,
  type ResearchModelPreference,
} from "@cortex-work/core/research/model-selection";

/// 研究模型的展示信息。
export interface ResearchModelDisplay {
  /// 「供应商展示名 / 模型 id」；一个可用供应商都没有时为 null。
  label: string | null;
  /// 实际生效的供应商 id 与模型 id（无可用供应商时为 undefined）。
  /// 设置页据此把「模型」下拉的选项限定在生效供应商名下——否则用户会在下拉里
  /// 看到别家供应商的模型，选中后又被选型静默丢弃。
  providerId?: string;
  model?: string;
  /// 所选模型是否运行在本机（loopback）。label 为 null 时无意义。
  isLocal: boolean;
  /// 一句话的出站说明；无可用供应商时是引导用户去配供应商的提示。
  egressZh: string;
}

/// 解析当前设置下研究会用哪个模型。
///
/// preference 直接取研究设置的 modelProviderId / modelId（两者都可缺省 = 跟随全局默认）；
/// 失效的偏好在 core 侧静默降级，因此这里显示出来的**就是实际会用的那个**，
/// 而不是用户当初填进设置里的字面值——两者不一致时，界面必须站在实际那一侧。
export function resolveResearchModelDisplay(
  providerSettings: ProviderSettings,
  preference: ResearchModelPreference,
): ResearchModelDisplay {
  const selection = selectResearchModel({
    providers: providerSettings.providers,
    preference,
    ...(providerSettings.defaultProviderId
      ? { fallbackProviderId: providerSettings.defaultProviderId }
      : {}),
    ...(providerSettings.defaultModel ? { fallbackModel: providerSettings.defaultModel } : {}),
  });

  if (!selection.ok) {
    return { label: null, isLocal: false, egressZh: selection.message };
  }

  // 展示名优先用 provider.name（用户自己起的名字），缺失才退回 id。
  const provider = providerSettings.providers.find((p) => p.id === selection.providerId);
  const providerName = provider?.name?.trim() || selection.providerId;
  return {
    label: `${providerName} / ${selection.model}`,
    providerId: selection.providerId,
    model: selection.model,
    isLocal: selection.isLocal,
    egressZh: describeModelEgress(selection.isLocal).summaryZh,
  };
}
