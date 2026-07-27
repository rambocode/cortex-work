// CRE 的持久化仓储：接口契约 + SQLite 实现（spec §9.1、§13.2、§19.3.2）。
//
// 三条不可让步的约束，改这个文件前先读一遍：
//
// 1. **原子提交边界（spec §9.1）**：一轮的 round / candidates / documents / chunks / coverage /
//    report / citations / 预算消耗必须在**同一个 SQLite 事务**里写完，要么全成要么全不成。
//    这就是 RepositoryTx 全部方法都是**同步**的原因——它们只在 driver.transaction() 的同步回调里
//    被调用，回调内不允许出现任何 await（见 sqlite-driver.ts 的 transaction 注释）。
//    「Worker 返回后先改内存状态再异步落盘」是被明确禁止的写法。
//
// 2. **summary 不含正文（spec §19.3.2 / §19.4）**：getSession(id, "summary") 只读
//    research_sessions 一张表，绝不 join document_chunks、不读 research_reports、不碰 blob。
//    1000 篇文档的 Session 取 summary 必须是一次单行查询。计数列因此是刻意冗余的。
//
// 3. **跨 Session 复用要带 userScope（KTD9）**：findDocumentByContentHash 必须同时按
//    (content_hash, user_scope) 命中，否则换个账号就能读到上一位用户抓取的内容。
//
// 内存替身见 ./repository-memory（P5/P7 上层编排的测试接缝，语义必须与本文件一致）。
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
  ResearchConsumer,
  ResearchDetailLevel,
  ResearchMode,
  ResearchOutputRequest,
  ResearchPlan,
  ResearchReport,
  ResearchRound,
  ResearchSessionFilter,
  ResearchSessionStatus,
  ResearchSessionSummary,
  ResearchSessionView,
  SourceScope,
} from "@cortex-work/core/research/types";
import type { KnowledgeItem, MemoryCandidate } from "@cortex-work/core/research/knowledge";
import type { SqlValue, SqliteDriver } from "./sqlite-driver";
// 行类型与「行 → 领域对象」映射拆到独立文件，本文件只留查询与事务逻辑（见 repository-rows.ts 头注）。
import {
  jsonOrNull,
  parseJson,
  rowToChunk,
  rowToCoverage,
  rowToDocument,
  rowToPlan,
  rowToReport,
  rowToRound,
  rowToSummary,
  toSql,
  type ChunkRow,
  type CitationRow,
  type CoverageRow,
  type DocumentRow,
  type OperationRow,
  type PlanRow,
  type QueryRow,
  type ReportRow,
  type RoundRow,
  type SessionRow,
  type SubquestionRow,
} from "./repository-rows";

// ---------------------------------------------------------------------------
// 接口契约
// ---------------------------------------------------------------------------

/// 一次外部调用的种类（spec §9.1 的 operation）。有限枚举而非自由文本：
/// 崩溃恢复要据此决定「这条未提交的操作该怎么重试」。
export type ResearchOperationKind = "plan" | "search" | "fetch" | "evaluate" | "report";

/// 建 Session 的入参。createdAt 可注入，缺省取系统时钟——仓储不是时钟的真源，
/// 但也不该逼每个调用方都传一遍。
export interface CreateSessionInput {
  sessionId: string;
  consumer: ResearchConsumer;
  objective: string;
  mode: ResearchMode;
  sourceScopes: readonly SourceScope[];
  output: ResearchOutputRequest;
  budget: ResearchBudget;
  /// KTD9 的隔离键（当前用户/工作区）。跨 Session 复用查询必须带上它。
  userScope: string;
  /// 会话归属的项目 id；缺省表示不使用项目（报告归档落 Documents）。
  /// 仓储只存 id 不存路径：路径在归档时刻按 id 现查，项目被删就自动退回 Documents。
  projectId?: string;
  status?: ResearchSessionStatus;
  createdAt?: string;
}

/// listSessions 的筛选条件。在 core 的 ResearchSessionFilter 之上多一个 statuses：
/// 启动恢复要一次取出全部 5 个非终态，逐个状态查 5 次既啰嗦又容易漏分页。
export interface ResearchSessionQuery extends ResearchSessionFilter {
  statuses?: readonly ResearchSessionStatus[];
}

/// 登记一次待提交操作的入参。requestPayloadHash 用于崩溃恢复时判断
/// 「重试请求与原请求是否一致」，避免重复发出一次已经生效的副作用调用。
export interface BeginOperationInput {
  sessionId: string;
  operationId: string;
  kind: ResearchOperationKind;
  requestPayloadHash: string;
  createdAt?: string;
}

/// 一条尚未提交的操作。retryable 由启动恢复置位（见 ./startup-recovery）。
export interface PendingOperation {
  operationId: string;
  sessionId: string;
  kind: ResearchOperationKind;
  requestPayloadHash: string;
  createdAt: string;
  retryable: boolean;
}

/// Session 的预算实际消耗。与 ResearchBudget 的上限逐项对应，
/// 编排层用「上限 - 消耗」判断还能不能再跑一轮。
export interface ResearchBudgetSpend {
  rounds: number;
  queries: number;
  candidates: number;
  documents: number;
  browserFetches: number;
  evidenceCharsToModel: number;
  durationMs: number;
}

