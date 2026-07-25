// ResearchRepository 两套实现（InMemory / SQLite）共用的样例数据工厂。
//
// **仅供测试 import**（默认轮的 repository-memory.test.ts 与真 SQLite 轮的
// research-repository.sqlite.test.ts）。刻意共用同一份样例：内存版是上层编排测试的替身，
// 只有当两轮断言的是同一批数据时，「内存版与 SQLite 版语义一致」这条前提才算被验证过，
// 而不是各写各的样例各自自洽。
import { DEFAULT_SOURCE_POLICIES } from "@cortex-work/core/research/trust-policy";
import { MODE_BUDGETS } from "@cortex-work/core/research/budget";
import type {
  CitationRef,
  DuplicateCluster,
  EvidenceChunk,
  ResearchDocument,
  SearchCandidate,
} from "@cortex-work/core/research/evidence";
import type {
  CoverageReport,
  PlannedQuery,
  ResearchPlan,
  ResearchReport,
  ResearchRound,
} from "@cortex-work/core/research/types";
import type { CreateSessionInput } from "./research-repository";

/// 固定的用户隔离键（KTD9 跨 Session 复用要求同一用户）。
export const FIXTURE_USER_SCOPE = "user-fixture";

/// 64 位十六进制哈希生成器：把一个短标签铺满 64 字符，既满足 blob 路径的
/// `^[a-f0-9]{64}$` 校验，又让失败断言里能一眼看出是哪条样例。
export function fixtureHash(seed: string): string {
  const hex = [...seed].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return hex.repeat(Math.ceil(64 / hex.length)).slice(0, 64);
}

/// 一条最小可用的建 Session 入参；overrides 覆盖任意字段。
export function fixtureSessionInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    sessionId: "sess-1",
    consumer: "deep_research",
    objective: "调研 Electron 39 的 node:sqlite 稳定性",
    mode: "standard",
    modelDataPolicy: "evidence_allowed",
    sourceScopes: [{ kind: "public_web" }],
    output: { format: "report", requireCitations: true },
    budget: MODE_BUDGETS.standard,
    userScope: FIXTURE_USER_SCOPE,
    createdAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

/// 一条计划查询。
export function fixtureQuery(overrides: Partial<PlannedQuery> = {}): PlannedQuery {
  return {
    queryId: "q-1",
    subquestionId: "sq-1",
    text: "node:sqlite stability",
    language: "en",
    timeRange: "year",
    limit: 10,
    ...overrides,
  };
}

/// 一份完整的初始计划（含子问题与初始查询）。
export function fixturePlan(overrides: Partial<ResearchPlan> = {}): ResearchPlan {
  return {
    schemaVersion: 1,
    objective: "调研 Electron 39 的 node:sqlite 稳定性",
    scope: { language: "en", timeRange: "year", regions: ["us"] },
    subquestions: [
      { id: "sq-1", text: "node:sqlite 的 API 稳定性如何", rationale: "决定是否需要抽象层" },
      { id: "sq-2", text: "有哪些已知回归" },
    ],
    initialQueries: [fixtureQuery(), fixtureQuery({ queryId: "q-2", subquestionId: "sq-2", text: "node sqlite regressions" })],
    budget: MODE_BUDGETS.standard,
    completion: {
      minSourcesPerSubquestion: 2,
      minIndependentDomains: 2,
      requirePrimarySource: true,
      requireContradiction: false,
      minimumRelevance: 0.4,
    },
    ...overrides,
  };
}

/// 一轮执行记录。
export function fixtureRound(overrides: Partial<ResearchRound> = {}): ResearchRound {
  return {
    roundIndex: 0,
    startedAt: "2026-07-25T00:01:00.000Z",
    endedAt: "2026-07-25T00:02:00.000Z",
    decision: "search_more",
    queryIds: ["q-1", "q-2"],
    candidateCount: 2,
    documentCount: 1,
    chunkCount: 1,
    ...overrides,
  };
}

