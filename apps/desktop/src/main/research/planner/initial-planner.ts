// Initial Planner（spec §10.1）：把研究目标交给模型拆成子问题 + 查询。
//
// **失败哲学：Planner 永远不该让 Session 失败。** 模型不可用、输出畸形、重试仍畸形——
// 这三种情况一律降级为确定性种子计划（由 objective 直接生成一条查询），研究照常进行，
// 只是拆解质量下降。理由：用户要的是「查到东西」，不是「一份漂亮的计划」；
// 一个能跑出证据的笨计划，远胜于一条「计划生成失败」的报错。
//
// 唯一返回 PlanFailure 的情况是**连种子计划都构造不出来**（目标为空），
// 那属于调用方传参错误，必须暴露。
import { parseResearchPlan } from "@cortex-work/core/research/plan-schema";
import { SEARCH_LIMITS } from "@cortex-work/core/research/search-api";
import type {
  ResearchBudget,
  ResearchConsumer,
  ResearchMode,
  ResearchPlan,
  ResearchScope,
} from "@cortex-work/core/research/types";
import { buildSeedPlan } from "../research-orchestrator";
import type { ModelCallInput, ModelCallResult } from "../research-model-gateway";
import { stripTruncationMarker } from "../../ipc/openai-chat";
import { extractJsonObject } from "./json-output";
import { INITIAL_PLANNER_SYSTEM_PROMPT, buildInitialPlanUserPrompt } from "./prompts";

/// Planner 只需要网关的一个方法。收窄成接口是为了让测试用 10 行替身覆盖，
/// 也从类型上断绝「Planner 顺手去读 provider 配置」的可能。
export interface ModelGatewayLike {
  call(input: ModelCallInput): Promise<ModelCallResult>;
}

/// Planner 的共享依赖。
export interface PlannerDeps {
  gateway: ModelGatewayLike;
  /// 域名黑名单，交给 core 的 Plan Validator 清洗模型给出的 domainAllowlist。
  blockedDomains?: readonly string[];
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

/// 初始规划入参（spec §10.1 的输入清单）。
export interface InitialPlanInput {
  objective: string;
  consumer: ResearchConsumer;
  mode: ResearchMode;
  scope: ResearchScope;
  /// Session 的**权威预算**（已夹取）。模型输出里的 budget 一律被它覆盖。
  budget: ResearchBudget;
  signal?: AbortSignal;
}

/// 连降级都不可能时的失败结果。
export interface PlanFailure {
  ok: false;
  code: "invalid_objective";
  message: string;
}

/// 判别式：ResearchPlan 恒有 schemaVersion，PlanFailure 恒有 ok:false。
export function isPlanFailure(value: ResearchPlan | PlanFailure): value is PlanFailure {
  return (value as PlanFailure).ok === false;
}

/// 计划的输出 token 预算，按模式分档。
///
/// **1500 是不够的**，这是实测踩出来的：deepseek-v4-pro 在 standard 档下计划 JSON 会被截断
/// 在字符串中间（finish_reason=length、completion_tokens 正好顶到上限），提取失败 → 重试
/// 同样截断 → 降级种子计划。而种子计划只有一个子问题（原始目标本身），单一子问题轻易被
/// 判「覆盖充分」，于是 maxRounds=3 的研究**只跑了 1 轮**。
///
/// 一个「输出 token 不够」的参数，最终表现成「研究不深入」，中间隔了三层降级。
/// 计划 JSON 的体积随子问题与初始查询数增长，而那两者本来就按模式放大，预算必须跟着走。
///
/// 推理模型（reasoning model）还会先消耗一部分预算在思考上，余量要留够。
const PLAN_MAX_TOKENS_BY_MODE = {
  quick: 3_000,
  standard: 6_000,
  deep: 10_000,
} as const;

/// 由 budget 反推模式档位。budget 里没有 mode 字段，maxEvidenceCharsToModel 是唯一
/// 能区分三档的量（quick 20k / standard 60k / deep 120k），阈值取两档中点。
export function resolvePlanMaxTokens(budget: ResearchBudget): number {
  const chars = budget.maxEvidenceCharsToModel;
  const tier = chars >= 90_000 ? "deep" : chars >= 40_000 ? "standard" : "quick";
  return PLAN_MAX_TOKENS_BY_MODE[tier];
}

/// 生成初始计划。
///
/// 流程：模型 → 提取 JSON → core 的 parseResearchPlan（丢 URL、夹预算、去重查询、校验归属）
/// → 失败则把 zod 错误回喂重试一次 → 仍失败降级种子计划。
export async function planInitial(
  input: InitialPlanInput,
  deps: PlannerDeps,
): Promise<ResearchPlan | PlanFailure> {
  const objective = input.objective.trim();
  if (objective.length === 0) {
    return { ok: false, code: "invalid_objective", message: "研究目标不能为空" };
  }

  const seed = (): ResearchPlan =>
    buildSeedPlan({ objective, mode: input.mode, budget: input.budget });

  let previousErrors: string[] = [];
  // 最多两次：首次 + 一次带错误反馈的重试（spec §10.1 允许重试 Planner）。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await deps.gateway.call({
      purpose: "initial_plan",
      systemPrompt: INITIAL_PLANNER_SYSTEM_PROMPT,
      userPrompt: buildInitialPlanUserPrompt({
        objective,
        consumer: input.consumer,
        mode: input.mode,
        scope: input.scope,
        budget: input.budget,
        ...(previousErrors.length > 0 ? { previousErrors } : {}),
      }),
      maxTokens: resolvePlanMaxTokens(input.budget),
      maxPromptChars: input.budget.maxEvidenceCharsToModel,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    // 模型压根不可用（一个可用供应商都没配）：重试没有意义，立刻降级。
    if (!result.ok) {
      // 只记 code 会丢掉全部可操作信息（真实踩过：一句 call_failed 查了很久才发现
      // 是选中了一个 reranker 当 chat 模型）。message 已在网关侧脱敏，provider/model 是配置。
      deps.logger?.warn("[research] 初始规划无法调用模型，降级为种子计划", {
        code: result.code,
        message: result.message,
        provider: result.providerId,
        model: result.model,
      });
      return seed();
    }

    // 先剥截断标记：被截断的 JSON 一定解析失败，而「不是合法 JSON」这个报错会把人
    // 引向 JSON 提取逻辑——真实踩过，根因其实是 maxTokens 不够。
    const { text: modelText, truncated } = stripTruncationMarker(result.text);
    const raw = extractJsonObject(modelText);
    if (raw === null) {
      if (truncated) {
        deps.logger?.warn("[research] 初始计划输出被 token 上限截断，重试一次", {
          maxTokens: resolvePlanMaxTokens(input.budget),
        });
      }
      previousErrors = [
        truncated
          ? "上次输出被长度上限截断，请输出更精简的计划（更少的子问题与查询）"
          : "输出不是合法 JSON，请只输出一个 JSON 对象",
      ];
      continue;
    }

    const parsed = parseResearchPlan(raw, {
      mode: input.mode,
      ...(deps.blockedDomains ? { blockedDomains: deps.blockedDomains } : {}),
    });
    if (!parsed.ok) {
      previousErrors = parsed.errors;
      continue;
    }
    if (parsed.warnings.length > 0) {
      // warnings 里含「丢弃了模型生成的 URL」这类注入信号，必须可观测（但不含正文）。
      deps.logger?.warn("[research] 初始计划已被清洗", parsed.warnings);
    }

    return applySessionInvariants(parsed.plan, input, objective);
  }

