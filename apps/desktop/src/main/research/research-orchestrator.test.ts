// 单轮编排闭环的行为测试。
//
// 全部依赖都是手写替身：InMemoryResearchRepository + 假 Search Client + 假 Worker + 内存 blob。
// 零 Electron、零网络、零 SQLite。
import { beforeEach, describe, expect, it } from "vitest";
import type { PlannerDecision, ResearchEvent, ResearchPlan } from "@cortex-work/core/research/types";
import type { SearchBatchResponse } from "@cortex-work/core/research/search-api";
import { StealthFetchError } from "./clients/stealth-fetch-client";
import { InMemoryResearchRepository } from "./repository-memory";
import { fixtureSessionInput } from "./repository-fixtures";
import { IllegalStatusTransitionError } from "./session-state";
import {
  ResearchOrchestrator,
  buildSeedPlan,
  type GapPlannerInput,
  type InitialPlannerInput,
  type ReportGenerator,
} from "./research-orchestrator";
import type { WorkerFetchPrepareResult } from "./worker-mapping";

const SESSION_ID = "sess-1";
const CONTENT_HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const TEXT_HASH = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";

/// 一个正常的搜索响应（两个域名，便于观察多样性选择）。
function searchResponse(requestId: string): SearchBatchResponse {
  return {
    request_id: requestId,
    results: [
      {
        query_id: "q_1",
        items: [
          {
            url: "https://example.com/a",
            title: "Example A",
            snippet: "线索摘要",
            domain: "example.com",
            engines: ["duckduckgo"],
            score: 0.9,
            canonical_url: "https://example.com/a",
          },
          {
            url: "https://other.com/b",
            title: "Other B",
            domain: "other.com",
            engines: ["brave"],
            score: 0.4,
          },
        ],
        errors: [],
      },
    ],
    stats: {
      provider_count: 2,
      raw_result_count: 2,
      returned_result_count: 2,
      cache_hit: false,
      duration_ms: 120,
    },
  };
}

/// 按给定 URL 列表构造搜索响应。stealth 降级的用例需要控制候选域名，
/// 而 searchResponse 里的域名是写死的。
function searchResponseFor(requestId: string, ...urls: string[]): SearchBatchResponse {
  return {
    request_id: requestId,
    results: [
      {
        query_id: "q_1",
        items: urls.map((url, i) => ({
          url,
          title: `候选 ${i + 1}`,
          domain: new URL(url).hostname,
          engines: ["mojeek"],
          score: 0.9 - i * 0.1,
          canonical_url: url,
        })),
        errors: [],
      },
    ],
    stats: {
      provider_count: 1,
      raw_result_count: urls.length,
      returned_result_count: urls.length,
      cache_hit: false,
      duration_ms: 100,
    },
  };
}

/// 一个正常的 fetch_prepare 结果（一篇文档 + 一个 chunk）。
/// candidateId 由调用方回传：真实 Worker 会原样回显我们下发的候选 id，
/// 替身必须同样回显，否则"候选 → 查询 → 子问题"的归因链在测试里是断的。
function fetchResult(operationId: string, candidateId: string): WorkerFetchPrepareResult {
  return {
    operation_id: operationId,
    documents: [
      {
        candidate_id: candidateId,
        url: "https://example.com/a",
        canonical_url: "https://example.com/a",
        title: "Example A",
        content_hash: CONTENT_HASH,
        simhash: "c3f1a2b4d5e60718",
        media_type: "text/html",
        fetch_method: "http",
        fetched_at: "2026-07-25T09:00:00.000Z",
        text: "node:sqlite 在 Node 22 上可用，但仍标记为实验特性。",
        text_length: 27,
        trust_zone: "public_web",
      },
    ],
    chunks: [
      {
        chunk_id: "ch_1",
        content_hash: CONTENT_HASH,
        start_offset: 0,
        end_offset: 27,
        heading_path: ["Example A"],
        text: "node:sqlite 在 Node 22 上可用，但仍标记为实验特性。",
        text_hash: TEXT_HASH,
        lexical_score: 0.8,
      },
    ],
    duplicate_clusters: [],
    failures: [],
    stats: { http_fetches: 1, browser_fetches: 0, total_bytes: 2048, duration_ms: 300, skipped_known: 0 },
  };
}

