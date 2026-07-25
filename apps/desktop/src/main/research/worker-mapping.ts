// Worker 协议结果（snake_case）→ 仓储领域对象（camelCase）的映射层。
//
// **这层归 P5**：P3 的仓储只认 camelCase 领域对象，P4 的 rpc-client 只认协议 JSON，
// 两者之间的翻译没有别的落点。跨进程契约的真源是 core/research/protocol，
// 领域形状的真源是 core/research/evidence，本文件不得自造第三套字段名。
//
// 三条映射原则：
// 1. **id 由 main 铸造**。document_id / chunk_id 必须全局唯一（P3 的约束），而 Worker 给的
//    chunk_id 只在一次 fetch_prepare 内唯一——两个 Session 抓同一个页面就会撞主键。
// 2. **绝不留悬空引用**。duplicate_of 指向未知内容、chunk 找不到归属文档时一律丢弃并记 note，
//    宁可少一条证据，也不能让 Coverage 的重复簇收敛陷进不存在的文档。
// 3. **协议没有的字段以协议为准**，缺的信息从候选/查询侧补齐，补不出来就留空并在 notes 里报告
//    （例如 per-subquestion 相关性，协议里根本不存在，见 subquestionScores 的注释）。
import type { WORKER_RESULT_SCHEMAS } from "@cortex-work/core/research/protocol";
import { resolveSourcePolicy } from "@cortex-work/core/research/trust-policy";
import type {
  DuplicateCluster,
  EvidenceChunk,
  FetchFailure,
  ResearchDocument,
  SearchCandidate,
  SourceRef,
} from "@cortex-work/core/research/evidence";
import type { z } from "zod";

/// fetch_prepare 的结果类型，直接从协议 schema 派生——协议改字段这里会立刻编译报错。
export type WorkerFetchPrepareResult = z.infer<(typeof WORKER_RESULT_SCHEMAS)["fetch_prepare"]>;

/// 映射所需的上下文。全部显式注入，映射函数本身是纯函数（除 newId 外无副作用）。
export interface WorkerMappingContext {
  /// 铸造全局唯一 id（生产传 randomUUID，测试传自增序列）。
  newId: () => string;
  /// candidateId → 候选。用于补齐 sourceType 与域名，Worker 不知道这些。
  candidates: ReadonlyMap<string, SearchCandidate>;
  /// queryId → subquestionId。用于把 chunk 的相关性归到它所服务的子问题上。
  subquestionByQueryId: ReadonlyMap<string, string>;
  /// 跨 Session 复用命中时，已知 contentHash → 已有 documentId。
  knownDocumentIdByHash?: ReadonlyMap<string, string>;
}

/// 映射结果。texts 单独返回而不是塞进 document：正文要由 main 写 blob（KTD1），
/// 而 ResearchDocument 里只留 contentRef。
export interface MappedFetchResult {
  documents: ResearchDocument[];
  /// documentId → 正文，调用方据此写 blob 后再提交事务。
  texts: Map<string, string>;
  chunks: EvidenceChunk[];
  clusters: DuplicateCluster[];
  failures: FetchFailure[];
  stats: {
    httpFetches: number;
    browserFetches: number;
    totalBytes: number;
    durationMs: number;
    skippedKnown: number;
  };
  /// 降级说明（丢弃了什么、为什么）。进日志与 Session 诊断，**不含正文**。
  notes: string[];
}

