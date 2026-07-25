// P7 装配层的接线测试：网关 + Planner + Report Generator 拼起来之后，
// 三条注入项的签名与安全语义是否仍然成立。
//
// 这里刻意用**真的 PolicyAwareModelGateway**（只注入假 fetch），
// 因为要验的正是「装配之后 local_only 依然不出站」这条跨模块的性质。
import { describe, expect, it } from "vitest";
import type { ProviderSettings } from "@cortex-work/core/desktop/types";
import { clampResearchBudget } from "@cortex-work/core/research/budget";
import type { EvidenceChunk, ResearchDocument } from "@cortex-work/core/research/evidence";
import type { ResearchPlan } from "@cortex-work/core/research/types";
import { createResearchLlmHooks } from "./llm-hooks";

function cloudOnly(): ProviderSettings {
  return {
    providers: [
      {
        id: "cloud",
        name: "Cloud",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-secret",
        endpointFormat: "chat_completions",
        models: [{ id: "cloud-model" }],
        enabled: true,
      },
    ],
  };
}

function makeFetch(content: string): { fetchFn: typeof fetch; calls: number } {
  const state = { calls: 0 };
  const fetchFn = (async () => {
    state.calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => "",
    };
  }) as unknown as typeof fetch;
  return {
    fetchFn,
    get calls() {
      return state.calls;
    },
  };
}

const BUDGET = clampResearchBudget("quick");

const PLAN: ResearchPlan = {
  schemaVersion: 1,
  objective: "调研 node:sqlite 是否可用于生产",
  scope: {},
  subquestions: [{ id: "sq_1", text: "稳定性状态" }],
  initialQueries: [{ queryId: "q_1", subquestionId: "sq_1", text: "node sqlite" }],
  budget: BUDGET,
  completion: {
    minSourcesPerSubquestion: 1,
    minIndependentDomains: 1,
    requirePrimarySource: false,
    requireContradiction: false,
    minimumRelevance: 0.2,
  },
};

const DOCUMENT: ResearchDocument = {
  documentId: "doc_1",
  source: {
    sourceType: "documentation",
    trustZone: "public_web",
    locator: "https://nodejs.org/api/sqlite.html",
    domain: "nodejs.org",
  },
  title: "node:sqlite 文档",
  contentHash: "hash",
  mediaType: "text/html",
  fetchMethod: "http",
  fetchedAt: "2026-07-25T09:00:00.000Z",
  contentRef: "blob:hash",
  textLength: 20,
  policy: {
    trustZone: "public_web",
    allowSearchServer: true,
    allowCloudModel: true,
    allowCrossSessionReuse: true,
  },
};

const CHUNK: EvidenceChunk = {
  chunkId: "ch_1",
  documentId: "doc_1",
  text: "node:sqlite 目前是实验特性。",
  textHash: "th_1",
  objectiveScore: 0.9,
  subquestionScores: { sq_1: 0.9 },
  trustZone: "public_web",
};

describe("createResearchLlmHooks", () => {
  it("local_only + 只有云 provider：三个注入项全部走确定性降级，fetch 一次都不发", async () => {
    const fetcher = makeFetch("不该被调用");
    const hooks = createResearchLlmHooks({
      providerSettings: cloudOnly(),
      policy: "local_only",
      consumer: "deep_research",
      fetchFn: fetcher.fetchFn,
    });
    const signal = new AbortController().signal;

    const plan = await hooks.planInitial({
      objective: "调研 node:sqlite 是否可用于生产",
      mode: "quick",
      budget: BUDGET,
      signal,
    });
    expect(plan.subquestions).toHaveLength(1);
    expect(plan.budget).toEqual(BUDGET);

    const decision = await hooks.planGap({
      plan,
      roundIndex: 1,
      coverage: [],
      executedQueries: ["node sqlite"],
      remainingBudget: BUDGET,
      missingSummary: [],
      candidates: [],
      knownCandidateIds: [],
      signal,
    });
    expect(decision.action).toBe("finish");

    const markdown = await hooks.generateReport({
      plan: PLAN,
      chunks: [CHUNK],
      documents: [DOCUMENT],
      coverage: [],
      signal,
    });
    expect(markdown).toContain("[^ch_1]");

    // spec §19.2.5：local_only 下没有任何请求到达远程模型
    expect(fetcher.calls).toBe(0);
  });

  it("evidence_allowed 时按模型输出产出计划与报告", async () => {
    const planJson = JSON.stringify({
      schemaVersion: 1,
      objective: "调研 node:sqlite 是否可用于生产",
      subquestions: [{ id: "sq_a", text: "稳定性" }],
      initialQueries: [{ queryId: "q_a", subquestionId: "sq_a", text: "node sqlite stability" }],
    });
    const hooks = createResearchLlmHooks({
      providerSettings: cloudOnly(),
      policy: "evidence_allowed",
      consumer: "deep_research",
      complete: async (params) =>
        params.messages[0]!.content.includes("Markdown 研究报告")
          ? "node:sqlite 是实验特性[^ch_1]。"
          : planJson,
    });
    const signal = new AbortController().signal;

    const plan = await hooks.planInitial({
      objective: "调研 node:sqlite 是否可用于生产",
      mode: "quick",
      budget: BUDGET,
      signal,
    });
    expect(plan.subquestions[0]!.id).toBe("sq_a");

    const markdown = await hooks.generateReport({
      plan: PLAN,
      chunks: [CHUNK],
      documents: [DOCUMENT],
      coverage: [],
      signal,
    });
    expect(markdown).toBe("node:sqlite 是实验特性[^ch_1]。");
  });
});
