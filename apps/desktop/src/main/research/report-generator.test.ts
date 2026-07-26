// LLM 报告生成器的行为测试（spec §10.4、§19.1.6）。
//
// 两条红线各有一个用例：
// - 模型编造 chunkId → 引用被删、该段标 unsupported；
// - 模型不可用 → 降级为确定性证据摘要，而不是让 Session 失败。
import { describe, expect, it } from "vitest";
import { clampResearchBudget } from "@cortex-work/core/research/budget";
import type { EvidenceChunk, ResearchDocument } from "@cortex-work/core/research/evidence";
import type { CoverageReport } from "@cortex-work/core/research/types";
import type { ModelCallInput, ModelCallResult } from "./research-model-gateway";
import { generateReport, resolveReportMaxTokens } from "./report-generator";

function fakeGateway(...responses: ModelCallResult[]): {
  gateway: { call(input: ModelCallInput): Promise<ModelCallResult> };
  calls: ModelCallInput[];
} {
  const calls: ModelCallInput[] = [];
  let index = 0;
  return {
    calls,
    gateway: {
      call: async (input) => {
        calls.push(input);
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return response ?? { ok: false, code: "call_failed", message: "no response" };
      },
    },
  };
}

function ok(text: string): ModelCallResult {
  return { ok: true, text, providerId: "p", model: "m", isLocal: false };
}

const PUBLIC_TEXT = "node:sqlite 在 Node 22 上可用，但仍被标记为实验特性，生产前需评估。";
/// 只出现在正文里、不出现在目标/标题里的判别串。
const BODY_MARKER = "仍被标记为实验特性";
const MEMORY_TEXT = "用户的私人记忆：上周与投资人的会议纪要，不得出站。";

function chunk(id: string, documentId: string, text: string, trustZone: EvidenceChunk["trustZone"]): EvidenceChunk {
  return {
    chunkId: id,
    documentId,
    text,
    textHash: `hash_${id}`,
    objectiveScore: 0.8,
    subquestionScores: { sq_1: 0.8 },
    trustZone,
  };
}

function document(id: string, trustZone: ResearchDocument["policy"]["trustZone"]): ResearchDocument {
  return {
    documentId: id,
    source: { sourceType: "documentation", trustZone, locator: `https://nodejs.org/${id}`, domain: "nodejs.org" },
    title: `文档 ${id}`,
    contentHash: `content_${id}`,
    mediaType: "text/html",
    fetchMethod: "http",
    fetchedAt: "2026-07-25T09:00:00.000Z",
    contentRef: `blob:${id}`,
    textLength: 40,
    policy: {
      trustZone,
      allowSearchServer: trustZone === "public_web",
      allowCloudModel: trustZone === "public_web",
      allowCrossSessionReuse: trustZone === "public_web",
    },
  };
}

const BUDGET = clampResearchBudget("standard");

const INPUT = {
  objective: "调研 node:sqlite 是否可用于生产",
  subquestions: [{ id: "sq_1", text: "node:sqlite 的稳定性状态" }],
  chunks: [chunk("ch_1", "doc_1", PUBLIC_TEXT, "public_web")],
  documents: [document("doc_1", "public_web")],
  budget: BUDGET,
  generatedAt: "2026-07-25T10:00:00.000Z",
};

function coverage(
  bestChunkIds: string[],
  overrides: Partial<CoverageReport> = {},
): CoverageReport {
  return {
    subquestionId: "sq_1",
    status: "sufficient",
    sourceCount: 4,
    independentDomainCount: 4,
    primarySourceCount: 1,
    contradictionCount: 0,
    averageRelevance: 0.9,
    bestChunkIds,
    missing: [],
    ...overrides,
  };
}

