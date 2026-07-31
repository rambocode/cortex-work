// P7 装配层的接线测试：网关 + Planner + Report Generator 拼起来之后，
// 三条注入项的签名与安全语义是否仍然成立。
//
// 这里刻意用**真的 ResearchModelGateway**（只注入假 pi 运行时），
// 因为要验的正是「装配之后，模型引用悬空依然零出站」这条跨模块的性质。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clampResearchBudget } from "@cortex-work/core/research/budget";
import type { EvidenceChunk, ResearchDocument } from "@cortex-work/core/research/evidence";
import type { ResearchPlan } from "@cortex-work/core/research/types";
let catalog: ReturnType<typeof fakeCatalog> | undefined;
vi.mock("../../providers/catalog", () => ({ getProviderCatalog: () => catalog }));
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));

import { createFakePiRuntime, fakeCatalog } from "../../providers/__fixtures__/fake-pi-runtime";
import { resolveReportMaxTokens } from "../report-generator";
import { createResearchLlmHooks } from "./llm-hooks";

const CLOUD = { providerId: "cloud", modelId: "cloud-model" };

beforeEach(() => {
  catalog = fakeCatalog("cloud", "cloud-model");
});

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
  it("模型引用悬空：三个注入项全部走确定性降级，出站一次都不发", async () => {
    const runtime = createFakePiRuntime({ texts: ["不该被调用"] });
    const hooks = createResearchLlmHooks({
      // Catalog 里没有这个 provider → Gateway 出站前 config 阻断（计划 §5，不回退）。
      model: { providerId: "已下线的供应商", modelId: "不存在的模型" },
      consumer: "deep_research",
      runtime,
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

    const generated = await hooks.generateReport({
      plan: PLAN,
      chunks: [CHUNK],
      documents: [DOCUMENT],
      coverage: [],
      signal,
    });
    expect(typeof generated === "string" ? generated : generated.markdown).toContain("[^ch_1]");

    // spec §19.2.5 / 计划 §5：引用不可用时没有任何请求出站（一个字节都不发）
    expect(runtime.calls).toHaveLength(0);
  });

  it("模型可用时按模型输出产出计划与报告", async () => {
    const planJson = JSON.stringify({
      schemaVersion: 1,
      objective: "调研 node:sqlite 是否可用于生产",
      subquestions: [{ id: "sq_a", text: "稳定性" }],
      initialQueries: [{ queryId: "q_a", subquestionId: "sq_a", text: "node sqlite stability" }],
    });
    const hooks = createResearchLlmHooks({
      model: CLOUD,
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

    const generated = await hooks.generateReport({
      plan: PLAN,
      chunks: [CHUNK],
      documents: [DOCUMENT],
      coverage: [],
      signal,
    });
    expect(typeof generated === "string" ? generated : generated.markdown).toBe(
      "node:sqlite 是实验特性[^ch_1]。",
    );
  });

  // 报告篇幅由用户在研究目标里的表述决定，装配层不注入任何字数指令；
  // 输出 token 上限只是安全阀，按研究强度分档（见 report-generator 的 resolveReportMaxTokens）。
  it("按研究强度给出输出上限，不受任何篇幅配置影响", async () => {
    const seen: Array<number | undefined> = [];
    const hooks = createResearchLlmHooks({
      model: CLOUD,
      consumer: "deep_research",
      complete: async (params) => {
        seen.push(params.maxTokens);
        return "正文[^ch_1]。";
      },
    });

    await hooks.generateReport({
      plan: PLAN,
      chunks: [CHUNK],
      documents: [DOCUMENT],
      coverage: [],
      signal: new AbortController().signal,
    });

    expect(seen[0]).toBe(resolveReportMaxTokens({ budget: PLAN.budget }));
  });
});
