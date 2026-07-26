import { describe, expect, it } from "vitest";

import { decideStop, evaluateCoverage, type CoverageInput } from "./coverage";
import type { CompletionCriteria, ResearchBudget } from "./types";

const SQ = [
  { id: "sq1", text: "子问题一" },
  { id: "sq2", text: "子问题二" },
];

const baseCriteria: CompletionCriteria = {
  minSourcesPerSubquestion: 2,
  minIndependentDomains: 2,
  requirePrimarySource: false,
  requireContradiction: false,
  minimumRelevance: 0.3,
};

const criteria = (over: Partial<CompletionCriteria> = {}): CompletionCriteria => ({
  ...baseCriteria,
  ...over,
});

const budget = (over: Partial<ResearchBudget> = {}): ResearchBudget => ({
  maxRounds: 3,
  maxQueries: 12,
  maxCandidates: 60,
  maxDocuments: 10,
  maxBrowserFetches: 2,
  maxDurationMs: 120_000,
  maxEvidenceCharsToModel: 100_000,
  ...over,
});

const chunk = (
  chunkId: string,
  documentId: string,
  scores: Record<string, number>,
): CoverageInput["chunks"][number] => ({ chunkId, documentId, subquestionScores: scores });

describe("evaluateCoverage", () => {
  it("没有任何相关 chunk 时判定为 missing", () => {
    const [report] = evaluateCoverage({
      subquestions: [SQ[0]!],
      criteria: criteria(),
      chunks: [],
      documents: [],
    });

    expect(report).toMatchObject({
      subquestionId: "sq1",
      status: "missing",
      sourceCount: 0,
      independentDomainCount: 0,
      primarySourceCount: 0,
      contradictionCount: 0,
      averageRelevance: 0,
      bestChunkIds: [],
    });
    expect(report!.missing).toEqual(["尚无任何相关来源"]);
  });

  it("低于 minimumRelevance 的 chunk 不计入覆盖度", () => {
    const [report] = evaluateCoverage({
      subquestions: [SQ[0]!],
      criteria: criteria({ minimumRelevance: 0.5 }),
      chunks: [chunk("k1", "d1", { sq1: 0.2 }), chunk("k2", "d2", { sq1: 0.1 })],
      documents: [
        { documentId: "d1", domain: "a.com" },
        { documentId: "d2", domain: "b.com" },
      ],
    });

    expect(report!.status).toBe("missing");
    expect(report!.sourceCount).toBe(0);
  });

  it("来源数不足时为 weak 并给出缺口描述", () => {
    const [report] = evaluateCoverage({
      subquestions: [SQ[0]!],
      criteria: criteria(),
      chunks: [chunk("k1", "d1", { sq1: 0.9 })],
      documents: [{ documentId: "d1", domain: "a.com" }],
    });

    expect(report!.status).toBe("weak");
    expect(report!.sourceCount).toBe(1);
    expect(report!.missing).toEqual(["独立来源不足（1/2）", "独立域名不足（1/2）"]);
  });

  it("满足全部条件时为 sufficient 且无缺口", () => {
    const [report] = evaluateCoverage({
      subquestions: [SQ[0]!],
      criteria: criteria(),
      chunks: [chunk("k1", "d1", { sq1: 0.9 }), chunk("k2", "d2", { sq1: 0.7 })],
      documents: [
        { documentId: "d1", domain: "a.com" },
        { documentId: "d2", domain: "b.com" },
      ],
    });

    expect(report!.status).toBe("sufficient");
    expect(report!.sourceCount).toBe(2);
    expect(report!.independentDomainCount).toBe(2);
    expect(report!.missing).toEqual([]);
  });

  it("同一重复簇只算一个独立来源", () => {
    const [report] = evaluateCoverage({
      subquestions: [SQ[0]!],
      criteria: criteria(),
      chunks: [
        chunk("k1", "d1", { sq1: 0.9 }),
        chunk("k2", "d2", { sq1: 0.8 }),
        chunk("k3", "d3", { sq1: 0.7 }),
      ],
      documents: [
        { documentId: "d1", domain: "a.com" },
        { documentId: "d2", domain: "b.com", duplicateOf: "d1" },
        // 链式指向：d3 → d2 → d1，必须收敛到同一个代表
        { documentId: "d3", domain: "c.com", duplicateOf: "d2" },
      ],
    });

    expect(report!.sourceCount).toBe(1);
    expect(report!.independentDomainCount).toBe(1);
    expect(report!.status).toBe("weak");
  });

  it("同一 authorityGroup 的镜像域名算同一个独立来源", () => {
    const [report] = evaluateCoverage({
      subquestions: [SQ[0]!],
      criteria: criteria(),
      chunks: [chunk("k1", "d1", { sq1: 0.9 }), chunk("k2", "d2", { sq1: 0.8 })],
      documents: [
        { documentId: "d1", domain: "news.example.com", authorityGroup: "example" },
        { documentId: "d2", domain: "mirror.example.cn", authorityGroup: "example" },
      ],
    });

    expect(report!.sourceCount).toBe(2);
    expect(report!.independentDomainCount).toBe(1);
    expect(report!.missing).toEqual(["独立域名不足（1/2）"]);
  });

  it("requirePrimarySource 未满足时报缺一手来源", () => {
    const [report] = evaluateCoverage({
      subquestions: [SQ[0]!],
      criteria: criteria({ requirePrimarySource: true }),
      chunks: [chunk("k1", "d1", { sq1: 0.9 }), chunk("k2", "d2", { sq1: 0.8 })],
      documents: [
        { documentId: "d1", domain: "a.com", sourceType: "news" },
        { documentId: "d2", domain: "b.com", sourceType: "secondary" },
      ],
    });

    expect(report!.primarySourceCount).toBe(0);
    expect(report!.status).toBe("weak");
    expect(report!.missing).toEqual(["缺少一手来源"]);
  });

  it("requireContradiction 满足时计入 contradictionCount", () => {
    const [report] = evaluateCoverage({
      subquestions: [SQ[0]!],
      criteria: criteria({ requireContradiction: true, requirePrimarySource: true }),
      chunks: [chunk("k1", "d1", { sq1: 0.9 }), chunk("k2", "d2", { sq1: 0.8 })],
      documents: [
        { documentId: "d1", domain: "a.com", sourceType: "primary" },
        { documentId: "d2", domain: "b.com", sourceType: "secondary" },
      ],
      contradictions: [
        { subquestionId: "sq1", chunkIds: ["k1", "k2"] },
        { subquestionId: "sq2", chunkIds: ["k1"] },
      ],
    });

    expect(report!.primarySourceCount).toBe(1);
    expect(report!.contradictionCount).toBe(1);
    expect(report!.status).toBe("sufficient");
  });

  it("requireContradiction 未满足时报缺交叉验证", () => {
    const [report] = evaluateCoverage({
      subquestions: [SQ[0]!],
      criteria: criteria({ requireContradiction: true }),
      chunks: [chunk("k1", "d1", { sq1: 0.9 }), chunk("k2", "d2", { sq1: 0.8 })],
      documents: [
        { documentId: "d1", domain: "a.com" },
        { documentId: "d2", domain: "b.com" },
      ],
    });

    expect(report!.missing).toEqual(["缺少交叉验证或反面证据"]);
    expect(report!.status).toBe("weak");
  });

  it("bestChunkIds 取得分最高的前 3 个，averageRelevance 为均值", () => {
    const [report] = evaluateCoverage({
      subquestions: [SQ[0]!],
      criteria: criteria(),
      chunks: [
        chunk("k1", "d1", { sq1: 0.4 }),
        chunk("k2", "d2", { sq1: 0.8 }),
        chunk("k3", "d3", { sq1: 0.6 }),
        chunk("k4", "d4", { sq1: 0.9 }),
        chunk("k5", "d5", { sq1: 0.1 }),
      ],
      documents: [1, 2, 3, 4, 5].map((n) => ({ documentId: `d${n}`, domain: `d${n}.com` })),
    });

    expect(report!.bestChunkIds).toEqual(["k4", "k2", "k3"]);
    // k5 低于 minimumRelevance 0.3，被排除；(0.4+0.8+0.6+0.9)/4 = 0.675
    expect(report!.averageRelevance).toBe(0.675);
  });

  it("按子问题逐个产出报告，顺序与入参一致", () => {
    const reports = evaluateCoverage({
      subquestions: SQ,
      criteria: criteria(),
      chunks: [chunk("k1", "d1", { sq1: 0.9, sq2: 0.1 })],
      documents: [{ documentId: "d1", domain: "a.com" }],
    });

    expect(reports.map((r) => r.subquestionId)).toEqual(["sq1", "sq2"]);
    expect(reports[0]!.status).toBe("weak");
    expect(reports[1]!.status).toBe("missing");
  });

  it("documents 里缺失的 documentId 各自算独立来源", () => {
    const [report] = evaluateCoverage({
      subquestions: [SQ[0]!],
      criteria: criteria(),
      chunks: [chunk("k1", "unknown-1", { sq1: 0.9 }), chunk("k2", "unknown-2", { sq1: 0.8 })],
      documents: [],
    });

    expect(report!.sourceCount).toBe(2);
    expect(report!.independentDomainCount).toBe(2);
    expect(report!.status).toBe("sufficient");
  });
});

