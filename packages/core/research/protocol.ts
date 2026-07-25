// Research Worker 的进程间协议真源（spec §12）。
//
// 跨进程/跨语言契约：Electron main（客户端）、TS Worker（服务端）、将来的 Rust Worker
// 三方都以本文件为准。样例见 ./protocol-fixtures，契约测试见 ./protocol.test.ts。
//
// 承载管道的偏离（U0 spike S3，见 docs/superpowers/specs/2026-07-25-cre-u0-spike-findings.md）：
// spec §12.1 写的是 stdin/stdout JSONL，但 Electron 的 utilityProcess **不允许 pipe stdin**
// （electron.d.ts:20716）。因此实际承载改为 postMessage，契约收敛为「一行 JSONL 进 / 一行
// JSONL 出」。消息体、method 名、字段、错误信封在此保持与 spec 逐字一致，换 Rust Worker 时
// 只需换一个真 stdio 的 WorkerTransport 实现，本文件零改动。
//
// 命名风格：**协议 JSON 一律 snake_case**（对齐 spec §12.1 的 protocol_version/desktop_version，
// 也让 Rust serde 默认派生即可用）。TS 领域模型（./types、./evidence）是 camelCase，两者在
// main 侧的 rpc-client 边界处转换，不要在别处混用。
import { z } from "zod";

/// 当前协议版本。任何破坏性字段变更都必须 +1，且 main 在 hello 阶段拒绝不兼容的 Worker。
export const RESEARCH_PROTOCOL_VERSION = 1;

/// 业务 method 全集（spec §12.1）。顺序即文档顺序，测试据此校验 fixtures 覆盖完整。
export const WORKER_METHODS = [
  "hello",
  "doctor",
  "fetch_prepare",
  "rerank",
  "cancel",
  "shutdown",
] as const;

export type WorkerMethod = (typeof WORKER_METHODS)[number];

// ---------------------------------------------------------------------------
// 共享子结构
// ---------------------------------------------------------------------------

/// 信任区。与 ./trust-policy 的 TrustZone 同集合，此处独立声明以免协议层反向依赖领域层。
const trustZoneSchema = z.enum([
  "public_web",
  "authenticated_web",
  "local_file",
  "enterprise",
  "memory",
]);

/// 单个来源的授权与复用策略（spec §6）。Worker 只读不改，用于决定是否允许 Browser 降级等。
const sourcePolicySchema = z.object({
  trust_zone: trustZoneSchema,
  allow_search_server: z.boolean(),
  allow_cloud_model: z.boolean(),
  allow_cross_session_reuse: z.boolean(),
  expires_at: z.string().optional(),
});

/// 搜索候选：Worker 的抓取输入。**只是线索**（spec KTD3），snippet 不得进入最终 Claim。
const searchCandidateSchema = z.object({
  candidate_id: z.string().min(1),
  query_id: z.string().min(1),
  title: z.string(),
  url: z.string().min(1),
  canonical_url: z.string().optional(),
  snippet: z.string().optional(),
  domain: z.string().min(1),
  engines: z.array(z.string()),
  published_at: z.string().optional(),
  server_score: z.number(),
});

/// 资源限制。main 下发硬上限，Worker 必须自行强制（不能假设 main 已经夹取过）。
const resourceLimitsSchema = z.object({
  max_documents: z.int().min(1),
  max_browser_fetches: z.int().min(0),
  max_total_bytes: z.int().min(1),
  max_duration_ms: z.int().min(1),
  http_concurrency: z.int().min(1).max(32),
  per_host_concurrency: z.int().min(1).max(8),
  request_timeout_ms: z.int().min(1),
});

/// 已知文档指纹。用于跨 Session 复用去重：Worker 命中即跳过抓取，只回报 duplicate_of。
const knownFingerprintSchema = z.object({
  document_id: z.string().min(1),
  content_hash: z.string().min(1),
  simhash: z.string().optional(),
});

// ---------------------------------------------------------------------------
// 入站（main → worker）
// ---------------------------------------------------------------------------

const helloParamsSchema = z.object({
  protocol_version: z.int().min(1),
  desktop_version: z.string().min(1),
});

const doctorParamsSchema = z.object({
  /// 可选：让 Worker 顺带自检 agent-browser 二进制是否可执行。
  agent_browser_binary: z.string().optional(),
});

