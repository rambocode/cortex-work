// SqliteResearchRepository 的真 SQLite 验收（`pnpm --filter @cortex-work/desktop test:sqlite`）。
//
// 断言的是 InMemoryResearchRepository 无法证明的部分：真事务回滚、真外键级联、
// 以及 spec §19.3.2「summary 不读正文」在真 SQL 上同样成立。
import { beforeEach, describe, expect, it } from "vitest";
import { createNodeSqliteDriver, type SqliteDriver } from "./sqlite-driver";
import { applyMigrations } from "./migrations";
import { SqliteResearchRepository } from "./research-repository";
import {
  FIXTURE_USER_SCOPE,
  fixtureCandidate,
  fixtureChunk,
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

let driver: SqliteDriver;
let repo: SqliteResearchRepository;

beforeEach(async () => {
  driver = await createNodeSqliteDriver(":memory:");
  applyMigrations(driver);
  repo = new SqliteResearchRepository(driver);
});

async function seedSession() {
  await repo.createSession(fixtureSessionInput());
}

async function commitFullRound(operationId = "op-1") {
  await repo.beginOperation({
    sessionId: "sess-1",
    operationId,
    kind: "fetch",
    requestPayloadHash: fixtureHash("op1"),
  });
  await repo.commitOperation(operationId, (tx) => {
    tx.insertRound(fixtureRound());
    tx.insertQueries([fixtureQuery({ queryId: "q-3" })], 0);
    tx.insertCandidates([fixtureCandidate()], 0);
    tx.insertDocuments([fixtureDocument()]);
    tx.insertChunks([fixtureChunk()]);
    tx.insertDuplicateClusters([fixtureCluster()]);
    tx.upsertCoverage(0, [fixtureCoverage()]);
    tx.insertReport(fixtureReport());
    tx.insertCitations(fixtureReport().citations);
    tx.consumeBudget({ documents: 1, queries: 1 });
  });
}

describe("SqliteResearchRepository（真 SQLite）", () => {
  it("session CRUD 往返", async () => {
    await seedSession();
    const view = await repo.getSession("sess-1", "summary");
    expect(view?.summary).toMatchObject({
      sessionId: "sess-1",
      consumer: "deep_research",
      objective: "调研 Electron 39 的 node:sqlite 稳定性",
      mode: "standard",
      status: "created",
      roundCount: 0,
    });

    await repo.updateSessionStatus("sess-1", "failed", "Search Server 503");
    expect((await repo.getSession("sess-1", "summary"))?.summary.errorMessage).toBe("Search Server 503");
    expect((await repo.listSessions({ status: "failed" })).map((s) => s.sessionId)).toEqual(["sess-1"]);
    expect(await repo.getSession("ghost", "summary")).toBeNull();
  });

  it("getSession(id, \"summary\") 不返回任何正文，且 SQL 层不触碰 chunk/report 正文列", async () => {
    await seedSession();
    await repo.savePlan("sess-1", fixturePlan());
    await commitFullRound();

    const executed: string[] = [];
    const traced = tracingDriver(driver, executed);
    const tracedRepo = new SqliteResearchRepository(traced);
    const view = await tracedRepo.getSession("sess-1", "summary");

    expect(view?.plan).toBeUndefined();
    expect(view?.chunks).toBeUndefined();
    expect(view?.documents).toBeUndefined();
    expect(view?.report).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("DatabaseSync");
    // 真源断言：summary 路径连 chunk / report / document 表都没查过。
    const touched = executed.join(" | ");
    expect(touched).not.toMatch(/document_chunks|research_reports|research_documents/);
  });

  it("full 与 evidence 层级逐级放开数据", async () => {
    await seedSession();
    await repo.savePlan("sess-1", fixturePlan());
    await commitFullRound();

    const full = await repo.getSession("sess-1", "full");
    expect(full?.plan?.subquestions.map((s) => s.id)).toEqual(["sq-1", "sq-2"]);
    expect(full?.plan?.initialQueries.map((q) => q.queryId)).toEqual(["q-1", "q-2"]);
    expect(full?.plan?.completion.minSourcesPerSubquestion).toBe(2);
    expect(full?.rounds?.[0]).toMatchObject({ roundIndex: 0, decision: "search_more", queryIds: ["q-1", "q-2"] });
    expect(full?.coverage?.[0]?.bestChunkIds).toEqual(["chunk-1"]);
    expect(full?.report?.citations.map((c) => c.chunkId)).toEqual(["chunk-1"]);
    expect(full?.documents).toBeUndefined();

    const evidence = await repo.getSession("sess-1", "evidence");
    expect(evidence?.documents?.[0]).toMatchObject({
      documentId: "doc-1",
      contentHash: fixtureHash("doc1"),
      fetchMethod: "http",
      textLength: 4096,
    });
    expect(evidence?.documents?.[0]?.policy.allowCloudModel).toBe(true);
    expect(evidence?.chunks?.[0]?.headingPath).toEqual(["node:sqlite", "DatabaseSync"]);
    expect(evidence?.chunks?.[0]?.subquestionScores).toEqual({ "sq-1": 0.9, "sq-2": 0.3 });
  });

  it("operation 从 pending 走到 committed；计数与预算随之更新", async () => {
    await seedSession();
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-1",
      kind: "search",
      requestPayloadHash: fixtureHash("op1"),
    });
    expect((await repo.listPendingOperations("sess-1")).map((o) => o.operationId)).toEqual(["op-1"]);

    await repo.commitOperation("op-1", (tx) => {
      tx.insertRound(fixtureRound());
      tx.consumeBudget({ queries: 2, candidates: 5 });
    });

    expect(await repo.listPendingOperations("sess-1")).toEqual([]);
    expect((await repo.getSession("sess-1", "summary"))?.summary.roundCount).toBe(1);
    expect(await repo.getBudgetSpend("sess-1")).toMatchObject({ queries: 2, candidates: 5 });
  });

  it("提交事务中途抛错：round / 证据 / 计数 / operation 状态全部保持原样", async () => {
    await seedSession();
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
        tx.consumeBudget({ documents: 1 });
        throw new Error("响应 schema 校验失败");
      }),
    ).rejects.toThrow("响应 schema 校验失败");

    expect(countOf(driver, "research_rounds")).toBe(0);
    expect(countOf(driver, "research_documents")).toBe(0);
    expect(countOf(driver, "document_chunks")).toBe(0);
    expect((await repo.getSession("sess-1", "summary"))?.summary).toMatchObject({
      roundCount: 0,
      documentCount: 0,
      chunkCount: 0,
    });
    expect(await repo.getBudgetSpend("sess-1")).toMatchObject({ documents: 0 });
    expect((await repo.listPendingOperations()).map((o) => o.operationId)).toEqual(["op-1"]);
  });

  it("findDocumentByContentHash 命中同用户、跨用户与未知哈希不命中", async () => {
    await seedSession();
    await commitFullRound();

    const hit = await repo.findDocumentByContentHash(fixtureHash("doc1"), FIXTURE_USER_SCOPE);
    expect(hit?.documentId).toBe("doc-1");
    expect(hit?.contentRef).toBe(`blob:${fixtureHash("doc1")}`);
    expect(await repo.findDocumentByContentHash(fixtureHash("doc1"), "other-user")).toBeNull();
    expect(await repo.findDocumentByContentHash(fixtureHash("nope"), FIXTURE_USER_SCOPE)).toBeNull();
  });

  it("deleteSession 级联清空所有子表", async () => {
    await seedSession();
    await repo.savePlan("sess-1", fixturePlan());
    await commitFullRound();
    await repo.beginOperation({
      sessionId: "sess-1",
      operationId: "op-2",
      kind: "search",
      requestPayloadHash: fixtureHash("op2"),
    });

    await repo.deleteSession("sess-1");

    expect(await repo.getSession("sess-1", "summary")).toBeNull();
    for (const table of [
      "research_plans",
      "research_subquestions",
      "research_rounds",
      "research_operations",
      "research_queries",
      "search_candidates",
      "research_documents",
      "document_chunks",
      "duplicate_clusters",
      "coverage_reports",
      "research_reports",
      "citation_links",
    ]) {
      expect(`${table}:${countOf(driver, table)}`).toBe(`${table}:0`);
    }
    expect(await repo.listReferencedContentHashes()).toEqual(new Set());
  });

  it("savePlan 可重复写入（重规划覆盖旧计划，不残留旧子问题）", async () => {
    await seedSession();
    await repo.savePlan("sess-1", fixturePlan());
    await repo.savePlan(
      "sess-1",
      fixturePlan({
        subquestions: [{ id: "sq-9", text: "重规划后的唯一子问题" }],
        initialQueries: [fixtureQuery({ queryId: "q-9", subquestionId: "sq-9" })],
      }),
    );
    const full = await repo.getSession("sess-1", "full");
    expect(full?.plan?.subquestions.map((s) => s.id)).toEqual(["sq-9"]);
    expect(full?.plan?.initialQueries.map((q) => q.queryId)).toEqual(["q-9"]);
  });

  it("listReferencedContentHashes 汇总所有文档的正文哈希", async () => {
    await seedSession();
    await commitFullRound();
    expect(await repo.listReferencedContentHashes()).toEqual(new Set([fixtureHash("doc1")]));
  });
});

/// 统计某表行数（测试内联工具，避免每处重复写 SQL）。
function countOf(d: SqliteDriver, table: string): number {
  return d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{ n: number }>()?.n ?? -1;
}

/// 记录所有 prepare 过的 SQL 的透明包装 driver。
/// 用它来证明「summary 路径根本没查正文表」——只断言返回值证明不了这一点，
/// 因为实现完全可能查了正文再丢掉（那就白读了 1000 篇文档的正文，违反 spec §19.4）。
function tracingDriver(inner: SqliteDriver, sink: string[]): SqliteDriver {
  return {
    exec: (sql) => inner.exec(sql),
    prepare: (sql) => {
      sink.push(sql);
      return inner.prepare(sql);
    },
    transaction: (fn) => inner.transaction(fn),
    close: () => {
      /* 包装层不负责关闭底层连接 */
    },
  };
}
