// ResearchService（Facade 实现 + Session 注册表 + 事件广播）的行为测试。
//
// 依赖全部是手写替身：内存仓储、假 Worker Provider、假 Search Client、假 sender。
// 零 Electron、零网络。
import { describe, expect, it } from "vitest";
import { DEFAULT_RESEARCH_ENGINE_SETTINGS } from "@cortex-work/core/research/settings";
import type { ResearchEngineSettings } from "@cortex-work/core/research/settings";
import type { ResearchRequest } from "@cortex-work/core/research/types";
import type { SearchBatchResponse } from "@cortex-work/core/research/search-api";
import { InMemoryResearchRepository } from "./repository-memory";
import { fixtureChunk, fixtureDocument, fixtureRound, fixtureSessionInput } from "./repository-fixtures";
import {
  ResearchDisabledError,
  ResearchService,
  type ResearchEventSender,
  type ResearchServiceDeps,
} from "./research-service";

const REQUEST: ResearchRequest = {
  consumer: "deep_research",
  objective: "调研 node:sqlite 是否可用于生产",
  mode: "quick",
  sourceScopes: [{ kind: "public_web" }],
  output: { format: "report", requireCitations: true },
};

function enabledSettings(overrides: Partial<ResearchEngineSettings> = {}): ResearchEngineSettings {
  return {
    ...DEFAULT_RESEARCH_ENGINE_SETTINGS,
    enabled: true,
    deepResearchEnabled: true,
    ...overrides,
  };
}

/// 空搜索响应：让编排在"无候选"分支上快速收敛，测试只关心 service 的行为。
function emptySearch(requestId: string): SearchBatchResponse {
  return {
    request_id: requestId,
    results: [],
    stats: {
      provider_count: 0,
      raw_result_count: 0,
      returned_result_count: 0,
      cache_hit: false,
      duration_ms: 1,
    },
  };
}

interface Harness {
  repository: InMemoryResearchRepository;
  service: ResearchService;
  ensureCalls: number;
  stopCalls: number;
}

function makeHarness(
  settings: ResearchEngineSettings = enabledSettings(),
  llmHooks?: ResearchServiceDeps["llmHooks"],
): Harness {
  const repository = new InMemoryResearchRepository();
  const harness: Harness = {
    repository,
    ensureCalls: 0,
    stopCalls: 0,
    service: undefined as unknown as ResearchService,
  };
  let seq = 0;

  harness.service = new ResearchService({
    repository,
    blobStore: { putBlob: async (hash) => `blob:${hash}` },
    settings: () => settings,
    createSearchClient: () => ({ searchBatch: async (request) => emptySearch(request.request_id) }),
    workerProvider: {
      ensure: async () => {
        harness.ensureCalls += 1;
        return { request: (async () => ({ ok: true })) as never };
      },
      stop: async () => {
        harness.stopCalls += 1;
      },
    },
    userScope: () => "user-fixture",
    newId: () => `id_${(seq += 1)}`,
    now: () => new Date("2026-07-25T10:00:00.000Z"),
    ...(llmHooks ? { llmHooks } : {}),
  });
  return harness;
}

/// 可观测的假 renderer sender（形状与 WebContents 的相关子集一致）。
class FakeSender implements ResearchEventSender {
  readonly received: unknown[] = [];
  private destroyed = false;
  private destroyListeners: Array<() => void> = [];

  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(_channel: string, payload: unknown): void {
    this.received.push(payload);
  }
  once(_event: "destroyed", listener: () => void): void {
    this.destroyListeners.push(listener);
  }
  destroy(): void {
    this.destroyed = true;
    for (const listener of this.destroyListeners) listener();
  }
}

describe("ResearchService.create", () => {
  it("落一份带夹取预算的种子计划，并返回 summary", async () => {
    const { service, repository } = makeHarness();
    const summary = await service.create({ ...REQUEST, budget: { maxDocuments: 9999 } });

    expect(summary.status).toBe("created");
    expect(summary.consumer).toBe("deep_research");
    const view = (await repository.getSession(summary.sessionId, "full"))!;
    // 用户覆盖被夹到全局硬上限（HARD_BUDGET_CEILING.maxDocuments = 100），不是 quick 默认值
    expect(view.plan!.budget.maxDocuments).toBe(100);
    // 未覆盖的字段仍取 quick 档基线
    expect(view.plan!.budget.maxRounds).toBe(1);
    expect(view.plan!.initialQueries).toHaveLength(1);
  });

  it("总开关关闭时拒绝创建", async () => {
    const { service } = makeHarness(enabledSettings({ enabled: false }));
    await expect(service.create(REQUEST)).rejects.toBeInstanceOf(ResearchDisabledError);
  });

  it("对应 Consumer 的灰度开关关闭时拒绝创建", async () => {
    const { service } = makeHarness(enabledSettings({ deepResearchEnabled: false }));
    await expect(service.create(REQUEST)).rejects.toBeInstanceOf(ResearchDisabledError);
  });
});

