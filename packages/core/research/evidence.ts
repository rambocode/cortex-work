// CRE 证据链领域类型（spec §6、§8.2）：Candidate → Document → EvidenceChunk → CitationRef。
//
// 这条链的不变量（KTD3）：**搜索结果只是线索**。SearchCandidate 的 snippet 永远不能直接进入最终
// Claim；只有成功抓取并解析成 ResearchDocument、再切成 EvidenceChunk 的来源，才有资格被引用。
//
// 相关文件：编排类型（ResearchPlan / Facade / Coverage）见 ./types；Worker 协议（snake_case
// 版的同批结构）见 ./protocol——两者字段一一对应，在 main 侧 rpc-client 边界处做命名转换。
//
// 命名风格：本文件是 TS 领域模型，全 camelCase。

// ---------------------------------------------------------------------------
// 信任区与来源
// ---------------------------------------------------------------------------

/// 信任区全集（spec §6）。与 ./protocol 的 trust_zone 枚举同集合。
/// 常量数组是运行时真源，下面的 TrustZone 类型由它派生，两者永远不会漂移。
export const TRUST_ZONES = [
  "public_web",
  "authenticated_web",
  "local_file",
  "enterprise",
  "memory",
] as const;

/// 来源信任与数据敏感度边界。决定「能否发 Search Server / 能否发云模型 / 能否跨 Session 复用」。
export type TrustZone = (typeof TRUST_ZONES)[number];

/// 来源的形态分类。primary（一手：官方文档、原始论文、公告）在 Coverage 里单独计数，
/// 因为「三篇转载」不等于「一篇一手来源」。
export type SourceType =
  | "primary"
  | "secondary"
  | "documentation"
  | "news"
  | "forum"
  | "code"
  | "academic"
  | "local_file"
  | "memory"
  | "unknown";

/// 指向一个来源的最小可定位描述。Coding Agent 默认只拿到 Evidence Package + SourceRef，
/// 不拿原文（spec §15.5）。
export interface SourceRef {
  sourceType: SourceType;
  trustZone: TrustZone;
  /// 公网来源为 URL；本地来源为工作区相对路径；Memory 来源为 memory 对象 id。
  locator: string;
  title?: string;
  domain?: string;
  publishedAt?: string;
}

/// 单个来源的授权与复用策略（spec §6）。**默认矩阵**：
/// public_web 可发 Search Server、按 ModelDataPolicy 发云模型、可跨 Session 复用（受 TTL）；
/// 其余信任区默认都不发 Search Server、不发云模型，需要来源级单独批准。
export interface SourcePolicy {
  trustZone: TrustZone;
  allowSearchServer: boolean;
  allowCloudModel: boolean;
  allowCrossSessionReuse: boolean;
  /// 授权过期时间（ISO）。过期后复用判定必须失败，而不是静默沿用。
  expiresAt?: string;
}

// ---------------------------------------------------------------------------
// Candidate / Document / Chunk
// ---------------------------------------------------------------------------

/// 搜索候选：只有标题、摘要和 URL 的待验证线索，来自 Search Server（spec §8.2）。
/// trustZone 固定为 public_web——Search Server 只检索公网，本地与企业来源不走这条路径。
export interface SearchCandidate {
  candidateId: string;
  queryId: string;
  title: string;
  url: string;
  canonicalUrl?: string;
  /// 搜索引擎给的摘要。**只用于排序与选择，禁止进入最终 Claim**（KTD3）。
  snippet?: string;
  domain: string;
  /// 命中该结果的搜索引擎名列表；多引擎命中是聚合排序的重要信号。
  engines: string[];
  sourceType?: SourceType;
  publishedAt?: string;
  serverScore: number;
  trustZone: "public_web";
}

/// 抓取方式。browser 表示走了 agent-browser 降级（成本高、有额度上限）。
/// 文档是怎么拿到的。
///
/// stealth = 由 main 经服务端（Camoufox）抓回、再交给 Worker 抽取。单列一个值而不是复用
/// http：它的来源链路不同（URL 离开过本机），审计与可信度评估需要区分得开。
/// 与协议层 fetchPrepareParamsSchema 的 fetch_method 枚举必须同步。
export type FetchMethod = "http" | "browser" | "pdf" | "local_file" | "stealth";