/// 全零的预算消耗基线。
export const EMPTY_BUDGET_SPEND: ResearchBudgetSpend = {
  rounds: 0,
  queries: 0,
  candidates: 0,
  documents: 0,
  browserFetches: 0,
  evidenceCharsToModel: 0,
  durationMs: 0,
};

/// 提交事务内的同步写入面（spec §9.1）。
///
/// **每个方法都必须是同步的、且只能在 commitOperation 的 apply 回调里被调用。**
/// 返回 void 而不是写入结果，是为了杜绝「拿到 id 再去 await 点什么」的写法——
/// 那会让写入跨出事务边界。
export interface RepositoryTx {
  insertRound(round: ResearchRound): void;
  /// 写入本轮新增的查询；roundIndex 为 null 表示初始计划里的查询。
  insertQueries(queries: readonly PlannedQuery[], roundIndex: number | null): void;
  insertCandidates(candidates: readonly SearchCandidate[], roundIndex: number): void;
  insertDocuments(documents: readonly ResearchDocument[]): void;
  insertChunks(chunks: readonly EvidenceChunk[]): void;
  insertDuplicateClusters(clusters: readonly DuplicateCluster[]): void;
  /// 覆盖度按 (round, subquestion) 幂等写入：同一轮重算会覆盖而不是堆叠。
  upsertCoverage(roundIndex: number, reports: readonly CoverageReport[]): void;
  /// 写报告正文；一个 Session 只有一份报告，重生成即覆盖。
  insertReport(report: ResearchReport): void;
  /// 写本 Session 的引用集合，**整体替换**旧集合——报告重生成后旧引用必须一起消失，
  /// 否则会出现「报告里没有、citation_links 里还有」的幽灵引用。
  insertCitations(citations: readonly CitationRef[]): void;
  /// 累加预算消耗（增量语义，不是覆盖）。
  consumeBudget(delta: Partial<ResearchBudgetSpend>): void;
}

/// CRE 的持久化契约。两套实现：SqliteResearchRepository（生产）与
/// InMemoryResearchRepository（上层编排的测试替身）。
export interface ResearchRepository {
  createSession(input: CreateSessionInput): Promise<ResearchSessionSummary>;
  /// 按 detail 逐级返回；不存在返回 null。summary 层级绝不读取任何正文。
  getSession(sessionId: string, detail: ResearchDetailLevel): Promise<ResearchSessionView | null>;
  listSessions(filter?: ResearchSessionQuery): Promise<ResearchSessionSummary[]>;
  /// 不做状态机校验：转移合法性属编排层职责（core/research/session-status 的 canTransition），
  /// 而启动恢复要写入由 statusOnAppRestart 归一出来的状态，仓储在这里必须是"听话"的。
  updateSessionStatus(
    sessionId: string,
    status: ResearchSessionStatus,
    errorMessage?: string,
    updatedAt?: string,
  ): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  /// 记录报告归档后的落盘路径（v5）。归档发生在报告落库与 done 之后
  /// （research-service.archiveReport），故单独 UPDATE 而非并入 insertReport 事务；
  /// 报告不存在时静默 no-op（归档前置判断已保证有报告，这里只防御竞态删除）。
  setReportArchivedPath(sessionId: string, archivedPath: string): Promise<void>;
  savePlan(sessionId: string, plan: ResearchPlan): Promise<void>;
  beginOperation(input: BeginOperationInput): Promise<void>;
  /// 在一个事务里执行 apply 并把操作标记为已提交。apply 抛错时整笔回滚，
  /// 操作保持 pending，崩溃恢复会重试它。
  commitOperation(
    operationId: string,
    apply: (tx: RepositoryTx) => void,
    committedAt?: string,
  ): Promise<void>;
  listPendingOperations(sessionId?: string): Promise<PendingOperation[]>;
  markOperationRetryable(operationId: string): Promise<void>;
  findDocumentByContentHash(contentHash: string, userScope: string): Promise<ResearchDocument | null>;
  getBudgetSpend(sessionId: string): Promise<ResearchBudgetSpend>;
  /// 仍被引用的正文哈希全集，是 blob GC 的输入（spec §19.3.4）。
  listReferencedContentHashes(): Promise<Set<string>>;

  // ── U10：Knowledge 与 Memory 候选 ─────────────────────────────────────────
  //
  // KTD10 红线：候选**必须**经用户逐条批准（status='approved'）才允许进入 Memory。
  // 仓储层只负责存取与状态流转，绝不自己把任何候选标成 approved。

  /// 写入一批知识条目与由它们派生的候选（同一事务）。
  /// 重复调用按主键 upsert：同一份报告重复沉淀不该产生重复候选。
  saveKnowledgeAndCandidates(input: {
    sessionId: string;
    items: readonly KnowledgeItem[];
    candidates: readonly MemoryCandidate[];
  }): Promise<void>;
  /// 列出候选（按状态筛选；缺省列全部）。附带派生它的知识条目，供 UI 展示来源。
  listMemoryCandidates(status?: MemoryCandidate["status"]): Promise<MemoryCandidateView[]>;
  /// 流转候选状态（批准 / 拒绝 / 撤销 / 标记过期）。
  /// approvedAt 只在转入 approved 时写；转出时保留原值（撤销后仍要知道当初何时批的）。
  updateMemoryCandidateStatus(
    candidateId: string,
    status: MemoryCandidate["status"],
    at?: string,
  ): Promise<void>;

