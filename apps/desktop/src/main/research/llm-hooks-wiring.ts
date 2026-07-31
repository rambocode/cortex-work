// LLM 能力的装配判定（从 runtime.ts 抽出的可测部分）。
//
// runtime.ts 依赖 Electron 的 app / safeStorage / utilityProcess，整体无法单测；而
// 「该不该给这个 Session 装 LLM」是一条真实的业务判定，出错的后果是整套多轮 Planner
// 静默退化成确定性行为（单测依然全绿）。故把判定抽到这里，由 llm-hooks-wiring.test.ts 钉住。
import type { ResearchModelPreference } from "@cortex-work/core/research/model-selection";
import type { ResearchSessionSummary } from "@cortex-work/core/research/types";

import type { ModelRef } from "../providers/contract";
import type { PiGatewayRuntime } from "../providers/pi-runtime";
import { createResearchLlmHooks, type ResearchLlmHooks } from "./planner/llm-hooks";

/// 装配入参。runtime 只为测试注入而存在，生产不传。
export interface ResearchLlmWiringInput {
  summary: ResearchSessionSummary;
  /// 研究设置里的模型偏好（modelProviderId / modelId）；两段都齐才算一个有效选择。
  preference?: ResearchModelPreference;
  /// 全局默认模型引用；研究偏好缺失或不完整时用它。缺省 = 没有默认模型。
  fallback?: ModelRef | null;
  blockedDomains?: readonly string[];
  runtime?: PiGatewayRuntime;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

/// 把「研究偏好 → 全局默认」两级回落成一个完整的模型引用；两级都不完整返回 null。
///
/// **两段必须成套**：模型 id 属于某个供应商，把 A 家的模型名套到 B 家只会得到一个必然 404
/// 的请求。因此偏好缺 providerId 或缺 modelId 时整级作废、落到下一级，而不是跨级拼接。
/// 也**不做「取该供应商第一个模型」式兜底**（计划 §5：悬空引用不自动回退）。
function resolveResearchModelRef(input: ResearchLlmWiringInput): ModelRef | null {
  const candidates: (ModelRef | null | undefined)[] = [
    input.preference?.providerId && input.preference?.modelId
      ? { providerId: input.preference.providerId, modelId: input.preference.modelId }
      : null,
    input.fallback,
  ];
  for (const candidate of candidates) {
    const providerId = candidate?.providerId?.trim();
    const modelId = candidate?.modelId?.trim();
    if (providerId && modelId) return { providerId, modelId };
  }
  return null;
}

/// 为一个 Session 装配 LLM 能力；返回 null 表示不接 LLM（编排层沿用确定性的种子计划 +
/// 单轮 + 证据摘要，**不是让 Session 失败**）。
///
/// 这里只判「有没有一个完整的模型引用」这一件事。**刻意不判引用是否仍然有效**（Catalog 里
/// 还在不在、供应商认没认证）—— 那是 Pi Model Gateway 出站前的单一判定点（config 阻断态，
/// 计划 §5）。装配层若也判一次，两处规则会随时间漂移，而且会把「你选的那个模型下线了」
/// 误报成「你没配模型」，给用户完全错误的引导。
export function buildResearchLlmHooks(input: ResearchLlmWiringInput): ResearchLlmHooks | null {
  const model = resolveResearchModelRef(input);
  if (!model) return null;

  return createResearchLlmHooks({
    model,
    consumer: input.summary.consumer,
    mode: input.summary.mode,
    ...(input.blockedDomains ? { blockedDomains: input.blockedDomains } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  });
}