/// 永不 settle 的 Promise，用于制造"取消发生在某阶段进行中"。
function hang<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/// 内存 blob 替身。
class FakeBlobStore {
  readonly blobs = new Map<string, string>();
  async putBlob(contentHash: string, text: string): Promise<string> {
    this.blobs.set(contentHash, text);
    return `blob:${contentHash}`;
  }
}

interface Harness {
  repository: InMemoryResearchRepository;
  blobStore: FakeBlobStore;
  events: ResearchEvent[];
  searchCalls: number;
  workerCalls: Array<{ method: string; params: unknown }>;
  orchestrator: ResearchOrchestrator;
}

interface HarnessOptions {
  search?: (requestId: string) => Promise<SearchBatchResponse>;
  fetch?: (
    operationId: string,
    params: { candidates: Array<{ candidate_id: string; url: string }> },
  ) => Promise<WorkerFetchPrepareResult>;
  generateReport?: (input: Parameters<ReportGenerator>[0]) => Promise<string>;
  abortIntent?: () => "cancel" | "pause";
  /// P7：多轮循环的 Gap Planner 注入点。
  planGap?: (input: GapPlannerInput) => Promise<PlannerDecision>;
  /// P7：Initial Planner 注入点。
  planInitial?: (input: InitialPlannerInput) => Promise<ResearchPlan>;
  mode?: "quick" | "standard" | "deep";
  /// stealth 抓取注入点。缺省 = 不注入,编排层行为与从前完全一致(只发一轮)。
  stealthFetch?: (url: string, signal?: AbortSignal) => Promise<{
    status: number;
    html: string;
    finalUrl: string;
  }>;
  /// Worker 在返回结果前上报的抓取进度（模拟真实 Worker 的 type:"event" 流）。
  fetchProgress?: Array<{ completed: number; total: number }>;
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const mode = options.mode ?? "quick";
  const repository = new InMemoryResearchRepository();
  await repository.createSession(fixtureSessionInput({ sessionId: SESSION_ID, mode }));
  await repository.savePlan(
    SESSION_ID,
    buildSeedPlan({ objective: "调研 node:sqlite 是否可用于生产", mode }),
  );

  const blobStore = new FakeBlobStore();
  const events: ResearchEvent[] = [];
  const workerCalls: Array<{ method: string; params: unknown }> = [];
  const harness: Harness = {
    repository,
    blobStore,
    events,
    searchCalls: 0,
    workerCalls,
    orchestrator: undefined as unknown as ResearchOrchestrator,
  };

  let seq = 0;
  harness.orchestrator = new ResearchOrchestrator({
    repository,
    blobStore,
    searchClient: {
      searchBatch: async (request) => {
        harness.searchCalls += 1;
        return options.search
          ? await options.search(request.request_id)
          : searchResponse(request.request_id);
      },
    },
    worker: {
      request: (async (
        method: string,
        params: unknown,
        onProgress?: (progress: { completed: number; total: number }) => void,
      ) => {
        workerCalls.push({ method, params });
        if (method === "cancel") return { ok: true };
        const typed = params as {
          operation_id: string;
          candidates: Array<{ candidate_id: string; url: string }>;
        };
        // 真实 Worker 在抓取过程中会持续上报进度，返回结果之前发完。
        for (const progress of options.fetchProgress ?? []) onProgress?.(progress);
        return options.fetch
          ? await options.fetch(typed.operation_id, typed)
          : fetchResult(typed.operation_id, typed.candidates[0]!.candidate_id);
      }) as never,
    },
    userScope: "user-fixture",
    newId: () => `id_${(seq += 1)}`,
    now: () => new Date("2026-07-25T10:00:00.000Z"),
    emit: (event) => events.push(event),
    ...(options.generateReport ? { generateReport: options.generateReport } : {}),
    ...(options.abortIntent ? { abortIntent: options.abortIntent } : {}),
    // stealth 注入点：包成 StealthFetchLike 的形状（编排层只要一个 fetch 方法）。
    ...(options.stealthFetch ? { stealthFetch: { fetch: options.stealthFetch } } : {}),
    ...(options.planGap ? { planGap: options.planGap } : {}),
    ...(options.planInitial ? { planInitial: options.planInitial } : {}),
  });
  return harness;
}

