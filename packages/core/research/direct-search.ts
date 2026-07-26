// 桌面端直连商业搜索的纯逻辑层（Search Server 未配置时的逃生阀）。
//
// **为什么存在**：CRE 的唯一搜索路径原本是自建 Go Search Server + SearXNG。实测（见
// docs/superpowers/specs/2026-07-25-cre-acceptance-log.md §7.3）自建出口下多数免费引擎
// timeout / 429 / CAPTCHA，且未部署 Search Server 时 createSearchClient() 返回 null，
// 研究直接抛「未配置」。这一层让用户填一个商业搜索 API key 就能用起来。
//
// 隐私边界（与自建路径的差异，必须让用户知情）：走这条路时**查询词从桌面端直接出站到第三方**，
// 绕开了服务端的限流与审计。因此：
//   - 优先级低于 Search Server（runtime.createSearchClient 先看 searchServer）；
//   - endpoint host **写死在本文件常量里，不接受用户自定义 baseUrl** —— 可配置的 baseUrl
//     等于给了一个「任意 URL 出站」通道，那是本仓库在 url-safety / dns-guard 上花了大力气
//     堵住的东西，不能从设置页开个后门放回来；
//   - API key 只走请求头，绝不进 URL（URL 会进日志、进 crash report）。
//
// 信任边界：商业 API 的响应与 Search Server 一样**完全不可信**。parseDirectSearchResults
// 对任意 unknown 输入都必须返回可用数组且绝不抛错 —— 一次响应形状变化不该让整轮研究失败。
//
// 相关文件：目标形状（SearchResultItem / SearchBatchResponse）与限额见 ./search-api；
// main 侧的 HTTP 客户端见 apps/desktop/src/main/research/clients/direct-search-client.ts。
import {
  SEARCH_LIMITS,
  truncateToChars,
  type SearchBatchQuery,
  type SearchBatchResponse,
  type SearchQueryResult,
  type SearchResultItem,
} from "./search-api";

/// 支持的直连供应商。刻意只收两家：Brave（有免费额度、结果覆盖面广）与
/// Tavily（面向 LLM 的检索 API，直接给相关度分）。每多一家就多一套要长期维护的响应形状。
export const DIRECT_SEARCH_PROVIDER_IDS = ["brave", "tavily"] as const;
export type DirectSearchProviderId = (typeof DIRECT_SEARCH_PROVIDER_IDS)[number];

const providerIdSet = new Set<string>(DIRECT_SEARCH_PROVIDER_IDS);

/// 是否是受支持的供应商 id。设置归一化与 IPC 入参校验都用它，避免各写一份枚举。
export function isDirectSearchProviderId(value: unknown): value is DirectSearchProviderId {
  return typeof value === "string" && providerIdSet.has(value);
}

/// 供应商描述。endpoint 与 host 是常量，**没有对应的设置项**（见文件头注释）。
export interface DirectSearchProvider {
  id: DirectSearchProviderId;
  /// 展示名（设置页下拉）。
  label: string;
  /// 固定端点。host 必须等于 new URL(endpoint).hostname，由测试锁住。
  endpoint: string;
  host: string;
  /// 一句话说明去哪儿申请 key 与额度概况（设置页展示，避免用户去搜）。
  hint: string;
}

export const DIRECT_SEARCH_PROVIDERS: Record<DirectSearchProviderId, DirectSearchProvider> = {
  brave: {
    id: "brave",
    label: "Brave Search API",
    endpoint: "https://api.search.brave.com/res/v1/web/search",
    host: "api.search.brave.com",
    hint: "在 brave.com/search/api 申请，免费档每月约 2000 次查询。",
  },
  tavily: {
    id: "tavily",
    label: "Tavily",
    endpoint: "https://api.tavily.com/search",
    host: "api.tavily.com",
    hint: "在 tavily.com 申请，免费档每月约 1000 次查询，结果自带相关度分。",
  },
};

// ---------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------

/// 一次直连调用的完整描述。刻意不用 RequestInit：headers 收窄成 string map，
/// 便于测试直接断言「key 在不在头里」，也杜绝调用方塞进 signal 之外的奇怪字段。
export interface DirectSearchCall {
  url: string;
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    /// 仅 POST 有值。
    body?: string;
  };
}

