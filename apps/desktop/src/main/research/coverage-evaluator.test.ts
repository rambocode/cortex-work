// 覆盖度薄封装的测试：领域对象 → core 纯函数入参的投影是否正确。
import { describe, expect, it } from "vitest";
import { fixtureChunk, fixtureDocument, fixturePlan } from "./repository-fixtures";
import { evaluateSessionCoverage } from "./coverage-evaluator";

const PLAN = fixturePlan();

describe("evaluateSessionCoverage", () => {
  it("把文档域名与来源类型投影给 core，产出逐子问题的覆盖度", () => {
    const documents = [
      // 一手来源：fixturePlan 的 completion 要求 requirePrimarySource
      fixtureDocument({
        documentId: "d1",
        source: {
          sourceType: "primary",
          trustZone: "public_web",
          locator: "https://nodejs.org/api/sqlite.html",
          domain: "nodejs.org",
        },
      }),
      fixtureDocument({
        documentId: "d2",
        source: {
          sourceType: "news",
          trustZone: "public_web",
          locator: "https://other.com/x",
          domain: "other.com",
        },
      }),
    ];
    const chunks = [
      fixtureChunk({ chunkId: "c1", documentId: "d1", subquestionScores: { "sq-1": 0.9 } }),
      fixtureChunk({ chunkId: "c2", documentId: "d2", subquestionScores: { "sq-1": 0.8 } }),
    ];

    const coverage = evaluateSessionCoverage({
      subquestions: PLAN.subquestions,
      criteria: PLAN.completion,
      chunks,
      documents,
    });

    expect(coverage.map((item) => item.subquestionId)).toEqual(["sq-1", "sq-2"]);
    expect(coverage[0]).toMatchObject({
      status: "sufficient",
      sourceCount: 2,
      independentDomainCount: 2,
      primarySourceCount: 1,
    });
    // sq-2 一条证据都没有 → missing
    expect(coverage[1]!.status).toBe("missing");
  });

  it("重复文档只算一个独立来源（duplicateOf 收敛）", () => {
    const documents = [
      fixtureDocument({ documentId: "d1" }),
      fixtureDocument({ documentId: "d2", duplicateOf: "d1" }),
    ];
    const chunks = [
      fixtureChunk({ chunkId: "c1", documentId: "d1", subquestionScores: { "sq-1": 0.9 } }),
      fixtureChunk({ chunkId: "c2", documentId: "d2", subquestionScores: { "sq-1": 0.9 } }),
    ];

    const coverage = evaluateSessionCoverage({
      subquestions: PLAN.subquestions,
      criteria: PLAN.completion,
      chunks,
      documents,
    });
    expect(coverage[0]!.sourceCount).toBe(1);
  });

  it("域名缺失时从 locator 反推，保证多样性统计不塌成一个桶", () => {
    const documents = [
      fixtureDocument({
        documentId: "d1",
        source: { sourceType: "unknown", trustZone: "public_web", locator: "https://a.com/1" },
      }),
      fixtureDocument({
        documentId: "d2",
        source: { sourceType: "unknown", trustZone: "public_web", locator: "https://b.com/1" },
      }),
    ];
    const chunks = [
      fixtureChunk({ chunkId: "c1", documentId: "d1", subquestionScores: { "sq-1": 0.9 } }),
      fixtureChunk({ chunkId: "c2", documentId: "d2", subquestionScores: { "sq-1": 0.9 } }),
    ];

    const coverage = evaluateSessionCoverage({
      subquestions: PLAN.subquestions,
      criteria: PLAN.completion,
      chunks,
      documents,
    });
    expect(coverage[0]!.independentDomainCount).toBe(2);
  });
});