describe("ResearchService.run", () => {
  it("researchEngine.enabled 为 false 时不起 Worker", async () => {
    const harness = makeHarness();
    const summary = await harness.service.create(REQUEST);

    // 创建之后再关掉总开关，模拟用户在设置页关闭
    const disabled = makeHarness(enabledSettings({ enabled: false }));
    await disabled.repository.createSession(fixtureSessionInput({ sessionId: summary.sessionId }));

    await expect(disabled.service.run(summary.sessionId)).rejects.toBeInstanceOf(ResearchDisabledError);
    expect(disabled.ensureCalls).toBe(0);
  });

  it("并发 run 单飞：同一 Session 只拉起一次 Worker", async () => {
    const harness = makeHarness();
    const summary = await harness.service.create(REQUEST);

    await Promise.all([harness.service.run(summary.sessionId), harness.service.run(summary.sessionId)]);

    expect(harness.ensureCalls).toBe(1);
    expect((await harness.repository.getSession(summary.sessionId, "summary"))!.summary.status).toBe(
      "completed",
    );
  });
});

describe("ResearchService.get / list", () => {
  it("get(id, \"summary\") 不含任何正文（spec §19.3.2）", async () => {
    const { service, repository } = makeHarness();
    const summary = await service.create(REQUEST);

    // 塞一份带正文的证据与报告
    await repository.beginOperation({
      sessionId: summary.sessionId,
      operationId: "op-1",
      kind: "fetch",
      requestPayloadHash: "h",
    });
    await repository.commitOperation("op-1", (tx) => {
      tx.insertRound(fixtureRound({ roundIndex: 0 }));
      tx.insertDocuments([fixtureDocument({ documentId: "d1" })]);
      tx.insertChunks([fixtureChunk({ chunkId: "c1", documentId: "d1", text: "机密正文片段" })]);
    });

    const view = await service.get(summary.sessionId, "summary");

    expect(view.chunks).toBeUndefined();
    expect(view.documents).toBeUndefined();
    expect(view.report).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("机密正文片段");
    // 计数仍然可见（UI 需要它做进度展示）
    expect(view.summary.chunkCount).toBe(1);
  });

  it("evidence 层级才返回正文", async () => {
    const { service, repository } = makeHarness();
    const summary = await service.create(REQUEST);
    await repository.beginOperation({
      sessionId: summary.sessionId,
      operationId: "op-1",
      kind: "fetch",
      requestPayloadHash: "h",
    });
    await repository.commitOperation("op-1", (tx) => {
      tx.insertDocuments([fixtureDocument({ documentId: "d1" })]);
      tx.insertChunks([fixtureChunk({ chunkId: "c1", documentId: "d1", text: "机密正文片段" })]);
    });

    const view = await service.get(summary.sessionId, "evidence");
    expect(JSON.stringify(view)).toContain("机密正文片段");
  });

  it("未知 Session 抛错", async () => {
    const { service } = makeHarness();
    await expect(service.get("nope", "summary")).rejects.toThrow(/nope/);
  });

  it("list 透传筛选条件", async () => {
    const { service } = makeHarness();
    await service.create(REQUEST);
    await service.create({ ...REQUEST, consumer: "chat" }).catch(() => undefined);

    const all = await service.list();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(await service.list({ consumer: "slides" })).toEqual([]);
  });
});

describe("ResearchService.cancel / delete", () => {
  it("取消一个未在运行的 Session：终态是 cancelled", async () => {
    const { service, repository } = makeHarness();
    const summary = await service.create(REQUEST);

    await service.cancel(summary.sessionId);

    expect((await repository.getSession(summary.sessionId, "summary"))!.summary.status).toBe("cancelled");
  });

  it("delete 移除 Session", async () => {
    const { service, repository } = makeHarness();
    const summary = await service.create(REQUEST);

    await service.delete(summary.sessionId);

    expect(await repository.getSession(summary.sessionId, "summary")).toBeNull();
  });
});

describe("ResearchService 事件广播", () => {
  it("推给所有活跃 sender；sender 销毁后自动回收且不再收到事件", async () => {
    const harness = makeHarness();
    const alive = new FakeSender();
    const dying = new FakeSender();
    harness.service.addEventSender(alive);
    harness.service.addEventSender(dying);
    // 重复注册必须幂等，否则同一个窗口会收到两份事件
    harness.service.addEventSender(alive);

    const summary = await harness.service.create(REQUEST);
    await harness.service.run(summary.sessionId);
    const beforeDestroy = alive.received.length;
    expect(beforeDestroy).toBeGreaterThan(0);
    expect(dying.received.length).toBe(beforeDestroy);

    dying.destroy();
    await harness.service.cancel(summary.sessionId).catch(() => undefined);

    expect(dying.received.length).toBe(beforeDestroy);
    // 每条事件只推一次（幂等注册的验证）
    const stageEvents = alive.received.filter(
      (event) => (event as { type: string }).type === "stage" && (event as { stage: string }).stage === "planning",
    );
    expect(stageEvents).toHaveLength(1);
  });
});