/// time_range → Brave 的 freshness 参数。`all` 映射为 undefined（不传 = 不限时间）。
const BRAVE_FRESHNESS: Record<string, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

/// time_range → Tavily 的 days 参数（它按「最近 N 天」表达时效）。
const TAVILY_DAYS: Record<string, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

/// 把 limit 夹到 1..maxResultsPerQuery。与 search-api 的 clampLimit 同语义，
/// 但那个是模块私有且返回 undefined（表示「字段不发」）；直连这边两家都需要显式值。
function clampCount(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SEARCH_LIMITS.maxResultsPerQuery;
  return Math.min(SEARCH_LIMITS.maxResultsPerQuery, Math.max(1, Math.round(limit)));
}

/// 构造一次直连搜索调用。
///
/// apiKey **只出现在 headers 里**：Brave 用 X-Subscription-Token，Tavily 用 Authorization。
/// Tavily 的旧版协议允许把 api_key 放进 body，这里刻意不用 —— body 会被完整写进
/// 调试日志与错误诊断文本，头则有统一的擦除路径（见 main 侧的 scrubSecret）。
export function buildDirectSearchCall(
  providerId: DirectSearchProviderId,
  query: SearchBatchQuery,
  apiKey: string,
): DirectSearchCall {
  const provider = DIRECT_SEARCH_PROVIDERS[providerId];
  const text = truncateToChars(query.text.trim(), SEARCH_LIMITS.maxQueryChars);
  const count = clampCount(query.limit);

  if (providerId === "brave") {
    const url = new URL(provider.endpoint);
    url.searchParams.set("q", text);
    url.searchParams.set("count", String(count));
    if (query.language) url.searchParams.set("search_lang", query.language);
    const freshness = query.time_range ? BRAVE_FRESHNESS[query.time_range] : undefined;
    if (freshness) url.searchParams.set("freshness", freshness);
    return {
      url: url.toString(),
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
      },
    };
  }

  // tavily
  const body: Record<string, unknown> = {
    query: text,
    max_results: count,
    // basic 而非 advanced：advanced 会在服务端做一次额外抓取与重排，费用与延迟都翻倍，
    // 而 CRE 本地本来就有抓取 + 重排管线，服务端那一份是纯浪费。
    search_depth: "basic",
  };
  // Tavily 用 topic 而非类别集合。只有 news 有明确对应；其余类别（general/it/science）
  // 都落在它的默认 topic 上，不做牵强映射。
  if (query.categories?.includes("news")) body.topic = "news";
  const days = query.time_range ? TAVILY_DAYS[query.time_range] : undefined;
  if (days !== undefined) body.days = days;
  if (query.domain_allowlist?.length) body.include_domains = [...query.domain_allowlist];
  if (query.domain_blocklist?.length) body.exclude_domains = [...query.domain_blocklist];

  return {
    url: provider.endpoint,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
  };
}

// ---------------------------------------------------------------------------
// 响应归一
// ---------------------------------------------------------------------------

/// 读一个可选的非空字符串字段；非字符串或空串一律 undefined。
function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/// 取出响应里的原始结果数组。两家的嵌套位置不同，且都可能整体缺失。
function extractRawResults(providerId: DirectSearchProviderId, raw: unknown): unknown[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const source = raw as Record<string, unknown>;
  if (providerId === "brave") {
    const web = source.web;
    if (typeof web !== "object" || web === null || Array.isArray(web)) return [];
    const results = (web as Record<string, unknown>).results;
    return Array.isArray(results) ? results : [];
  }
  const results = source.results;
  return Array.isArray(results) ? results : [];
}

/// 校验并归一 URL。只接受 http/https —— 其余协议（javascript:、ftp:、data:）
/// 一旦进入候选池就会被当成可抓取来源送进 worker，虽然 worker 侧还有闸，
/// 但脏数据不该走到那么远。
function normalizeUrl(value: unknown): { url: string; domain: string } | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.hostname.length === 0) return null;
  return { url: parsed.toString(), domain: parsed.hostname };
}

/// 名次兜底分：第一条 1.0，之后线性递减但恒 > 0。
///
/// Brave 不回相关度分，Tavily 偶尔缺 score。下游 candidate-selector 按 score 排序取样，
/// 全给同一个值会让「保留 serverScore 最高的那条」退化成随机，所以必须保住名次信息。
function rankScore(index: number, total: number): number {
  if (total <= 1) return 1;
  return 1 - index / total;
}

