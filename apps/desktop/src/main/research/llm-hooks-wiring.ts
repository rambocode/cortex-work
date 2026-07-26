// LLM 能力的装配判定（从 runtime.ts 抽出的可测部分）。
//
// runtime.ts 依赖 Electron 的 app / safeStorage / utilityProcess，整体无法单测；而
// 「该不该给这个 Session 装 LLM」是一条真实的业务判定，出错的后果是整套多轮 Planner
// 静默退化成确定性行为（单测依然全绿）。故把判定抽到这里，由 llm-hooks-wiring.test.ts 钉住。
import type { ProviderSettings } from "@cortex-work/core/desktop/types";
import type { ResearchModelPreference } from "@cortex-work/core/research/model-selection";
import type { ResearchSessionSummary } from "@cortex-work/core/research/types";

import { createResearchLlmHooks, type ResearchLlmHooks } from "./planner/llm-hooks";

/// 装配入参。fetchFn / complete 只为测试注入而存在，生产不传。
export interface ResearchLlmWiringInput {
  summary: ResearchSessionSummary;
  /// 来自 personal-workspace.json 的供应商配置；未配置时为 null。
  providerSettings: ProviderSettings | null | undefined;
  /// 研究设置里的模型偏好（modelProviderId / modelId）；缺省 = 跟随全局默认模型。
  preference?: ResearchModelPreference;
  blockedDomains?: readonly string[];
  fetchFn?: typeof fetch;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

/// 为一个 Session 装配 LLM 能力；返回 null 表示不接 LLM（编排层沿用确定性的种子计划 +
/// 单轮 + 证据摘要，**不是让 Session 失败**）。
///
/// 这里只判「有没有可用的供应商配置」这一件事。**刻意不判研究模型偏好是否有效**——
/// 那是 ResearchModelGateway 的 selectResearchModel 的职责（spec §19.2.5 的单一判定点，
/// 失效偏好在那里静默降级）。装配层若也判一次，两处规则会随时间漂移，而且会把
/// 「你选的那个供应商被删了」误报成「你没配模型」，给用户完全错误的引导。
export function buildResearchLlmHooks(input: ResearchLlmWiringInput): ResearchLlmHooks | null {
  const enabledProviders = (input.providerSettings?.providers ?? []).filter(
    (provider) => provider.enabled && provider.models.length > 0,
  );
  if (enabledProviders.length === 0) return null;

  return createResearchLlmHooks({
    providerSettings: input.providerSettings as ProviderSettings,
    consumer: input.summary.consumer,
    mode: input.summary.mode,
    ...(input.preference ? { preference: input.preference } : {}),
    ...(input.blockedDomains ? { blockedDomains: input.blockedDomains } : {}),
    ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  });
}
