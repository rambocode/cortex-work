// SQLite 行类型与「行 → 领域对象」映射（research-repository.ts 的私有实现细节）。
//
// 从 research-repository.ts 拆出来的唯一理由是行数：仓储主体逼近单文件 1200 行上限，
// 而映射层职责单一、与 SQL 语句无关，是最干净的切分线。**不要在这里放任何查询逻辑**——
// 本文件只做纯数据形状转换，不认识 SqliteDriver。
//
// 一条贯穿全文件的约定：SQLite 的 NULL 在 JS 里是 null，而领域类型（core/research/*）
// 用 undefined 表示「没有」。因此可选字段一律「有值才赋值」，而不是无脑写 `x: opt(row.y)`——
// 后者会在对象上留下一堆 `key: undefined`，让 toEqual 之类的结构比较出现意外差异。
import type {
  CitationRef,
  EvidenceChunk,
  FetchMethod,
  ResearchDocument,
  SourcePolicy,
  SourceRef,
  TrustZone,
} from "@cortex-work/core/research/evidence";
import type {
  CompletionCriteria,
  CoverageReport,
  PlannedQuery,
  PlannerDecision,
  ResearchBudget,
  ResearchPlan,
  ResearchScope,
  ResearchSubquestion,
  ResearchConsumer,
  ResearchMode,
  ResearchReport,
  ResearchRound,
  ResearchSessionStatus,
  ResearchSessionSummary,
  ResearchTimeRange,
} from "@cortex-work/core/research/types";
import type { SqlValue } from "./sqlite-driver";

/// research_sessions 表的一行。三个 *_count 是**刻意冗余的计数列**：summary 路径不允许
/// join 证据表（否则列表渲染会把上千篇正文拖进内存），计数只能在写入事务里同步维护。
export interface SessionRow {
  session_id: string;
  consumer: string;
  objective: string;
  mode: string;
  status: string;
  user_scope: string;
  source_scopes_json: string;
  output_json: string;
  budget_json: string;
  budget_spent_json: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  round_count: number;
  document_count: number;
  chunk_count: number;
}

/// SQLite 的 NULL 在 JS 里是 null，而领域类型用 undefined 表示"没有"。
/// 统一在这里转换，避免每个可选字段各写一次三元。
export function opt<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

/// 解析必填的 JSON 列。列为 NOT NULL 时才用它——解析失败直接抛，让损坏的行显式报错而不是静默降级。
export function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

/// 解析可空的 JSON 列：NULL → undefined，其余按 JSON 解析。
export function optJson<T>(text: string | null): T | undefined {
  return text === null || text === undefined ? undefined : (JSON.parse(text) as T);
}

/// undefined → null 的入参归一。SqlValue 刻意不含 undefined：
/// 漏传字段应该显式变成 NULL，而不是被当成"少了一个参数"。
export function toSql(value: string | number | undefined | null): SqlValue {
  return value === undefined || value === null ? null : value;
}