describe("ResearchOrchestrator 单轮闭环", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  it("跑完 search → select → fetch → evidence → citation，Session 收敛到 completed", async () => {
    await harness.orchestrator.run(SESSION_ID, new AbortController().signal);

    const view = (await harness.repository.getSession(SESSION_ID, "evidence"))!;
    expect(view.summary.status).toBe("completed");
    expect(view.rounds).toHaveLength(1);
    expect(view.rounds![0]).toMatchObject({ roundIndex: 0, documentCount: 1, chunkCount: 1 });
    expect(view.documents).toHaveLength(1);
    expect(view.chunks).toHaveLength(1);
    expect(view.coverage!.length).toBeGreaterThan(0);
    // 报告里的每条引用都必须能回溯到已提交的 chunk（Citation Validator 的红线）
    const knownChunkIds = new Set(view.chunks!.map((chunk) => chunk.chunkId));
    expect(view.report!.citations.length).toBeGreaterThan(0);
    for (const citation of view.report!.citations) {
      expect(knownChunkIds.has(citation.chunkId)).toBe(true);
    }
    // 正文落 blob，不进 SQLite 之外的地方
    expect(harness.blobStore.blobs.get(CONTENT_HASH)).toContain("node:sqlite");
    // 预算消耗被记账
    expect(await harness.repository.getBudgetSpend(SESSION_ID)).toMatchObject({
      rounds: 1,
      documents: 1,
    });
    expect(harness.events.at(-1)).toEqual({ type: "done", sessionId: SESSION_ID, status: "completed" });
  });

  it("Worker 的 snake_case 结果无损落库成 camelCase 领域对象", async () => {
    await harness.orchestrator.run(SESSION_ID, new AbortController().signal);
    const view = (await harness.repository.getSession(SESSION_ID, "evidence"))!;

    expect(view.documents![0]).toMatchObject({
      contentHash: CONTENT_HASH,
      contentRef: `blob:${CONTENT_HASH}`,
      mediaType: "text/html",
      fetchMethod: "http",
      fetchedAt: "2026-07-25T09:00:00.000Z",
      simhash: "c3f1a2b4d5e60718",
      textLength: 27,
      canonicalUrl: "https://example.com/a",
    });
    expect(view.chunks![0]).toMatchObject({
      documentId: view.documents![0]!.documentId,
      textHash: TEXT_HASH,
      startOffset: 0,
      endOffset: 27,
      headingPath: ["Example A"],
      objectiveScore: 0.8,
      trustZone: "public_web",
    });
    // 子问题相关性由"候选 → 查询 → 子问题"归因补齐（协议本身不提供）
    expect(Object.keys(view.chunks![0]!.subquestionScores)).toHaveLength(1);
  });

  it("搜索无候选时不调用 Worker，仍收敛到 completed", async () => {
    const empty = await makeHarness({
      search: async (requestId) => ({
        request_id: requestId,
        results: [{ query_id: "q_1", items: [], errors: [] }],
        stats: {
          provider_count: 1,
          raw_result_count: 0,
          returned_result_count: 0,
          cache_hit: false,
          duration_ms: 10,
        },
      }),
    });

    await empty.orchestrator.run(SESSION_ID, new AbortController().signal);

    expect(empty.workerCalls).toEqual([]);
    expect((await empty.repository.getSession(SESSION_ID, "summary"))!.summary.status).toBe("completed");
  });
});

// 执行流水是「研究正在干什么」的唯一实时来源：没有它，用户在几分钟里只能看到一个不动的阶段徽标。
describe("ResearchOrchestrator 执行流水与抓取进度", () => {
  it("发出查询 / 文档 / 决策三类流水，且不夹带任何正文", async () => {
    const harness = await makeHarness();
    await harness.orchestrator.run(SESSION_ID, new AbortController().signal);

    const activities = harness.events.filter((event) => event.type === "activity");
    const kinds = activities.map((a) => a.kind);
    expect(kinds).toContain("query");
    expect(kinds).toContain("document");
    expect(kinds).toContain("report");

    // 查询流水带的是查询词本身（它已在 plan.initialQueries 里给过 renderer）。
    expect(activities.find((a) => a.kind === "query")?.text).toContain("node:sqlite");
    // 文档流水**只带域名**：完整 URL 的 query string 可能含搜索词，标题属 evidence 级别。
    const doc = activities.find((a) => a.kind === "document")!;
    expect(doc.text).toBe("example.com");
    expect(doc.roundIndex).toBe(0);
    // 兜底：任何一条流水都不得出现抓取到的正文或文档标题。
    for (const a of activities) {
      expect(a.text).not.toContain("实验特性");
      expect(a.text).not.toContain("Example A");
    }
  });

  it("Worker 的抓取进度被转成 stage:fetching 的 completed/total", async () => {
    const harness = await makeHarness({
      fetchProgress: [
        { completed: 1, total: 2 },
        { completed: 2, total: 2 },
      ],
    });
    await harness.orchestrator.run(SESSION_ID, new AbortController().signal);

    const fetching = harness.events.flatMap((event) =>
      event.type === "stage" && event.stage === "fetching" ? [event.progress?.completed] : [],
    );
    // 起始的 0/N 之外，Worker 报几次就该有几条，且 completed 递增。
    expect(fetching).toEqual([0, 1, 2]);
  });
});

