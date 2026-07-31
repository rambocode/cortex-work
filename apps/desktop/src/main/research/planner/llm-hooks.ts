// P7 的装配点：把「模型网关 + Initial Planner + Gap Planner + Report Generator」拼成
// 编排器认得的三个注入项。
//
// 存在的意义是把**唯一一处知道用哪个模型的代码**收敛在这里：
// 编排器只看见三个函数，Planner 只看见网关，谁都拿不到凭据（收编后凭据根本不进主进程业务层，
// 只在 safeStorage 金库与 pi 运行时之间流动）。装配层换实现都只改这一个文件。
//
// 每个 Session 建一个实例：网关持有模型引用的快照，Session 中途改设置不会漂移。
import type {
  PlannerDecision,
  ResearchConsumer,
  ResearchMode,
  ResearchPlan,
} from "@cortex-work/core/research/types";
import type { postChatCompletion, postChatCompletionStream } from "../../ipc/openai-chat";
import type { ModelRef } from "../../providers/contract";
import type { PiGatewayRuntime } from "../../providers/pi-runtime";
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

/// 装配入参。complete / completeStream / runtime 只为测试注入而存在，生产不传。
export interface ResearchLlmHooksInput {
  /// 本次 Session 使用的 Catalog 模型引用（已由 llm-hooks-wiring 按研究偏好 → 全局默认解析）。
  model: ModelRef;
  consumer: ResearchConsumer;
  /// Session 的权威研究强度；报告档位不得由可覆盖预算反推。
  mode?: ResearchMode;
  blockedDomains?: readonly string[];
  complete?: typeof postChatCompletion;
  /// 报告是唯一走流式的调用，因此它有独立的注入口（Planner 仍走 complete）。
  completeStream?: typeof postChatCompletionStream;
  runtime?: PiGatewayRuntime;
  now?: () => Date;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

/// 按 Session 装配 LLM 能力。
export function createResearchLlmHooks(input: ResearchLlmHooksInput): ResearchLlmHooks {
  const gateway = new ResearchModelGateway({
    model: input.model,
    ...(input.complete ? { complete: input.complete } : {}),
    ...(input.completeStream ? { completeStream: input.completeStream } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
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

    generateReport: async (call) => {
      const report = await generateReport(
        {
          objective: call.plan.objective,
          ...(input.mode ? { mode: input.mode } : {}),
          subquestions: call.plan.subquestions,
          coverage: call.coverage,
          ...(call.rounds ? { rounds: call.rounds } : {}),
          chunks: call.chunks,
          documents: call.documents,
          budget: call.plan.budget,
          minimumRelevance: call.plan.completion.minimumRelevance,
          signal: call.signal,
          // 流式增量原样转交编排层（它负责节流并转成 report_delta 事件）。
          ...(call.onDelta ? { onDelta: call.onDelta } : {}),
        },
        {
          gateway,
          ...(input.now ? { now: input.now } : {}),
          ...(input.logger ? { logger: input.logger } : {}),
        },
      );
      // 编排器会再过一次 Citation Validator 并自行组装 CitationRef。这里的 citations
      // 会被丢弃不是浪费：generateReport 里的那次校验负责
      // **在 LLM 输出进入系统的第一时间**就删掉伪造引用，两次校验是幂等的纯函数。
      return {
        markdown: report.markdown,
        ...(report.generationStats ? { generationStats: report.generationStats } : {}),
      };
    },
  };
}