  close(): void;
}

/// 候选 + 它所依据的知识条目（UI 展示与写入 Memory 都要这两样）。
export interface MemoryCandidateView {
  candidate: MemoryCandidate;
  knowledge: KnowledgeItem | null;
}

// ---------------------------------------------------------------------------
// SQLite 实现
// ---------------------------------------------------------------------------

/// 基于注入 SqliteDriver 的仓储实现。driver 由外部创建并注入（spec §13.2），
/// 因此本类本身完全不知道 node:sqlite 的存在，可以被任意替身 driver 驱动。
export class SqliteResearchRepository implements ResearchRepository {
  constructor(private readonly driver: SqliteDriver) {}

  async createSession(input: CreateSessionInput): Promise<ResearchSessionSummary> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const status = input.status ?? "created";
    this.driver
      .prepare(
        `INSERT INTO research_sessions
           (session_id, consumer, objective, mode, status, user_scope,
            source_scopes_json, output_json, budget_json, budget_spent_json,
            error_message, project_id, created_at, updated_at, round_count, document_count, chunk_count)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0)`,
      )
      .run([
        input.sessionId,
        input.consumer,
        input.objective,
        input.mode,
        status,
        input.userScope,
        JSON.stringify(input.sourceScopes),
        JSON.stringify(input.output),
        JSON.stringify(input.budget),
        JSON.stringify(EMPTY_BUDGET_SPEND),
        null,
        toSql(input.projectId),
        createdAt,
        createdAt,
      ]);
    return {
      sessionId: input.sessionId,
      consumer: input.consumer,
      objective: input.objective,
      mode: input.mode,
      status,
      createdAt,
      updatedAt: createdAt,
      roundCount: 0,
      documentCount: 0,
      chunkCount: 0,
    };
  }

  async getSession(sessionId: string, detail: ResearchDetailLevel): Promise<ResearchSessionView | null> {
    // 单行查询，只碰 research_sessions —— summary 路径的隐私红线（spec §19.3.2）。
    const row = this.driver
      .prepare("SELECT * FROM research_sessions WHERE session_id = ?")
      .get<SessionRow>([sessionId]);
    if (!row) return null;

    const view: ResearchSessionView = { summary: rowToSummary(row) };
    // 项目归属只进 view 不进 summary（隐私红线，与下面的 output/sourceScopes 同一条先例）。
    // 有值才赋值：老库的 NULL 要读回 undefined 而不是 null，否则归档逻辑会把它当「有项目」。
    if (row.project_id !== null && row.project_id !== undefined) {
      view.projectId = row.project_id;
    }
    // output 在 summary 层级就解出来：它只是一小段 JSON（格式/字数/是否强制引用），
    // 不涉及正文，不违反「summary 路径不读正文」的隐私红线。
    // 解析失败**只是丢掉这个字段**而不是让整次 getSession 失败：旧数据或人工改坏的行
    // 不该让一个 Session 彻底打不开，报告生成会退回按模式分档的默认预算。
    try {
      view.output = parseJson<ResearchOutputRequest>(row.output_json);
    } catch {
      // 忽略：调用方按 output 缺省处理。
    }
    try {
      view.sourceScopes = parseJson<SourceScope[]>(row.source_scopes_json);
    } catch {
      // 同上：坏数据只丢字段，不让整次 getSession 失败。
    }
    if (detail === "summary") return view;

    const plan = this.readPlan(sessionId);
    if (plan) view.plan = plan;
    view.rounds = this.readRounds(sessionId);
    view.coverage = this.readCoverage(sessionId);
    const report = this.readReport(sessionId);
    if (report) view.report = report;
    if (detail === "full") return view;

    view.documents = this.readDocuments(sessionId);
    view.chunks = this.readChunks(sessionId);
    return view;
  }

  async listSessions(filter: ResearchSessionQuery = {}): Promise<ResearchSessionSummary[]> {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.consumer) {
      where.push("consumer = ?");
      params.push(filter.consumer);
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      where.push(`status IN (${filter.statuses.map(() => "?").join(",")})`);
      params.push(...filter.statuses);
    }
    if (filter.before) {
      where.push("updated_at < ?");
      params.push(filter.before);
    }
    // limit 走参数化而非字符串拼接；负数/非整数按"无限制"处理（-1 是 SQLite 的无限制约定）。
    const limit = Number.isInteger(filter.limit) && (filter.limit ?? 0) > 0 ? filter.limit! : -1;
    const sql =
      "SELECT * FROM research_sessions" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY updated_at DESC, session_id DESC LIMIT ?";
    return this.driver.prepare(sql).all<SessionRow>([...params, limit]).map(rowToSummary);
  }

  async updateSessionStatus(
    sessionId: string,
    status: ResearchSessionStatus,
    errorMessage?: string,
    updatedAt?: string,
  ): Promise<void> {
    this.driver
      .prepare("UPDATE research_sessions SET status = ?, error_message = ?, updated_at = ? WHERE session_id = ?")
      .run([status, toSql(errorMessage), updatedAt ?? new Date().toISOString(), sessionId]);
  }

  async deleteSession(sessionId: string): Promise<void> {
    // 子表全部 ON DELETE CASCADE（migrations.ts），且建库时开了 PRAGMA foreign_keys，
    // 因此一条 DELETE 就能清空整条证据链。
    this.driver.prepare("DELETE FROM research_sessions WHERE session_id = ?").run([sessionId]);
  }

  async setReportArchivedPath(sessionId: string, archivedPath: string): Promise<void> {
    // 报告行不存在时 UPDATE 影响 0 行,即接口约定的静默 no-op。
    this.driver
      .prepare("UPDATE research_reports SET archived_path = ? WHERE session_id = ?")
      .run([archivedPath, sessionId]);
  }

  async savePlan(sessionId: string, plan: ResearchPlan): Promise<void> {
    this.driver.transaction(() => {
      const now = new Date().toISOString();
      this.driver
        .prepare(
          `INSERT INTO research_plans (session_id, schema_version, objective, scope_json, budget_json, completion_json, created_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(session_id) DO UPDATE SET
             schema_version = excluded.schema_version, objective = excluded.objective,
             scope_json = excluded.scope_json, budget_json = excluded.budget_json,
             completion_json = excluded.completion_json, created_at = excluded.created_at`,
        )
        .run([
          sessionId,
          plan.schemaVersion,
          plan.objective,
          JSON.stringify(plan.scope),
          JSON.stringify(plan.budget),
          JSON.stringify(plan.completion),
          now,
        ]);

      // 重规划时整体替换：留着旧子问题会让 Coverage 永远补不齐一个已经不存在的问题。
      this.driver.prepare("DELETE FROM research_subquestions WHERE session_id = ?").run([sessionId]);
      const insertSub = this.driver.prepare(
        "INSERT INTO research_subquestions (session_id, subquestion_id, text, rationale, position) VALUES (?,?,?,?,?)",
      );
      plan.subquestions.forEach((sub, index) => {
        insertSub.run([sessionId, sub.id, sub.text, toSql(sub.rationale), index]);
      });

      // 初始查询以 round_index IS NULL 标记；各轮补充查询不受影响。
      this.driver
        .prepare("DELETE FROM research_queries WHERE session_id = ? AND round_index IS NULL")
        .run([sessionId]);
      insertQueryRows(this.driver, sessionId, plan.initialQueries, null);
    });
  }

  async beginOperation(input: BeginOperationInput): Promise<void> {
    this.driver
      .prepare(
        `INSERT INTO research_operations (operation_id, session_id, kind, request_payload_hash, created_at, committed_at, retryable)
         VALUES (?,?,?,?,?,NULL,0)`,
      )
      .run([
        input.operationId,
        input.sessionId,
        input.kind,
        input.requestPayloadHash,
        input.createdAt ?? new Date().toISOString(),
      ]);
  }

  async commitOperation(
    operationId: string,
    apply: (tx: RepositoryTx) => void,
    committedAt?: string,
  ): Promise<void> {
    const at = committedAt ?? new Date().toISOString();
    const op = this.driver
      .prepare("SELECT session_id, committed_at FROM research_operations WHERE operation_id = ?")
      .get<{ session_id: string; committed_at: string | null }>([operationId]);
    if (!op) throw new Error(`未知的 operation: ${operationId}`);
    if (op.committed_at !== null) throw new Error(`operation 已提交，不可重复提交: ${operationId}`);

    // 整笔写入 + 标记 committed 在同一事务里（spec §9.1 第 4、5 步）。
    // apply 抛错 → ROLLBACK → operation 仍是 pending，崩溃恢复会重试它。
    this.driver.transaction(() => {
      apply(new SqliteRepositoryTx(this.driver, op.session_id, at));
      this.driver
        .prepare("UPDATE research_operations SET committed_at = ?, retryable = 0 WHERE operation_id = ?")
        .run([at, operationId]);
      this.driver
        .prepare("UPDATE research_sessions SET updated_at = ? WHERE session_id = ?")
        .run([at, op.session_id]);
    });
  }

  async listPendingOperations(sessionId?: string): Promise<PendingOperation[]> {
    const rows = sessionId
      ? this.driver
          .prepare(
            "SELECT * FROM research_operations WHERE session_id = ? AND committed_at IS NULL ORDER BY created_at, operation_id",
          )
          .all<OperationRow>([sessionId])
      : this.driver
          .prepare("SELECT * FROM research_operations WHERE committed_at IS NULL ORDER BY created_at, operation_id")
          .all<OperationRow>();
    return rows.map((row) => ({
      operationId: row.operation_id,
      sessionId: row.session_id,
      kind: row.kind as ResearchOperationKind,
      requestPayloadHash: row.request_payload_hash,
      createdAt: row.created_at,
      retryable: Number(row.retryable) === 1,
    }));
  }

  async markOperationRetryable(operationId: string): Promise<void> {
    this.driver
      .prepare("UPDATE research_operations SET retryable = 1 WHERE operation_id = ? AND committed_at IS NULL")
      .run([operationId]);
  }

  async findDocumentByContentHash(contentHash: string, userScope: string): Promise<ResearchDocument | null> {
    // KTD9：content_hash 与 user_scope 必须同时匹配；取最近抓取的一条。
    // 授权是否仍然有效（policy / TTL）由调用方用 canReuseAcrossSessions 再判一次，
    // 仓储不替它做策略决定。
    const row = this.driver
      .prepare(
        "SELECT * FROM research_documents WHERE content_hash = ? AND user_scope = ? ORDER BY fetched_at DESC LIMIT 1",
      )
      .get<DocumentRow>([contentHash, userScope]);
    return row ? rowToDocument(row) : null;
  }

  async getBudgetSpend(sessionId: string): Promise<ResearchBudgetSpend> {
    const row = this.driver
      .prepare("SELECT budget_spent_json FROM research_sessions WHERE session_id = ?")
      .get<{ budget_spent_json: string }>([sessionId]);
    if (!row) return { ...EMPTY_BUDGET_SPEND };
    return { ...EMPTY_BUDGET_SPEND, ...parseJson<Partial<ResearchBudgetSpend>>(row.budget_spent_json) };
  }

  async listReferencedContentHashes(): Promise<Set<string>> {
    return new Set(
      this.driver
        .prepare("SELECT DISTINCT content_hash FROM research_documents")
        .all<{ content_hash: string }>()
        .map((r) => r.content_hash),
    );
  }

  // ── U10：Knowledge 与 Memory 候选 ─────────────────────────────────────────

  async saveKnowledgeAndCandidates(input: {
    sessionId: string;
    items: readonly KnowledgeItem[];
    candidates: readonly MemoryCandidate[];
  }): Promise<void> {
    this.driver.transaction(() => {
      for (const item of input.items) {
        this.driver
          .prepare(
            `INSERT INTO knowledge_items
               (knowledge_id, session_id, subject, statement, confidence,
                citation_chunk_ids_json, trust_zones_json, valid_from, valid_until, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(knowledge_id) DO UPDATE SET
               subject = excluded.subject, statement = excluded.statement,
               confidence = excluded.confidence,
               citation_chunk_ids_json = excluded.citation_chunk_ids_json,
               trust_zones_json = excluded.trust_zones_json,
               valid_from = excluded.valid_from, valid_until = excluded.valid_until,
               updated_at = excluded.updated_at`,
          )
          .run([
            item.knowledgeId,
            input.sessionId,
            item.subject,
            item.statement,
            item.confidence,
            JSON.stringify(item.citationChunkIds),
            JSON.stringify(item.trustZones),
            item.validFrom ?? null,
            item.validUntil ?? null,
            item.createdAt,
            item.updatedAt,
          ]);
      }
      for (const candidate of input.candidates) {
        // **status 不进 ON CONFLICT 的 UPDATE 列表**：重复沉淀同一份报告时，
        // 用户已经批准/拒绝过的候选绝不能被重置回 pending——那等于让用户白批一次，
        // 更糟的是「已撤销」的条目会悄悄复活成待批。
        this.driver
          .prepare(
            `INSERT INTO memory_candidates
               (candidate_id, knowledge_id, scope, text, citation_chunk_ids_json, status, approved_at, created_at)
             VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT(candidate_id) DO UPDATE SET
               scope = excluded.scope, text = excluded.text,
               citation_chunk_ids_json = excluded.citation_chunk_ids_json`,
          )
          .run([
            candidate.candidateId,
            candidate.knowledgeId,
            candidate.scope,
            candidate.text,
            JSON.stringify(candidate.citationChunkIds),
            candidate.status,
            candidate.approvedAt ?? null,
            candidate.createdAt,
          ]);
      }
    });
  }

  async listMemoryCandidates(status?: MemoryCandidate["status"]): Promise<MemoryCandidateView[]> {
    const rows = status
      ? this.driver
          .prepare(
            `SELECT c.*, k.subject AS k_subject, k.statement AS k_statement, k.confidence AS k_confidence,
                    k.citation_chunk_ids_json AS k_chunks, k.trust_zones_json AS k_zones,
                    k.valid_from AS k_valid_from, k.valid_until AS k_valid_until,
                    k.created_at AS k_created_at, k.updated_at AS k_updated_at
               FROM memory_candidates c
               LEFT JOIN knowledge_items k ON k.knowledge_id = c.knowledge_id
              WHERE c.status = ?
              ORDER BY c.created_at DESC`,
          )
          .all([status])
      : this.driver
          .prepare(
            `SELECT c.*, k.subject AS k_subject, k.statement AS k_statement, k.confidence AS k_confidence,
                    k.citation_chunk_ids_json AS k_chunks, k.trust_zones_json AS k_zones,
                    k.valid_from AS k_valid_from, k.valid_until AS k_valid_until,
                    k.created_at AS k_created_at, k.updated_at AS k_updated_at
               FROM memory_candidates c
               LEFT JOIN knowledge_items k ON k.knowledge_id = c.knowledge_id
              ORDER BY c.created_at DESC`,
          )
          .all();
    return rows.map((row) => toMemoryCandidateView(row as Record<string, SqlValue>));
  }

  async updateMemoryCandidateStatus(
    candidateId: string,
    status: MemoryCandidate["status"],
    at: string = new Date().toISOString(),
  ): Promise<void> {
    // approved_at 只在转入 approved 时写；转出（拒绝/撤销）保留原值，
    // 撤销之后仍然要能回答「当初是什么时候批的」。
    this.driver
      .prepare(
        `UPDATE memory_candidates
            SET status = ?, approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END
          WHERE candidate_id = ?`,
      )
      .run([status, status, at, candidateId]);
  }

  close(): void {
    this.driver.close();
  }

  // ---- detail 层级的分段读取 -------------------------------------------------

  private readPlan(sessionId: string): ResearchPlan | null {
    const row = this.driver
      .prepare("SELECT * FROM research_plans WHERE session_id = ?")
      .get<PlanRow>([sessionId]);
    if (!row) return null;
    const subquestions = this.driver
      .prepare("SELECT * FROM research_subquestions WHERE session_id = ? ORDER BY position")
      .all<SubquestionRow>([sessionId]);
    // round_index IS NULL 即初始计划里的查询；各轮补充查询不属于 plan.initialQueries。
    const initialQueries = this.driver
      .prepare("SELECT * FROM research_queries WHERE session_id = ? AND round_index IS NULL ORDER BY position")
      .all<QueryRow>([sessionId]);
    return rowToPlan(row, subquestions, initialQueries);
  }

  private readRounds(sessionId: string): ResearchRound[] {
    return this.driver
      .prepare("SELECT * FROM research_rounds WHERE session_id = ? ORDER BY round_index")
      .all<RoundRow>([sessionId])
      .map(rowToRound);
  }

  private readCoverage(sessionId: string): CoverageReport[] {
    return this.driver
      .prepare("SELECT * FROM coverage_reports WHERE session_id = ? ORDER BY round_index, subquestion_id")
      .all<CoverageRow>([sessionId])
      .map(rowToCoverage);
  }

  private readReport(sessionId: string): ResearchReport | null {
    const row = this.driver
      .prepare("SELECT * FROM research_reports WHERE session_id = ?")
      .get<ReportRow>([sessionId]);
    if (!row) return null;
    const citations = this.driver
      .prepare("SELECT * FROM citation_links WHERE session_id = ? ORDER BY position")
      .all<CitationRow>([sessionId]);
    return rowToReport(row, citations);
  }

  private readDocuments(sessionId: string): ResearchDocument[] {
    return this.driver
      .prepare("SELECT * FROM research_documents WHERE session_id = ? ORDER BY fetched_at, document_id")
      .all<DocumentRow>([sessionId])
      .map(rowToDocument);
  }

  private readChunks(sessionId: string): EvidenceChunk[] {
    return this.driver
      .prepare("SELECT * FROM document_chunks WHERE session_id = ? ORDER BY position")
      .all<ChunkRow>([sessionId])
      .map(rowToChunk);
  }
}