const fetchPrepareParamsSchema = z.object({
  operation_id: z.string().min(1),
  objective: z.string().min(1),
  subquestions: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })),
  // 空候选集意味着 main 侧编排出错——与其让 Worker 空转一轮，不如在协议层拒绝。
  candidates: z.array(searchCandidateSchema).min(1),
  known_fingerprints: z.array(knownFingerprintSchema),
  policy: sourcePolicySchema,
  limits: resourceLimitsSchema,
  /// main 解析出的 agent-browser 绝对路径。缺省表示 Browser 降级不可用，Worker 只走 HTTP。
  agent_browser_binary: z.string().optional(),
  /// Browser 降级允许访问的域名白名单，由 main 从候选集推导后下发。
  allowed_domains: z.array(z.string()).optional(),
  /// main 已经抓好的正文（服务端 stealth 抓取的产物），Worker 直接走抽取、**不再联网**。
  ///
  /// 为什么要有这条通道：反爬站点只有服务端的 Camoufox 抓得到，而那次请求要带 PAT——
  /// 凭据绝不能进 Worker 进程（它解析的是不可信 HTML，一个解析漏洞就会升级成凭据泄漏）。
  /// 于是抓取留在 main、抽取留在 Worker，HTML 经这个字段传递。
  prefetched: z
    .array(
      z.object({
        candidate_id: z.string().min(1),
        html: z.string().min(1),
        final_url: z.string().min(1),
      }),
    )
    .optional(),
});

const rerankParamsSchema = z.object({
  operation_id: z.string().min(1),
  query: z.string().min(1),
  subquestions: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })),
  chunks: z
    .array(z.object({ chunk_id: z.string().min(1), text: z.string().min(1) }))
    .min(1),
  top_k: z.int().min(1).max(200),
});

const cancelParamsSchema = z.object({
  /// 取消目标。缺省表示取消该 Worker 上全部在途 operation。
  operation_id: z.string().optional(),
});

const shutdownParamsSchema = z.object({
  /// 优雅退出的最长等待毫秒数；超时后 main 会走两段式 kill。
  grace_ms: z.int().min(0).optional(),
});

/// 入站消息 = 带 method 判别的请求。以 method 做 discriminated union，未知 method 直接拒绝。
const workerInboundSchema = z.discriminatedUnion("method", [
  z.object({ type: z.literal("request"), id: z.string().min(1), method: z.literal("hello"), params: helloParamsSchema }),
  z.object({ type: z.literal("request"), id: z.string().min(1), method: z.literal("doctor"), params: doctorParamsSchema }),
  z.object({ type: z.literal("request"), id: z.string().min(1), method: z.literal("fetch_prepare"), params: fetchPrepareParamsSchema }),
  z.object({ type: z.literal("request"), id: z.string().min(1), method: z.literal("rerank"), params: rerankParamsSchema }),
  z.object({ type: z.literal("request"), id: z.string().min(1), method: z.literal("cancel"), params: cancelParamsSchema }),
  z.object({ type: z.literal("request"), id: z.string().min(1), method: z.literal("shutdown"), params: shutdownParamsSchema }),
]);

export type WorkerInbound = z.infer<typeof workerInboundSchema>;

// ---------------------------------------------------------------------------
// 出站（worker → main）
// ---------------------------------------------------------------------------

/// 抓取产出的文档。contentRef 由 Worker 给出内容哈希，真正落 blob 由 main 完成（KTD1：
/// Worker 不写数据库、不写用户产物）。
const workerDocumentSchema = z.object({
  candidate_id: z.string().optional(),
  url: z.string().min(1),
  canonical_url: z.string().optional(),
  title: z.string(),
  content_hash: z.string().min(1),
  simhash: z.string().optional(),
  media_type: z.string().min(1),
  // stealth = 由 main 经服务端（Camoufox）抓回、再交给 Worker 抽取的文档。
  // 单列一个值而不是复用 http：它的来源链路不同（URL 离开过本机），审计与可信度评估
  // 需要区分得开。
  fetch_method: z.enum(["http", "browser", "pdf", "local_file", "stealth"]),
  fetched_at: z.string().min(1),
  published_at: z.string().optional(),
  text: z.string(),
  text_length: z.int().min(0),
  duplicate_of: z.string().optional(),
  trust_zone: trustZoneSchema,
});

const workerChunkSchema = z.object({
  chunk_id: z.string().min(1),
  content_hash: z.string().min(1),
  page: z.int().optional(),
  start_offset: z.int().min(0).optional(),
  end_offset: z.int().min(0).optional(),
  heading_path: z.array(z.string()).optional(),
  text: z.string().min(1),
  text_hash: z.string().min(1),
  lexical_score: z.number(),
});

const duplicateClusterSchema = z.object({
  cluster_id: z.string().min(1),
  representative_hash: z.string().min(1),
  member_hashes: z.array(z.string()).min(1),
});

/// 单 URL 的失败分类。**必须是有限枚举**：main 据此决定重试/降级/放弃，自由文本不可编程。
const fetchFailureSchema = z.object({
  candidate_id: z.string().min(1),
  url: z.string().min(1),
  code: z.enum([
    "blocked_by_policy",   // URL/DNS/私网/端口/scheme 判定拒绝
    "dns_failure",
    "connect_failure",
    "tls_failure",
    "http_error",          // 4xx/5xx
    "too_large",
    "timeout",
    "unsupported_media",
    "empty_content",
    "browser_unavailable",
    "cancelled",
    "internal_error",
  ]),
  message: z.string(),
  http_status: z.int().optional(),
});