describe("ResearchOrchestrator 取消（spec §19.1.3：任一阶段取消后终态必须是 cancelled）", () => {
  it("search 进行中取消", async () => {
    const controller = new AbortController();
    const harness = await makeHarness({
      search: async () => {
        controller.abort();
        return hang<SearchBatchResponse>();
      },
    });

    await harness.orchestrator.run(SESSION_ID, controller.signal);

    expect((await harness.repository.getSession(SESSION_ID, "summary"))!.summary.status).toBe("cancelled");
    expect(harness.events.at(-1)).toMatchObject({ type: "done", status: "cancelled" });
  });

  it("fetch 进行中取消（并向 Worker 发 cancel）", async () => {
    const controller = new AbortController();
    const harness = await makeHarness({
      fetch: async () => {
        controller.abort();
        return hang<WorkerFetchPrepareResult>();
      },
    });

    await harness.orchestrator.run(SESSION_ID, controller.signal);

    expect((await harness.repository.getSession(SESSION_ID, "summary"))!.summary.status).toBe("cancelled");
    expect(harness.workerCalls.map((call) => call.method)).toContain("cancel");
    // 取消不得留下半个已提交的轮次
    const view = (await harness.repository.getSession(SESSION_ID, "evidence"))!;
    expect(view.rounds).toEqual([]);
    expect(view.documents).toEqual([]);
  });

  it("report 进行中取消", async () => {
    const controller = new AbortController();
    const harness = await makeHarness({
      generateReport: async () => {
        controller.abort();
        return hang<string>();
      },
    });

    await harness.orchestrator.run(SESSION_ID, controller.signal);

    const view = (await harness.repository.getSession(SESSION_ID, "evidence"))!;
    expect(view.summary.status).toBe("cancelled");
    // 取消发生在报告阶段：此前已提交的证据必须保留（spec §19.1.5 同款要求）
    expect(view.documents).toHaveLength(1);
    expect(view.report).toBeUndefined();
  });

  it("abortIntent 为 pause 时收敛到 paused 而不是 cancelled", async () => {
    const controller = new AbortController();
    const harness = await makeHarness({
      search: async () => {
        controller.abort();
        return hang<SearchBatchResponse>();
      },
      abortIntent: () => "pause",
    });

    await harness.orchestrator.run(SESSION_ID, controller.signal);
    expect((await harness.repository.getSession(SESSION_ID, "summary"))!.summary.status).toBe("paused");
  });
});

describe("ResearchOrchestrator 失败与非法转移", () => {
  it("终态 Session 再次 run 被状态机拒绝，且不产生任何外部调用", async () => {
    const harness = await makeHarness();
    await harness.repository.updateSessionStatus(SESSION_ID, "completed");

    await expect(
      harness.orchestrator.run(SESSION_ID, new AbortController().signal),
    ).rejects.toBeInstanceOf(IllegalStatusTransitionError);
    expect(harness.searchCalls).toBe(0);
    expect(harness.workerCalls).toEqual([]);
  });

  it("Worker 失败时 Session 收敛到 failed，并带可展示的错误说明", async () => {
    const harness = await makeHarness({
      fetch: async () => {
        throw new Error("worker 抓取失败");
      },
    });

    await expect(harness.orchestrator.run(SESSION_ID, new AbortController().signal)).rejects.toThrow();

    const summary = (await harness.repository.getSession(SESSION_ID, "summary"))!.summary;
    expect(summary.status).toBe("failed");
    expect(summary.errorMessage).toContain("worker 抓取失败");
    expect(harness.events.some((event) => event.type === "error")).toBe(true);
  });

  it("未知 Session 直接抛错", async () => {
    const harness = await makeHarness();
    await expect(harness.orchestrator.run("nope", new AbortController().signal)).rejects.toThrow(/nope/);
  });
});

