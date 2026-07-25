// ResearchRepository 的内存实现。
//
// **定位：这是 P5/P7 上层编排（Orchestrator / Facade）的测试接缝。** 有了它，编排逻辑的单测
// 不需要真 SQLite，就能在系统 Node 20 的默认测试轮里跑（`node:sqlite` 只存在于 Electron 内嵌
// 的 Node 22，见 vitest.config.ts 的说明）。
//
// 因此它必须与 SqliteResearchRepository **语义一致**，尤其是这两点：
// - 原子性：commitOperation 的 apply 抛错时不留任何部分写入（用整状态快照 + 回滚模拟事务）；
// - 隔离性：读出去的对象是深拷贝，调用方就地改写不会污染仓储内部状态（SQLite 天然如此）。
// 两套实现共用 repository-fixtures.ts 的样例，contract 差异会在测试里直接暴露。
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
  ResearchBudget,
  ResearchDetailLevel,
  ResearchOutputRequest,
  ResearchPlan,
  ResearchReport,
  ResearchRound,
  ResearchSessionStatus,
  ResearchSessionSummary,
  ResearchSessionView,
  SourceScope,
} from "@cortex-work/core/research/types";
import {
  EMPTY_BUDGET_SPEND,
  type BeginOperationInput,
  type CreateSessionInput,
  type PendingOperation,
  type RepositoryTx,
  type ResearchBudgetSpend,
  type ResearchOperationKind,
  type ResearchRepository,
  type ResearchSessionQuery,
} from "./research-repository";

/// 单个 Session 的全部内存状态。字段划分刻意对齐 SQLite 的表，
/// 让「内存版漏实现了某张表」这类偏差在读写路径上立刻可见。
interface SessionRecord {
  summary: ResearchSessionSummary;
  userScope: string;
  sourceScopes: readonly SourceScope[];
  output: ResearchOutputRequest;
  budget: ResearchBudget;
  budgetSpend: ResearchBudgetSpend;
  plan?: ResearchPlan;
  rounds: ResearchRound[];
  queries: { query: PlannedQuery; roundIndex: number | null }[];
  candidates: { candidate: SearchCandidate; roundIndex: number }[];
  documents: ResearchDocument[];
  chunks: EvidenceChunk[];
  clusters: DuplicateCluster[];
  coverage: { roundIndex: number; report: CoverageReport }[];
  /// 报告正文；引用单独存 citations（与 SQLite 的 research_reports / citation_links 分表一致）。
  report?: ResearchReport;
  citations: CitationRef[];
}

interface OperationRecord {
  operationId: string;
  sessionId: string;
  kind: ResearchOperationKind;
  requestPayloadHash: string;
  createdAt: string;
  committedAt: string | null;
  retryable: boolean;
}

interface RepositoryState {
  sessions: Record<string, SessionRecord>;
  operations: Record<string, OperationRecord>;
}

/// 深拷贝。structuredClone 在 Node 18+ 是全局可用的，且能正确处理嵌套数组/对象；
/// 用它而不是 JSON 往返，是为了不把 undefined 字段悄悄抹平成"键不存在"以外的行为差异。
function clone<T>(value: T): T {
  return structuredClone(value);
}

/// ResearchRepository 的内存实现（测试替身，也可用于一次性 dry-run）。
export class InMemoryResearchRepository implements ResearchRepository {
  private state: RepositoryState = { sessions: {}, operations: {} };