function standardReport(body: string, citations = "[^ch_1]"): string {
  return [
    "# node:sqlite 生产可用性研究报告",
    "",
    "## 执行摘要",
    `${body}${citations}`,
    "",
    "## 研究范围与方法",
    "- 研究模式：standard",
    "- 证据范围：公开网页",
    "",
    "## node:sqlite 的稳定性状态",
    `${body}${citations}`,
    "",
    "## 综合分析与争议",
    `${body}${citations}`,
    "",
    "## 关键洞察与应用建议",
    `${body}${citations}`,
    "",
    "## 局限与待验证问题",
    `${body}${citations}`,
    "",
    "## 结论",
    `${body}${citations}`,
  ].join("\n");
}

describe("标准研究报告契约", () => {
  it("把混合研究框架、模式篇幅目标和覆盖度统计写入 prompt", async () => {
    const { gateway, calls } = fakeGateway(ok(standardReport("证据支持该结论。".repeat(300))));

    await generateReport(
      {
        ...INPUT,
        coverage: [coverage(["ch_1"])],
        rounds: [
          {
            roundIndex: 0,
            startedAt: "2026-07-25T09:00:00.000Z",
            queryIds: ["q_1"],
            candidateCount: 8,
            documentCount: 1,
            chunkCount: 1,
          },
        ],
      },
      { gateway },
    );

    expect(calls[0]!.systemPrompt).toContain("执行摘要");
    expect(calls[0]!.systemPrompt).toContain("综合分析与争议");
    expect(calls[0]!.systemPrompt).toContain("局限与待验证问题");
    expect(calls[0]!.userPrompt).toContain("目标正文长度：4000~7000 个中文字符");
    expect(calls[0]!.userPrompt).toContain("研究轮次：1");
    expect(calls[0]!.userPrompt).toContain("覆盖状态 sufficient");
  });

  it("优先把 coverage 评定的最佳片段放在对应章节前面", async () => {
    const highScore = {
      ...chunk("ch_score", "doc_score", "仅按分数会排在前面的材料", "public_web"),
      subquestionScores: { sq_1: 0.99 },
    };
    const coverageBest = {
      ...chunk("ch_best", "doc_best", "覆盖度评估选出的最佳材料", "public_web"),
      subquestionScores: { sq_1: 0.7 },
    };
    const { gateway, calls } = fakeGateway(
      ok(standardReport("综合两份证据。".repeat(300), "[^ch_score][^ch_best]")),
    );

    await generateReport(
      {
        ...INPUT,
        chunks: [highScore, coverageBest],
        documents: [document("doc_score", "public_web"), document("doc_best", "public_web")],
        coverage: [coverage(["ch_best"])],
      },
      { gateway },
    );

    expect(calls[0]!.userPrompt.indexOf("[ch_best]")).toBeLessThan(
      calls[0]!.userPrompt.indexOf("[ch_score]"),
    );
  });

  it("首稿过短或缺少标准章节时只重写一次，并保存达标稿", async () => {
    const complete = standardReport("证据支持该结论。".repeat(300));
    const { gateway, calls } = fakeGateway(ok("简短结论[^ch_1]。"), ok(complete));

    const report = await generateReport(
      {
        ...INPUT,
        coverage: [coverage(["ch_1"])],
      },
      { gateway },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]!.systemPrompt).toContain("上一次报告未达到质量标准");
    expect(calls[1]!.systemPrompt).toContain("正文长度不足");
    expect(report.markdown).toBe(complete);
    expect(report.generationStats).toMatchObject({
      qualityRetryCount: 1,
      qualityPassed: true,
      coveredSubquestionCount: 1,
    });
    expect(report.generationStats?.reportBodyChars).toBeGreaterThanOrEqual(4_000);
  });

  it("剩余出站预算不足以分配两次调用时不重试，且不突破硬上限", async () => {
    const oneCharacterBudget = clampResearchBudget("quick", {
      maxEvidenceCharsToModel: 1,
    });
    const { gateway, calls } = fakeGateway(ok("简短结论[^ch_1]。"));

    const report = await generateReport(
      {
        ...INPUT,
        mode: "quick",
        budget: oneCharacterBudget,
        coverage: [coverage(["ch_1"])],
      },
      { gateway },
    );

    expect(calls).toHaveLength(1);
    expect(report.generationStats?.promptEvidenceChars).toBeLessThanOrEqual(1);
    expect(report.generationStats?.qualityRetryCount).toBe(0);
  });

  it("研究模式是报告档位真源，证据预算被覆盖后不能反向改变 deep 篇幅", async () => {
    const deepWithSmallEvidenceBudget = clampResearchBudget("deep", {
      maxEvidenceCharsToModel: 20_000,
    });
    const { gateway, calls } = fakeGateway(
      ok(standardReport("证据支持该结论。".repeat(600))),
    );

    await generateReport(
      {
        ...INPUT,
        mode: "deep",
        budget: deepWithSmallEvidenceBudget,
        coverage: [coverage(["ch_1"])],
      },
      { gateway },
    );

    expect(calls[0]!.userPrompt).toContain("研究强度：deep");
    expect(calls[0]!.userPrompt).toContain("目标正文长度：7000~12000 个中文字符");
    expect(calls[0]!.maxTokens).toBe(14_000);
  });
});