/// 一条搜索候选（只是线索，KTD3 不得直接进入 Claim）。
export function fixtureCandidate(overrides: Partial<SearchCandidate> = {}): SearchCandidate {
  return {
    candidateId: "cand-1",
    queryId: "q-1",
    title: "node:sqlite docs",
    url: "https://nodejs.org/api/sqlite.html",
    canonicalUrl: "https://nodejs.org/api/sqlite.html",
    snippet: "SQLite is an experimental feature",
    domain: "nodejs.org",
    engines: ["duckduckgo", "brave"],
    sourceType: "documentation",
    publishedAt: "2026-06-01T00:00:00.000Z",
    serverScore: 0.91,
    trustZone: "public_web",
    ...overrides,
  };
}

/// 一篇已抓取文档；contentRef 指向 blob 存储，正文本身不进 SQLite。
export function fixtureDocument(overrides: Partial<ResearchDocument> = {}): ResearchDocument {
  const contentHash = overrides.contentHash ?? fixtureHash("doc1");
  return {
    documentId: "doc-1",
    candidateId: "cand-1",
    source: {
      sourceType: "documentation",
      trustZone: "public_web",
      locator: "https://nodejs.org/api/sqlite.html",
      title: "node:sqlite docs",
      domain: "nodejs.org",
      publishedAt: "2026-06-01T00:00:00.000Z",
    },
    title: "node:sqlite docs",
    canonicalUrl: "https://nodejs.org/api/sqlite.html",
    contentHash,
    simhash: "ff00aa11",
    mediaType: "text/html",
    fetchMethod: "http",
    fetchedAt: "2026-07-25T00:01:30.000Z",
    publishedAt: "2026-06-01T00:00:00.000Z",
    contentRef: `blob:${contentHash}`,
    textLength: 4096,
    policy: DEFAULT_SOURCE_POLICIES.public_web,
    ...overrides,
  };
}

/// 一个证据片段。text 是正文，**只应出现在 detail === "evidence"** 的读取路径上。
export function fixtureChunk(overrides: Partial<EvidenceChunk> = {}): EvidenceChunk {
  return {
    chunkId: "chunk-1",
    documentId: "doc-1",
    page: 1,
    startOffset: 0,
    endOffset: 42,
    headingPath: ["node:sqlite", "DatabaseSync"],
    text: "DatabaseSync 提供同步的 SQLite 连接。",
    textHash: fixtureHash("chunk1"),
    objectiveScore: 0.82,
    subquestionScores: { "sq-1": 0.9, "sq-2": 0.3 },
    trustZone: "public_web",
    ...overrides,
  };
}

/// 一个近重复簇。
export function fixtureCluster(overrides: Partial<DuplicateCluster> = {}): DuplicateCluster {
  return {
    clusterId: "cluster-1",
    representativeHash: fixtureHash("doc1"),
    memberHashes: [fixtureHash("doc1"), fixtureHash("doc2")],
    ...overrides,
  };
}

/// 一条子问题覆盖度评估。
export function fixtureCoverage(overrides: Partial<CoverageReport> = {}): CoverageReport {
  return {
    subquestionId: "sq-1",
    status: "weak",
    sourceCount: 1,
    independentDomainCount: 1,
    primarySourceCount: 1,
    contradictionCount: 0,
    averageRelevance: 0.82,
    bestChunkIds: ["chunk-1"],
    missing: ["缺少第二个独立来源"],
    ...overrides,
  };
}

/// 一条引用。
export function fixtureCitation(overrides: Partial<CitationRef> = {}): CitationRef {
  return {
    chunkId: "chunk-1",
    documentId: "doc-1",
    title: "node:sqlite docs",
    url: "https://nodejs.org/api/sqlite.html",
    page: 1,
    retrievedAt: "2026-07-25T00:01:30.000Z",
    textHash: fixtureHash("chunk1"),
    ...overrides,
  };
}

/// 一份最终报告（citations 由 insertCitations 单独落库，见 research-repository.ts 注释）。
export function fixtureReport(overrides: Partial<ResearchReport> = {}): ResearchReport {
  return {
    markdown: "# 结论\n\nnode:sqlite 可用但仍是实验特性。",
    citations: [fixtureCitation()],
    unsupportedSections: ["风险展望"],
    generatedAt: "2026-07-25T00:05:00.000Z",
    ...overrides,
  };
}
