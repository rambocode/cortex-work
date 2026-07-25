// Go Search Server 的请求 / 响应契约真源（spec §11.2、§11.3）。
//
// 跨语言契约：Go 侧 `../server` 的 struct json tag 与 SEARCH_LIMITS 里的数字都以本文件为准，
// 两边任何一侧改字段名都必须同步改这里，否则会在运行时静默变成「字段丢失」而不是编译错误。
//
// 命名风格：**本文件全部 snake_case**（与 ./protocol 一致，让 Go 侧默认 json tag 即可对齐）。
// TS 领域模型（./types 的 PlannedQuery 等）是 camelCase，转换只发生在 buildSearchBatchRequest
// 与 main 侧的 search-server-client 边界，不要在别处混用两套命名。
//
// 信任边界：Search Server 是外部服务，返回的一切都不可信 —— main 收到响应后必须先过
// parseSearchBatchResponse 才允许进入编排层（未知字段会被 zod 剥离，防止「响应里塞提示词」）。
import { z } from "zod";

import type { PlannedQuery } from "./types";

/// Search Server 的硬限制（spec §11.2）。**Go 侧会照抄这些数字**做服务端强制校验，
/// 客户端夹取只是「不浪费一次往返」，绝不能当成唯一的防线。
export const SEARCH_LIMITS = {
  /// 单请求最多查询数。
  maxQueriesPerRequest: 8,
  /// 单查询文本上限，单位是 **code point（Go 的 rune）**，见 countUtf8Chars 的注释。
  maxQueryChars: 512,
  /// 单查询最多返回结果数。
  maxResultsPerQuery: 20,
  /// 请求 body 上限（64 KiB），用 countUtf8Bytes 度量。
  maxBodyBytes: 65536,
  /// 服务端总超时；客户端的 AbortController 应取相同或略大的值。
  totalTimeoutMs: 20000,
} as const;

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/// 单条搜索查询（snake_case，直接 JSON.stringify 发出）。
export interface SearchBatchQuery {
  query_id: string;
  text: string;
  language?: string;
  categories?: string[];
  time_range?: "day" | "week" | "month" | "year" | "all";
  domain_allowlist?: string[];
  domain_blocklist?: string[];
  limit?: number;
}

/// 一次批量搜索请求。research_session_id 供服务端做限流与审计，服务端不据此保存查询正文。
export interface SearchBatchRequest {
  request_id: string;
  research_session_id: string;
  queries: SearchBatchQuery[];
}

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

/// 单条搜索结果。**只是线索**（spec KTD3）：snippet 不得直接进入最终 Claim。
export interface SearchResultItem {
  url: string;
  title: string;
  snippet?: string;
  domain: string;
  engines: string[];
  published_at?: string;
  score: number;
  canonical_url?: string;
}

/// 单个查询的结果。errors 非空但 items 也非空是正常的局部失败（spec §11.3）。
export interface SearchQueryResult {
  query_id: string;
  items: SearchResultItem[];
  errors: Array<{ provider: string; code: string }>;
}

/// 一次批量搜索的服务端统计，用于 UI 展示与成本观测，不含任何查询正文。
export interface SearchBatchStats {
  provider_count: number;
  raw_result_count: number;
  returned_result_count: number;
  cache_hit: boolean;
  duration_ms: number;
}

/// 批量搜索响应。只要有一个 Provider 成功就是 HTTP 200 + 局部 errors；全失败走 503（无 body 契约）。
export interface SearchBatchResponse {
  request_id: string;
  results: SearchQueryResult[];
  stats: SearchBatchStats;
}

// ---------------------------------------------------------------------------
// 长度度量
// ---------------------------------------------------------------------------

/// 按 **Unicode code point** 计数（等价于 Go 的 `utf8.RuneCountInString`）。
///
/// 歧义与取舍：spec §11.2 只写了「单查询 UTF-8 最多 512 字符」，既可读作字节数也可读作字符数。
/// 这里按「字符 = code point」实现，理由是服务端用 Go 写，最自然的实现就是 RuneCountInString；
/// 若按字节数解释，一条 170 字的中文查询就会被拒，明显不是本意。
/// 注意 code point 不等于用户看到的字形：ZWJ emoji 序列（如 👩‍💻）会计为多个 code point，
/// 这与 Go 侧行为一致，两端不会出现「客户端算 511、服务端算 513」的边界打架。
export function countUtf8Chars(text: string): number {
  // 用迭代器逐 code point 计数，避免 .length 把代理对算成 2。
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/// 按 UTF-8 字节计数。供 body 大小（SEARCH_LIMITS.maxBodyBytes）夹取使用 ——
/// 那个限制天然是字节语义，与查询文本的字符语义是两回事，所以两个函数都要导出。
/// 不用 TextEncoder 是为了不依赖任何平台全局，保持 core 层纯 JS/TS。
export function countUtf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/// 按 code point 截断到 maxChars，不会切坏代理对。
export function truncateToChars(text: string, maxChars: number): string {
  const points = [...text];
  return points.length <= maxChars ? text : points.slice(0, maxChars).join("");
}

// ---------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------

/// 把 limit 夹到 1..maxResultsPerQuery；非有限数返回 undefined（字段整体不发，由服务端取默认）。
function clampLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || !Number.isFinite(limit)) return undefined;
  const rounded = Math.round(limit);
  return Math.min(SEARCH_LIMITS.maxResultsPerQuery, Math.max(1, rounded));
}