// ── P7：多轮循环 ─────────────────────────────────────────────────────────────

/// 按候选 URL 产出对应的文档：多轮测试里第二轮抓的是另一个域名，
/// 用同一份固定响应会造成 contentHash 冲突，也就看不出「独立域名数」的变化。
function fetchResultForCandidate(
  operationId: string,
  candidate: { candidate_id: string; url: string },
): WorkerFetchPrepareResult {
  const isOther = candidate.url.includes("other.com");
  const hash = isOther
    ? "b1a2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
    : CONTENT_HASH;
  return {
    operation_id: operationId,
    documents: [
      {
        candidate_id: candidate.candidate_id,
        url: candidate.url,
        canonical_url: candidate.url,
        title: isOther ? "Other B" : "Example A",
        content_hash: hash,
        media_type: "text/html",
        fetch_method: "http",
        fetched_at: "2026-07-25T09:00:00.000Z",
        text: "node:sqlite 在 Node 22 上可用，但仍标记为实验特性。",
        text_length: 27,
        trust_zone: "public_web",
      },
    ],
    chunks: [
      {
        chunk_id: "ch_1",
        content_hash: hash,
        text: "node:sqlite 在 Node 22 上可用，但仍标记为实验特性。",
        text_hash: TEXT_HASH,
        lexical_score: 0.8,
      },
    ],
    duplicate_clusters: [],
    failures: [],
    stats: { http_fetches: 1, browser_fetches: 0, total_bytes: 2048, duration_ms: 300, skipped_known: 0 },
  };
}

