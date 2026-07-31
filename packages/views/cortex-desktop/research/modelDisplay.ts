// 「这次研究会用哪个模型 + 数据会去哪」的展示层解析。
//
// 存在的意义是让**设置页、新建表单、右栏面板显示同一句话**，而且这句话必须与主进程实际
// 用的模型一致。若各自拼一遍，用户会在不同界面看到不同答案，而真正生效的是第四种。
//
// ── 阶段③·4.1 收编后的关键变化 ────────────────────────────────────────────────
// 主进程侧已**移除** `selectResearchModel`：`research-model-gateway.ts` 改成收一个由
// `llm-hooks-wiring.ts` 解析好的 `ModelRef`，回落规则是「研究偏好 → 全局默认」**两级各自成套**，
// 不做任何「取第一个可用模型」兜底。
//
// 所以这一层必须跟着改成同一套规则。否则冲突会翻转成更难查的版本：**UI 显示一个回退后的
// 模型、主进程却根本不会用它** —— 用户看到「本次研究将使用 X」，实际是阻断态什么都没跑。
//
// 出站说明（本机 loopback vs 出站）由 Catalog 里该 Provider 的 baseUrl 推导，与主进程同口径
// （两边都用 core 的 `isLoopbackBaseUrl`）。

import { useMemo } from "react";
import { usePersonalStore } from "@cortex-work/core";
import type { ModelRef } from "@cortex-work/core/desktop/provider-catalog";
import {
  describeModelEgress,
  isLoopbackBaseUrl,
  type ResearchModelPreference,
} from "@cortex-work/core/research/model-selection";
import {
  collectModelOptions,
  useProviderViews,
  type ProviderView,
} from "../personal/settings/provider/useProviderData";

/// 研究模型的展示信息。
export interface ResearchModelDisplay {
  /// 「供应商展示名 / 模型 id」；未配置或引用悬空时为 null。
  label: string | null;
  /// 实际生效的引用（label 为 null 时为 undefined）。
  providerId?: string;
  model?: string;
  /// 所选模型是否运行在本机（loopback）。label 为 null 时无意义。
  isLocal: boolean;
  /// 一句话的出站说明；未配置时是引导用户去配模型的提示。
  egressZh: string;
}

const NOT_CONFIGURED: ResearchModelDisplay = {
  label: null,
  isLocal: false,
  egressZh: "尚未配置可用的研究模型。请在「设置 → 深度研究」里选一个，或先到「供应商管理」登录供应商。",
};

/**
 * 纯函数版：给定候选集与两级偏好，解析出展示信息。抽出来是为了可单测（无需 React）。
 *
 * 回落**两级各自成套**：研究偏好的 providerId 与 modelId 必须都在，缺一整级作废、落到全局
 * 默认；全局默认同样要求成套。任何一级解析出的引用还要过 Catalog 候选集（认证可用 ∧ 未隐藏）
 * 才算数——查不到就是查不到，**绝不继续往下找「第一个可用模型」**（计划 §5）。
 */
export function resolveResearchModelDisplay(
  views: ProviderView[],
  preference: ResearchModelPreference,
  defaultRef: ModelRef | undefined,
): ResearchModelDisplay {
  const options = collectModelOptions(views);
  const candidates: ModelRef[] = [];
  if (preference.providerId && preference.modelId) {
    candidates.push({ providerId: preference.providerId, modelId: preference.modelId });
  }
  if (defaultRef?.providerId && defaultRef.modelId) {
    candidates.push({ providerId: defaultRef.providerId, modelId: defaultRef.modelId });
  }

  for (const ref of candidates) {
    const hit = options.find((o) => o.providerId === ref.providerId && o.modelId === ref.modelId);
    if (!hit) continue; // 该级引用悬空 → 试下一级；两级都悬空即未配置，不再兜底
    const baseUrl = views.find((v) => v.provider.id === hit.providerId)?.provider.baseUrl ?? "";
    const isLocal = isLoopbackBaseUrl(baseUrl);
    return {
      label: `${hit.providerName} / ${hit.modelId}`,
      providerId: hit.providerId,
      model: hit.modelId,
      isLocal,
      egressZh: describeModelEgress(isLocal).summaryZh,
    };
  }
  return NOT_CONFIGURED;
}

/**
 * Hook 版：设置页与右栏面板都用它，保证两处（以及与主进程）说同一句话。
 * 直接读 Catalog 与全局默认，调用方只需给研究偏好。
 */
export function useResearchModelDisplay(preference: ResearchModelPreference): ResearchModelDisplay {
  const { views } = useProviderViews();
  const defaultRef = usePersonalStore((s) => s.defaultModelRef);
  return useMemo(
    () => resolveResearchModelDisplay(views, preference, defaultRef),
    [views, preference.providerId, preference.modelId, defaultRef],
  );
}