describe("generateReport 的引用校验（spec §19.1.6）", () => {
  it("模型编造未知 chunkId 时该引用被删，且失去支撑的段落被标 unsupported", async () => {
    const { gateway } = fakeGateway(
      ok("node:sqlite 仍是实验特性[^ch_1]。\n\n它已经完全可用于生产[^ch_forged]。"),
    );
    const report = await generateReport(INPUT, { gateway });

    expect(report.markdown).toContain("[^ch_1]");
    expect(report.markdown).not.toContain("ch_forged");
    expect(report.citations.map((item) => item.chunkId)).toEqual(["ch_1"]);
    expect(report.unsupportedSections).toHaveLength(1);
    // 引用的元数据一律取自我们自己的证据链，而不是模型输出
    expect(report.citations[0]).toMatchObject({
      documentId: "doc_1",
      title: "文档 doc_1",
      textHash: "hash_ch_1",
      retrievedAt: "2026-07-25T09:00:00.000Z",
    });
  });

  it("模型拿到多篇来源却只引用一篇时重试一次", async () => {
    const { gateway, calls } = fakeGateway(
      ok("只引用第一篇[^ch_1]。"),
      ok("综合两篇独立来源[^ch_1][^ch_2]。"),
    );
    const report = await generateReport(
      {
        ...INPUT,
        chunks: [
          chunk("ch_1", "doc_1", PUBLIC_TEXT, "public_web"),
          chunk("ch_2", "doc_2", "第二篇独立来源支持相同主题。", "public_web"),
        ],
        documents: [document("doc_1", "public_web"), document("doc_2", "public_web")],
      },
      { gateway },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]!.maxPromptChars).toBeLessThanOrEqual(
      Math.floor(BUDGET.maxEvidenceCharsToModel / 2),
    );
    expect(report.citations.map((item) => item.documentId).sort()).toEqual(["doc_1", "doc_2"]);
  });

  it("记录已抓取、入选 prompt 与最终引用三层统计", async () => {
    const { gateway } = fakeGateway(ok("综合两篇来源[^ch_1][^ch_2]。"));
    const report = await generateReport(
      {
        ...INPUT,
        chunks: [
          chunk("ch_1", "doc_1", PUBLIC_TEXT, "public_web"),
          chunk("ch_2", "doc_2", "第二篇独立来源。", "public_web"),
        ],
        documents: [document("doc_1", "public_web"), document("doc_2", "public_web")],
      },
      { gateway },
    );

    expect(report.generationStats).toMatchObject({
      availableDocumentCount: 2,
      availableChunkCount: 2,
      includedDocumentCount: 2,
      includedChunkCount: 2,
      citedDocumentCount: 2,
      citedChunkCount: 2,
      promptTruncated: false,
    });
    expect(report.generationStats?.promptEvidenceChars).toBeGreaterThan(0);
  });
});

