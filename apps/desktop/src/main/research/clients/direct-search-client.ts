// 直连商业搜索的 main 侧 HTTP 客户端（Search Server 未部署时的逃生阀）。
//
// 它实现的是编排层唯一认识的最小面 `SearchClientLike`（见 ../research-orchestrator），
// 因此对候选选择、抓取、证据链、引用校验全都是 **drop-in**：下游没有任何一处需要知道
// 结果来自自建 SearXNG 还是商业 API。
//
// 与 SearchServerClient 的三处刻意差异（都有代价明确的理由）：
//   1. **串行发查询**。自建服务端一次 POST 收 8 条查询，由它自己并发；商业 API 是
//      「一次请求一条查询」，按请求计费且都有 QPS 限制。并发打过去的结果是 429 熔断，
//      比慢几秒糟得多。
//   2. **局部失败不抛错**。SearchServerClient 对形状不符的响应整份判错（契约漂移值得炸），
//      这边是第三方 API 的自然演进，判错会让用户某天早上突然「研究完全不能用」，
//      所以失败收敛成 SearchQueryResult.errors，其余查询照常返回。
//   3. **没有 request_id 校验**。商业 API 不回显我们的 request_id，无从校验；
//      作为补偿，responses 与 query 的对应关系由本地逐条发送的顺序保证，不存在串台可能。
//
// 隐私红线：API key 只走请求头（见 core 的 buildDirectSearchCall），且所有对外文本
// 都过 scrubSecret —— 服务端有可能把鉴权头回显进错误体。
import {
  DIRECT_SEARCH_PROVIDERS,
  buildDirectSearchCall,
  parseDirectSearchResults,
  toDirectSearchBatchResponse,
  type DirectSearchProviderId,
  type DirectSearchQueryOutcome,
} from "@cortex-work/core/research/direct-search";
import {
  SEARCH_LIMITS,
  type SearchBatchRequest,
  type SearchBatchResponse,
} from "@cortex-work/core/research/search-api";

import { scrubSecret } from "../redact-research";

/// 单条查询的响应体上限（1 MiB）。20 条结果的正常响应远小于它。
export const MAX_DIRECT_SEARCH_RESPONSE_BYTES = 1024 * 1024;

/// 单条查询超时。比 Search Server 的整批超时短得多——这边一条就是一次往返，
/// 拖长只会让整批 N 条查询的总耗时成倍膨胀。
const DEFAULT_QUERY_TIMEOUT_MS = 12_000;

/// 相邻两条查询之间的间隔。商业 API 的免费档普遍是 1 QPS 左右，
/// 不留间隔会在第二条就吃 429。
const DEFAULT_THROTTLE_MS = 250;

/// 错误分类。**必须是有限枚举**：它原样进 SearchQueryResult.errors[].code，
/// UI 与编排层按码分支，按 message 文本判定会在措辞改动时静默失效。
export type DirectSearchErrorCode =
  /// 401：key 无效或过期，重试无意义。
  | "unauthorized"
  /// 403：key 有效但无权访问该能力（多为额度已耗尽或未开通对应套餐）。
  | "forbidden"
  /// 429：触发限流，可退避后重试。
  | "rate_limited"
  /// 503/502/504：上游临时不可用。
  | "unavailable"
  /// 其它非 2xx。
  | "http_error"
  /// 响应体超过上限。
  | "too_large"
  /// 非 JSON。
  | "invalid_response"
  /// 连接层失败（DNS / TCP / TLS）。
  | "network_error"
  /// 单条查询超时（不是调用方取消——后者直接抛出中断整批）。
  | "timeout";

/// 调用方取消时抛出的错误。取消是**用户意图**，必须中断整批而不是收敛成某条查询的错误：
/// 把它记成 errors 会让 UI 显示「搜索失败」，而用户明明只是点了取消。
export class DirectSearchCancelled extends Error {
  constructor() {
    super("搜索请求已取消");
    this.name = "DirectSearchCancelled";
  }
}

/// 连接配置。apiKey 是**已解密的明文**，只在 main 内存里存在，永不进日志、永不回 renderer。
export interface DirectSearchConfig {
  provider: DirectSearchProviderId;
  apiKey: string;
}

/// 注入依赖（照 search-server-client 的惯例：fetchFn 可注入，测试零网络）。
export interface DirectSearchDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /// 相邻查询的间隔；测试传 0。
  throttleMs?: number;
}

