// CRE 的窄同步检索面：discover（只搜不抓）+ prepare（抓指定 URL）。
//
// 契约与设计理由见 core/research/quick-types 的文件头。这里只记实现侧的三条约束：
//
//   1. **不建 Session、不落 SQLite、不写 blob**。这一面服务于交互式调用（agent 工具、
//      发消息前补齐），一次调用产生一行会话记录只会把「研究」列表冲成一堆一次性噪音。
//      代价是结果不可回溯——所以引用锚在 URL 上，调用方自己透出给用户核对。
//   2. **复用而不是重写**：搜索客户端、候选选择、Worker 抓取、URL 安全闸全部走深度研究
//      那一套现成实现。任何在这里另写一份"轻量版"的冲动都要按下去——两份实现必然漂移，
//      而漂移的地方恰好是安全闸。
//   3. **准入闸不可绕过**：两个方法都先过 assertResearchEnabled（与 ResearchService 同一份判定）。
import { randomUUID } from "node:crypto";
import type { ResearchEngineSettings } from "@cortex-work/core/research/settings";
import {
  QUICK_RETRIEVAL_LIMITS,
  clampGatherDocuments,
  clampLeadLimit,
  clampPrepareUrls,
  clipPreparedDocuments,
  isRetryableSearchError,
  type DiscoveryRequest,
  type DiscoveryResult,
  type GatherRequest,
  type GatherResult,
  type PrepareFailure,
  type PreparedSourcesResult,
  type PrepareSourcesRequest,
  type SearchProviderError,
} from "@cortex-work/core/research/quick-types";
import { buildSearchBatchRequest } from "@cortex-work/core/research/search-api";
import { checkUrlPolicy } from "@cortex-work/core/research/url-safety";
import { DEFAULT_SOURCE_POLICIES } from "@cortex-work/core/research/trust-policy";
import type { SearchCandidate } from "@cortex-work/core/research/evidence";

import { assertResearchEnabled, SearchServerNotConfiguredError } from "./consumer-gate";
import { selectCandidates, toSearchCandidates } from "./candidate-selector";
import type { SearchClientLike } from "./research-orchestrator";
import type { ResearchWorkerProvider } from "./research-service";
import {
  mapFetchPrepareResult,
  toWorkerCandidates,
  type WorkerFetchPrepareParams,
} from "./worker-mapping";

/// 抓取管线的并发与体积上限。**刻意比编排层更小**：编排层一轮抓 24~50 篇，
/// 这里最多 5 篇，沿用那边的 50 MiB / 6 并发只会让一次交互式调用有能力吃掉几十 MB 内存。
const QUICK_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const QUICK_HTTP_CONCURRENCY = 3;
const QUICK_PER_HOST_CONCURRENCY = 2;
const QUICK_REQUEST_TIMEOUT_MS = 10_000;

/// 极简并发闸：同时最多 limit 个任务在跑，其余排队。
///
/// **为什么需要它**：模型在一轮里会并发甩出好几个 web_search，而商业搜索免费档普遍是
/// 1 QPS 量级，无闸并发会让大半请求被限流。这里不引入调度库——一个计数器加一条等待队列
/// 就够，且行为完全可预测（FIFO，无优先级、无超时抢占）。
///
/// 闸只管上游搜索请求，不管抓取：抓取那边有自己的 HTTP/host 并发参数。
class ConcurrencyGate {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      // 只放行一个，保持在飞数恒 ≤ limit。**必须在 finally 里放**，否则任务抛错时
      // 队列会永久卡住（一次搜索报错让此后所有搜索排队等死）。
      this.queue.shift()?.();
    }
  }
}

/// 上游错误里是否存在值得退避重试的码。
function hasRetryableError(errors: readonly SearchProviderError[]): boolean {
  return errors.some((error) => isRetryableSearchError(error.code));
}

/// 可被 signal 打断的退避等待。
function backoffDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/// QuickRetrieval 的依赖。与 ResearchServiceDeps 同风格：全部注入，无模块级单例。
export interface QuickRetrievalDeps {
  /// 读当前设置快照（每次调用都重读，设置页改动立即生效）。
  settings: () => ResearchEngineSettings;
  /// 按当前设置构造搜索客户端；未配置返回 null。
  createSearchClient: () => SearchClientLike | null;
  workerProvider: ResearchWorkerProvider;
  newId?: () => string;
  blockedDomains?: () => readonly string[];
  agentBrowserBinary?: () => string | null;
  logger?: { warn(...args: unknown[]): void };
}