/// 序列化写入 JSON 列；undefined / null 一律写 NULL，不写字符串 "null"（后者读回来是个坑）。
export function jsonOrNull(value: unknown): SqlValue {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/// 行 → 会话摘要。**这是隐私红线的落点**：只读元数据列，绝不触碰正文/证据表
/// （列表渲染走的就是这条路径）。
export function rowToSummary(row: SessionRow): ResearchSessionSummary {
  const summary: ResearchSessionSummary = {
    sessionId: row.session_id,
    consumer: row.consumer as ResearchConsumer,
    objective: row.objective,
    mode: row.mode as ResearchMode,
    status: row.status as ResearchSessionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    roundCount: Number(row.round_count),
    documentCount: Number(row.document_count),
    chunkCount: Number(row.chunk_count),
  };
  if (row.error_message !== null && row.error_message !== undefined) {
    summary.errorMessage = row.error_message;
  }
  return summary;
}


/// research_operations 表的一行。committed_at 为 NULL 即「未提交」——启动恢复据此判定中断的操作。
export interface OperationRow {
  operation_id: string;
  session_id: string;
  kind: string;
  request_payload_hash: string;
  created_at: string;
  committed_at: string | null;
  retryable: number;
}
/// research_plans 表的一行（一个 Session 至多一份计划）。schema_version 供计划结构演进时做迁移分支。
export interface PlanRow {
  session_id: string;
  schema_version: number;
  objective: string;
  scope_json: string;
  budget_json: string;
  completion_json: string;
}
/// 计划下的子问题行。id 只需 Session 内唯一（表主键是 (session_id, subquestion_id) 复合键）。
export interface SubquestionRow {
  subquestion_id: string;
  text: string;
  rationale: string | null;
}
/// 已规划/已执行的检索查询行。limit_value 而非 limit：limit 是 SQL 保留字。
export interface QueryRow {
  query_id: string;
  subquestion_id: string;
  text: string;
  language: string | null;
  categories_json: string | null;
  time_range: string | null;
  domain_allowlist_json: string | null;
  domain_blocklist_json: string | null;
  limit_value: number | null;
}
/// 一轮研究的行。三个 *_count 与 SessionRow 同理，是写入时同步维护的冗余计数。
export interface RoundRow {
  round_index: number;
  started_at: string;
  ended_at: string | null;
  decision: string | null;
  query_ids_json: string;
  candidate_count: number;
  document_count: number;
  chunk_count: number;
}
/// 覆盖度评估行，按 (round_index, subquestion_id) 幂等 upsert：同一轮重算是覆盖而不是堆叠。
export interface CoverageRow {
  round_index: number;
  subquestion_id: string;
  status: string;
  source_count: number;
  independent_domain_count: number;
  primary_source_count: number;
  contradiction_count: number;
  average_relevance: number;
  best_chunk_ids_json: string;
  missing_json: string;
}
/// 报告正文行。一个 Session 只有一份，重生成即整体覆盖。
export interface ReportRow {
  markdown: string;
  unsupported_sections_json: string;
  generated_at: string;
  generation_stats_json: string | null;
}
/// 引用行。position 保序：报告里的引用顺序必须可复现，SQLite 不保证无 ORDER BY 时的行序。
export interface CitationRow {
  position: number;
  chunk_id: string;
  document_id: string;
  title: string;
  url: string | null;
  page: number | null;
  retrieved_at: string;
  text_hash: string;
}
/// 抓取到的文档行。**不含正文**——正文在 blob 里，此处只存 content_ref（`blob:<sha256>`）。
export interface DocumentRow {
  document_id: string;
  candidate_id: string | null;
  source_json: string;
  title: string;
  canonical_url: string | null;
  content_hash: string;
  simhash: string | null;
  media_type: string;
  fetch_method: string;
  fetched_at: string;
  published_at: string | null;
  content_ref: string;
  text_length: number;
  duplicate_of: string | null;
  policy_json: string;
}
/// 证据块行。text 是正文片段，因此只允许出现在 evidence 及以上的 detail 级别。
export interface ChunkRow {
  chunk_id: string;
  document_id: string;
  page: number | null;
  start_offset: number | null;
  end_offset: number | null;
  heading_path_json: string | null;
  text: string;
  text_hash: string;
  objective_score: number;
  subquestion_scores_json: string;
  trust_zone: string;
}

/// 行 → PlannedQuery。可选字段一律「有值才赋」，避免把 undefined 显式写进对象（exactOptionalPropertyTypes）。
export function rowToQuery(row: QueryRow): PlannedQuery {
  const query: PlannedQuery = {
    queryId: row.query_id,
    subquestionId: row.subquestion_id,
    text: row.text,
  };
  const language = opt(row.language);
  if (language !== undefined) query.language = language;
  const categories = optJson<string[]>(row.categories_json);
  if (categories) query.categories = categories;
  if (row.time_range !== null) query.timeRange = row.time_range as ResearchTimeRange;
  const allow = optJson<string[]>(row.domain_allowlist_json);
  if (allow) query.domainAllowlist = allow;
  const block = optJson<string[]>(row.domain_blocklist_json);
  if (block) query.domainBlocklist = block;
  if (row.limit_value !== null) query.limit = Number(row.limit_value);
  return query;
}

/// 行 → ResearchDocument。同样只做形状转换：不读 blob、不解压正文。
export function rowToDocument(row: DocumentRow): ResearchDocument {
  const doc: ResearchDocument = {
    documentId: row.document_id,
    source: parseJson<SourceRef>(row.source_json),
    title: row.title,
    contentHash: row.content_hash,
    mediaType: row.media_type,
    fetchMethod: row.fetch_method as FetchMethod,
    fetchedAt: row.fetched_at,
    contentRef: row.content_ref,
    textLength: Number(row.text_length),
    policy: parseJson<SourcePolicy>(row.policy_json),
  };
  const candidateId = opt(row.candidate_id);
  if (candidateId !== undefined) doc.candidateId = candidateId;
  const canonicalUrl = opt(row.canonical_url);
  if (canonicalUrl !== undefined) doc.canonicalUrl = canonicalUrl;
  const simhash = opt(row.simhash);
  if (simhash !== undefined) doc.simhash = simhash;
  const publishedAt = opt(row.published_at);
  if (publishedAt !== undefined) doc.publishedAt = publishedAt;
  const duplicateOf = opt(row.duplicate_of);
  if (duplicateOf !== undefined) doc.duplicateOf = duplicateOf;
  return doc;
}

/// 轮次行 → ResearchRound。
export function rowToRound(row: RoundRow): ResearchRound {
  const round: ResearchRound = {
    roundIndex: Number(row.round_index),
    startedAt: row.started_at,
    queryIds: parseJson<string[]>(row.query_ids_json),
    candidateCount: Number(row.candidate_count),
    documentCount: Number(row.document_count),
    chunkCount: Number(row.chunk_count),
  };
  if (row.ended_at !== null) round.endedAt = row.ended_at;
  if (row.decision !== null) round.decision = row.decision as PlannerDecision["action"];
  return round;
}

/// 覆盖度行 → CoverageReport。
export function rowToCoverage(row: CoverageRow): CoverageReport {
  return {
    subquestionId: row.subquestion_id,
    status: row.status as CoverageReport["status"],
    sourceCount: Number(row.source_count),
    independentDomainCount: Number(row.independent_domain_count),
    primarySourceCount: Number(row.primary_source_count),
    contradictionCount: Number(row.contradiction_count),
    averageRelevance: Number(row.average_relevance),
    bestChunkIds: parseJson<string[]>(row.best_chunk_ids_json),
    missing: parseJson<string[]>(row.missing_json),
  };
}

/// 引用行 → CitationRef。
export function rowToCitation(row: CitationRow): CitationRef {
  const citation: CitationRef = {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    title: row.title,
    retrievedAt: row.retrieved_at,
    textHash: row.text_hash,
  };
  if (row.url !== null) citation.url = row.url;
  if (row.page !== null) citation.page = Number(row.page);
  return citation;
}

/// 报告行 + 引用行 → ResearchReport。引用分表存放，读取时在这里合流。
export function rowToReport(row: ReportRow, citations: readonly CitationRow[]): ResearchReport {
  const report: ResearchReport = {
    markdown: row.markdown,
    citations: citations.map(rowToCitation),
    unsupportedSections: parseJson<string[]>(row.unsupported_sections_json),
    generatedAt: row.generated_at,
  };
  if (row.generation_stats_json !== null) {
    report.generationStats = parseJson<NonNullable<ResearchReport["generationStats"]>>(
      row.generation_stats_json,
    );
  }
  return report;
}

/// 证据片段行 → EvidenceChunk。**只应在 detail === "evidence" 的路径上被调用**：
/// text 是网页正文，summary/full 层级都不得读到它（spec §19.3.2）。
export function rowToChunk(row: ChunkRow): EvidenceChunk {
  const chunk: EvidenceChunk = {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    text: row.text,
    textHash: row.text_hash,
    objectiveScore: Number(row.objective_score),
    subquestionScores: parseJson<Record<string, number>>(row.subquestion_scores_json),
    trustZone: row.trust_zone as TrustZone,
  };
  if (row.page !== null) chunk.page = Number(row.page);
  if (row.start_offset !== null) chunk.startOffset = Number(row.start_offset);
  if (row.end_offset !== null) chunk.endOffset = Number(row.end_offset);
  const headingPath = optJson<string[]>(row.heading_path_json);
  if (headingPath) chunk.headingPath = headingPath;
  return chunk;
}

/// 子问题行 → ResearchPlan 的子问题条目。
export function rowToSubquestion(row: SubquestionRow): ResearchSubquestion {
  const sub: ResearchSubquestion = { id: row.subquestion_id, text: row.text };
  if (row.rationale !== null) sub.rationale = row.rationale;
  return sub;
}

/// 计划行 + 子问题行 + 初始查询行 → ResearchPlan。
export function rowToPlan(
  row: PlanRow,
  subquestionRows: readonly SubquestionRow[],
  queryRows: readonly QueryRow[],
): ResearchPlan {
  return {
    schemaVersion: Number(row.schema_version) as 1,
    objective: row.objective,
    scope: parseJson<ResearchScope>(row.scope_json),
    subquestions: subquestionRows.map(rowToSubquestion),
    initialQueries: queryRows.map(rowToQuery),
    budget: parseJson<ResearchBudget>(row.budget_json),
    completion: parseJson<CompletionCriteria>(row.completion_json),
  };
}