/// 清洗域名列表：去空白、丢弃空项；返回 undefined 表示「该字段不发」。
/// 空数组与「未设置」在服务端语义相同，但发空数组会白占 body，因此统一折叠成不发。
function normalizeDomains(domains: string[] | undefined): string[] | undefined {
  if (!domains) return undefined;
  const cleaned = domains.map((item) => item.trim()).filter((item) => item.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

/// 从 camelCase 的 PlannedQuery 构造 snake_case 请求体，并在此处强制客户端侧硬限制。
///
/// 夹取而非报错的理由：Planner 已经过 plan-schema 清洗，走到这里的越界值属于编排层 bug 或
/// 历史数据，宁可发出一个合法的收窄请求，也不要让整轮研究因为一个 limit 写错而失败。
/// 被丢弃的只有「发出去必然 400」的查询：query_id 为空或文本 trim 后为空。
export function buildSearchBatchRequest(input: {
  requestId: string;
  sessionId: string;
  queries: readonly PlannedQuery[];
}): SearchBatchRequest {
  const queries: SearchBatchQuery[] = [];

  for (const source of input.queries) {
    if (queries.length >= SEARCH_LIMITS.maxQueriesPerRequest) break;

    const queryId = source.queryId?.trim() ?? "";
    const text = truncateToChars(source.text?.trim() ?? "", SEARCH_LIMITS.maxQueryChars);
    if (queryId.length === 0 || text.length === 0) continue;

    // 逐字段白名单重建，保证 PlannedQuery 上任何多余字段都不会漏到线上请求里。
    const query: SearchBatchQuery = { query_id: queryId, text };
    if (source.language) query.language = source.language;
    const categories = normalizeDomains(source.categories);
    if (categories) query.categories = categories;
    if (source.timeRange) query.time_range = source.timeRange;
    const allowlist = normalizeDomains(source.domainAllowlist);
    if (allowlist) query.domain_allowlist = allowlist;
    const blocklist = normalizeDomains(source.domainBlocklist);
    if (blocklist) query.domain_blocklist = blocklist;
    const limit = clampLimit(source.limit);
    if (limit !== undefined) query.limit = limit;

    queries.push(query);
  }

  return {
    request_id: input.requestId,
    research_session_id: input.sessionId,
    queries,
  };
}

// ---------------------------------------------------------------------------
// 响应校验
// ---------------------------------------------------------------------------

/// Go 的 nil slice 会被 encoding/json 序列化成 null（而不是 []）。
/// 这不是错误响应，因此在 schema 层就把 null/缺失统一折叠成空数组，
/// 免得每个调用方都要写一遍 `?? []`。
function nullableArray<T extends z.ZodTypeAny>(element: T) {
  return z
    .array(element)
    .nullish()
    .transform((value) => value ?? []);
}

const searchResultItemSchema = z.object({
  url: z.string().min(1),
  title: z.string(),
  snippet: z.string().nullish().transform((value) => value ?? undefined),
  domain: z.string().min(1),
  engines: nullableArray(z.string()),
  published_at: z.string().nullish().transform((value) => value ?? undefined),
  // 分数必须是有限数：NaN/Infinity 会污染后续排序，宁可整份响应判错。
  score: z.number().finite(),
  canonical_url: z.string().nullish().transform((value) => value ?? undefined),
});

const searchProviderErrorSchema = z.object({
  provider: z.string().min(1),
  code: z.string().min(1),
});

const searchQueryResultSchema = z.object({
  query_id: z.string().min(1),
  items: nullableArray(searchResultItemSchema),
  errors: nullableArray(searchProviderErrorSchema),
});

const searchBatchStatsSchema = z.object({
  provider_count: z.int().min(0),
  raw_result_count: z.int().min(0),
  returned_result_count: z.int().min(0),
  cache_hit: z.boolean(),
  duration_ms: z.int().min(0),
});

/// 批量搜索响应的运行时 schema。未知字段被 zod 默认剥离，
/// 这一点是有意的安全属性：远端多塞的任何内容都进不了编排层。
export const searchBatchResponseSchema = z.object({
  request_id: z.string().min(1),
  results: nullableArray(searchQueryResultSchema),
  stats: searchBatchStatsSchema,
});

/// 校验并归一化 Search Server 响应。**main 收到 HTTP body 后必须先过这里**。
/// 校验失败直接抛（ZodError）：一个形状对不上的响应说明契约漂移或中间人篡改，
/// 静默降级成空结果会让问题在几轮之后才以「研究没找到来源」的形式暴露，更难排查。
export function parseSearchBatchResponse(raw: unknown): SearchBatchResponse {
  return searchBatchResponseSchema.parse(raw) as SearchBatchResponse;
}
