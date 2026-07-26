// Worker 协议（snake_case）→ 仓储领域对象（camelCase）的映射测试。
//
// 这层归 P5（P3 的仓储只认 camelCase，P4 的 rpc-client 只认协议），所以映射的无损性
// 必须在这里被钉死：用协议 fixtures 的真实响应行做端到端断言。
import { describe, expect, it } from "vitest";
import { PROTOCOL_FIXTURES } from "@cortex-work/core/research/protocol-fixtures";
import { parseWorkerOutbound, parseWorkerResult } from "@cortex-work/core/research/protocol";
import type { SearchCandidate } from "@cortex-work/core/research/evidence";
import { mapFetchPrepareResult, type WorkerFetchPrepareResult } from "./worker-mapping";

/// 从 fixtures 取出真实的 fetch_prepare 响应结果段。
function fixtureResult(): WorkerFetchPrepareResult {
  const line = PROTOCOL_FIXTURES.find((f) => f.name === "fetch_prepare:response")!.line;
  const message = parseWorkerOutbound(JSON.parse(line));
  if (message.type !== "response") throw new Error("fixture 不是响应");
  return parseWorkerResult("fetch_prepare", message.result);
}

const CANDIDATE: SearchCandidate = {
  candidateId: "c_1",
  queryId: "q_1",
  title: "Example Domain",
  url: "https://example.com/a",
  domain: "example.com",
  engines: ["duckduckgo"],
  sourceType: "documentation",
  serverScore: 0.82,
  trustZone: "public_web",
};

function context(overrides: Partial<Parameters<typeof mapFetchPrepareResult>[1]> = {}) {
  let seq = 0;
  return {
    newId: () => `id_${(seq += 1)}`,
    candidates: new Map([[CANDIDATE.candidateId, CANDIDATE]]),
    subquestionByQueryId: new Map([["q_1", "sq_1"]]),
    ...overrides,
  };
}

describe("mapFetchPrepareResult", () => {
  it("把协议 fixture 的响应无损映射成领域对象", () => {
    const mapped = mapFetchPrepareResult(fixtureResult(), context());

    expect(mapped.documents).toHaveLength(1);
    const document = mapped.documents[0]!;
    expect(document).toMatchObject({
      documentId: "id_1",
      candidateId: "c_1",
      title: "Example Domain",
      canonicalUrl: "https://example.com/a",
      contentHash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      simhash: "c3f1a2b4d5e60718",
      mediaType: "text/html",
      fetchMethod: "http",
      fetchedAt: "2026-07-25T09:00:00Z",
      publishedAt: "2026-06-01T00:00:00Z",
      textLength: 49,
      contentRef: "blob:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    });
    // 来源描述由候选补齐（Worker 不知道 sourceType）。
    expect(document.source).toEqual({
      sourceType: "documentation",
      trustZone: "public_web",
      locator: "https://example.com/a",
      title: "Example Domain",
      domain: "example.com",
      publishedAt: "2026-06-01T00:00:00Z",
    });
    // 正文交给调用方落 blob（KTD1：Worker 不写数据库、不写用户产物）。
    expect(mapped.texts.get(document.documentId)).toBe(
      "This domain is for use in documentation examples.",
    );

    expect(mapped.chunks).toHaveLength(1);
    expect(mapped.chunks[0]).toMatchObject({
      chunkId: "id_2",
      documentId: "id_1",
      startOffset: 0,
      endOffset: 49,
      headingPath: ["Example Domain"],
      text: "This domain is for use in documentation examples.",
      textHash: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
      objectiveScore: 0.41 / 1.41,
      // 该 chunk 所属文档由 q_1 触发，故相关性归到 q_1 的子问题上。
      subquestionScores: { sq_1: 0.41 / 1.41 },
      trustZone: "public_web",
    });

    expect(mapped.failures).toEqual([
      {
        candidateId: "c_2",
        url: "http://10.0.0.5/internal",
        code: "blocked_by_policy",
        message: "resolved address is in a forbidden range",
      },
    ]);
    expect(mapped.stats).toEqual({
      httpFetches: 1,
      browserFetches: 0,
      totalBytes: 1256,
      durationMs: 842,
      skippedKnown: 1,
    });
    expect(mapped.notes).toEqual([]);
  });

  it("正的原始词法分数单调归一化到 0..1，不会全部饱和为 1", () => {
    const result = fixtureResult();
    result.chunks[0]!.lexical_score = 2.7;
    const medium = mapFetchPrepareResult(result, context()).chunks[0]!.objectiveScore;
    result.chunks[0]!.lexical_score = 10;
    const high = mapFetchPrepareResult(result, context()).chunks[0]!.objectiveScore;
    expect(medium).toBeCloseTo(2.7 / 3.7);
    expect(high).toBeCloseTo(10 / 11);
    expect(high).toBeGreaterThan(medium);
    expect(high).toBeLessThan(1);

    result.chunks[0]!.lexical_score = -3;
    expect(mapFetchPrepareResult(result, context()).chunks[0]!.objectiveScore).toBe(0);
  });

  it("优先采用 Worker 返回的目标与逐子问题分数", () => {
    const result = fixtureResult();
    Object.assign(result.chunks[0]!, {
      objective_score: 2,
      subquestion_scores: { sq_1: 0.5, sq_2: 3 },
    });
    const mapped = mapFetchPrepareResult(result, context()).chunks[0]!;

    expect(mapped.objectiveScore).toBeCloseTo(2 / 3);
    expect(mapped.subquestionScores).toEqual({
      sq_1: 0.5 / 1.5,
      sq_2: 3 / 4,
    });
  });

  it("duplicate_of 指向本批次内的 content_hash 时换算成代表文档的 documentId", () => {
    const result = fixtureResult();
    const first = result.documents[0]!;
    result.documents.push({
      ...first,
      candidate_id: "c_1",
      url: "https://mirror.example.com/a",
      content_hash: "a".repeat(64),
      duplicate_of: first.content_hash,
    });

    const mapped = mapFetchPrepareResult(result, context());
    expect(mapped.documents[1]!.duplicateOf).toBe(mapped.documents[0]!.documentId);
  });

  it("duplicate_of 指向未知内容时丢弃该字段并记 note（不留悬空引用）", () => {
    const result = fixtureResult();
    result.documents[0]!.duplicate_of = "b".repeat(64);

    const mapped = mapFetchPrepareResult(result, context());
    expect(mapped.documents[0]!.duplicateOf).toBeUndefined();
    expect(mapped.notes.join()).toContain("duplicate_of");
  });

  it("chunk 找不到归属文档时被丢弃并记 note（外键完整性）", () => {
    const result = fixtureResult();
    result.chunks[0]!.content_hash = "c".repeat(64);

    const mapped = mapFetchPrepareResult(result, context());
    expect(mapped.chunks).toEqual([]);
    expect(mapped.notes.join()).toContain("chunk");
  });

  it("候选缺失时来源类型降级为 unknown、子问题相关性留空并记 note", () => {
    const mapped = mapFetchPrepareResult(
      fixtureResult(),
      context({ candidates: new Map(), subquestionByQueryId: new Map() }),
    );

    expect(mapped.documents[0]!.source.sourceType).toBe("unknown");
    expect(mapped.chunks[0]!.subquestionScores).toEqual({});
    expect(mapped.notes.join()).toContain("子问题");
  });
});