describe("generateReport 的出站过滤（spec §10.4）", () => {
  it("不允许出站的来源不会进入 prompt（memory / 未批准来源被剔除）", async () => {
    const { gateway, calls } = fakeGateway(ok("结论[^ch_1]。"));
    await generateReport(
      {
        ...INPUT,
        chunks: [
          chunk("ch_1", "doc_1", PUBLIC_TEXT, "public_web"),
          chunk("ch_2", "doc_2", MEMORY_TEXT, "memory"),
        ],
        documents: [document("doc_1", "public_web"), document("doc_2", "memory")],
      },
      { gateway },
    );

    const prompt = calls[0]!.userPrompt;
    expect(prompt).toContain(BODY_MARKER);
    expect(prompt).not.toContain("私人记忆");
    expect(prompt).not.toContain("ch_2");
  });

  it("public_web 的正文可以直接进 prompt（证据正文允许发给所选模型）", async () => {
    const { gateway, calls } = fakeGateway(ok("结论[^ch_1]。"));
    await generateReport(INPUT, { gateway });
    expect(calls[0]!.userPrompt).toContain(BODY_MARKER);
  });

  // fail-closed：拿不到 chunk 对应的文档就拿不到来源策略，此时不能假定它可以出站。
  it("文档元数据缺失时该 chunk 被剔除", async () => {
    const { gateway, calls } = fakeGateway(ok("结论。"));
    await generateReport({ ...INPUT, documents: [] }, { gateway });
    expect(calls[0]!.userPrompt).not.toContain(BODY_MARKER);
  });

  it("出站预算被传给网关", async () => {
    const { gateway, calls } = fakeGateway(ok("结论[^ch_1]。"));
    await generateReport(INPUT, { gateway });
    expect(calls[0]!.maxPromptChars).toBe(Math.floor(BUDGET.maxEvidenceCharsToModel / 2));
  });

  it("超长来源标题不会挤掉同一节的后续证据", async () => {
    const { gateway, calls } = fakeGateway(ok("结论[^ch_1][^ch_2]。"));
    await generateReport(
      {
        ...INPUT,
        chunks: [
          chunk("ch_1", "doc_1", PUBLIC_TEXT, "public_web"),
          chunk("ch_2", "doc_2", "第二篇独立来源提供了 Agent 架构证据。", "public_web"),
        ],
        documents: [
          { ...document("doc_1", "public_web"), title: `GitHub - ${"异常标题".repeat(20_000)}` },
          { ...document("doc_2", "public_web"), title: "第二篇正常来源" },
        ],
      },
      { gateway },
    );

    const prompt = calls[0]!.userPrompt;
    expect([...prompt].length).toBeLessThanOrEqual(BUDGET.maxEvidenceCharsToModel);
    expect(prompt).toContain("[ch_1]");
    expect(prompt).toContain("[ch_2]");
    expect(prompt).toContain("第二篇正常来源");
  });

  it("证据总量超预算时按子问题轮询装入，不会只保留前面的章节", async () => {
    const subquestions = Array.from({ length: 5 }, (_, i) => ({
      id: `sq_${i + 1}`,
      text: `子问题 ${i + 1}`,
    }));
    const chunks = subquestions.flatMap((subquestion, sectionIndex) =>
      Array.from({ length: 8 }, (_, chunkIndex) => ({
        ...chunk(
          `ch_${sectionIndex + 1}_${chunkIndex + 1}`,
          `doc_${sectionIndex + 1}_${chunkIndex + 1}`,
          `${"证据正文".repeat(200)} section-${sectionIndex + 1}`,
          "public_web",
        ),
        subquestionScores: { [subquestion.id]: 0.9 },
      })),
    );
    const documents = chunks.map((item) => ({
      ...document(item.documentId, "public_web"),
      title: `来源 ${item.documentId}`,
    }));
    const quickBudget = clampResearchBudget("quick");
    const { gateway, calls } = fakeGateway(ok("综述[^ch_1_1][^ch_5_1]。"));

    await generateReport(
      {
        ...INPUT,
        subquestions,
        chunks,
        documents,
        budget: quickBudget,
      },
      { gateway },
    );

    const prompt = calls[0]!.userPrompt;
    expect([...prompt].length).toBeLessThanOrEqual(quickBudget.maxEvidenceCharsToModel);
    expect(prompt).toContain("[ch_1_1]");
    expect(prompt).toContain("[ch_5_1]");
  });

  it("同一子问题优先装入不同文档，单篇文档最多两个片段", async () => {
    const constrainedBudget = clampResearchBudget("quick", { maxEvidenceCharsToModel: 3_000 });
    const chunks = [
      { ...chunk("ch_a1", "doc_a", "A".repeat(900), "public_web"), objectiveScore: 1, subquestionScores: { sq_1: 1 } },
      { ...chunk("ch_a2", "doc_a", "B".repeat(900), "public_web"), objectiveScore: 0.9, subquestionScores: { sq_1: 0.9 } },
      { ...chunk("ch_a3", "doc_a", "C".repeat(900), "public_web"), objectiveScore: 0.8, subquestionScores: { sq_1: 0.8 } },
      { ...chunk("ch_b1", "doc_b", "D".repeat(900), "public_web"), objectiveScore: 0.7, subquestionScores: { sq_1: 0.7 } },
    ];
    const { gateway, calls } = fakeGateway(ok("结论[^ch_a1][^ch_b1]。"));

    await generateReport(
      {
        ...INPUT,
        chunks,
        documents: [document("doc_a", "public_web"), document("doc_b", "public_web")],
        budget: constrainedBudget,
      },
      { gateway },
    );

    const prompt = calls[0]!.userPrompt;
    expect(prompt).toContain("[ch_a1]");
    expect(prompt).toContain("[ch_b1]");
    expect(prompt).not.toContain("[ch_a3]");
  });
});