/// 窄面实现。单例复用即可——**唯一的实例级状态是搜索并发闸**（见 searchGate），
/// 它必须跨调用共享才有意义，这也是这个类不再是纯无状态的原因。
export class QuickRetrieval {
  /// 上游搜索的并发闸。跨 discover 调用共享，用来压住模型的并发批量搜索。
  private readonly searchGate = new ConcurrencyGate(QUICK_RETRIEVAL_LIMITS.maxSearchConcurrency);

  constructor(private readonly deps: QuickRetrievalDeps) {}

  /// 搜索线索：只发一次搜索，不抓取任何页面。典型 2~5 秒。
  ///
  /// 单条查询而非批量：调用方（agent 工具 / 会话补齐）一次就问一件事，
  /// 拆多条查询是 Planner 的职责，属于会话式路径。
  async discover(request: DiscoveryRequest, signal?: AbortSignal): Promise<DiscoveryResult> {
    assertResearchEnabled(this.deps.settings(), request.consumer);

    const searchClient = this.deps.createSearchClient();
    if (!searchClient) throw new SearchServerNotConfiguredError();

    const limit = clampLeadLimit(request.limit);
    const batch = buildSearchBatchRequest({
      requestId: this.newId(),
      // 窄面没有 Session。传一个一次性 id 而不是空串：服务端用它做限流与审计分组，
      // 空串会让所有窄面调用挤进同一个桶。
      sessionId: `quick-${this.newId()}`,
      queries: [
        {
          queryId: "q1",
          // PlannedQuery 要求 subquestionId（会话式路径用它把候选归到子问题）。
          // 窄面没有子问题拆解，填一个固定值即可——它不会离开本次调用。
          subquestionId: "q1",
          text: request.query,
          ...(request.categories ? { categories: [...request.categories] } : {}),
          ...(request.timeRange ? { timeRange: request.timeRange } : {}),
          limit,
        },
      ],
    });

    // 过并发闸 + 限流退避重试。**超时按「每次尝试」独立计**（不是整个重试链共用一个 8s）：
    // 限流响应通常是快速失败，共用预算会让重试根本没机会跑完。
    const response = await this.searchGate.run(async () => {
      let attempt = 0;
      for (;;) {
        const combined = this.withTimeout(QUICK_RETRIEVAL_LIMITS.discoverTimeoutMs, signal);
        const current = await searchClient.searchBatch(batch, combined);
        const errors = collectProviderErrors(current);
        // 只在「一条结果都没拿到」且「错误是临时性的」时重试：
        // 有结果说明这次调用已经有用了，重试纯属浪费上游配额；
        // auth/配置类错误重试一万次也不会变好，只会让工具调用白等。
        const empty = current.results.every((r) => r.items.length === 0);
        if (
          attempt >= QUICK_RETRIEVAL_LIMITS.searchRetries ||
          !empty ||
          !hasRetryableError(errors)
        ) {
          return current;
        }
        attempt += 1;
        this.deps.logger?.warn(
          `[quick-retrieval] 上游临时失败，${QUICK_RETRIEVAL_LIMITS.searchRetryBackoffMs}ms 后重试`,
          errors.map((e) => `${e.provider}:${e.code}`).join(","),
        );
        await backoffDelay(QUICK_RETRIEVAL_LIMITS.searchRetryBackoffMs, signal);
        if (signal?.aborted) return current;
      }
    });

    const candidates = toSearchCandidates(response, { newId: () => this.newId() });
    // 复用编排层的候选选择：URL 归一去重 + 单域名配额 + 域名黑名单。
    // 这三件事在窄面同样必要——搜索结果里同一站点连着 5 条是常态，全塞给 agent 只是浪费上下文。
    const selected = selectCandidates({
      candidates,
      alreadyFetched: new Set(),
      // 借 budget.maxDocuments 表达"要几条线索"：selectCandidates 用它做名额上限。
      budget: quickBudgetForLeads(limit),
      ...(this.deps.blockedDomains ? { blockedDomains: this.deps.blockedDomains() } : {}),
    });

    return {
      leads: selected.map((candidate) => ({
        url: candidate.url,
        title: candidate.title,
        domain: candidate.domain,
        ...(candidate.snippet !== undefined ? { snippet: candidate.snippet } : {}),
        ...(candidate.publishedAt !== undefined ? { publishedAt: candidate.publishedAt } : {}),
      })),
      warnings: collectSearchWarnings(response),
      // 结构化错误码与 warnings 同源。**有才带这个键**（exactOptionalPropertyTypes 下
      // `key: undefined` 不合法），空数组也不带——调用方只需判「有没有」。
      ...(collectProviderErrors(response).length > 0
        ? { providerErrors: collectProviderErrors(response) }
        : {}),
    };
  }