  deps.logger?.warn("[research] 初始规划两次均未通过校验，降级为种子计划", previousErrors);
  return seed();
}

/// 把 Session 的权威字段盖回模型计划。
///
/// **预算必须以 Session 为准**：parseResearchPlan 只保证模型给的预算被夹到模式上限之内，
/// 但用户在 ResearchRequest 里的覆盖值比模式默认值更权威（可能更小），
/// 让模型的数字留下来等于用户的限额被模型悄悄放大。scope 同理：语言/时间范围是用户选择。
function applySessionInvariants(
  plan: ResearchPlan,
  input: InitialPlanInput,
  objective: string,
): ResearchPlan {
  return {
    ...plan,
    objective,
    scope: { ...plan.scope, ...input.scope },
    initialQueries: selectInitialQueries(plan),
    budget: input.budget,
  };
}

/// 首轮最多发一个 Search Server batch。按子问题轮询而不是直接 slice，避免计划按章节排列时
/// 前两个章节吃完 8 个名额，后续章节从一开始就没有任何检索机会。
function selectInitialQueries(plan: ResearchPlan): ResearchPlan["initialQueries"] {
  const buckets = new Map(
    plan.subquestions.map((subquestion) => [
      subquestion.id,
      plan.initialQueries.filter((query) => query.subquestionId === subquestion.id),
    ]),
  );
  const selected: ResearchPlan["initialQueries"] = [];
  for (let depth = 0; selected.length < SEARCH_LIMITS.maxQueriesPerRequest; depth += 1) {
    let added = false;
    for (const subquestion of plan.subquestions) {
      const query = buckets.get(subquestion.id)?.[depth];
      if (!query) continue;
      selected.push(query);
      added = true;
      if (selected.length >= SEARCH_LIMITS.maxQueriesPerRequest) break;
    }
    if (!added) break;
  }
  return selected;
}
