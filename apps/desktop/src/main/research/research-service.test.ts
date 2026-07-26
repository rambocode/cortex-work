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
import {
  fixtureChunk,
  fixtureDocument,
  fixtureReport,
  fixtureRound,
  fixtureSessionInput,
} from "./repository-fixtures";
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
  overrides: Partial<ResearchServiceDeps> = {},
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
    ...overrides,
  });
  return harness;
}

/// 轮询等待 Session 落到某个状态（编排是后台跑的，状态不会在 run 返回的那一刻就位）。
/// 只让出微任务、不用假定时器，避免与被测代码里的真实 await 顺序耦合。
async function waitForStatus(
  harness: Harness,
  sessionId: string,
  target: string,
  maxTicks = 50,
): Promise<string | undefined> {
  for (let i = 0; i < maxTicks; i += 1) {
    const status = (await harness.repository.getSession(sessionId, "summary"))?.summary.status;
    if (status === target) return status;
    await Promise.resolve();
  }
  return (await harness.repository.getSession(sessionId, "summary"))?.summary.status;
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
    await harness.service.settled(summary.sessionId);

    expect(harness.ensureCalls).toBe(1);
    expect((await harness.repository.getSession(summary.sessionId, "summary"))!.summary.status).toBe(
      "completed",
    );
  });

  // run 是**启动即返回**的：它挂到编排跑完才 resolve 的话，renderer 那条 IPC 会一直悬着，
  // 会话在界面上根本不会出现，整个执行期间的事件也就无处可落（这正是「点开始后页面毫无反应」）。
  it("启动即返回：编排还在跑时 run 就已经 resolve", async () => {
    let releaseSearch: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    const harness = makeHarness(enabledSettings(), undefined, {
      createSearchClient: () => ({
        searchBatch: async (request) => {
          await blocked;
          return emptySearch(request.request_id);
        },
      }),
    });
    const summary = await harness.service.create(REQUEST);

    await harness.service.run(summary.sessionId);

    // run 已经返回，而编排此刻正卡在搜索里——会话处于运行中而不是终态，
    // 这正是「启动即返回」与旧行为的分水岭（旧行为下 run 要等到 completed 才 resolve）。
    const midway = await waitForStatus(harness, summary.sessionId, "searching");
    expect(midway).toBe("searching");

    releaseSearch!();
    await harness.service.settled(summary.sessionId);
    expect((await harness.repository.getSession(summary.sessionId, "summary"))!.summary.status).toBe(
      "completed",
    );
  });

  // 「搜索服务未配置」是用户最常撞的启动失败，必须在 run 返回前就原样抛回 renderer，
  // 不能因为改成 fire-and-forget 而变成一条悄无声息的后台失败。
  it("搜索服务未配置时同步抛错，且不拉起 Worker", async () => {
    const harness = makeHarness(enabledSettings(), undefined, { createSearchClient: () => null });
    const summary = await harness.service.create(REQUEST);

    await expect(harness.service.run(summary.sessionId)).rejects.toThrow(/搜索服务/);
    expect(harness.ensureCalls).toBe(0);
  });

  // 启动之后才发生的失败（Worker 拉不起来等）没人能 await 了，必须以终态事件的形式广播出去。
  it("启动后的失败会落 failed 并广播 error(terminal) + done(failed)", async () => {
    const harness = makeHarness(enabledSettings(), undefined, {
      workerProvider: {
        ensure: async () => {
          throw new Error("Worker 拉起失败");
        },
        stop: async () => undefined,
      },
    });
    const sender = new FakeSender();
    harness.service.addEventSender(sender);
    const summary = await harness.service.create(REQUEST);

    await harness.service.run(summary.sessionId);
    await harness.service.settled(summary.sessionId);

    expect((await harness.repository.getSession(summary.sessionId, "summary"))!.summary.status).toBe(
      "failed",
    );
    const types = sender.received.map((e) => (e as { type: string }).type);
    expect(types).toContain("error");
    expect(sender.received).toContainEqual(
      expect.objectContaining({ type: "done", status: "failed" }),
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

describe("ResearchService.pause", () => {
  // 暂停只写库不广播的话，renderer 会一直显示「抓取中」，必须重开覆盖层才看得到真实状态。
  it("广播 status 事件，renderer 无需重新拉列表就能看到 paused", async () => {
    const harness = makeHarness();
    const sender = new FakeSender();
    harness.service.addEventSender(sender);
    const summary = await harness.service.create(REQUEST);
    // 没有在途编排的静止会话：走 service 自己的状态转移分支。
    await harness.repository.updateSessionStatus(summary.sessionId, "searching");

    await harness.service.pause(summary.sessionId);

    expect(sender.received).toContainEqual({
      type: "status",
      sessionId: summary.sessionId,
      status: "paused",
    });
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
    await harness.service.settled(summary.sessionId);
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
    await harness.service.settled(summary.sessionId);

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
    await harness.service.settled(summary.sessionId);
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
      output: { format: "answer", requireCitations: false },
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
    // 产物形态与引用要求都得原样继承：任一项被悄悄换成默认值，
    // 「重跑」就变成了「跑了个不一样的东西」，而用户看不出来。
    expect(view?.output?.format).toBe("answer");
    expect(view?.output?.requireCitations).toBe(false);
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

describe("regenerateReport（复用证据覆盖原报告）", () => {
  async function completedWithEvidence(
    generateReport: NonNullable<ReturnType<NonNullable<ResearchServiceDeps["llmHooks"]>>>["generateReport"],
    initialEvidenceSpend = 0,
  ): Promise<Harness & { sessionId: string }> {
    const harness = makeHarness(enabledSettings(), () => ({
      planInitial: async () => {
        throw new Error("本用例不该重新规划");
      },
      planGap: async () => ({ action: "finish", reason: "本用例不该补充检索" }),
      generateReport,
    }));
    const created = await harness.service.create(REQUEST);
    const oldReport = fixtureReport({
      markdown: "旧报告正文[^chunk-1]。",
      generatedAt: "2026-07-25T09:00:00.000Z",
    });
    await harness.repository.beginOperation({
      operationId: "seed-report",
      sessionId: created.sessionId,
      kind: "report",
      requestPayloadHash: "seed",
      createdAt: "2026-07-25T09:00:00.000Z",
    });
    await harness.repository.commitOperation("seed-report", (tx) => {
      tx.insertDocuments([fixtureDocument()]);
      tx.insertChunks([fixtureChunk()]);
      tx.insertReport(oldReport);
      tx.insertCitations(oldReport.citations);
      if (initialEvidenceSpend > 0) {
        tx.consumeBudget({ evidenceCharsToModel: initialEvidenceSpend });
      }
    });
    await harness.repository.updateSessionStatus(created.sessionId, "completed");
    return { ...harness, sessionId: created.sessionId };
  }

  it("不重新搜索或启动 Worker，直接用原计划与证据生成并覆盖报告", async () => {
    let receivedChunks = 0;
    const harness = await completedWithEvidence(async (input) => {
      receivedChunks = input.chunks.length;
      return { markdown: "新报告正文[^chunk-1]。" };
    });

    const report = await harness.service.regenerateReport(harness.sessionId);
    const persisted = await harness.repository.getSession(harness.sessionId, "full");

    expect(receivedChunks).toBe(1);
    expect(harness.ensureCalls).toBe(0);
    expect(report.markdown).toBe("新报告正文[^chunk-1]。");
    expect(persisted?.report?.markdown).toBe("新报告正文[^chunk-1]。");
    expect(persisted?.report?.citations.map((item) => item.chunkId)).toEqual(["chunk-1"]);
    expect(persisted?.summary.status).toBe("completed");
  });

  it("生成失败时旧报告与旧引用保持不变", async () => {
    const harness = await completedWithEvidence(async () => {
      throw new Error("模型暂不可用");
    });

    await expect(harness.service.regenerateReport(harness.sessionId)).rejects.toThrow("模型暂不可用");
    const persisted = await harness.repository.getSession(harness.sessionId, "full");

    expect(persisted?.report?.markdown).toBe("旧报告正文[^chunk-1]。");
    expect(persisted?.report?.citations.map((item) => item.chunkId)).toEqual(["chunk-1"]);
  });

  it("真实生成器走确定性降级时拒绝覆盖旧报告", async () => {
    const fallbackStats = {
      ...fixtureReport().generationStats!,
      usedFallback: true,
    };
    const harness = await completedWithEvidence(async () => ({
      markdown: "模型失败后的降级摘要[^chunk-1]。",
      generationStats: fallbackStats,
    }));

    await expect(harness.service.regenerateReport(harness.sessionId)).rejects.toThrow(
      /保留原报告/,
    );
    const persisted = await harness.repository.getSession(harness.sessionId, "full");
    const spent = await harness.repository.getBudgetSpend(harness.sessionId);
    expect(persisted?.report?.markdown).toBe("旧报告正文[^chunk-1]。");
    expect(spent.evidenceCharsToModel).toBe(800);
  });

  it("只使用 Session 剩余证据出站预算，耗尽后拒绝连续重生成", async () => {
    let calls = 0;
    let receivedBudget = 0;
    const harness = await completedWithEvidence(async (input) => {
      calls += 1;
      receivedBudget = input.plan.budget.maxEvidenceCharsToModel;
      return {
        markdown: "预算内的新报告[^chunk-1]。",
        generationStats: {
          ...fixtureReport().generationStats!,
          promptEvidenceChars: receivedBudget,
          usedFallback: false,
        },
      };
    }, 19_000);

    await harness.service.regenerateReport(harness.sessionId);
    await expect(harness.service.regenerateReport(harness.sessionId)).rejects.toThrow(/预算已用尽/);

    expect(receivedBudget).toBe(1_000);
    expect(calls).toBe(1);
  });

  it("并发点击采用 single-flight，只生成一次", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await completedWithEvidence(async () => {
      calls += 1;
      await blocked;
      return { markdown: "并发后的新报告[^chunk-1]。" };
    });

    const first = harness.service.regenerateReport(harness.sessionId);
    const second = harness.service.regenerateReport(harness.sessionId);
    release!();
    const reports = await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(reports[0].markdown).toBe(reports[1].markdown);
  });
});