  /// 抓取指定 URL 并抽取正文。典型 3~15 秒（取决于目标站点）。
  ///
  /// **URL 先过本地安全闸再进 Worker**：Worker 侧的 safe-request 有完整的三道闸
  /// （URL 策略 → DNS 私网判定 → 连接钉扎），这里这一道是**提前拒绝 + 给出可读原因**——
  /// 让调用方拿到「这个地址不允许访问」而不是「抓取失败」，同时省掉一次跨进程往返。
  /// 它不替代 Worker 侧的闸，只是把明显非法的输入挡在进程边界之外。
  async prepare(
    request: PrepareSourcesRequest,
    signal?: AbortSignal,
  ): Promise<PreparedSourcesResult> {
    assertResearchEnabled(this.deps.settings(), request.consumer);

    const failures: PrepareFailure[] = [];
    const candidates: SearchCandidate[] = [];

    for (const [index, url] of clampPrepareUrls(request.urls).entries()) {
      const policy = checkUrlPolicy({
        url,
        ...(this.deps.blockedDomains ? { blocklist: [...this.deps.blockedDomains()] } : {}),
      });
      if (!policy.ok) {
        failures.push({ url, reason: policy.message });
        continue;
      }
      candidates.push({
        candidateId: this.newId(),
        // 窄面没有查询，用一个固定 queryId：worker-mapping 需要它把 chunk 归到子问题上，
        // 而这里没有子问题，归到哪儿都一样。
        queryId: "q1",
        title: policy.url.hostname,
        url: policy.url.toString(),
        domain: policy.url.hostname,
        engines: [],
        // 保序：靠前的 URL 分更高，让 selectCandidates 之外的下游也维持调用方给的顺序。
        serverScore: 1 - index / QUICK_RETRIEVAL_LIMITS.maxUrls,
        trustZone: "public_web",
      });
    }

    if (candidates.length === 0) return { documents: [], failures };

    const worker = await this.deps.workerProvider.ensure();
    const params: WorkerFetchPrepareParams = {
      operation_id: this.newId(),
      objective: request.objective,
      subquestions: [],
      candidates: toWorkerCandidates(candidates),
      known_fingerprints: [],
      policy: {
        trust_zone: "public_web",
        allow_search_server: DEFAULT_SOURCE_POLICIES.public_web.allowSearchServer,
        allow_cloud_model: DEFAULT_SOURCE_POLICIES.public_web.allowCloudModel,
        allow_cross_session_reuse: DEFAULT_SOURCE_POLICIES.public_web.allowCrossSessionReuse,
      },
      limits: {
        max_documents: candidates.length,
        // 窄面**不开浏览器兜底**：启动 Chrome 动辄数秒，与「交互式调用」的时延预算冲突。
        // 需要浏览器才拿得到的站点，走深度研究那条路。
        max_browser_fetches: 0,
        max_total_bytes: QUICK_MAX_TOTAL_BYTES,
        max_duration_ms: QUICK_RETRIEVAL_LIMITS.prepareTimeoutMs,
        http_concurrency: QUICK_HTTP_CONCURRENCY,
        per_host_concurrency: QUICK_PER_HOST_CONCURRENCY,
        request_timeout_ms: QUICK_REQUEST_TIMEOUT_MS,
      },
    };

    const raw = await this.runWithTimeout(
      () => worker.request("fetch_prepare", params),
      QUICK_RETRIEVAL_LIMITS.prepareTimeoutMs,
      signal,
    );

    const mapped = mapFetchPrepareResult(raw, {
      newId: () => this.newId(),
      candidates: new Map(candidates.map((c) => [c.candidateId, c])),
      subquestionByQueryId: new Map(),
    });

    const documents = mapped.documents
      // duplicateOf 有值 = 与前一篇内容重复，正文不会单独回传，收进来只会是空壳。
      .filter((document) => document.duplicateOf === undefined)
      .map((document) => ({
        url: document.canonicalUrl ?? document.source.locator,
        ...(document.title ? { title: document.title } : {}),
        text: mapped.texts.get(document.documentId) ?? "",
        fetchMethod: document.fetchMethod,
        ...(document.publishedAt !== undefined ? { publishedAt: document.publishedAt } : {}),
      }))
      .filter((document) => document.text.length > 0);

    for (const failure of mapped.failures) {
      failures.push({ url: failure.url, reason: failure.message });
    }

    return { documents: clipPreparedDocuments(documents), failures };
  }