describe("ResearchService 的 P7 LLM 接线", () => {
  it("把 Session 的 summary 与注入项透传给编排器", async () => {
    const seen: Array<{ sessionId: string }> = [];
    let reportCalls = 0;
    const harness = makeHarness(enabledSettings(), ({ summary }) => {
      seen.push({ sessionId: summary.sessionId });
      return {
        planInitial: async (input) =>
          ({
            schemaVersion: 1,
            objective: input.objective,
            scope: {},
            subquestions: [{ id: "sq_1", text: input.objective }],
            initialQueries: [{ queryId: "q_1", subquestionId: "sq_1", text: input.objective }],
            budget: input.budget,
            completion: {
              minSourcesPerSubquestion: 1,
              minIndependentDomains: 1,
              requirePrimarySource: false,
              requireContradiction: false,
              minimumRelevance: 0.2,
            },
          }) as const,
        planGap: async () => ({ action: "finish", reason: "无候选" }) as const,
        generateReport: async () => {
          reportCalls += 1;
          return "模型撰写的报告正文。";
        },
      };
    });

    const summary = await harness.service.create(REQUEST);
    await harness.service.run(summary.sessionId);

    // 装配回调对每个 Session 只调一次，且拿到的是这个 Session 自己的 summary。
    expect(seen).toEqual([{ sessionId: summary.sessionId }]);
    expect(reportCalls).toBe(1);
    const view = await harness.service.get(summary.sessionId, "full");
    expect(view.report!.markdown).toContain("模型撰写的报告正文");
  });

  it("未注入 llmHooks 时沿用确定性行为", async () => {
    const harness = makeHarness();
    const summary = await harness.service.create(REQUEST);
    await harness.service.run(summary.sessionId);
    const view = await harness.service.get(summary.sessionId, "full");
    expect(view.summary.status).toBe("completed");
    expect(view.report!.markdown).toContain(REQUEST.objective);
  });
});

/// 终态 Session 的「重跑」。
///
/// **为什么是克隆而不是就地重置**：session-status 的转移表把三个终态设成无出口，
/// 并写明理由「想重跑只能新建 Session，这样报告与证据的因果链才不会被就地改写」。
/// 就地擦掉 rounds/documents/report 再退回 created，等于把那条不变量拆掉——
/// 旧报告引用的证据会凭空消失，而报告本身可能已经被导出、被引用过。
/// 克隆则两全：旧会话连同它的报告原样留着，新会话用同一批参数重跑。
describe("rerun（终态会话的重跑）", () => {
  async function completedSession(): Promise<{ service: ResearchService; repository: InMemoryResearchRepository; sessionId: string }> {
    const { service, repository } = makeHarness();
    const created = await service.create({
      consumer: "deep_research",
      objective: "llm 与 agent 的关系",
      mode: "standard",
      sourceScopes: [{ kind: "public_web" }],
      output: { format: "report", maxWords: 3000, requireCitations: true },
    });
    await repository.updateSessionStatus(created.sessionId, "completed");
    return { service, repository, sessionId: created.sessionId };
  }

  it("用同一批参数新建会话，旧会话原样保留", async () => {
    const { service, repository, sessionId } = await completedSession();
    const clone = await service.rerun(sessionId);

    expect(clone.sessionId).not.toBe(sessionId);
    expect(clone.status).toBe("created");
    expect(clone.objective).toBe("llm 与 agent 的关系");
    expect(clone.mode).toBe("standard");
    // 旧会话必须纹丝不动——它的报告可能已经被导出或引用过。
    const old = await repository.getSession(sessionId, "summary");
    expect(old?.summary.status).toBe("completed");
  });

  it("来源范围与输出要求一并继承（否则重跑会悄悄换一套约束）", async () => {
    const { service, repository, sessionId } = await completedSession();
    const clone = await service.rerun(sessionId);

    const view = await repository.getSession(clone.sessionId, "summary");
    expect(view?.sourceScopes).toEqual([{ kind: "public_web" }]);
    expect(view?.output?.maxWords).toBe(3000);
    expect(view?.output?.requireCitations).toBe(true);
  });

  it("新会话带种子计划，可以直接点开始", async () => {
    const { service, repository, sessionId } = await completedSession();
    const clone = await service.rerun(sessionId);
    const view = await repository.getSession(clone.sessionId, "full");
    expect(view?.plan?.objective).toBe("llm 与 agent 的关系");
  });

  it("非终态会话拒绝重跑（还在跑的东西没有重跑的语义）", async () => {
    const { service, repository, sessionId } = await completedSession();
    await repository.updateSessionStatus(sessionId, "searching");
    await expect(service.rerun(sessionId)).rejects.toThrow();
  });

  it("未知会话抛错", async () => {
    const { service } = await completedSession();
    await expect(service.rerun("不存在")).rejects.toThrow();
  });
})
