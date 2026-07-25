// Gap Planner（spec §10.3）：看覆盖度统计决定「再搜 / 再抓 / 收尾」。
//
// **本文件是 prompt injection 防线的第二环（spec §6.1 第 2 条）：入参里没有、也不允许有
// 网页正文、Memory 内容或本地文件路径。** 结构上的保证是 GapPlanInput 根本没有承载正文的
// 字段，而 prompt 的构造只经 buildGapPlanUserPrompt 一条路径（它同样只认统计量）——
// 想把正文送进来，必须先改类型定义，这个动作在 review 里藏不住。
//
// 失败哲学：Gap 决策只影响「要不要再来一轮」，因此任何异常一律降级为 finish ——
// 用已有证据收尾，好过让整个 Session 失败。也因此**不做重试**：省下的那次模型调用
// 远比一个更漂亮的补充查询值钱。
import { parsePlannerDecision } from "@cortex-work/core/research/plan-schema";
import type {
  CoverageReport,
  ModelDataPolicy,
  PlannerDecision,
  ResearchBudget,
  ResearchSubquestion,
} from "@cortex-work/core/research/types";
import { extractJsonObject } from "./json-output";
import type { PlannerDeps } from "./initial-planner";
import { GAP_PLANNER_SYSTEM_PROMPT, buildGapPlanUserPrompt } from "./prompts";

/// Gap 规划入参。**新增字段前先确认它不含正文**（见文件头注释）。
export interface GapPlanInput {
  /// 计划里的子问题（只有 id 与文本，来自用户目标的拆解，不是抓取内容）。
  subquestions: readonly ResearchSubquestion[];
  coverage: readonly CoverageReport[];
  /// 已执行的查询文本，避免模型重复出同样的查询。
  executedQueries: readonly string[];
  remainingBudget: ResearchBudget;
  /// 缺口摘要（由 CoverageReport.missing 汇总而成的人类可读描述）。
  missingSummary: readonly string[];
  /// 尚未抓取的候选：**只有 id / 标题 / 域名**，来自搜索结果元数据，不含 snippet 与正文。
  candidates?: readonly { candidateId: string; title: string; domain: string }[];
  /// 允许出现在 fetch_more 里的候选 id 全集（通常是本 Session 的全部候选）。
  knownCandidateIds?: readonly string[];
  policy: ModelDataPolicy;
  signal?: AbortSignal;
}

/// 决策是结构化 JSON，但 search_more 分支会带上多条补充查询，并不总是很短。
///
/// 800 的旧值与 PLAN_MAX_TOKENS=1500 是同一类问题（见 initial-planner 的说明）：
/// 一旦被截断，决策解析失败 → 按 finish 收尾 → 多轮研究退化成单轮，
/// 而现象层面只看得到「研究不深入」。推理模型还要先花掉一部分预算思考。
const DECISION_MAX_TOKENS = 3_000;

/// 决定下一步（spec §10.3）。**任何失败路径都返回 finish**，绝不抛错。
export async function planGap(input: GapPlanInput, deps: PlannerDeps): Promise<PlannerDecision> {
  const userPrompt = buildGapPlanUserPrompt({
    subquestions: input.subquestions,
    coverage: input.coverage,
    executedQueries: input.executedQueries,
    remainingBudget: input.remainingBudget,
    missingSummary: input.missingSummary,
    ...(input.candidates ? { candidates: input.candidates } : {}),
  });

  const result = await deps.gateway.call({
    purpose: "gap_plan",
    systemPrompt: GAP_PLANNER_SYSTEM_PROMPT,
    userPrompt,
    policy: input.policy,
    maxTokens: DECISION_MAX_TOKENS,
    maxPromptChars: input.remainingBudget.maxEvidenceCharsToModel,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!result.ok) {
    deps.logger?.warn("[research] Gap 规划无法调用模型，按 finish 收尾", {
      code: result.code,
      message: result.message,
      provider: result.providerId,
      model: result.model,
    });
    return { action: "finish", reason: "模型不可用，使用已有证据收尾" };
  }

  const raw = extractJsonObject(result.text);
  if (raw === null) {
    deps.logger?.warn("[research] Gap 决策不是合法 JSON，按 finish 收尾");
    return { action: "finish", reason: "决策输出不可解析，使用已有证据收尾" };
  }

  // core 的 parsePlannerDecision 负责：剥 URL 字段、删未知 candidateId、删未知 subquestion 的查询，
  // 清洗后无事可做时自行降级为 finish。这里不重复实现任何一条。
  const parsed = parsePlannerDecision(raw, {
    knownCandidateIds: input.knownCandidateIds ?? [],
    subquestionIds: input.subquestions.map((item) => item.id),
  });
  if (!parsed.ok) {
    deps.logger?.warn("[research] Gap 决策未通过校验，按 finish 收尾", parsed.errors);
    return { action: "finish", reason: "决策未通过校验，使用已有证据收尾" };
  }
  if (parsed.warnings.length > 0) {
    deps.logger?.warn("[research] Gap 决策已被清洗", parsed.warnings);
  }
  return parsed.decision;
}

export type { PlannerDeps };