describe("generateReport 的相关性门槛", () => {
  it("低于计划 minimumRelevance 的片段不会进入报告 prompt", async () => {
    const { gateway, calls } = fakeGateway(ok("结论[^ch_high]。"));
    const low = {
      ...chunk("ch_low", "doc_2", "低相关材料", "public_web"),
      objectiveScore: 0.2,
      subquestionScores: { sq_1: 0.2 },
    };
    const high = {
      ...chunk("ch_high", "doc_1", "高相关材料", "public_web"),
      objectiveScore: 0.8,
      subquestionScores: { sq_1: 0.8 },
    };

    await generateReport(
      {
        ...INPUT,
        chunks: [low, high],
        documents: [document("doc_1", "public_web"), document("doc_2", "public_web")],
        minimumRelevance: 0.5,
      },
      { gateway },
    );

    expect(calls[0]!.userPrompt).toContain("ch_high");
    expect(calls[0]!.userPrompt).not.toContain("ch_low");
  });

  it("模型失败后的确定性报告也不会重新引入低相关片段", async () => {
    const { gateway } = fakeGateway({ ok: false, code: "call_failed", message: "offline" });
    const low = {
      ...chunk("ch_low", "doc_2", "低相关材料", "public_web"),
      objectiveScore: 0.2,
      subquestionScores: { sq_1: 0.2 },
    };
    const high = {
      ...chunk("ch_high", "doc_1", "高相关材料", "public_web"),
      objectiveScore: 0.8,
      subquestionScores: { sq_1: 0.8 },
    };

    const report = await generateReport(
      {
        ...INPUT,
        chunks: [low, high],
        documents: [document("doc_1", "public_web"), document("doc_2", "public_web")],
        minimumRelevance: 0.5,
      },
      { gateway },
    );

    expect(report.citations.map((citation) => citation.chunkId)).toEqual(["ch_high"]);
  });
});

