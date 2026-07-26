// CRE 的「窄同步检索面」契约：discover / prepare（架构文档 §7.1 的 ResearchEngine 接口）。
//
// **为什么需要它**：现有的 ResearchEngineFacade 是会话式的——create 建会话、run 启动即返回、
// 结果经 research:event 广播。那套设计对多轮深度研究是对的（可中断、可恢复、覆盖层卸载不打断），
// 但对「agent 调一次工具要拿到结果」「发消息前补一段最新资料」这类交互式调用完全用不了：
// 调用方拿不到返回值，只能去订阅一条全局事件流再自己按 sessionId 过滤。
//
// 因此这一面是**请求-响应**的：一次调用、一个返回值、不建 Session、不落 SQLite。
// 它与深度研究共用同一套搜索客户端、抓取 Worker 与安全闸，只是不共用会话与证据持久化。
//
// **引用形态的差异（重要）**：深度研究的引用锚在持久化的 chunkId 上，由 citation-validator
// 校验模型不能凭空捏造。窄面不落库，chunkId 无处可查，所以这里的引用单位是 **URL**——
// 调用方（MCP 工具 / 会话注入）把 URL 原样透出给用户即可点开核对。别在这条路径上发明
// 一套查不回去的 chunkId，那比没有引用更糟。
//
// 相关文件：搜索契约见 ./search-api；深度研究的类型见 ./types；实现在
// apps/desktop/src/main/research/quick-retrieval.ts。
import type { ResearchConsumer } from "./types";
import type { SearchCategory } from "./search-api";
import type { FetchMethod } from "./evidence";

/// 窄面的硬限制。**刻意比 MODE_BUDGETS.quick 更紧**：那一档是给「用户点了开始、愿意等」
/// 的场景定的（90s），而这一面服务于交互式调用——agent 的一次工具调用、发消息前的一次补齐。
/// 在这些场景里，超时比结果不全伤害大得多：慢 30 秒的回答，用户当作卡死。
export const QUICK_RETRIEVAL_LIMITS = {
  /// discover 的总超时。
  discoverTimeoutMs: 8_000,
  /// discover 单次最多返回的线索数。
  maxLeads: 10,
  /// prepare 的总超时（含抓取、抽取、分块）。
  prepareTimeoutMs: 20_000,
  /// prepare 单次最多抓取的 URL 数。超出部分直接截断——一次工具调用抓 20 个页面
  /// 既慢又会把 agent 的上下文塞爆。
  maxUrls: 5,
  /// 单篇正文回传给调用方的字符上限。
  maxCharsPerDocument: 8_000,
  /// 一次 prepare 回传的正文字符总上限。与 MODE_BUDGETS.quick 的
  /// maxEvidenceCharsToModel（20k）取同值：两者都是「一次交互能塞给模型多少」的闸。
  maxTotalChars: 20_000,
  /// 同时在飞行的上游搜索请求上限。
  ///
  /// 为什么必须有：模型在一轮里会并发甩出好几个 web_search（实测一次 3~5 个），而
  /// 商业搜索的免费档普遍是 1 QPS 量级（Brave 免费档即是）。无闸并发 → 大半请求被限流 →
  /// 模型看到"没搜到"就换词再试 → 配额烧得更快。取 2 而不是 1：完全串行会让批量搜索
  /// 明显变慢，而 2 已经能把限流压到靠一次退避重试就能救回来的程度。
  maxSearchConcurrency: 2,
  /// 上游临时错误（限流等）的退避重试次数。**只重试一次**：交互式工具调用不能为了
  /// 一条搜索等太久，而限流响应通常是快速失败，一次退避已能救回大多数情况。
  searchRetries: 1,
  /// 退避等待。取 1s 是因为免费档的配额窗口通常按秒计。
  searchRetryBackoffMs: 1_000,
} as const;

// ---------------------------------------------------------------------------
// discover：只搜不抓
// ---------------------------------------------------------------------------

/// 发现请求。**没有 sessionId、没有 sourceScopes**：窄面只走公网搜索，
/// 本地文件与企业来源属于会话式路径（需要目录授权流程，见 ipc/research.ts 的 sourceScopeSchema）。
export interface DiscoveryRequest {
  consumer: ResearchConsumer;
  query: string;
  categories?: SearchCategory[];
  timeRange?: "day" | "week" | "month" | "year" | "all";
  /// 期望的线索条数；会被夹到 maxLeads 以内。
  limit?: number;
}

/// 一条搜索线索。**是线索不是证据**（spec KTD3）：snippet 来自搜索引擎的摘要，
/// 未经抓取与核对，不得被当作事实直接引用——要引用必须先 prepare 拿正文。
export interface DiscoveryLead {
  url: string;
  title: string;
  domain: string;
  snippet?: string;
  publishedAt?: string;
}

/// 上游搜索源的错误码。**保留结构而不是只留人话字符串**：调用方要据此分流——
/// 「配额被限流」和「这个词确实没有结果」对 agent 是截然不同的信号，前者该退避、后者该换词。
/// 曾经只有 warnings: string[]，server 层只能靠匹配中文文案猜，于是把限流一律说成
/// 「没有搜到相关结果」，模型换个词继续搜，反而把配额烧得更快。
export interface SearchProviderError {
  provider: string;
  code: string;
}

/// 视为「上游临时不可用、值得退避重试」的错误码。
///
/// 只收**明确表示"稍后再来"**的码。auth/配置类错误重试是纯浪费（重试一万次也不会有 key），
/// 且会拖长每次工具调用的等待。
export const RETRYABLE_SEARCH_ERROR_CODES: readonly string[] = [
  "rate_limited",
  "timeout",
  "unavailable",
  "upstream_error",
];