  async createSession(input: CreateSessionInput): Promise<ResearchSessionSummary> {
    if (this.state.sessions[input.sessionId]) {
      throw new Error(`session 已存在: ${input.sessionId}`);
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const summary: ResearchSessionSummary = {
      sessionId: input.sessionId,
      consumer: input.consumer,
      objective: input.objective,
      mode: input.mode,
      status: input.status ?? "created",
      createdAt,
      updatedAt: createdAt,
      roundCount: 0,
      documentCount: 0,
      chunkCount: 0,
    };
    this.state.sessions[input.sessionId] = {
      summary,
      userScope: input.userScope,
      sourceScopes: clone(input.sourceScopes),
      output: clone(input.output),
      budget: clone(input.budget),
      budgetSpend: { ...EMPTY_BUDGET_SPEND },
      rounds: [],
      queries: [],
      candidates: [],
      documents: [],
      chunks: [],
      clusters: [],
      coverage: [],
      citations: [],
    };
    return clone(summary);
  }

  async getSession(sessionId: string, detail: ResearchDetailLevel): Promise<ResearchSessionView | null> {
    const record = this.state.sessions[sessionId];
    if (!record) return null;

    // summary 层级只回元数据：不带计划、不带轮次、不带任何正文（spec §19.3.2）。
    const view: ResearchSessionView = {
      summary: clone(record.summary),
      output: clone(record.output),
      sourceScopes: clone(record.sourceScopes),
    };
    if (detail === "summary") return view;

    if (record.plan) view.plan = clone(record.plan);
    view.rounds = clone(record.rounds);
    view.coverage = [...record.coverage]
      .sort((a, b) => a.roundIndex - b.roundIndex || a.report.subquestionId.localeCompare(b.report.subquestionId))
      .map((entry) => clone(entry.report));
    if (record.report) {
      view.report = { ...clone(record.report), citations: clone(record.citations) };
    }
    if (detail === "full") return view;

    view.documents = clone(record.documents);
    view.chunks = clone(record.chunks);
    return view;
  }

  async listSessions(filter: ResearchSessionQuery = {}): Promise<ResearchSessionSummary[]> {
    let rows = Object.values(this.state.sessions).map((r) => r.summary);
    if (filter.consumer) rows = rows.filter((s) => s.consumer === filter.consumer);
    if (filter.status) rows = rows.filter((s) => s.status === filter.status);
    if (filter.statuses && filter.statuses.length > 0) {
      const allowed = new Set<ResearchSessionStatus>(filter.statuses);
      rows = rows.filter((s) => allowed.has(s.status));
    }
    if (filter.before) rows = rows.filter((s) => s.updatedAt < filter.before!);
    rows = rows.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.sessionId.localeCompare(a.sessionId),
    );
    if (Number.isInteger(filter.limit) && (filter.limit ?? 0) > 0) rows = rows.slice(0, filter.limit);
    return rows.map(clone);
  }

  async updateSessionStatus(
    sessionId: string,
    status: ResearchSessionStatus,
    errorMessage?: string,
    updatedAt?: string,
  ): Promise<void> {
    const record = this.state.sessions[sessionId];
    if (!record) throw new Error(`未知 session: ${sessionId}`);
    record.summary.status = status;
    record.summary.updatedAt = updatedAt ?? new Date().toISOString();
    // errorMessage 缺省即清空：与 SQLite 版的 `SET error_message = ?` 一致，
    // 否则一次失败留下的旧文案会跟着 Session 一路带到 completed。
    if (errorMessage === undefined) delete record.summary.errorMessage;
    else record.summary.errorMessage = errorMessage;
  }

  async deleteSession(sessionId: string): Promise<void> {
    delete this.state.sessions[sessionId];
    for (const [id, op] of Object.entries(this.state.operations)) {
      if (op.sessionId === sessionId) delete this.state.operations[id];
    }
  }

  async savePlan(sessionId: string, plan: ResearchPlan): Promise<void> {
    const record = this.requireSession(sessionId);
    record.plan = clone(plan);
    // 与 SQLite 版一致：重规划整体替换初始查询（round_index IS NULL 的那批），各轮补充查询不动。
    record.queries = record.queries.filter((q) => q.roundIndex !== null);
    record.queries.push(...plan.initialQueries.map((query) => ({ query: clone(query), roundIndex: null })));
  }

  async beginOperation(input: BeginOperationInput): Promise<void> {
    // 外键语义：SQLite 版会因 FK 约束失败，内存版必须同样拒绝，否则编排层的错误
    // 会在替身上被吞掉、只在生产环境暴露。
    this.requireSession(input.sessionId);
    if (this.state.operations[input.operationId]) {
      throw new Error(`operation 已存在: ${input.operationId}`);
    }
    this.state.operations[input.operationId] = {
      operationId: input.operationId,
      sessionId: input.sessionId,
      kind: input.kind,
      requestPayloadHash: input.requestPayloadHash,
      createdAt: input.createdAt ?? new Date().toISOString(),
      committedAt: null,
      retryable: false,
    };
  }

  async commitOperation(
    operationId: string,
    apply: (tx: RepositoryTx) => void,
    committedAt?: string,
  ): Promise<void> {
    const op = this.state.operations[operationId];
    if (!op) throw new Error(`未知的 operation: ${operationId}`);
    if (op.committedAt !== null) throw new Error(`operation 已提交，不可重复提交: ${operationId}`);
    const at = committedAt ?? new Date().toISOString();
    const record = this.requireSession(op.sessionId);

    // 事务模拟：整状态快照 + 失败整体还原。粗暴但语义等价于 SQLite 的 ROLLBACK，
    // 而且不可能漏掉某个"忘了回滚"的字段——这正是替身最容易出错的地方。
    const snapshot = clone(this.state);
    try {
      apply(new InMemoryRepositoryTx(record, at));
      op.committedAt = at;
      op.retryable = false;
      record.summary.updatedAt = at;
    } catch (err) {
      this.state = snapshot;
      throw err;
    }
  }