const helloResultSchema = z.object({
  worker_version: z.string().min(1),
  /// Worker 支持的最高协议版本；main 据此决定是否继续发业务请求。
  max_protocol_version: z.int().min(1),
  methods: z.array(z.enum(WORKER_METHODS)).min(1),
  browser_available: z.boolean(),
});

const doctorResultSchema = z.object({
  ok: z.boolean(),
  node_version: z.string(),
  browser_available: z.boolean(),
  pdf_available: z.boolean(),
  /// 人类可读的自检问题列表，供设置页展示；不参与任何自动化判定。
  issues: z.array(z.string()),
});

const fetchPrepareResultSchema = z.object({
  operation_id: z.string().min(1),
  documents: z.array(workerDocumentSchema),
  chunks: z.array(workerChunkSchema),
  duplicate_clusters: z.array(duplicateClusterSchema),
  failures: z.array(fetchFailureSchema),
  stats: z.object({
    http_fetches: z.int().min(0),
    browser_fetches: z.int().min(0),
    total_bytes: z.int().min(0),
    duration_ms: z.int().min(0),
    /// 命中 known_fingerprints 而跳过抓取的数量。
    skipped_known: z.int().min(0),
  }),
});

const rerankResultSchema = z.object({
  operation_id: z.string().min(1),
  ranked: z.array(z.object({ chunk_id: z.string().min(1), score: z.number() })),
});

const ackResultSchema = z.object({ ok: z.literal(true) });

const workerErrorSchema = z.object({
  /// 有限错误码，与 fetch_failure 分开：这是 RPC 层错误，不是单 URL 抓取失败。
  code: z.enum([
    "invalid_params",
    "unknown_method",
    "protocol_mismatch",
    "not_ready",
    "cancelled",
    "budget_exceeded",
    "internal_error",
  ]),
  message: z.string(),
  data: z.unknown().optional(),
});

/// 响应信封。result 与 error 严格互斥——同时出现或同时缺失都是协议违规，必须在解析层拦下，
/// 否则 main 侧会出现「既成功又失败」的分支，进而写坏 operation 的提交状态。
const workerResponseSchema = z
  .object({
    type: z.literal("response"),
    id: z.string().min(1),
    result: z.unknown().optional(),
    error: workerErrorSchema.optional(),
  })
  .refine((v) => (v.result === undefined) !== (v.error === undefined), {
    message: "response must carry exactly one of result / error",
  });

/// 进度事件。**无 id**：它不关联任何请求应答，main 只用它更新 UI 进度，不得据此推进状态机。
const workerEventSchema = z.object({
  type: z.literal("event"),
  event: z.literal("progress"),
  operation_id: z.string().min(1),
  stage: z.enum(["fetching", "extracting", "chunking", "ranking"]),
  completed: z.int().min(0),
  total: z.int().min(0),
});

const workerOutboundSchema = z.union([workerResponseSchema, workerEventSchema]);

export type WorkerOutbound = z.infer<typeof workerOutboundSchema>;

/// 各 method 的 result 形状。响应信封只保证 result 存在，具体形状由调用方按 method 二次校验
/// （main 侧的 rpc-client 知道自己发的是哪个 method，Worker 侧不需要反查）。
export const WORKER_RESULT_SCHEMAS = {
  hello: helloResultSchema,
  doctor: doctorResultSchema,
  fetch_prepare: fetchPrepareResultSchema,
  rerank: rerankResultSchema,
  cancel: ackResultSchema,
  shutdown: ackResultSchema,
} as const satisfies Record<WorkerMethod, z.ZodTypeAny>;

// ---------------------------------------------------------------------------
// 解析入口
// ---------------------------------------------------------------------------

/// 解析 main → worker 的一条消息。解析失败抛出，由 Worker 的 rpc-server 转成 invalid_params。
export function parseWorkerInbound(raw: unknown): WorkerInbound {
  return workerInboundSchema.parse(raw);
}

/// 解析 worker → main 的一条消息。解析失败抛出，由 main 的 rpc-client 视为该 operation 失败。
export function parseWorkerOutbound(raw: unknown): WorkerOutbound {
  return workerOutboundSchema.parse(raw);
}

/// 按 method 校验 result 的具体形状。分两步是因为响应信封先于 method 可知性到达解析层。
export function parseWorkerResult<M extends WorkerMethod>(
  method: M,
  result: unknown,
): z.infer<(typeof WORKER_RESULT_SCHEMAS)[M]> {
  return WORKER_RESULT_SCHEMAS[method].parse(result) as z.infer<(typeof WORKER_RESULT_SCHEMAS)[M]>;
}

/// 构造一行错误响应。JSON.stringify 天然不产生裸换行（\n 会被转义），故单行性有保证。
export function workerErrorResponse(
  id: string,
  code: z.infer<typeof workerErrorSchema>["code"],
  message: string,
  data?: unknown,
): string {
  return JSON.stringify({ type: "response", id, error: { code, message, data } });
}

/// 构造一行成功响应。
export function workerOkResponse(id: string, result: unknown): string {
  return JSON.stringify({ type: "response", id, result });
}