describe("decideStop", () => {
  const sufficient = evaluateCoverage({
    subquestions: [SQ[0]!],
    criteria: criteria(),
    chunks: [chunk("k1", "d1", { sq1: 0.9 }), chunk("k2", "d2", { sq1: 0.8 })],
    documents: [
      { documentId: "d1", domain: "a.com" },
      { documentId: "d2", domain: "b.com" },
    ],
  });

  const weak = evaluateCoverage({
    subquestions: [SQ[0]!],
    criteria: criteria(),
    chunks: [chunk("k1", "d1", { sq1: 0.9 })],
    documents: [{ documentId: "d1", domain: "a.com" }],
  });

  it("全部子问题 sufficient 时停止", () => {
    expect(decideStop({ coverage: sufficient, roundsUsed: 1, budget: budget(), elapsedMs: 1000 })).toEqual({
      stop: true,
      reason: "全部子问题覆盖度已达标",
    });
  });

  it("轮数用尽时停止", () => {
    expect(decideStop({ coverage: weak, roundsUsed: 3, budget: budget(), elapsedMs: 1000 })).toEqual({
      stop: true,
      reason: "轮数已用尽（3/3）",
    });
  });

  it("时长用尽时停止", () => {
    expect(
      decideStop({ coverage: weak, roundsUsed: 1, budget: budget(), elapsedMs: 120_000 }),
    ).toEqual({ stop: true, reason: "时长已用尽（120/120 秒）" });
  });

  it("其它预算用尽时停止", () => {
    expect(
      decideStop({
        coverage: weak,
        roundsUsed: 1,
        budget: budget(),
        elapsedMs: 1000,
        usage: { documents: 10 },
      }),
    ).toEqual({ stop: true, reason: "预算已用尽（文档数 10/10）" });
  });

  it("查询、候选、Browser 或报告字符额度耗尽不直接终止整个研究循环", () => {
    const result = decideStop({
      coverage: weak,
      roundsUsed: 1,
      budget: budget(),
      elapsedMs: 1000,
      usage: {
        queries: 12,
        candidates: 60,
        documents: 1,
        browserFetches: 2,
        evidenceCharsToModel: 100_000,
      },
    });

    expect(result.stop).toBe(false);
  });

  it("还有余量且未达标时继续", () => {
    expect(decideStop({ coverage: weak, roundsUsed: 1, budget: budget(), elapsedMs: 1000 })).toEqual({
      stop: false,
      reason: "仍有子问题未达标，可继续下一轮",
    });
  });

  it("没有任何子问题时不会误判为已达标", () => {
    expect(decideStop({ coverage: [], roundsUsed: 0, budget: budget(), elapsedMs: 0 }).stop).toBe(
      false,
    );
  });
});