  async listPendingOperations(sessionId?: string): Promise<PendingOperation[]> {
    return Object.values(this.state.operations)
      .filter((op) => op.committedAt === null && (sessionId === undefined || op.sessionId === sessionId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.operationId.localeCompare(b.operationId))
      .map((op) => ({
        operationId: op.operationId,
        sessionId: op.sessionId,
        kind: op.kind,
        requestPayloadHash: op.requestPayloadHash,
        createdAt: op.createdAt,
        retryable: op.retryable,
      }));
  }

  async markOperationRetryable(operationId: string): Promise<void> {
    const op = this.state.operations[operationId];
    if (op && op.committedAt === null) op.retryable = true;
  }

  async findDocumentByContentHash(contentHash: string, userScope: string): Promise<ResearchDocument | null> {
    // KTD9：必须同时匹配 userScope，跨用户绝不复用。
    const matches = Object.values(this.state.sessions)
      .filter((record) => record.userScope === userScope)
      .flatMap((record) => record.documents)
      .filter((doc) => doc.contentHash === contentHash)
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
    return matches.length > 0 ? clone(matches[0]!) : null;
  }

  async getBudgetSpend(sessionId: string): Promise<ResearchBudgetSpend> {
    const record = this.state.sessions[sessionId];
    return record ? { ...record.budgetSpend } : { ...EMPTY_BUDGET_SPEND };
  }

  async listReferencedContentHashes(): Promise<Set<string>> {
    const hashes = new Set<string>();
    for (const record of Object.values(this.state.sessions)) {
      for (const doc of record.documents) hashes.add(doc.contentHash);
    }
    return hashes;
  }

  close(): void {
    // 内存实现没有需要释放的句柄；保留方法只为契约对齐。
  }

  private requireSession(sessionId: string): SessionRecord {
    const record = this.state.sessions[sessionId];
    if (!record) throw new Error(`未知 session: ${sessionId}`);
    return record;
  }
}

/// 内存版的提交写入面。所有方法同步执行，直接改 SessionRecord；
/// 失败回滚由 commitOperation 的快照还原负责（见上）。
class InMemoryRepositoryTx implements RepositoryTx {
  constructor(
    private readonly record: SessionRecord,
    private readonly at: string,
  ) {}

  insertRound(round: ResearchRound): void {
    this.record.rounds.push(clone(round));
    this.record.summary.roundCount += 1;
    this.touch();
  }

  insertQueries(queries: readonly PlannedQuery[], roundIndex: number | null): void {
    this.record.queries.push(...queries.map((query) => ({ query: clone(query), roundIndex })));
  }

  insertCandidates(candidates: readonly SearchCandidate[], roundIndex: number): void {
    this.record.candidates.push(...candidates.map((candidate) => ({ candidate: clone(candidate), roundIndex })));
  }

  insertDocuments(documents: readonly ResearchDocument[]): void {
    this.record.documents.push(...documents.map(clone));
    this.record.summary.documentCount += documents.length;
    this.touch();
  }

  insertChunks(chunks: readonly EvidenceChunk[]): void {
    this.record.chunks.push(...chunks.map(clone));
    this.record.summary.chunkCount += chunks.length;
    this.touch();
  }

  insertDuplicateClusters(clusters: readonly DuplicateCluster[]): void {
    for (const cluster of clusters) {
      const existing = this.record.clusters.findIndex((c) => c.clusterId === cluster.clusterId);
      if (existing >= 0) this.record.clusters[existing] = clone(cluster);
      else this.record.clusters.push(clone(cluster));
    }
  }

  upsertCoverage(roundIndex: number, reports: readonly CoverageReport[]): void {
    for (const report of reports) {
      const existing = this.record.coverage.findIndex(
        (c) => c.roundIndex === roundIndex && c.report.subquestionId === report.subquestionId,
      );
      const entry = { roundIndex, report: clone(report) };
      if (existing >= 0) this.record.coverage[existing] = entry;
      else this.record.coverage.push(entry);
    }
  }

  insertReport(report: ResearchReport): void {
    // 引用不随报告一起存：它们由 insertCitations 单独整体替换（与 SQLite 分表一致）。
    this.record.report = { ...clone(report), citations: [] };
  }

  insertCitations(citations: readonly CitationRef[]): void {
    this.record.citations = citations.map(clone);
  }

  consumeBudget(delta: Partial<ResearchBudgetSpend>): void {
    for (const key of Object.keys(EMPTY_BUDGET_SPEND) as (keyof ResearchBudgetSpend)[]) {
      this.record.budgetSpend[key] += delta[key] ?? 0;
    }
    this.touch();
  }

  private touch(): void {
    this.record.summary.updatedAt = this.at;
  }
}