/// 把商业 API 的响应归一为 SearchResultItem[]。
///
/// 契约：**对任意 unknown 输入都不抛错**。这与 Search Server 那条路径刻意不同——
/// 那边形状对不上意味着契约漂移或中间人，值得整份判错；这边是第三方 API 的自然演进，
/// 判错会让用户在某天早上突然「研究完全不能用」，降级成少几条结果要好得多。
export function parseDirectSearchResults(
  providerId: DirectSearchProviderId,
  raw: unknown,
): SearchResultItem[] {
  const rawResults = extractRawResults(providerId, raw);
  const items: SearchResultItem[] = [];
  const seenUrls = new Set<string>();

  for (const entry of rawResults) {
    if (items.length >= SEARCH_LIMITS.maxResultsPerQuery) break;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const source = entry as Record<string, unknown>;

    const location = normalizeUrl(source.url);
    if (!location) continue;
    // 商业 API 也会回重复 URL（同页不同锚点、CDN 镜像）。这里先去一次重，
    // 下游 candidate-selector 还会按 canonical URL 再去一次。
    if (seenUrls.has(location.url)) continue;
    seenUrls.add(location.url);

    const item: SearchResultItem = {
      url: location.url,
      // title 在契约里是必填。缺失时用域名兜底而不是空串——空标题在 UI 上是一片空白，
      // 用户无从判断这条来源是什么。
      title: readString(source, "title") ?? location.domain,
      domain: location.domain,
      engines: [providerId],
      score: 0,
    };

    // 摘要字段两家不同名：Brave 是 description，Tavily 是 content。
    const snippet = readString(source, providerId === "brave" ? "description" : "content");
    if (snippet) item.snippet = snippet;

    // 发布时间同样不同名，且都可能缺。
    const publishedAt = readString(source, providerId === "brave" ? "page_age" : "published_date");
    if (publishedAt) item.published_at = publishedAt;

    // Tavily 给 0..1 的相关度分，直接沿用；非有限数（远端回了 null/字符串/NaN）落名次兜底。
    const rawScore = source.score;
    item.score = typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : Number.NaN;
    items.push(item);
  }

  // 名次兜底必须等全部收完才能算（需要 total）。
  return items.map((item, index) =>
    Number.isFinite(item.score) ? item : { ...item, score: rankScore(index, items.length) },
  );
}

// ---------------------------------------------------------------------------
// 批量响应拼装
// ---------------------------------------------------------------------------

/// 单条查询的直连结果。error 是**已分类的错误码**（不是给人看的文本）——
/// 它会原样出现在 SearchQueryResult.errors[].code 里，编排层与 UI 按码分支。
export interface DirectSearchQueryOutcome {
  queryId: string;
  items: SearchResultItem[];
  error?: string;
}

/// 把逐条查询的结果拼成与 Search Server **完全同形**的 SearchBatchResponse。
///
/// 同形是这条逃生阀的核心价值：编排层、候选选择、证据链、引用校验全都不需要知道
/// 结果来自哪条路径，因此 direct-search 是真正的 drop-in，而不是第二套并行实现。
export function toDirectSearchBatchResponse(input: {
  requestId: string;
  provider: DirectSearchProviderId;
  durationMs: number;
  perQuery: readonly DirectSearchQueryOutcome[];
}): SearchBatchResponse {
  const results: SearchQueryResult[] = input.perQuery.map((outcome) => ({
    query_id: outcome.queryId,
    items: outcome.items,
    errors: outcome.error ? [{ provider: input.provider, code: outcome.error }] : [],
  }));

  const returned = results.reduce((sum, result) => sum + result.items.length, 0);

  return {
    request_id: input.requestId,
    results,
    stats: {
      // 直连恒为单一 provider。
      provider_count: 1,
      // 直连拿不到「去重前的原始条数」（远端不告诉我们），与返回条数取同值。
      raw_result_count: returned,
      returned_result_count: returned,
      // 直连没有服务端缓存层，恒 false —— 别让 UI 显示一个假的缓存命中。
      cache_hit: false,
      duration_ms: Math.max(0, Math.round(input.durationMs)),
    },
  };
}