/// 该错误码是否值得退避重试。
export function isRetryableSearchError(code: string): boolean {
  return RETRYABLE_SEARCH_ERROR_CODES.includes(code.toLowerCase());
}

export interface DiscoveryResult {
  leads: DiscoveryLead[];
  /// 局部失败说明（某个 provider 挂了但其它有结果）。可直接展示给用户，不含凭据。
  warnings: string[];
  /// 上游错误的结构化形态，与 warnings 同源（warnings 是它的人话渲染）。
  /// 缺省/空数组 = 没有上游错误。调用方用它区分「限流」与「没命中」。
  providerErrors?: SearchProviderError[];
}

// ---------------------------------------------------------------------------
// prepare：抓取指定 URL 并抽取正文
// ---------------------------------------------------------------------------

/// 抓取请求。objective 只用于 Worker 侧的相关性预排序，不参与安全判定。
export interface PrepareSourcesRequest {
  consumer: ResearchConsumer;
  objective: string;
  urls: string[];
}

/// 抓取并抽取后的文档。text 已按 maxCharsPerDocument 截断。
export interface PreparedDocument {
  url: string;
  title?: string;
  text: string;
  /// 正文是否因超出字符上限被截断。调用方据此决定要不要提示"内容未完整"。
  truncated: boolean;
  /// 复用领域侧的 FetchMethod 而不是另写一个窄union：那边加了 "stealth" 之后，
  /// 两份枚举会在某次映射时静默漏掉一档。
  fetchMethod: FetchMethod;
  publishedAt?: string;
}

/// 单个 URL 的失败。reason 是**可展示给用户的一句话**，不含内网地址与凭据。
export interface PrepareFailure {
  url: string;
  reason: string;
}

export interface PreparedSourcesResult {
  documents: PreparedDocument[];
  failures: PrepareFailure[];
}

// ---------------------------------------------------------------------------
// gather：discover + prepare 的组合
// ---------------------------------------------------------------------------

/// 一次「搜一下并把前几条读回来」的请求。
///
/// 存在的理由：会话内自动检索与写作检索都需要这个组合，而「搜完抓哪几条」不该交给
/// 渲染端决定——那等于让 renderer 指挥主进程去抓任意 URL。组合在主进程内完成。
export interface GatherRequest {
  consumer: ResearchConsumer;
  query: string;
  timeRange?: "day" | "week" | "month" | "year" | "all";
  /// 抓取几条线索；会被夹到 maxGatherDocuments 以内。
  documentLimit?: number;
}

export interface GatherResult {
  documents: PreparedDocument[];
  failures: PrepareFailure[];
  /// 搜索源的局部失败说明（可直接展示，不含凭据）。
  warnings: string[];
}

/// gather 默认抓几条。
///
/// 取值依据：这是**每轮对话都可能发生**的开销，3 条在实测下总耗时约 5~10 秒，
/// 是「用户还愿意等」的上限；再多既拖延迟又稀释相关性（第 4 条往后通常已经跑题）。
export const DEFAULT_GATHER_DOCUMENTS = 3;

/// gather 的抓取条数上限。不超过 prepare 本身的 maxUrls。
export const MAX_GATHER_DOCUMENTS = QUICK_RETRIEVAL_LIMITS.maxUrls;

/// 把 gather 的 documentLimit 夹到 1..MAX_GATHER_DOCUMENTS；缺省取 DEFAULT_GATHER_DOCUMENTS。
export function clampGatherDocuments(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_GATHER_DOCUMENTS;
  return Math.min(MAX_GATHER_DOCUMENTS, Math.max(1, Math.round(limit)));
}

// ---------------------------------------------------------------------------
// 夹取helper（纯函数，两端共用）
// ---------------------------------------------------------------------------

/// 把 discover 的 limit 夹到 1..maxLeads；缺省取 maxLeads。
export function clampLeadLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return QUICK_RETRIEVAL_LIMITS.maxLeads;
  return Math.min(QUICK_RETRIEVAL_LIMITS.maxLeads, Math.max(1, Math.round(limit)));
}

/// 按 maxUrls 截断 URL 列表，同时去重（保持首次出现的顺序）。
///
/// 去重在这里做而不是交给下游：重复 URL 会各消耗一个抓取名额，5 个名额里塞 3 份同一篇文章
/// 是对预算的实际浪费，而调用方（尤其是 LLM 生成的参数）很容易传重复项。
export function clampPrepareUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const trimmed = url.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= QUICK_RETRIEVAL_LIMITS.maxUrls) break;
  }
  return out;
}

/// 按「单篇上限 + 总上限」裁剪正文，返回裁剪后的文档列表。
///
/// 两级预算的理由：只有单篇上限时，5 篇 × 8k = 40k 字符会把 quick 档的模型预算翻一倍；
/// 只有总上限时，第一篇长文会把额度吃光，后面几篇一个字都进不来（而多来源正是引用可信度的来源）。
/// 因此先按单篇截，再按总量截，且总量耗尽后**不再收录后续文档**而不是收一个空壳。
export function clipPreparedDocuments(
  documents: readonly Omit<PreparedDocument, "truncated">[],
): PreparedDocument[] {
  const out: PreparedDocument[] = [];
  let remaining = QUICK_RETRIEVAL_LIMITS.maxTotalChars;

  for (const document of documents) {
    if (remaining <= 0) break;
    const budget = Math.min(QUICK_RETRIEVAL_LIMITS.maxCharsPerDocument, remaining);
    const points = [...document.text];
    const truncated = points.length > budget;
    const text = truncated ? points.slice(0, budget).join("") : document.text;
    remaining -= [...text].length;
    out.push({ ...document, text, truncated });
  }
  return out;
}