/// 把一次 fetch_prepare 的结果映射成可直接落库的领域对象。
export function mapFetchPrepareResult(
  result: WorkerFetchPrepareResult,
  ctx: WorkerMappingContext,
): MappedFetchResult {
  const notes: string[] = [];
  const documents: ResearchDocument[] = [];
  const texts = new Map<string, string>();
  /// contentHash → 本批次铸造的 documentId，供 duplicate_of 与 chunk 归属反查。
  const documentIdByHash = new Map<string, string>();
  /// documentId → 触发它的候选，供 chunk 计算子问题相关性。
  const candidateByDocumentId = new Map<string, SearchCandidate | undefined>();

  for (const raw of result.documents) {
    const documentId = ctx.newId();
    const candidate = raw.candidate_id ? ctx.candidates.get(raw.candidate_id) : undefined;
    const document: ResearchDocument = {
      documentId,
      source: buildSourceRef(raw, candidate),
      title: raw.title,
      contentHash: raw.content_hash,
      mediaType: raw.media_type,
      fetchMethod: raw.fetch_method,
      fetchedAt: raw.fetched_at,
      // contentRef 与 blob-store 的 putBlob 返回值同形（`blob:<sha256>`），
      // 由调用方写完 blob 后即生效；这里只负责给出逻辑引用。
      contentRef: `blob:${raw.content_hash}`,
      textLength: raw.text_length,
      policy: resolveSourcePolicy(raw.trust_zone),
    };
    if (raw.candidate_id !== undefined) document.candidateId = raw.candidate_id;
    if (raw.canonical_url !== undefined) document.canonicalUrl = raw.canonical_url;
    if (raw.simhash !== undefined) document.simhash = raw.simhash;
    if (raw.published_at !== undefined) document.publishedAt = raw.published_at;

    documents.push(document);
    texts.set(documentId, raw.text);
    documentIdByHash.set(raw.content_hash, documentId);
    candidateByDocumentId.set(documentId, candidate);
  }

  // duplicate_of 的解析必须放在全部文档铸造完 id 之后：代表文档可能出现在本批次的更后面。
  result.documents.forEach((raw, index) => {
    if (raw.duplicate_of === undefined) return;
    const representative =
      documentIdByHash.get(raw.duplicate_of) ?? ctx.knownDocumentIdByHash?.get(raw.duplicate_of);
    if (representative === undefined) {
      notes.push(`丢弃无法解析的 duplicate_of（未知代表内容）：${raw.content_hash.slice(0, 12)}…`);
      return;
    }
    documents[index]!.duplicateOf = representative;
  });

  const chunks: EvidenceChunk[] = [];
  let missingSubquestion = 0;
  for (const raw of result.chunks) {
    const documentId = documentIdByHash.get(raw.content_hash);
    if (documentId === undefined) {
      // document_chunks.document_id 是真外键（migrations.ts），悬空 chunk 会让整笔提交失败。
      notes.push(`丢弃无归属文档的 chunk：${raw.chunk_id}`);
      continue;
    }
    const objectiveScore = clamp01(raw.lexical_score);
    const candidate = candidateByDocumentId.get(documentId);
    const subquestionId = candidate ? ctx.subquestionByQueryId.get(candidate.queryId) : undefined;
    if (subquestionId === undefined) missingSubquestion += 1;

    const chunk: EvidenceChunk = {
      // 重新铸造 id：Worker 的 chunk_id 只在单次调用内唯一（见文件头原则 1）。
      chunkId: ctx.newId(),
      documentId,
      text: raw.text,
      textHash: raw.text_hash,
      objectiveScore,
      // 协议的 fetch_prepare 结果**没有 per-subquestion 相关性**（rerank 也只回单一分数）。
      // 折中：把词法分数归给"触发该文档的查询所属子问题"——这是可解释、可回放的归因，
      // 比留空导致 Coverage 恒为 missing 有用得多。真正的语义打分留给 P7 的模型重排。
      subquestionScores: subquestionId ? { [subquestionId]: objectiveScore } : {},
      trustZone: findTrustZone(result, raw.content_hash),
    };
    if (raw.page !== undefined) chunk.page = raw.page;
    if (raw.start_offset !== undefined) chunk.startOffset = raw.start_offset;
    if (raw.end_offset !== undefined) chunk.endOffset = raw.end_offset;
    if (raw.heading_path !== undefined) chunk.headingPath = raw.heading_path;
    chunks.push(chunk);
  }
  if (missingSubquestion > 0) {
    notes.push(`${missingSubquestion} 个 chunk 无法归属子问题，相关性留空`);
  }

  return {
    documents,
    texts,
    chunks,
    clusters: result.duplicate_clusters.map((cluster) => ({
      clusterId: cluster.cluster_id,
      representativeHash: cluster.representative_hash,
      memberHashes: [...cluster.member_hashes],
    })),
    failures: result.failures.map((failure) => {
      const mapped: FetchFailure = {
        candidateId: failure.candidate_id,
        url: failure.url,
        code: failure.code,
        message: failure.message,
      };
      if (failure.http_status !== undefined) mapped.httpStatus = failure.http_status;
      return mapped;
    }),
    stats: {
      httpFetches: result.stats.http_fetches,
      browserFetches: result.stats.browser_fetches,
      totalBytes: result.stats.total_bytes,
      durationMs: result.stats.duration_ms,
      skippedKnown: result.stats.skipped_known,
    },
    notes,
  };
}