describe("ResearchOrchestrator 多轮循环（spec §19.1.2）", () => {
  it("覆盖度不足时按 Gap Planner 的 search_more 再跑一轮，达标后收尾", async () => {
    const gapInputs: GapPlannerInput[] = [];
    const harness = await makeHarness({
      mode: "standard",
      fetch: async (operationId, params) =>
        fetchResultForCandidate(operationId, params.candidates[0]!),
      planGap: async (input) => {
        gapInputs.push(input);
        return {
          action: "search_more",
          reason: "独立域名不足",
          queries: [{ queryId: "q_2", subquestionId: "sq_1", text: "node sqlite production" }],
        };
      },
    });

    await harness.orchestrator.run(SESSION_ID, new AbortController().signal);

    const view = (await harness.repository.getSession(SESSION_ID, "evidence"))!;
    expect(view.summary.status).toBe("completed");
    // 第一轮覆盖度 weak → 再来一轮；第二轮两个独立域名 → sufficient，decideStop 直接收尾
    expect(view.rounds).toHaveLength(2);
    // decision 记录的是「驱动该轮的决策」：首轮由初始计划驱动因此为空，第二轮由 search_more 驱动
    expect(view.rounds![0]!.decision).toBeUndefined();
    expect(view.rounds![1]!.decision).toBe("search_more");
    expect(view.documents).toHaveLength(2);
    expect(harness.searchCalls).toBe(2);
    // Gap Planner 只被问了一次：第二轮结束时覆盖度已达标，停止判定先于模型调用
    expect(gapInputs).toHaveLength(1);
    expect(gapInputs[0]!.coverage[0]!.status).toBe("weak");
    expect(gapInputs[0]!.executedQueries).toEqual(["调研 node:sqlite 是否可用于生产"]);
    expect(gapInputs[0]!.candidates.length).toBeGreaterThan(0);
    // 事件里能看到两轮及各自决策
    const rounds = harness.events.filter((event) => event.type === "round");
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toEqual({ type: "round", sessionId: SESSION_ID, roundIndex: 0 });
    expect(rounds[1]).toMatchObject({ roundIndex: 1, decision: "search_more" });
  });

  it("fetch_more 决策只抓指定候选，不再发搜索请求", async () => {
    let call = 0;
    const harness = await makeHarness({
      mode: "standard",
      fetch: async (operationId, params) =>
        fetchResultForCandidate(operationId, params.candidates[0]!),
      planGap: async (input) => {
        call += 1;
        if (call > 1) return { action: "finish", reason: "够了" };
        const target = input.candidates.find((candidate) => candidate.domain === "other.com")!;
        return { action: "fetch_more", reason: "官方来源还没抓", candidateIds: [target.candidateId] };
      },
    });

    await harness.orchestrator.run(SESSION_ID, new AbortController().signal);

    const view = (await harness.repository.getSession(SESSION_ID, "evidence"))!;
    expect(view.rounds).toHaveLength(2);
    expect(view.rounds![1]!.decision).toBe("fetch_more");
    expect(view.rounds![1]!.queryIds).toEqual([]);
    // 第二轮没有搜索
    expect(harness.searchCalls).toBe(1);
    expect(view.documents).toHaveLength(2);
    expect(view.summary.status).toBe("completed");
  });

  it("轮数耗尽时强制收尾，不再询问 Gap Planner", async () => {
    let gapCalls = 0;
    const harness = await makeHarness({
      // quick 模式 maxRounds = 1
      planGap: async () => {
        gapCalls += 1;
        return { action: "search_more", reason: "还想再搜", queries: [] as never };
      },
    });

    await harness.orchestrator.run(SESSION_ID, new AbortController().signal);

    const view = (await harness.repository.getSession(SESSION_ID, "evidence"))!;
    expect(view.rounds).toHaveLength(1);
    expect(gapCalls).toBe(0);
    expect(view.summary.status).toBe("completed");
  });

  it("未注入 Gap Planner 时保持 P5 的单轮行为", async () => {
    const harness = await makeHarness({ mode: "standard" });
    await harness.orchestrator.run(SESSION_ID, new AbortController().signal);
    const view = (await harness.repository.getSession(SESSION_ID, "evidence"))!;
    expect(view.rounds).toHaveLength(1);
    expect(view.summary.status).toBe("completed");
  });

  it("首轮开始前用 Initial Planner 覆盖种子计划，并沿用 Session 预算", async () => {
    const seen: InitialPlannerInput[] = [];
    const harness = await makeHarness({
      mode: "standard",
      planInitial: async (input) => {
        seen.push(input);
        return {
          schemaVersion: 1,
          objective: input.objective,
          scope: {},
          subquestions: [{ id: "sq_a", text: "拆解后的子问题" }],
          initialQueries: [{ queryId: "q_a", subquestionId: "sq_a", text: "模型给的查询" }],
          budget: input.budget,
          completion: {
            minSourcesPerSubquestion: 1,
            minIndependentDomains: 1,
            requirePrimarySource: false,
            requireContradiction: false,
            minimumRelevance: 0.2,
          },
        };
      },
    });

    await harness.orchestrator.run(SESSION_ID, new AbortController().signal);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.budget.maxRounds).toBe(3);
    const view = (await harness.repository.getSession(SESSION_ID, "evidence"))!;
    expect(view.plan!.subquestions[0]!.id).toBe("sq_a");
    expect(view.plan!.budget.maxRounds).toBe(3);
    expect(view.summary.status).toBe("completed");
  });
});

describe("buildSeedPlan", () => {
  it("由目标生成单子问题 + 单查询的种子计划，预算按模式夹取", () => {
    const plan = buildSeedPlan({ objective: "  调研 X  ", mode: "quick" });
    expect(plan.schemaVersion).toBe(1);
    expect(plan.objective).toBe("调研 X");
    expect(plan.subquestions).toHaveLength(1);
    expect(plan.initialQueries[0]!.subquestionId).toBe(plan.subquestions[0]!.id);
    expect(plan.budget.maxRounds).toBe(1);
  });

  it("超长目标被截断到 Search Server 的查询上限", () => {
    const plan = buildSeedPlan({ objective: "长".repeat(2000), mode: "standard" });
    expect([...plan.initialQueries[0]!.text].length).toBeLessThanOrEqual(512);
  });
});

