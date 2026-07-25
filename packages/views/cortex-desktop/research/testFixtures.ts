// 组件测试共用的样例数据工厂（仅被 *.test.tsx 引用）。
//
// 刻意手写而不用 mock 框架：本目录的组件全部经 props 注入 bridge，替身就是普通对象，
// 保持「输入是什么、断言什么」一眼可读（范本见 apps/desktop 的 agent-browser/runtime.test.ts）。
import type {
  ResearchDocument,
  EvidenceChunk,
} from "@cortex-work/core/research/evidence";
import type {
  ResearchPlan,
  ResearchReport,
  ResearchSessionSummary,
  ResearchSessionView,
} from "@cortex-work/core/research/types";

/// 造一个会话摘要；只覆盖需要的字段，其余取稳定默认（时间戳固定，避免快照抖动）。
export function makeSummary(patch: Partial<ResearchSessionSummary> = {}): ResearchSessionSummary {
  return {
    sessionId: "s1",
    consumer: "deep_research",
    objective: "调查 Rust 异步运行时的现状",
    mode: "standard",
    status: "created",
    createdAt: "2026-07-25T01:00:00.000Z",
    updatedAt: "2026-07-25T02:00:00.000Z",
    roundCount: 0,
    documentCount: 0,
    chunkCount: 0,
    ...patch,
  };
}

/// 造一份最小可用的研究计划（两个子问题 + 两条初始查询）。
export function makePlan(patch: Partial<ResearchPlan> = {}): ResearchPlan {
  return {
    schemaVersion: 1,
    objective: "调查 Rust 异步运行时的现状",
    scope: { language: "zh", timeRange: "year" },
    subquestions: [
      { id: "q1", text: "主流运行时有哪些", rationale: "先划定范围" },
      { id: "q2", text: "各自的调度模型差异" },
    ],
    initialQueries: [
      { queryId: "k1", subquestionId: "q1", text: "rust async runtime 对比" },
      { queryId: "k2", subquestionId: "q2", text: "tokio scheduler work stealing" },
    ],
    budget: {
      maxRounds: 3,
      maxQueries: 16,
      maxCandidates: 72,
      maxDocuments: 24,
      maxBrowserFetches: 5,
      maxDurationMs: 600_000,
      maxEvidenceCharsToModel: 60_000,
    },
    completion: {
      minSourcesPerSubquestion: 2,
      minIndependentDomains: 2,
      requirePrimarySource: true,
      requireContradiction: false,
      minimumRelevance: 0.4,
    },
    ...patch,
  };
}

/// 造一篇已抓取文档。
export function makeDocument(patch: Partial<ResearchDocument> = {}): ResearchDocument {
  return {
    documentId: "d1",
    candidateId: "c1",
    source: {
      sourceType: "documentation",
      trustZone: "public_web",
      locator: "https://tokio.rs/tokio/tutorial",
      title: "Tokio 教程",
      domain: "tokio.rs",
    },
    title: "Tokio 教程",
    canonicalUrl: "https://tokio.rs/tokio/tutorial",
    contentHash: "hash-1",
    mediaType: "text/html",
    fetchMethod: "http",
    fetchedAt: "2026-07-25T02:30:00.000Z",
    contentRef: "blob://should-never-be-rendered",
    textLength: 4200,
    policy: {
      trustZone: "public_web",
      allowSearchServer: true,
      allowCloudModel: true,
      allowCrossSessionReuse: true,
    },
    ...patch,
  };
}

/// 造一条证据片段（正文只在 evidence 级别出现）。
export function makeChunk(patch: Partial<EvidenceChunk> = {}): EvidenceChunk {
  return {
    chunkId: "ch1",
    documentId: "d1",
    text: "Tokio 使用工作窃取调度器。",
    textHash: "th1",
    objectiveScore: 0.8,
    subquestionScores: { q2: 0.9 },
    trustZone: "public_web",
    ...patch,
  };
}

/// 造一份最终报告。
export function makeReport(patch: Partial<ResearchReport> = {}): ResearchReport {
  return {
    markdown: "## 结论\n\nTokio 是当前最主流的选择。",
    citations: [
      {
        chunkId: "ch1",
        documentId: "d1",
        title: "Tokio 教程",
        url: "https://tokio.rs/tokio/tutorial",
        retrievedAt: "2026-07-25T02:30:00.000Z",
        textHash: "th1",
      },
    ],
    unsupportedSections: [],
    generatedAt: "2026-07-25T03:00:00.000Z",
    ...patch,
  };
}

/// 造一个 full 级别的详情视图（含计划、轮次、报告，但**不含**文档与证据正文）。
export function makeFullView(patch: Partial<ResearchSessionView> = {}): ResearchSessionView {
  return {
    summary: makeSummary({ status: "completed", roundCount: 2, documentCount: 1, chunkCount: 1 }),
    plan: makePlan(),
    rounds: [
      {
        roundIndex: 0,
        startedAt: "2026-07-25T02:00:00.000Z",
        endedAt: "2026-07-25T02:20:00.000Z",
        decision: "search_more",
        queryIds: ["k1", "k2"],
        candidateCount: 20,
        documentCount: 6,
        chunkCount: 30,
      },
    ],
    report: makeReport(),
    ...patch,
  };
}