describe("generateReport 的降级", () => {
  it("一个供应商都没配时降级为确定性证据摘要，而不是失败", async () => {
    const { gateway } = fakeGateway({
      ok: false,
      code: "no_provider_configured",
      message: "尚未配置任何可用的模型供应商",
    });
    const report = await generateReport(INPUT, { gateway });

    expect(report.markdown).toContain("node:sqlite");
    expect(report.markdown).toContain("[^ch_1]");
    expect(report.citations.map((item) => item.chunkId)).toEqual(["ch_1"]);
    expect(report.generatedAt).toBe("2026-07-25T10:00:00.000Z");
    expect(report.generationStats).toMatchObject({
      includedDocumentCount: 0,
      includedChunkCount: 0,
      promptEvidenceChars: 0,
      usedFallback: true,
    });
  });

  it("模型调用失败时降级为确定性证据摘要", async () => {
    const { gateway } = fakeGateway({ ok: false, code: "call_failed", message: "HTTP 500" });
    const report = await generateReport(INPUT, { gateway });
    expect(report.markdown).toContain("[^ch_1]");
  });

  it("模型返回空正文时降级为确定性证据摘要", async () => {
    const { gateway } = fakeGateway(ok("   "));
    const report = await generateReport(INPUT, { gateway });
    expect(report.markdown).toContain("[^ch_1]");
  });

  it("没有任何证据时仍产出可用的报告骨架（不抛错）", async () => {
    const { gateway } = fakeGateway({ ok: false, code: "call_failed", message: "x" });
    const report = await generateReport({ ...INPUT, chunks: [], documents: [] }, { gateway });
    expect(report.markdown.length).toBeGreaterThan(0);
    expect(report.citations).toEqual([]);
  });
});

// 报告是整个研究里最慢的一步（几十秒到几分钟）。不流式的话，用户在这段时间里
// 只能看到一个「撰写中」的徽标，完全无法判断是在写还是卡死了。
describe("generateReport 的流式输出", () => {
  /// 会主动喂增量的网关替身（模拟供应商 SSE 逐段回吐）。
  function streamingGateway(pieces: string[]): {
    gateway: { call(input: ModelCallInput): Promise<ModelCallResult> };
  } {
    return {
      gateway: {
        call: async (input) => {
          let acc = "";
          for (const piece of pieces) {
            acc += piece;
            input.onDelta?.(piece);
          }
          return ok(acc);
        },
      },
    };
  }

  it("把模型的增量按序透传给调用方，拼起来等于最终正文", async () => {
    const seen: string[] = [];
    const { gateway } = streamingGateway(["# 报告\n\n", "node:sqlite ", "仍是实验特性[^ch_1]。"]);

    const report = await generateReport(
      { ...INPUT, onDelta: (delta) => seen.push(delta) },
      { gateway },
    );

    expect(seen.join("")).toBe("# 报告\n\nnode:sqlite 仍是实验特性[^ch_1]。");
    expect(report.markdown).toContain("[^ch_1]");
  });

  it("不传 onDelta 时不向网关要求流式（Planner 等场景保持原样）", async () => {
    const { gateway, calls } = fakeGateway(ok("结论[^ch_1]。"));
    await generateReport(INPUT, { gateway });
    expect(calls[0]!.onDelta).toBeUndefined();
  });

  it("降级路径不发增量（用户不该看到草稿最后被一份完全不同的摘要替换）", async () => {
    const seen: string[] = [];
    const { gateway } = fakeGateway({ ok: false, code: "call_failed", message: "HTTP 500" });
    const report = await generateReport(
      { ...INPUT, onDelta: (delta) => seen.push(delta) },
      { gateway },
    );
    expect(seen).toEqual([]);
    expect(report.markdown).toContain("[^ch_1]");
  });

  it("来源多样性重试不把第二份完整报告追加到第一份流式草稿后面", async () => {
    const seen: string[] = [];
    let call = 0;
    const gateway = {
      call: async (input: ModelCallInput): Promise<ModelCallResult> => {
        call += 1;
        input.onDelta?.(call === 1 ? "第一份草稿" : "第二份草稿");
        return ok(call === 1 ? "只引用第一篇[^ch_1]。" : "综合两篇[^ch_1][^ch_2]。");
      },
    };

    const report = await generateReport(
      {
        ...INPUT,
        chunks: [
          chunk("ch_1", "doc_1", PUBLIC_TEXT, "public_web"),
          chunk("ch_2", "doc_2", "第二篇独立来源。", "public_web"),
        ],
        documents: [document("doc_1", "public_web"), document("doc_2", "public_web")],
        onDelta: (delta) => seen.push(delta),
      },
      { gateway },
    );

    expect(seen).toEqual(["第一份草稿"]);
    expect(report.citations).toHaveLength(2);
  });
});