describe("stealth 抓取降级（第二轮 fetch_prepare）", () => {
  /// 只有「本地抓不到 + 域名在清单里」两个条件同时满足才走服务端。
  ///
  /// 为什么不无条件降级：服务端每次要起一个 Camoufox（约 5s、并发上限 2），
  /// 而且抓取 URL 会离开本机。两者都要求这条路径是窄的。
  function failure403(candidateId: string, url: string) {
    return {
      candidate_id: candidateId,
      url,
      code: "http_error" as const,
      message: "HTTP 403",
      http_status: 403,
    };
  }

  /// 一轮全 403 的抓取结果（不产出任何文档）。
  function allFailed(
    operationId: string,
    candidates: Array<{ candidate_id: string; url: string }>,
  ): WorkerFetchPrepareResult {
    return {
      operation_id: operationId,
      documents: [],
      chunks: [],
      duplicate_clusters: [],
      failures: candidates.map((c) => failure403(c.candidate_id, c.url)),
      stats: {
        http_fetches: candidates.length,
        browser_fetches: 0,
        total_bytes: 0,
        duration_ms: 5,
        skipped_known: 0,
      },
    };
  }

  it("403 且域名命中清单时，用服务端抓回的 HTML 发第二轮 fetch_prepare", async () => {
    const stealthCalls: string[] = [];
    let round = 0;
    const harness = await makeHarness({
      search: async (requestId) => searchResponseFor(requestId, "https://zhuanlan.zhihu.com/p/1"),
      fetch: async (operationId, params) => {
        round += 1;
        if (round === 1) return allFailed(operationId, params.candidates);
        // 第二轮：main 已把 HTML 塞进 prefetched，Worker 直接抽取成功。
        return fetchResult(operationId, params.candidates[0]!.candidate_id);
      },
      stealthFetch: async (url: string) => {
        stealthCalls.push(url);
        return { status: 200, html: "<html>知乎正文</html>", finalUrl: url };
      },
    });
    await harness.orchestrator.run(SESSION_ID, new AbortController().signal);

    expect(stealthCalls).toEqual(["https://zhuanlan.zhihu.com/p/1"]);
    const prepares = harness.workerCalls.filter((c) => c.method === "fetch_prepare");
    expect(prepares).toHaveLength(2);
    expect((prepares[1]!.params as { prefetched?: unknown }).prefetched).toEqual([
      {
        candidate_id: expect.any(String),
        html: "<html>知乎正文</html>",
        final_url: "https://zhuanlan.zhihu.com/p/1",
      },
    ]);
  });

  it("域名不在清单里时不走服务端，也不发第二轮", async () => {
    const stealthCalls: string[] = [];
    const harness = await makeHarness({
      search: async (requestId) => searchResponseFor(requestId, "https://example.com/a"),
      fetch: async (operationId, params) => allFailed(operationId, params.candidates),
      stealthFetch: async (url: string) => {
        stealthCalls.push(url);
        throw new Error("不该被调用");
      },
    });
    await harness.orchestrator.run(SESSION_ID, new AbortController().signal);

    expect(stealthCalls).toEqual([]);
    expect(harness.workerCalls.filter((c) => c.method === "fetch_prepare")).toHaveLength(1);
  });

  /// unconfigured 不是「这个候选失败」而是「整条路径不可用」。
  /// 逐候选各撞一次 5 秒往返是最糟的表现形式。
  it("服务端回 unconfigured 时，同一轮内不再对其它候选重试", async () => {
    let stealthCalls = 0;
    const harness = await makeHarness({
      search: async (requestId) =>
        searchResponseFor(
          requestId,
          "https://zhihu.com/a",
          "https://zhihu.com/b",
          "https://zhihu.com/c",
        ),
      fetch: async (operationId, params) => allFailed(operationId, params.candidates),
      stealthFetch: async (_url: string) => {
        stealthCalls += 1;
        throw new StealthFetchError("unconfigured", "未配置");
      },
    });
    await harness.orchestrator.run(SESSION_ID, new AbortController().signal);

    expect(stealthCalls).toBe(1);
  });

  it("没有注入 stealthFetch 时行为与从前完全一致（只发一轮）", async () => {
    const harness = await makeHarness({
      search: async (requestId) => searchResponseFor(requestId, "https://zhihu.com/a"),
      fetch: async (operationId, params) => allFailed(operationId, params.candidates),
    });
    await harness.orchestrator.run(SESSION_ID, new AbortController().signal);
    expect(harness.workerCalls.filter((c) => c.method === "fetch_prepare")).toHaveLength(1);
  });
});