  /// discover + prepare 的组合：搜一次，把前 N 条读回来。
  ///
  /// **组合放在主进程而不是让调用方自己串**：否则渲染端要先拿到线索、再挑几条传回来抓，
  /// 那等于开了一条「renderer 指定主进程抓任意 URL」的通道——正是 ipc/research.ts 的
  /// sourceScopeSchema 花力气堵住的东西。
  ///
  /// 失败语义：搜索失败直接抛（调用方需要区分"没配好"与"没搜到"）；
  /// 抓取失败不抛，收敛进 failures——三条抓到一条也比整轮失败有用。
  async gather(request: GatherRequest, signal?: AbortSignal): Promise<GatherResult> {
    const documentLimit = clampGatherDocuments(request.documentLimit);
    const discovery = await this.discover(
      {
        consumer: request.consumer,
        query: request.query,
        ...(request.timeRange ? { timeRange: request.timeRange } : {}),
        // 多要一些线索再从中取前 N 条：selectCandidates 的域名配额会砍掉同站的重复项，
        // 只要 N 条的话，一次同站扎堆的搜索结果会让实际抓取数远低于预期。
        limit: Math.min(QUICK_RETRIEVAL_LIMITS.maxLeads, documentLimit * 2),
      },
      signal,
    );

    if (discovery.leads.length === 0) {
      return { documents: [], failures: [], warnings: discovery.warnings };
    }

    const prepared = await this.prepare(
      {
        consumer: request.consumer,
        objective: request.query,
        urls: discovery.leads.slice(0, documentLimit).map((lead) => lead.url),
      },
      signal,
    );
    return { ...prepared, warnings: discovery.warnings };
  }

  private newId(): string {
    return this.deps.newId?.() ?? randomUUID();
  }

  /// 组合「调用方取消」与「窄面超时」两个信号。
  private withTimeout(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  }

  /// 给不接受 AbortSignal 的调用加超时。
  ///
  /// Worker 的 request() 只按 operation_id 路由，没有取消入参（取消是编排层经
  /// worker.request("cancel") 单独发的）。窄面不做那套——一次交互式调用超时了就当它没发生，
  /// Worker 那边跑完自己会丢弃结果。**代价是超时后 Worker 仍在抓**，
  /// 由 max_duration_ms 兜住（与此处取同值），不会无限跑下去。
  private async runWithTimeout<T>(
    run: () => Promise<T>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const combined = this.withTimeout(timeoutMs, signal);
    return Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        if (combined.aborted) {
          reject(new Error("检索已取消或超时"));
          return;
        }
        combined.addEventListener("abort", () => reject(new Error("检索已取消或超时")), {
          once: true,
        });
      }),
    ]);
  }
}

/// 借 ResearchBudget 的形状向 selectCandidates 表达"要几条线索"。
///
/// selectCandidates 只读 budget.maxDocuments（见其实现首行），其余字段填 0 即可；
/// 但字段不能省——类型要求完整的 ResearchBudget，而给一个假的大值会让人误以为
/// 窄面真的有那么多预算。
function quickBudgetForLeads(limit: number): Parameters<typeof selectCandidates>[0]["budget"] {
  return {
    maxRounds: 1,
    maxQueries: 1,
    maxCandidates: limit,
    maxDocuments: limit,
    maxBrowserFetches: 0,
    maxDurationMs: QUICK_RETRIEVAL_LIMITS.discoverTimeoutMs,
    maxEvidenceCharsToModel: QUICK_RETRIEVAL_LIMITS.maxTotalChars,
  };
}

/// 把搜索响应里的上游错误按 provider+code 去重收集（结构化形态）。
///
/// 与 collectSearchWarnings 同源，区别是**保留错误码**：重试判定与上层的
/// 「限流 vs 没命中」分流都要靠 code，拍平成中文字符串就只能靠匹配文案猜。
function collectProviderErrors(response: {
  results: ReadonlyArray<{ errors: ReadonlyArray<{ provider: string; code: string }> }>;
}): SearchProviderError[] {
  const seen = new Map<string, SearchProviderError>();
  for (const result of response.results) {
    for (const error of result.errors) {
      seen.set(`${error.provider} ${error.code}`, {
        provider: error.provider,
        code: error.code,
      });
    }
  }
  return [...seen.values()];
}

/// 把搜索响应里的局部失败转成可展示的一句话。
///
/// 不静默丢掉：搜索后端只是部分可用时，用户看到的结果会莫名其妙地少，
/// 有这句话才知道是"引擎挂了"而不是"确实没有相关内容"。
function collectSearchWarnings(response: {
  results: ReadonlyArray<{ errors: ReadonlyArray<{ provider: string; code: string }> }>;
}): string[] {
  const seen = new Set<string>();
  for (const result of response.results) {
    for (const error of result.errors) {
      seen.add(`搜索源 ${error.provider} 未返回结果（${error.code}）`);
    }
  }
  return [...seen];
}