/// 输出 token 上限是**安全阀**，不与报告契约里的模式软目标混为一谈。
/// 这里只钉两件事：上限与「本次喂了多少材料」同向缩放；以及没有第二个用户配置字段
/// 可以绕开统一的模式档位改写它。
describe("报告输出预算", () => {
  function captureMaxTokens(): {
    gateway: { call: (input: ModelCallInput) => Promise<ModelCallResult>; preflight: () => never };
    seen: Array<number | undefined>;
  } {
    const seen: Array<number | undefined> = [];
    return {
      gateway: {
        call: async (input: ModelCallInput) => {
          seen.push(input.maxTokens);
          return ok("# 报告\n\n正文[^ch_1]。");
        },
        preflight: (() => {
          throw new Error("本用例不该走 preflight");
        }) as never,
      },
      seen,
    };
  }

  it("按模式分档：deep 的输出上限必须大于 quick（材料多 6 倍，写得一样短就是覆盖不全）", async () => {
    const quick = captureMaxTokens();
    await generateReport({ ...INPUT, budget: clampResearchBudget("quick") }, { gateway: quick.gateway });
    const deep = captureMaxTokens();
    await generateReport({ ...INPUT, budget: clampResearchBudget("deep") }, { gateway: deep.gateway });
    expect(deep.seen[0]!).toBeGreaterThan(quick.seen[0]!);
  });

  // 旧内部调用方尚未显式携带 mode 时仍按预算档位兼容；生产装配会传 Session.mode，
  // 因此用户收窄证据预算不会反向降低报告强度。
  it("旧调用方省略 mode 时仍可由 budget 推出兼容档位", async () => {
    const budget = clampResearchBudget("deep");
    const { gateway, seen } = captureMaxTokens();
    await generateReport({ ...INPUT, budget }, { gateway });
    expect(seen[0]).toBe(resolveReportMaxTokens({ budget }));
  });
});

describe("每节证据条数也要按模式分档", () => {
  /// 只放大输出预算是不够的：模型手上只有 8 条摘录时，让它写 9000 字只会得到注水。
  /// 输入材料量与输出长度必须一起放大，否则「报告变长」只是幻觉。
  function manyChunks(n: number): EvidenceChunk[] {
    return Array.from({ length: n }, (_, i) =>
      chunk(`ch_${i}`, `doc_${Math.floor(i / 2)}`, PUBLIC_TEXT, "public_web"),
    );
  }

  function capturePrompt(): {
    gateway: { call: (input: ModelCallInput) => Promise<ModelCallResult>; preflight: () => never };
    prompts: string[];
  } {
    const prompts: string[] = [];
    return {
      gateway: {
        call: async (input: ModelCallInput) => {
          prompts.push(input.userPrompt);
          return ok("# 报告\n\n正文[^ch_0]。");
        },
        preflight: (() => {
          throw new Error("本用例不该走 preflight");
        }) as never,
      },
      prompts,
    };
  }

  it("deep 模式送进 prompt 的 chunk 数多于 quick", async () => {
    const chunks = manyChunks(40);
    const documents = Array.from({ length: 20 }, (_, i) => document(`doc_${i}`, "public_web"));
    const quick = capturePrompt();
    await generateReport(
      { ...INPUT, chunks, documents, budget: clampResearchBudget("quick") },
      { gateway: quick.gateway },
    );
    const deep = capturePrompt();
    await generateReport(
      { ...INPUT, chunks, documents, budget: clampResearchBudget("deep") },
      { gateway: deep.gateway },
    );

    const countRefs = (prompt: string): number => (prompt.match(/ch_\d+/g) ?? []).length;
    expect(countRefs(deep.prompts[0]!)).toBeGreaterThan(countRefs(quick.prompts[0]!));
  });
});
