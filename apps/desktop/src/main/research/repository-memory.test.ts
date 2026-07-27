// InMemoryResearchRepository 的行为契约测试（默认轮，系统 Node）。
//
// 这个替身是 P5/P7 上层编排的测试接缝，因此它必须与 SQLite 版语义一致——尤其是
// spec §9.1 的原子提交边界：commitOperation 的 apply 抛错时不得留下任何部分写入。
// 同一批断言在 research-repository.sqlite.test.ts 里对真 driver 再跑一遍。
import { describe, expect, it } from "vitest";
import { InMemoryResearchRepository } from "./repository-memory";
import {
  FIXTURE_USER_SCOPE,
  fixtureCandidate,
  fixtureChunk,
  fixtureCitation,
  fixtureCluster,
  fixtureCoverage,
  fixtureDocument,
  fixtureHash,
  fixturePlan,
  fixtureQuery,
  fixtureReport,
  fixtureRound,
  fixtureSessionInput,
} from "./repository-fixtures";

async function seeded() {
  const repo = new InMemoryResearchRepository();
  await repo.createSession(fixtureSessionInput());
  return repo;
}

describe("InMemoryResearchRepository", () => {
  it("创建后可按 summary 读回元数据，计数从 0 起", async () => {
    const repo = await seeded();
    const view = await repo.getSession("sess-1", "summary");
    expect(view?.summary).toMatchObject({
      sessionId: "sess-1",
      consumer: "deep_research",
      mode: "standard",
      status: "created",
      roundCount: 0,
      documentCount: 0,
      chunkCount: 0,
    });
  });

  // 与 SQLite 版同形断言：projectId 只进 view 不进 summary（隐私红线，
  // 与 output / sourceScopes 同一条先例）。
  it("projectId 各 detail 级别都从 view 读回，且不进 summary", async () => {
    const repo = new InMemoryResearchRepository();
    await repo.createSession(fixtureSessionInput({ projectId: "proj-1" }));
    for (const detail of ["summary", "full", "evidence"] as const) {
      const view = await repo.getSession("sess-1", detail);
      expect(view?.projectId).toBe("proj-1");
      expect(view?.summary).not.toHaveProperty("projectId");
    }
  });

  it("不带 projectId 建的会话读回时 projectId 缺省（而非空串）", async () => {
    const repo = await seeded();
    expect((await repo.getSession("sess-1", "summary"))?.projectId).toBeUndefined();
  });

  it("未知 session 返回 null", async () => {
    const repo = await seeded();
    expect(await repo.getSession("nope", "summary")).toBeNull();
  });

  it("summary 层级绝不携带任何正文（spec §19.3.2）", async () => {
    const repo = await seeded();
    await repo.savePlan("sess-1", fixturePlan());
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-1",
      kind: "fetch",
      requestPayloadHash: fixtureHash("op1"),
    });
    await repo.commitOperation("op-1", (tx) => {
      tx.insertDocuments([fixtureDocument()]);
      tx.insertChunks([fixtureChunk()]);
      tx.insertReport(fixtureReport());
    });

    const view = await repo.getSession("sess-1", "summary");
    expect(view).not.toBeNull();
    expect(view?.plan).toBeUndefined();
    expect(view?.rounds).toBeUndefined();
    expect(view?.documents).toBeUndefined();
    expect(view?.chunks).toBeUndefined();
    expect(view?.report).toBeUndefined();
    expect(view?.coverage).toBeUndefined();
    // 兜底：整个 summary 序列化后不得出现 chunk 正文或报告正文。
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("DatabaseSync 提供同步的 SQLite 连接");
    expect(serialized).not.toContain("node:sqlite 可用但仍是实验特性");
  });

  it("full 层级返回计划/轮次/覆盖/报告，但不含证据正文；evidence 才补文档与 chunk", async () => {
    const repo = await seeded();
    await repo.savePlan("sess-1", fixturePlan());
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-1",
      kind: "fetch",
      requestPayloadHash: fixtureHash("op1"),
    });
    await repo.commitOperation("op-1", (tx) => {
      tx.insertRound(fixtureRound());
      tx.insertQueries([fixtureQuery({ queryId: "q-3" })], 0);
      tx.insertCandidates([fixtureCandidate()], 0);
      tx.insertDocuments([fixtureDocument()]);
      tx.insertChunks([fixtureChunk()]);
      tx.insertDuplicateClusters([fixtureCluster()]);
      tx.upsertCoverage(0, [fixtureCoverage()]);
      tx.insertReport(fixtureReport());
      tx.insertCitations(fixtureReport().citations);
    });

    const full = await repo.getSession("sess-1", "full");
    expect(full?.plan?.subquestions.map((s) => s.id)).toEqual(["sq-1", "sq-2"]);
    expect(full?.plan?.initialQueries.map((q) => q.queryId)).toEqual(["q-1", "q-2"]);
    expect(full?.rounds?.[0]?.queryIds).toEqual(["q-1", "q-2"]);
    expect(full?.coverage?.[0]?.subquestionId).toBe("sq-1");
    expect(full?.report?.markdown).toContain("实验特性");
    expect(full?.report?.citations.map((c) => c.chunkId)).toEqual(["chunk-1"]);
    expect(full?.documents).toBeUndefined();
    expect(full?.chunks).toBeUndefined();

    const evidence = await repo.getSession("sess-1", "evidence");
    expect(evidence?.documents?.map((d) => d.documentId)).toEqual(["doc-1"]);
    expect(evidence?.chunks?.[0]?.text).toContain("DatabaseSync");
    expect(evidence?.chunks?.[0]?.subquestionScores).toEqual({ "sq-1": 0.9, "sq-2": 0.3 });
  });

  it("提交后计数累加，预算消耗可读回", async () => {
    const repo = await seeded();
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-1",
      kind: "fetch",
      requestPayloadHash: fixtureHash("op1"),
    });
    await repo.commitOperation("op-1", (tx) => {
      tx.insertRound(fixtureRound());
      tx.insertDocuments([fixtureDocument()]);
      tx.insertChunks([fixtureChunk(), fixtureChunk({ chunkId: "chunk-2" })]);
      tx.consumeBudget({ documents: 1, queries: 2, evidenceCharsToModel: 500 });
    });

    const view = await repo.getSession("sess-1", "summary");
    expect(view?.summary).toMatchObject({ roundCount: 1, documentCount: 1, chunkCount: 2 });
    expect(await repo.getBudgetSpend("sess-1")).toMatchObject({
      documents: 1,
      queries: 2,
      evidenceCharsToModel: 500,
      rounds: 0,
    });
  });

  it("apply 抛错时整笔提交回滚，operation 仍处于 pending", async () => {
    const repo = await seeded();
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-1",
      kind: "fetch",
      requestPayloadHash: fixtureHash("op1"),
    });

    await expect(
      repo.commitOperation("op-1", (tx) => {
        tx.insertRound(fixtureRound());
        tx.insertDocuments([fixtureDocument()]);
        tx.insertChunks([fixtureChunk()]);
        throw new Error("worker 响应校验失败");
      }),
    ).rejects.toThrow("worker 响应校验失败");

    const view = await repo.getSession("sess-1", "evidence");
    expect(view?.summary).toMatchObject({ roundCount: 0, documentCount: 0, chunkCount: 0 });
    expect(view?.rounds ?? []).toEqual([]);
    expect(view?.documents ?? []).toEqual([]);
    expect(view?.chunks ?? []).toEqual([]);
    expect((await repo.listPendingOperations("sess-1")).map((o) => o.operationId)).toEqual(["op-1"]);
  });

  it("commit 后 operation 不再 pending；重复 commit 抛错", async () => {
    const repo = await seeded();
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-1",
      kind: "search",
      requestPayloadHash: fixtureHash("op1"),
    });
    expect(await repo.listPendingOperations()).toHaveLength(1);

    await repo.commitOperation("op-1", () => {});
    expect(await repo.listPendingOperations()).toEqual([]);
    await expect(repo.commitOperation("op-1", () => {})).rejects.toThrow();
  });

  it("markOperationRetryable 保留 pending 语义并置位 retryable", async () => {
    const repo = await seeded();
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-1",
      kind: "search",
      requestPayloadHash: fixtureHash("op1"),
    });
    await repo.markOperationRetryable("op-1");
    expect(await repo.listPendingOperations()).toMatchObject([{ operationId: "op-1", retryable: true }]);
  });

  it("listSessions 支持 consumer / status / statuses 过滤，按 updatedAt 倒序", async () => {
    const repo = await seeded();
    await repo.createSession(
      fixtureSessionInput({ sessionId: "sess-2", consumer: "chat", createdAt: "2026-07-25T00:10:00.000Z" }),
    );
    await repo.updateSessionStatus("sess-2", "searching", undefined, "2026-07-25T00:11:00.000Z");

    expect((await repo.listSessions()).map((s) => s.sessionId)).toEqual(["sess-2", "sess-1"]);
    expect((await repo.listSessions({ consumer: "chat" })).map((s) => s.sessionId)).toEqual(["sess-2"]);
    expect((await repo.listSessions({ status: "created" })).map((s) => s.sessionId)).toEqual(["sess-1"]);
    expect(
      (await repo.listSessions({ statuses: ["searching", "created"] })).map((s) => s.sessionId),
    ).toEqual(["sess-2", "sess-1"]);
    expect(await repo.listSessions({ limit: 1 })).toHaveLength(1);
  });

  it("updateSessionStatus 写入可展示错误，转出 failed 时清空", async () => {
    const repo = await seeded();
    await repo.updateSessionStatus("sess-1", "failed", "Search Server 返回 503");
    expect((await repo.getSession("sess-1", "summary"))?.summary.errorMessage).toBe("Search Server 返回 503");
    await repo.updateSessionStatus("sess-1", "interrupted");
    expect((await repo.getSession("sess-1", "summary"))?.summary.errorMessage).toBeUndefined();
  });

  it("findDocumentByContentHash 命中同用户，跨用户与未知哈希均不命中", async () => {
    const repo = await seeded();
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-1",
      kind: "fetch",
      requestPayloadHash: fixtureHash("op1"),
    });
    await repo.commitOperation("op-1", (tx) => tx.insertDocuments([fixtureDocument()]));

    const hit = await repo.findDocumentByContentHash(fixtureHash("doc1"), FIXTURE_USER_SCOPE);
    expect(hit?.documentId).toBe("doc-1");
    expect(hit?.policy.allowCrossSessionReuse).toBe(true);
    expect(await repo.findDocumentByContentHash(fixtureHash("doc1"), "other-user")).toBeNull();
    expect(await repo.findDocumentByContentHash(fixtureHash("nope"), FIXTURE_USER_SCOPE)).toBeNull();
  });

  it("deleteSession 级联清空全部子数据与 pending operation", async () => {
    const repo = await seeded();
    await repo.savePlan("sess-1", fixturePlan());
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-1",
      kind: "fetch",
      requestPayloadHash: fixtureHash("op1"),
    });
    await repo.commitOperation("op-1", (tx) => {
      tx.insertRound(fixtureRound());
      tx.insertDocuments([fixtureDocument()]);
      tx.insertChunks([fixtureChunk()]);
    });
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-2",
      kind: "search",
      requestPayloadHash: fixtureHash("op2"),
    });

    await repo.deleteSession("sess-1");
    expect(await repo.getSession("sess-1", "evidence")).toBeNull();
    expect(await repo.listPendingOperations()).toEqual([]);
    expect(await repo.listReferencedContentHashes()).toEqual(new Set());
  });

  it("listReferencedContentHashes 汇总仍被引用的正文哈希（blob GC 的输入）", async () => {
    const repo = await seeded();
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-1",
      kind: "fetch",
      requestPayloadHash: fixtureHash("op1"),
    });
    await repo.commitOperation("op-1", (tx) => {
      tx.insertDocuments([
        fixtureDocument(),
        fixtureDocument({ documentId: "doc-2", contentHash: fixtureHash("doc2") }),
      ]);
    });
    expect(await repo.listReferencedContentHashes()).toEqual(
      new Set([fixtureHash("doc1"), fixtureHash("doc2")]),
    );
  });

  it("对未知 session 开操作会抛错（外键语义）", async () => {
    const repo = new InMemoryResearchRepository();
    await expect(
      repo.beginOperation({
        sessionId: "ghost",
        operationId: "op-1",
        kind: "search",
        requestPayloadHash: fixtureHash("op1"),
      }),
    ).rejects.toThrow();
  });

  it("插入的引用与 chunk 不会被后续读取共享同一对象（防止调用方就地改写内部状态）", async () => {
    const repo = await seeded();
    const chunk = fixtureChunk();
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-1",
      kind: "fetch",
      requestPayloadHash: fixtureHash("op1"),
    });
    await repo.commitOperation("op-1", (tx) => {
      tx.insertDocuments([fixtureDocument()]);
      tx.insertChunks([chunk]);
    });
    chunk.text = "被外部改写";
    const view = await repo.getSession("sess-1", "evidence");
    expect(view?.chunks?.[0]?.text).toContain("DatabaseSync");
    expect(await repo.getSession("sess-1", "evidence")).not.toBe(view);
  });

  it("insertCitations 只保留 citation_links，报告正文与引用分开落库", async () => {
    const repo = await seeded();
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-1",
      kind: "report",
      requestPayloadHash: fixtureHash("op1"),
    });
    await repo.commitOperation("op-1", (tx) => {
      tx.insertReport(fixtureReport({ citations: [] }));
      tx.insertCitations([fixtureCitation(), fixtureCitation({ chunkId: "chunk-2" })]);
    });
    const full = await repo.getSession("sess-1", "full");
    expect(full?.report?.citations.map((c) => c.chunkId)).toEqual(["chunk-1", "chunk-2"]);
  });
});