/// 直连搜索客户端。无状态，可安全复用。
export class DirectSearchClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly throttleMs: number;

  constructor(
    private readonly config: DirectSearchConfig,
    deps: DirectSearchDeps = {},
  ) {
    this.fetchFn = deps.fetchFn ?? globalThis.fetch;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    this.throttleMs = deps.throttleMs ?? DEFAULT_THROTTLE_MS;
  }

  /// 逐条发送批量请求里的查询，拼成与 Search Server 同形的响应。
  async searchBatch(request: SearchBatchRequest, signal?: AbortSignal): Promise<SearchBatchResponse> {
    // 与 Search Server 同限额：超出部分直接截断，而不是发出去等对方拒。
    const queries = request.queries.slice(0, SEARCH_LIMITS.maxQueriesPerRequest);
    const startedAt = Date.now();
    const perQuery: DirectSearchQueryOutcome[] = [];

    for (const [index, query] of queries.entries()) {
      // 每条查询前都重新检查：取消可能发生在上一条的往返途中。
      if (signal?.aborted) throw new DirectSearchCancelled();
      if (index > 0 && this.throttleMs > 0) {
        await this.sleep(this.throttleMs, signal);
      }

      const outcome = await this.runOne(query, signal);
      perQuery.push(outcome);
    }

    return toDirectSearchBatchResponse({
      requestId: request.request_id,
      provider: this.config.provider,
      durationMs: Date.now() - startedAt,
      perQuery,
    });
  }

  /// 发一条查询。**除调用方取消外，任何失败都收敛成 outcome.error 而不抛出。**
  private async runOne(
    query: SearchBatchRequest["queries"][number],
    signal: AbortSignal | undefined,
  ): Promise<DirectSearchQueryOutcome> {
    const call = buildDirectSearchCall(this.config.provider, query, this.config.apiKey);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
      response = await this.fetchFn(call.url, {
        method: call.init.method,
        headers: call.init.headers,
        ...(call.init.body !== undefined ? { body: call.init.body } : {}),
        signal: combined,
      });
    } catch {
      // 调用方取消与本条查询超时必须分开：前者中断整批，后者只是这一条没成。
      if (signal?.aborted) throw new DirectSearchCancelled();
      if (timeoutSignal.aborted) return this.failed(query.query_id, "timeout");
      return this.failed(query.query_id, "network_error");
    }

    // fetch 成功返回但调用方在此期间取消了：同样中断整批（不浪费后续配额）。
    if (signal?.aborted) throw new DirectSearchCancelled();

    if (!response.ok) {
      return this.failed(query.query_id, statusToCode(response.status));
    }

    let text: string;
    try {
      text = await this.readLimited(response);
    } catch {
      return this.failed(query.query_id, "too_large");
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      // 刻意不把 body 拼进任何地方：它整段都可能是攻击者可控的文本。
      return this.failed(query.query_id, "invalid_response");
    }

    // 形状不认识 → 空数组且**不算错误**（见文件头第 2 条差异）。
    return { queryId: query.query_id, items: parseDirectSearchResults(this.config.provider, raw) };
  }

  /// 构造失败结果。error 是错误码而非人话，所以不含凭据；
  /// scrubSecret 在此处是**纵深防御**——万一未来有人把 body 拼进码里，这里仍然拦得住。
  private failed(queryId: string, code: DirectSearchErrorCode): DirectSearchQueryOutcome {
    return { queryId, items: [], error: scrubSecret(code, this.config.apiKey) };
  }

  /// 带上限地读完响应体，超限即断流（同 search-server-client 的理由：
  /// 先 text() 再判长度的话，1 GiB 的恶意响应已经把内存吃完了）。
  private async readLimited(response: Response): Promise<string> {
    const reader = response.body?.getReader?.();
    if (!reader) {
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_DIRECT_SEARCH_RESPONSE_BYTES) {
        throw new Error("too_large");
      }
      return text;
    }

    const decoder = new TextDecoder();
    let total = 0;
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DIRECT_SEARCH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("too_large");
      }
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  }

  /// 可被取消打断的等待。取消时立刻抛，不空等完整的节流间隔。
  private sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      function onAbort(): void {
        clearTimeout(timer);
        reject(new DirectSearchCancelled());
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/// HTTP 状态码 → 错误分类。
function statusToCode(status: number): DirectSearchErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  return "http_error";
}

/// 供应商展示名（设置页与错误提示共用，避免各写一份）。
export function directSearchProviderLabel(provider: DirectSearchProviderId): string {
  return DIRECT_SEARCH_PROVIDERS[provider].label;
}
