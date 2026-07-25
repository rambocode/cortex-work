// P7 的装配点：把「模型网关 + Initial Planner + Gap Planner + Report Generator」拼成
// 编排器认得的三个注入项。
//
// 存在的意义是把**唯一一处知道 provider 配置与研究模型偏好的代码**收敛在这里：
// 编排器只看见三个函数，Planner 只看见网关，谁都拿不到 apiKey。装配层换实现（换供应商、
// 换本地模型、整体关掉 LLM）都只改这一个文件。
//
// 每个 Session 建一个实例：网关持有 provider 与偏好的快照，Session 中途改设置不会漂移。
import type { ProviderSettings } from "@cortex-work/core/desktop/types";
import type { ResearchModelPreference } from "@cortex-work/core/research/model-selection";
import type {
  PlannerDecision,
  ResearchConsumer,
  ResearchPlan,
} from "@cortex-work/core/research/types";
import type { postChatCompletion } from "../../ipc/openai-chat";
import { ResearchModelGateway } from "../research-model-gateway";
import { generateReport } from "../report-generator";
import type { GapPlanner, InitialPlanner, ReportGenerator } from "../research-orchestrator";
import { planGap } from "./gap-planner";
import { isPlanFailure, planInitial } from "./initial-planner";

/// 编排器需要的三个 LLM 注入项。
export interface ResearchLlmHooks {
  planInitial: InitialPlanner;
  planGap: GapPlanner;
  generateReport: ReportGenerator;
}

/// 装配入参。complete / fetchFn 只为测试注入而存在，生产不传。
export interface ResearchLlmHooksInput {
  providerSettings: ProviderSettings;
  /// 研究模型偏好（研究设置的 modelProviderId / modelId）；缺省 = 跟随全局默认模型。
  preference?: ResearchModelPreference;
  consumer: ResearchConsumer;
  blockedDomains?: readonly string[];
  complete?: typeof postChatCompletion;
  fetchFn?: typeof fetch;
  now?: () => Date;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

/// 按 Session 装配 LLM 能力。
export function createResearchLlmHooks(input: ResearchLlmHooksInput): ResearchLlmHooks {
  const gateway = new ResearchModelGateway({
    providerSettings: input.providerSettings,
    ...(input.preference ? { preference: input.preference } : {}),
    ...(input.complete ? { complete: input.complete } : {}),
    ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  });
  const plannerDeps = {
    gateway,
    ...(input.blockedDomains ? { blockedDomains: input.blockedDomains } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  };

  return {
    planInitial: async (call): Promise<ResearchPlan> => {
      const plan = await planInitial(
        {
          objective: call.objective,
          consumer: input.consumer,
          mode: call.mode,
          scope: {},
          budget: call.budget,
          signal: call.signal,
        },
        plannerDeps,
      );
      // PlanFailure 只在目标为空时出现，而 Session 的 objective 由 create 校验过；
      // 真走到这里说明上游有 bug —— 抛错让它可见，编排层会把 Session 判为 failed。
      if (isPlanFailure(plan)) throw new Error(plan.message);
      return plan;
    },

    planGap: async (call): Promise<PlannerDecision> =>
      planGap(
        {
          subquestions: call.plan.subquestions,
          coverage: call.coverage,
          executedQueries: call.executedQueries,
          remainingBudget: call.remainingBudget,
          missingSummary: call.missingSummary,
          candidates: call.candidates,
          knownCandidateIds: call.knownCandidateIds,
          signal: call.signal,
        },
        plannerDeps,
      ),

    generateReport: async (call): Promise<string> => {
      const report = await generateReport(
        {
          objective: call.plan.objective,
          subquestions: call.plan.subquestions,
          chunks: call.chunks,
          documents: call.documents,
          budget: call.plan.budget,
          signal: call.signal,
        },
        {
          gateway,
          ...(input.now ? { now: input.now } : {}),
          ...(input.logger ? { logger: input.logger } : {}),
        },
      );
      // 编排器要的是 markdown（它会再过一次 Citation Validator 并自行组装 CitationRef）。
      // 这里的 report.citations 会被丢弃不是浪费：generateReport 里的那次校验负责
      // **在 LLM 输出进入系统的第一时间**就删掉伪造引用，两次校验是幂等的纯函数。
      return report.markdown;
    },
  };
}