/// 已抓取并解析的来源快照（spec §8.2）。
/// contentRef 是 blob 引用而非正文本身：正文落在 asar 外的 blob 存储，元数据留在 SQLite，
/// 这样 list/get summary 场景（1000 个 Document）不需要读任何正文（spec §19.4）。
export interface ResearchDocument {
  documentId: string;
  candidateId?: string;
  source: SourceRef;
  title: string;
  canonicalUrl?: string;
  /// 正文内容哈希，是跨 Session 复用与去重的主键（KTD9）。
  contentHash: string;
  /// 近似去重用的 simhash（十六进制字符串）；不是所有抓取路径都会产出。
  simhash?: string;
  mediaType: string;
  fetchMethod: FetchMethod;
  fetchedAt: string;
  publishedAt?: string;
  contentRef: string;
  textLength: number;
  /// 命中重复簇时指向代表文档的 documentId；此时本文档不参与独立来源计数。
  duplicateOf?: string;
  policy: SourcePolicy;
}

/// 可定位回 Document 的证据片段（spec §8.2）。
/// textHash 是引用防伪的关键：Citation Validator 用它确认模型引用的片段确实是我们抓到的那段，
/// 而不是模型自己编出来的「看起来像引用」的文本。
export interface EvidenceChunk {
  chunkId: string;
  documentId: string;
  page?: number;
  startOffset?: number;
  endOffset?: number;
  /// 该片段在原文中的标题层级路径，用于报告里给出「文档 > 章节」定位。
  headingPath?: string[];
  text: string;
  textHash: string;
  /// 与总目标的相关性（0~1）。
  objectiveScore: number;
  /// 与各子问题的相关性，key 是 ResearchSubquestion.id（见 ./types）。
  subquestionScores: Record<string, number>;
  trustZone: TrustZone;
}

/// 产物中一条事实性陈述的引用（spec §8.2）。报告里出现的每个引用最终都要收敛成这个结构，
/// 且 chunkId 必须存在于本 Session 已提交的证据集中，否则被 Citation Validator 删除。
export interface CitationRef {
  chunkId: string;
  documentId: string;
  title: string;
  url?: string;
  page?: number;
  retrievedAt: string;
  textHash: string;
}

/// 内容近重复簇。同一簇在 Coverage 里只算一个独立来源，避免转载稿刷高「来源数」。
export interface DuplicateCluster {
  clusterId: string;
  /// 代表文档的 contentHash；簇内其余成员的 duplicateOf 指向它对应的 documentId。
  representativeHash: string;
  memberHashes: string[];
}

// ---------------------------------------------------------------------------
// 抓取失败
// ---------------------------------------------------------------------------

/// 单 URL 抓取失败的有限错误码。
/// **与 ./protocol 的 fetch_failure.code 枚举是同一集合**（契约测试 evidence.test.ts 会用
/// WORKER_RESULT_SCHEMAS 反查断言）。必须是有限枚举而非自由文本：main 要据此决定
/// 重试 / 降级到 Browser / 直接放弃，自由文本无法编程判定。
export const FETCH_FAILURE_CODES = [
  "blocked_by_policy", // URL/DNS/私网/端口/scheme 判定拒绝
  "dns_failure",
  "connect_failure",
  "tls_failure",
  "http_error", // 4xx/5xx
  "too_large",
  "timeout",
  "unsupported_media",
  "empty_content",
  "browser_unavailable",
  "cancelled",
  "internal_error",
] as const;

/// 抓取失败码类型，由 FETCH_FAILURE_CODES 派生。
export type FetchFailureCode = (typeof FETCH_FAILURE_CODES)[number];

/// 一次抓取失败的可展示记录。message 面向用户，不含正文与内部路径。
export interface FetchFailure {
  candidateId: string;
  url: string;
  code: FetchFailureCode;
  message: string;
  httpStatus?: number;
}