/// 领域候选 → 协议候选（camelCase → snake_case）。fetch_prepare 的入参用它构造。
///
/// 逐字段白名单重建而不是展开对象：SearchCandidate 上任何多余字段都不该跨进程漏给 Worker。
export function toWorkerCandidates(
  candidates: readonly SearchCandidate[],
): NonNullable<WorkerFetchPrepareParams["candidates"]> {
  return candidates.map((candidate) => {
    const mapped: WorkerFetchPrepareParams["candidates"][number] = {
      candidate_id: candidate.candidateId,
      query_id: candidate.queryId,
      title: candidate.title,
      url: candidate.url,
      domain: candidate.domain,
      engines: [...candidate.engines],
      server_score: candidate.serverScore,
    };
    if (candidate.canonicalUrl !== undefined) mapped.canonical_url = candidate.canonicalUrl;
    if (candidate.snippet !== undefined) mapped.snippet = candidate.snippet;
    if (candidate.publishedAt !== undefined) mapped.published_at = candidate.publishedAt;
    return mapped;
  });
}

/// fetch_prepare 的入参形状（协议真源在 core/research/protocol 的 workerInboundSchema）。
/// 手写而不是从 schema 派生：入站 schema 是 discriminated union，取出单支的类型比这段声明还绕。
export interface WorkerFetchPrepareParams {
  operation_id: string;
  objective: string;
  subquestions: Array<{ id: string; text: string }>;
  candidates: Array<{
    candidate_id: string;
    query_id: string;
    title: string;
    url: string;
    canonical_url?: string;
    snippet?: string;
    domain: string;
    engines: string[];
    published_at?: string;
    server_score: number;
  }>;
  known_fingerprints: Array<{ document_id: string; content_hash: string; simhash?: string }>;
  policy: {
    trust_zone: EvidenceChunk["trustZone"];
    allow_search_server: boolean;
    allow_cloud_model: boolean;
    allow_cross_session_reuse: boolean;
    expires_at?: string;
  };
  limits: {
    max_documents: number;
    max_browser_fetches: number;
    max_total_bytes: number;
    max_duration_ms: number;
    http_concurrency: number;
    per_host_concurrency: number;
    request_timeout_ms: number;
  };
  agent_browser_binary?: string;
  allowed_domains?: string[];
  /// main 已抓好的正文（服务端 stealth 抓取的产物）。Worker 命中即直接抽取、不联网。
  /// 契约真源在 core 的 fetchPrepareParamsSchema，两处必须同形。
  prefetched?: Array<{ candidate_id: string; html: string; final_url: string }>;
}

/// 构造来源描述。sourceType 只有候选侧知道（Search Server 给的分类），
/// 候选缺失时降级为 unknown 而不是猜——猜错会污染 Coverage 的一手来源计数。
function buildSourceRef(
  raw: WorkerFetchPrepareResult["documents"][number],
  candidate: SearchCandidate | undefined,
): SourceRef {
  const source: SourceRef = {
    sourceType: candidate?.sourceType ?? "unknown",
    trustZone: raw.trust_zone,
    locator: raw.url,
    title: raw.title,
  };
  const domain = candidate?.domain ?? hostnameOf(raw.url);
  if (domain) source.domain = domain;
  if (raw.published_at !== undefined) source.publishedAt = raw.published_at;
  return source;
}

/// chunk 的信任区跟随它所属文档（Worker 的 chunk 结构里没有该字段）。
function findTrustZone(
  result: WorkerFetchPrepareResult,
  contentHash: string,
): EvidenceChunk["trustZone"] {
  return result.documents.find((doc) => doc.content_hash === contentHash)?.trust_zone ?? "public_web";
}

/// 把分数夹到 0..1。Worker 的 lexical_score 是无上界的 BM25 类分值，
/// 而领域模型约定 objectiveScore ∈ [0,1]，越界值会让 Coverage 的均值失真。
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/// 取 URL 的主机名；解析失败返回 undefined（不抛错，映射不该因一条脏 URL 整体失败）。
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
