// 原子提交（spec §9.1）的行为测试：全部走 InMemoryResearchRepository，零 SQLite、零 Electron。
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryResearchRepository } from "./repository-memory";
import { fixtureChunk, fixtureDocument, fixtureRound, fixtureSessionInput } from "./repository-fixtures";
import {
  OperationAlreadyCommittedError,
  OperationCancelledError,
  hashOperationPayload,
  runOperation,
} from "./operation-runner";

const SESSION_ID = "sess-1";

async function makeRepository(): Promise<InMemoryResearchRepository> {
  const repository = new InMemoryResearchRepository();
  await repository.createSession(fixtureSessionInput({ sessionId: SESSION_ID }));
  return repository;
}

/// 写一轮完整证据（round + document + chunk）的 apply，用于观察原子性。
function applyEvidence(): (tx: Parameters<Parameters<typeof runOperation>[0]["apply"]>[0]) => void {
  return (tx) => {
    tx.insertRound(fixtureRound({ roundIndex: 0 }));
    tx.insertDocuments([fixtureDocument()]);
    tx.insertChunks([fixtureChunk()]);
    tx.consumeBudget({ documents: 1 });
  };
}

describe("runOperation", () => {
  let repository: InMemoryResearchRepository;

  beforeEach(async () => {
    repository = await makeRepository();
  });

  it("成功路径：先登记 pending，再提交，最后没有遗留未提交操作", async () => {
    const result = await runOperation({
      repository,
      sessionId: SESSION_ID,
      operationId: "op-1",
      kind: "fetch",
      execute: async () => ({ ok: true }),
      validate: () => {},
      apply: (tx) => applyEvidence()(tx),
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ ok: true });
    expect(await repository.listPendingOperations()).toEqual([]);
    const view = await repository.getSession(SESSION_ID, "evidence");
    expect(view?.rounds).toHaveLength(1);
    expect(view?.documents).toHaveLength(1);
    expect(view?.chunks).toHaveLength(1);
  });

  it("apply 抛错时 round 与 evidence 都没有写进去（整笔回滚），操作仍为 pending", async () => {
    const error = await runOperation({
      repository,
      sessionId: SESSION_ID,
      operationId: "op-1",
      kind: "fetch",
      execute: async () => ({ ok: true }),
      validate: () => {},
      apply: (tx) => {
        applyEvidence()(tx);
        throw new Error("提交中途失败");
      },
      signal: new AbortController().signal,
    }).catch((err: unknown) => err);

    expect((error as Error).message).toBe("提交中途失败");
    const view = await repository.getSession(SESSION_ID, "evidence");
    expect(view?.rounds).toEqual([]);
    expect(view?.documents).toEqual([]);
    expect(view?.chunks).toEqual([]);
    expect(view?.summary.documentCount).toBe(0);
    // 未提交的 operation 保留下来，交给启动恢复重试（spec §9.1 第 6 步）。
    expect((await repository.listPendingOperations()).map((op) => op.operationId)).toEqual(["op-1"]);
  });

  it("validate 抛错时不落库，也不消耗预算", async () => {
    let applied = false;
    await runOperation({
      repository,
      sessionId: SESSION_ID,
      operationId: "op-1",
      kind: "search",
      execute: async () => ({ requestId: "other" }),
      validate: () => {
        throw new Error("request id 不匹配");
      },
      apply: () => {
        applied = true;
      },
      signal: new AbortController().signal,
    }).catch(() => {});

    expect(applied).toBe(false);
    expect(await repository.getBudgetSpend(SESSION_ID)).toMatchObject({ documents: 0 });
    expect((await repository.listPendingOperations()).map((op) => op.operationId)).toEqual(["op-1"]);
  });

  it("已 committed 的 operation 不重跑 execute", async () => {
    await runOperation({
      repository,
      sessionId: SESSION_ID,
      operationId: "op-1",
      kind: "search",
      execute: async () => 1,
      validate: () => {},
      apply: () => {},
      signal: new AbortController().signal,
    });

    let executed = 0;
    const error = await runOperation({
      repository,
      sessionId: SESSION_ID,
      operationId: "op-1",
      kind: "search",
      execute: async () => {
        executed += 1;
        return 2;
      },
      validate: () => {},
      apply: () => {},
      signal: new AbortController().signal,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OperationAlreadyCommittedError);
    expect(executed).toBe(0);
  });

  it("未提交的 operation 可以被重试（崩溃恢复路径）", async () => {
    await repository.beginOperation({
      sessionId: SESSION_ID,
      operationId: "op-1",
      kind: "fetch",
      requestPayloadHash: "h",
    });

    await runOperation({
      repository,
      sessionId: SESSION_ID,
      operationId: "op-1",
      kind: "fetch",
      execute: async () => ({ ok: true }),
      validate: () => {},
      apply: (tx) => applyEvidence()(tx),
      signal: new AbortController().signal,
    });

    expect(await repository.listPendingOperations()).toEqual([]);
  });

  it("入口即取消：不登记 operation、不调用 execute", async () => {
    const controller = new AbortController();
    controller.abort();
    let executed = 0;

    const error = await runOperation({
      repository,
      sessionId: SESSION_ID,
      operationId: "op-1",
      kind: "fetch",
      execute: async () => {
        executed += 1;
        return 1;
      },
      validate: () => {},
      apply: () => {},
      signal: controller.signal,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OperationCancelledError);
    expect(executed).toBe(0);
    expect(await repository.listPendingOperations()).toEqual([]);
  });

  it("execute 期间被取消：不提交，operation 留作 pending", async () => {
    const controller = new AbortController();

    const error = await runOperation({
      repository,
      sessionId: SESSION_ID,
      operationId: "op-1",
      kind: "fetch",
      execute: async () => {
        controller.abort();
        return { ok: true };
      },
      validate: () => {},
      apply: (tx) => applyEvidence()(tx),
      signal: controller.signal,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OperationCancelledError);
    const view = await repository.getSession(SESSION_ID, "evidence");
    expect(view?.rounds).toEqual([]);
    expect((await repository.listPendingOperations()).map((op) => op.operationId)).toEqual(["op-1"]);
  });
});

describe("hashOperationPayload", () => {
  it("同一载荷得到同一哈希，字段顺序不影响结果", () => {
    expect(hashOperationPayload({ a: 1, b: [2, 3] })).toBe(hashOperationPayload({ b: [2, 3], a: 1 }));
    expect(hashOperationPayload({ a: 1 })).not.toBe(hashOperationPayload({ a: 2 }));
  });
});