// ---------------------------------------------------------------------------
// 提交事务内的写入面
// ---------------------------------------------------------------------------

/// RepositoryTx 的 SQLite 实现。**所有方法同步执行**，由 commitOperation 在
/// driver.transaction() 的回调里驱动；单独 new 出来在事务外调用是错误用法
///（那样每条 INSERT 都会自成一个隐式事务，原子性荡然无存）。
class SqliteRepositoryTx implements RepositoryTx {
  constructor(
    private readonly driver: SqliteDriver,
    private readonly sessionId: string,
    private readonly at: string,
  ) {}

  insertRound(round: ResearchRound): void {
    this.driver
      .prepare(
        `INSERT INTO research_rounds (session_id, round_index, started_at, ended_at, decision, query_ids_json, candidate_count, document_count, chunk_count)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run([
        this.sessionId,
        round.roundIndex,
        round.startedAt,
        toSql(round.endedAt),
        toSql(round.decision),
        JSON.stringify(round.queryIds),
        round.candidateCount,
        round.documentCount,
        round.chunkCount,
      ]);
    this.bumpCounters({ round_count: 1 });
  }

  insertQueries(queries: readonly PlannedQuery[], roundIndex: number | null): void {
    insertQueryRows(this.driver, this.sessionId, queries, roundIndex);
  }

  insertCandidates(candidates: readonly SearchCandidate[], roundIndex: number): void {
    const stmt = this.driver.prepare(
      `INSERT INTO search_candidates (candidate_id, session_id, query_id, round_index, title, url, canonical_url, snippet, domain, engines_json, source_type, published_at, server_score, trust_zone)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const c of candidates) {
      stmt.run([
        c.candidateId,
        this.sessionId,
        c.queryId,
        roundIndex,
        c.title,
        c.url,
        toSql(c.canonicalUrl),
        toSql(c.snippet),
        c.domain,
        JSON.stringify(c.engines),
        toSql(c.sourceType),
        toSql(c.publishedAt),
        c.serverScore,
        c.trustZone,
      ]);
    }
  }

  insertDocuments(documents: readonly ResearchDocument[]): void {
    // user_scope 从 Session 冗余下来：跨 Session 复用查询靠它做隔离（KTD9）。
    const userScope =
      this.driver
        .prepare("SELECT user_scope FROM research_sessions WHERE session_id = ?")
        .get<{ user_scope: string }>([this.sessionId])?.user_scope ?? "";
    const stmt = this.driver.prepare(
      `INSERT INTO research_documents (document_id, session_id, candidate_id, source_json, title, canonical_url, content_hash, simhash, media_type, fetch_method, fetched_at, published_at, content_ref, text_length, duplicate_of, policy_json, user_scope)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const d of documents) {
      stmt.run([
        d.documentId,
        this.sessionId,
        toSql(d.candidateId),
        JSON.stringify(d.source),
        d.title,
        toSql(d.canonicalUrl),
        d.contentHash,
        toSql(d.simhash),
        d.mediaType,
        d.fetchMethod,
        d.fetchedAt,
        toSql(d.publishedAt),
        d.contentRef,
        d.textLength,
        toSql(d.duplicateOf),
        JSON.stringify(d.policy),
        userScope,
      ]);
    }
    this.bumpCounters({ document_count: documents.length });
  }

  insertChunks(chunks: readonly EvidenceChunk[]): void {
    const base = this.chunkCount();
    const stmt = this.driver.prepare(
      `INSERT INTO document_chunks (chunk_id, session_id, document_id, page, start_offset, end_offset, heading_path_json, text, text_hash, objective_score, subquestion_scores_json, trust_zone, position)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    chunks.forEach((c, i) => {
      stmt.run([
        c.chunkId,
        this.sessionId,
        c.documentId,
        toSql(c.page),
        toSql(c.startOffset),
        toSql(c.endOffset),
        jsonOrNull(c.headingPath),
        c.text,
        c.textHash,
        c.objectiveScore,
        JSON.stringify(c.subquestionScores),
        c.trustZone,
        base + i,
      ]);
    });
    this.bumpCounters({ chunk_count: chunks.length });
  }

  insertDuplicateClusters(clusters: readonly DuplicateCluster[]): void {
    const stmt = this.driver.prepare(
      `INSERT INTO duplicate_clusters (cluster_id, session_id, representative_hash, member_hashes_json)
       VALUES (?,?,?,?)
       ON CONFLICT(cluster_id) DO UPDATE SET
         representative_hash = excluded.representative_hash,
         member_hashes_json = excluded.member_hashes_json`,
    );
    for (const cluster of clusters) {
      stmt.run([cluster.clusterId, this.sessionId, cluster.representativeHash, JSON.stringify(cluster.memberHashes)]);
    }
  }

  upsertCoverage(roundIndex: number, reports: readonly CoverageReport[]): void {
    const stmt = this.driver.prepare(
      `INSERT INTO coverage_reports (session_id, round_index, subquestion_id, status, source_count, independent_domain_count, primary_source_count, contradiction_count, average_relevance, best_chunk_ids_json, missing_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id, round_index, subquestion_id) DO UPDATE SET
         status = excluded.status, source_count = excluded.source_count,
         independent_domain_count = excluded.independent_domain_count,
         primary_source_count = excluded.primary_source_count,
         contradiction_count = excluded.contradiction_count,
         average_relevance = excluded.average_relevance,
         best_chunk_ids_json = excluded.best_chunk_ids_json, missing_json = excluded.missing_json`,
    );
    for (const r of reports) {
      stmt.run([
        this.sessionId,
        roundIndex,
        r.subquestionId,
        r.status,
        r.sourceCount,
        r.independentDomainCount,
        r.primarySourceCount,
        r.contradictionCount,
        r.averageRelevance,
        JSON.stringify(r.bestChunkIds),
        JSON.stringify(r.missing),
      ]);
    }
  }

  insertReport(report: ResearchReport): void {
    this.driver
      .prepare(
        `INSERT INTO research_reports (session_id, markdown, unsupported_sections_json, generated_at, generation_stats_json)
         VALUES (?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET
           markdown = excluded.markdown,
           unsupported_sections_json = excluded.unsupported_sections_json,
           generated_at = excluded.generated_at,
           generation_stats_json = excluded.generation_stats_json`,
      )
      .run([
        this.sessionId,
        report.markdown,
        JSON.stringify(report.unsupportedSections),
        report.generatedAt,
        report.generationStats ? JSON.stringify(report.generationStats) : null,
      ]);
  }

  insertCitations(citations: readonly CitationRef[]): void {
    // 整体替换：报告重生成后旧引用必须一起消失，否则会出现「报告里没有、citation_links 里还有」
    // 的幽灵引用，Citation Validator 的结果就不再是唯一真源。
    this.driver.prepare("DELETE FROM citation_links WHERE session_id = ?").run([this.sessionId]);
    const stmt = this.driver.prepare(
      `INSERT INTO citation_links (session_id, position, chunk_id, document_id, title, url, page, retrieved_at, text_hash)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    citations.forEach((c, i) => {
      stmt.run([
        this.sessionId,
        i,
        c.chunkId,
        c.documentId,
        c.title,
        toSql(c.url),
        toSql(c.page),
        c.retrievedAt,
        c.textHash,
      ]);
    });
  }

  consumeBudget(delta: Partial<ResearchBudgetSpend>): void {
    const row = this.driver
      .prepare("SELECT budget_spent_json FROM research_sessions WHERE session_id = ?")
      .get<{ budget_spent_json: string }>([this.sessionId]);
    const current: ResearchBudgetSpend = {
      ...EMPTY_BUDGET_SPEND,
      ...(row ? parseJson<Partial<ResearchBudgetSpend>>(row.budget_spent_json) : {}),
    };
    const next = { ...current };
    for (const key of Object.keys(EMPTY_BUDGET_SPEND) as (keyof ResearchBudgetSpend)[]) {
      next[key] = current[key] + (delta[key] ?? 0);
    }
    this.driver
      .prepare("UPDATE research_sessions SET budget_spent_json = ?, updated_at = ? WHERE session_id = ?")
      .run([JSON.stringify(next), this.at, this.sessionId]);
  }

  /// 累加冗余计数列。summary 不允许 join 证据表，所以计数只能在写入时同步维护；
  /// 因为与证据写入同处一个事务，两者不存在漂移窗口。
  private bumpCounters(delta: { round_count?: number; document_count?: number; chunk_count?: number }): void {
    this.driver
      .prepare(
        `UPDATE research_sessions
            SET round_count = round_count + ?, document_count = document_count + ?, chunk_count = chunk_count + ?, updated_at = ?
          WHERE session_id = ?`,
      )
      .run([delta.round_count ?? 0, delta.document_count ?? 0, delta.chunk_count ?? 0, this.at, this.sessionId]);
  }

  /// 本 Session 已有的 chunk 条数，用作新 chunk 的 position 起点（保证读回顺序稳定）。
  private chunkCount(): number {
    return (
      this.driver
        .prepare("SELECT COUNT(*) AS n FROM document_chunks WHERE session_id = ?")
        .get<{ n: number }>([this.sessionId])?.n ?? 0
    );
  }
}

/// 查询行的写入（savePlan 与 tx.insertQueries 共用）。position 从当前该轮已有条数续排，
/// 保证读回时顺序稳定。
function insertQueryRows(
  driver: SqliteDriver,
  sessionId: string,
  queries: readonly PlannedQuery[],
  roundIndex: number | null,
): void {
  const base =
    driver
      .prepare("SELECT COUNT(*) AS n FROM research_queries WHERE session_id = ?")
      .get<{ n: number }>([sessionId])?.n ?? 0;
  const stmt = driver.prepare(
    `INSERT INTO research_queries (query_id, session_id, subquestion_id, round_index, text, language, categories_json, time_range, domain_allowlist_json, domain_blocklist_json, limit_value, position)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  queries.forEach((q, i) => {
    stmt.run([
      q.queryId,
      sessionId,
      q.subquestionId,
      roundIndex,
      q.text,
      toSql(q.language),
      jsonOrNull(q.categories),
      toSql(q.timeRange),
      jsonOrNull(q.domainAllowlist),
      jsonOrNull(q.domainBlocklist),
      toSql(q.limit),
      base + i,
    ]);
  });
}

/// 行 → 候选视图。JSON 列解析失败一律回空数组：候选是可再生的派生数据，
/// 一条脏行不该让整个待批列表打不开。
function toMemoryCandidateView(row: Record<string, SqlValue>): MemoryCandidateView {
  const parseIds = (value: SqlValue): string[] => {
    try {
      const parsed = JSON.parse(String(value ?? "[]")) as unknown;
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  };

  const candidate: MemoryCandidate = {
    candidateId: String(row.candidate_id),
    knowledgeId: String(row.knowledge_id),
    scope: String(row.scope) as MemoryCandidate["scope"],
    text: String(row.text),
    citationChunkIds: parseIds(row.citation_chunk_ids_json),
    status: String(row.status) as MemoryCandidate["status"],
    createdAt: String(row.created_at),
  };
  if (row.approved_at != null) candidate.approvedAt = String(row.approved_at);

  if (row.k_subject == null) return { candidate, knowledge: null };
  const knowledge: KnowledgeItem = {
    knowledgeId: candidate.knowledgeId,
    subject: String(row.k_subject),
    statement: String(row.k_statement),
    confidence: String(row.k_confidence) as KnowledgeItem["confidence"],
    citationChunkIds: parseIds(row.k_chunks),
    trustZones: parseIds(row.k_zones) as KnowledgeItem["trustZones"],
    createdAt: String(row.k_created_at),
    updatedAt: String(row.k_updated_at),
  };
  if (row.k_valid_from != null) knowledge.validFrom = String(row.k_valid_from);
  if (row.k_valid_until != null) knowledge.validUntil = String(row.k_valid_until);
  return { candidate, knowledge };
}
