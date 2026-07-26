// fetch_prepare：Worker 的主流程（spec §12.2、§12.4）。
//
//   候选 → 受控抓取 → 媒体判定 → 正文抽取 → 归一 → SHA-256 / SimHash → 近重复聚簇
//        → 切块（保留 offset 与标题路径）→ 词法打分 → 结果
//
// 三条铁律（KTD1 / KTD3）：
//   1) Worker **不写数据库、不落 blob、不生成 documentId**——正文与哈希回传给 main，由它落库；
//   2) 抓不到正文的候选**不产生 Document**，只产生一条有限错误码的 failure，绝不用 snippet 顶替；
//   3) 每个 URL 都要独立跑完整安全策略，不能因为「main 已经校验过候选」而跳过。
//
// 本文件跑在 utilityProcess Worker 里，**禁止 import electron**。
import {
  chunkPagedText,
  chunkStructuredText,
  type ChunkDraft,
} from "@cortex-work/core/research/chunking";
import type { IpRange } from "@cortex-work/core/research/url-safety";
import type { FetchFailureCode } from "@cortex-work/core/research/evidence";
import { tmpdir } from "node:os";
import {
  browserFetch,
  type BrowserAdapterDeps,
  type BrowserFetchInput,
  type BrowserFetchResult,
} from "../browser/agent-browser-adapter";
import { BrowserBudget } from "../browser/browser-budget";
import { clusterByHamming } from "../dedup/simhash";
import { normalizeDocument, sha256Hex } from "../document/normalize";
import { extractHtmlDocument } from "../extract/html";
import { extractPdfDocument, type PdfExtractionResult } from "../extract/pdf";
import { FetchLimiter } from "../net/limiter";
import {
  safeRequest,
  type SafeRequestDeps,
  type SafeRequestInput,
  type SafeRequestResult,
} from "../net/safe-request";
import { buildQueryText, scoreChunks } from "../scoring";
import type { FetchPrepareParams, FetchPrepareResult, MethodContext } from "../rpc-server";
import type { DnsLookupFn } from "../net/dns-guard";

/// 近重复的汉明距离阈值。64 位指纹上 3 是「几乎逐字相同」，对带导航残留的转载偏严；
/// 6 在实测的中英混排正文上能识别转载又不会把同主题的不同文章误并。
const DUPLICATE_HAMMING_THRESHOLD = 6;

/// 抓取函数的注入点（默认走 safeRequest）。
export type FetchFn = (
  input: SafeRequestInput,
  deps: SafeRequestDeps,
) => Promise<SafeRequestResult>;

/// PDF 抽取的注入点（默认走 pdfjs）。
export type ExtractPdfFn = (data: Uint8Array) => Promise<PdfExtractionResult>;

/// Browser 降级的注入点（默认走 agent-browser 适配器）。
export type BrowserFetchFn = (
  input: BrowserFetchInput,
  deps?: BrowserAdapterDeps,
  signal?: AbortSignal,
) => Promise<BrowserFetchResult>;

/// HTTP 抓取失败后是否值得起浏览器重试。
///
/// **安全红线：`blocked_by_policy` 永不降级。** 它是安全判定（私网 / 非法 scheme / userinfo /
/// 端口 / 域名黑名单）的结果，若允许降级重试等于给 SSRF 防线开一条绕行道——而 U0 spike S6 实测
/// `agent-browser read` 对简单页面根本不起 Chrome、走它自带的 HTTP 客户端，那条路上没有我们的
/// DNS 钉扎保护。同理 too_large / unsupported_media 也不降级：换个客户端结果一样。
///
/// 值得降级的只有两类「HTTP 拿不到但浏览器可能拿得到」的情形：
///   - empty_content：页面正文由 JS 渲染，静态 HTML 里确实没有；
///   - http_error 403/429：疑似反爬拦截，真实浏览器指纹可能通过。
/// 404/5xx 等不降级——页面确实不存在或服务端故障，起浏览器纯属浪费额度。
export function shouldFallbackToBrowser(code: FetchFailureCode, httpStatus?: number): boolean {
  if (code === "empty_content") return true;
  if (code === "http_error") return httpStatus === 403 || httpStatus === 429;
  return false;
}

/// fetch_prepare 的可注入依赖。forbiddenRanges 与 lookup 透传给抓取层，
/// 集成测试据此把 loopback 假站放行（见 core 的 isForbiddenIp 注释）。
export interface FetchPrepareDeps {
  fetch?: FetchFn;
  extractPdf?: ExtractPdfFn;
  browserFetch?: BrowserFetchFn;
  /// 一次性 action policy 文件的落盘目录（<userData>/research/browser-policy/）。
  /// 缺省时用系统临时目录——Browser 路径的 policy 文件是一次性的，读完即删。
  browserPolicyDir?: string;
  lookup?: DnsLookupFn;
  forbiddenRanges?: readonly IpRange[];
  /// 允许的端口，默认 [80, 443]。同 forbiddenRanges，只为集成测试的本地假站开放，生产不传。
  allowedPorts?: readonly number[];
  now?: () => number;
}

/// 抓取并抽取成功后的中间态（尚未分配 chunk）。
interface PreparedDocument {
  candidateId: string;
  url: string;
  canonicalUrl?: string;
  title: string;
  publishedAt?: string;
  mediaType: string;
  fetchMethod: "http" | "pdf" | "browser" | "stealth";
  text: string;
  contentHash: string;
  simhash: string;
  /// HTML 走结构化切块，PDF 走分页切块，两者的切块入参在这里保留。
  chunkSource:
    | { kind: "html"; headings: ReadonlyArray<{ offset: number; level: number; title: string }> }
    | { kind: "pdf"; pages: ReadonlyArray<{ page: number; text: string }> };
}

/// 单个候选的处理结果。
type CandidateOutcome =
  | { kind: "document"; document: PreparedDocument; bytes: number }
  | { kind: "failure"; failure: { candidate_id: string; url: string; code: FetchFailureCode; message: string; http_status?: number } };

/// 尝试用 Browser 降级抓取一个候选。
///
/// 返回 `null` 表示「没有走 Browser」（不该走 / 不能走 / 没额度 / 走了但失败），调用方据此
/// 保留原始 HTTP 失败。成功时返回一个 fetchMethod 为 `browser` 的 Document。
///
/// 三道前置闸，任一不满足即不起浏览器：
///   1. 失败码值得降级（见 shouldFallbackToBrowser 的安全说明）；
///   2. main 下发了 agent_browser_binary（缺省表示 Browser 不可用）；
///   3. allowed_domains 非空——Browser 路径**必须**有域名白名单，空白名单在 checkUrlPolicy 里
///      的语义是「不限制域名」，对这条路径必须相反地 fail closed。
async function tryBrowserFallback(
  candidate: FetchPrepareParams["candidates"][number],
  params: FetchPrepareParams,
  ctx: MethodContext,
  deps: FetchPrepareDeps,
  browserBudget: BrowserBudget,
  httpCode: FetchFailureCode,
  httpStatus?: number,
): Promise<CandidateOutcome | null> {
  if (!shouldFallbackToBrowser(httpCode, httpStatus)) return null;

  const binary = params.agent_browser_binary;
  const allowedDomains = params.allowed_domains ?? [];
  if (!binary || allowedDomains.length === 0) return null;

  const fetchViaBrowser = deps.browserFetch ?? browserFetch;
  const outcome = await browserBudget.run(() =>
    fetchViaBrowser(
      {
        url: candidate.url,
        sessionId: params.operation_id,
        allowedDomains: [...allowedDomains],
        binary,
        policyDir: deps.browserPolicyDir ?? tmpdir(),
        timeoutMs: params.limits.request_timeout_ms,
        ...(deps.forbiddenRanges ? { forbiddenRanges: deps.forbiddenRanges } : {}),
        ...(deps.allowedPorts ? { allowedPorts: deps.allowedPorts } : {}),
      },
      {},
      ctx.signal,
    ),
  );

  // 额度耗尽不是失败，是「本轮没轮到」——保留原 HTTP 失败，main 可下一轮再排期。
  if (!outcome.ok) return null;
  const result = outcome.value;
  if (!result.ok) return null;

  const normalized = normalizeDocument(result.text);
  if (normalized.text.length === 0) return null;

  return {
    kind: "document",
    // Browser 路径没有可靠的字节计数（agent-browser 只回正文），用正文字节数近似，
    // 让它照常计入 max_total_bytes 预算而不是白吃额度。
    bytes: Buffer.byteLength(normalized.text, "utf8"),
    document: {
      candidateId: candidate.candidate_id,
      url: result.finalUrl,
      ...(candidate.canonical_url ? { canonicalUrl: candidate.canonical_url } : {}),
      title: safeDocumentTitle(result.title, candidate.title, result.finalUrl),
      ...(candidate.published_at ? { publishedAt: candidate.published_at } : {}),
      mediaType: "text/html",
      fetchMethod: "browser",
      text: normalized.text,
      contentHash: normalized.contentHash,
      simhash: normalized.simhash,
      // agent-browser 回的是已抽好的可读文本，没有标题层级可用，退化为纯文本切块。
      chunkSource: { kind: "html", headings: [] },
    },
  };
}

/// 若已取消则抛出，让 rpc-server 把它转成 cancelled 错误码。
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("operation cancelled");
  }
}

/// 抓取并抽取单个候选。
async function prepareCandidate(
  candidate: FetchPrepareParams["candidates"][number],
  params: FetchPrepareParams,
  ctx: MethodContext,
  deps: FetchPrepareDeps,
  browserBudget: BrowserBudget,
): Promise<CandidateOutcome> {
  const fetchFn = deps.fetch ?? safeRequest;
  const fail = (code: FetchFailureCode, message: string, httpStatus?: number): CandidateOutcome => ({
    kind: "failure",
    failure: {
      candidate_id: candidate.candidate_id,
      url: candidate.url,
      code,
      message,
      ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
    },
  });

  // main 已经抓好正文时**直接抽取、绝不联网**。
  //
  // 这条短路排在最前面，顺序不能换：命中 prefetched 的候选是「本地抓不到」才被送到服务端的，
  // 再联网一次必然还是失败，白等一轮超时还会占掉 http 并发额度。
  const prefetched = params.prefetched?.find((item) => item.candidate_id === candidate.candidate_id);
  if (prefetched) {
    return htmlToOutcome(
      candidate,
      prefetched.html,
      prefetched.final_url,
      "stealth",
      Buffer.byteLength(prefetched.html, "utf8"),
      fail,
    );
  }

  const response = await fetchFn(
    {
      url: candidate.url,
      timeoutMs: params.limits.request_timeout_ms,
      ...(params.allowed_domains ? { allowlist: params.allowed_domains } : {}),
      ...(deps.allowedPorts ? { allowedPorts: deps.allowedPorts } : {}),
    },
    {
      // 取消信号必须透传到抓取层，否则 cancel 只能等当前请求超时才生效。
      signal: ctx.signal,
      ...(deps.lookup ? { lookup: deps.lookup } : {}),
      ...(deps.forbiddenRanges ? { forbiddenRanges: deps.forbiddenRanges } : {}),
    },
  );

  if (!response.ok) {
    // HTTP 拿不到正文时才考虑起浏览器；能不能起、值不值得起由 tryBrowserFallback 判定。
    const viaBrowser = await tryBrowserFallback(
      candidate,
      params,
      ctx,
      deps,
      browserBudget,
      response.code,
      response.httpStatus,
    );
    // 降级失败时上报**原始** HTTP 失败码：对 main 而言这个候选就是「没抓到正文」，
    // Browser 只是没能救回来，不该把适配器的内部码泄漏成候选的失败原因。
    return viaBrowser ?? fail(response.code, response.message, response.httpStatus);
  }

  if (response.mediaType === "application/pdf") {
    const extracted = await (deps.extractPdf ?? ((data: Uint8Array) => extractPdfDocument(data)))(
      response.body,
    );
    if (!extracted.ok) return fail(extracted.code, extracted.message);

    const joined = extracted.pages.map((page) => page.text).join("\n\n");
    const normalized = normalizeDocument(joined);
    return {
      kind: "document",
      bytes: response.bytes,
      document: {
        candidateId: candidate.candidate_id,
        url: response.finalUrl,
        ...(candidate.canonical_url ? { canonicalUrl: candidate.canonical_url } : {}),
        title: safeDocumentTitle("", candidate.title, response.finalUrl),
        ...(candidate.published_at ? { publishedAt: candidate.published_at } : {}),
        mediaType: response.mediaType,
        fetchMethod: "pdf",
        text: normalized.text,
        contentHash: normalized.contentHash,
        simhash: normalized.simhash,
        chunkSource: {
          kind: "pdf",
          pages: extracted.pages.map((page) => ({ page: page.page, text: page.text })),
        },
      },
    };
  }

  return htmlToOutcome(candidate, response.body.toString("utf8"), response.finalUrl, "http", response.bytes, fail);
}

/// HTML → CandidateOutcome。
///
/// 抽出来是为了让**三条路径共用同一份抽取逻辑**：本地 HTTP、Browser 降级、以及 main 经
/// 服务端抓回的 prefetched。抽取实现一旦分叉，就会出现「同一个页面走不同路径得到不同正文」
/// ——而 contentHash 是跨 Session 复用与去重的键，正文不一致会让缓存命中变成随机行为。
function htmlToOutcome(
  candidate: FetchPrepareParams["candidates"][number],
  html: string,
  finalUrl: string,
  fetchMethod: "http" | "stealth",
  bytes: number,
  fail: (code: FetchFailureCode, message: string, httpStatus?: number) => CandidateOutcome,
): CandidateOutcome {
  const extracted = extractHtmlDocument(html);
  const normalized = normalizeDocument(extracted.text);
  if (normalized.text.length === 0) {
    return fail("empty_content", "未能从页面中抽取出正文");
  }

  // canonical / publishedAt 以页面自报为准，缺失时回退到候选携带的元数据。
  const canonicalUrl = extracted.canonicalUrl ?? candidate.canonical_url;
  const publishedAt = extracted.publishedAt ?? candidate.published_at;
  return {
    kind: "document",
    bytes,
    document: {
      candidateId: candidate.candidate_id,
      url: finalUrl,
      ...(canonicalUrl ? { canonicalUrl } : {}),
      title: safeDocumentTitle(extracted.title, candidate.title, finalUrl),
      ...(publishedAt ? { publishedAt } : {}),
      mediaType: "text/html",
      fetchMethod,
      text: normalized.text,
      contentHash: normalized.contentHash,
      simhash: normalized.simhash,
      chunkSource: { kind: "html", headings: extracted.headings },
    },
  };
}

/// 按来源类型切块：HTML 用标题路径，PDF 用页码。
function chunkDocument(document: PreparedDocument): ChunkDraft[] {
  if (document.chunkSource.kind === "pdf") {
    return chunkPagedText(document.chunkSource.pages);
  }
  return chunkStructuredText({ text: document.text, headings: document.chunkSource.headings });
}

/// 执行 fetch_prepare。
export async function runFetchPrepare(
  params: FetchPrepareParams,
  ctx: MethodContext,
  deps: FetchPrepareDeps = {},
): Promise<FetchPrepareResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  throwIfAborted(ctx.signal);

  const limiter = new FetchLimiter({
    global: params.limits.http_concurrency,
    perHost: params.limits.per_host_concurrency,
  });
  // Browser 额度与 HTTP 并发是两套闸：起 Chrome 的成本远高于一次 HTTP 请求，
  // 并发默认 1、最多 2（spec §19.4）。次数在 BrowserBudget 内部同步扣，防并发突破上限。
  const browserBudget = new BrowserBudget({ maxFetches: params.limits.max_browser_fetches });
  const candidates = params.candidates.slice(0, params.limits.max_documents);
  const knownByHash = new Map(
    params.known_fingerprints.map((item) => [item.content_hash, item.document_id]),
  );

  const documents: PreparedDocument[] = [];
  const failures: Array<{
    candidate_id: string;
    url: string;
    code: FetchFailureCode;
    message: string;
    http_status?: number;
  }> = [];
  let totalBytes = 0;
  let httpFetches = 0;
  let completed = 0;

  // 预算是**运行期**判定而不是排期期判定：并发任务共享 totalBytes / 时间预算，
  // 只有在任务真正开始执行的那一刻才知道剩余额度。超预算的候选直接不抓，也不记 failure
  // ——它不是「抓失败」，而是「本轮没轮到」，main 可以在下一轮重新排期。
  const budgetExceeded = (): boolean =>
    totalBytes >= params.limits.max_total_bytes ||
    now() - startedAt >= params.limits.max_duration_ms;

  await Promise.all(
    candidates.map((candidate) =>
      limiter.run(candidate.domain, async () => {
        if (ctx.signal.aborted || budgetExceeded()) return;
        const outcome = await prepareCandidate(candidate, params, ctx, deps, browserBudget);
        completed += 1;
        if (outcome.kind === "failure") {
          failures.push(outcome.failure);
        } else {
          // 走 Browser 降级产出的文档不计入 http_fetches——两条通道的次数分开统计，
          // Browser 的计数以 browserBudget.used 为准（它同时涵盖了「起了但失败」的情况）。
          if (outcome.document.fetchMethod !== "browser") httpFetches += 1;
          totalBytes += outcome.bytes;
          documents.push(outcome.document);
        }
        ctx.emitProgress({ stage: "fetching", completed, total: candidates.length });
      }),
    ),
  );

  throwIfAborted(ctx.signal);
  ctx.emitProgress({ stage: "extracting", completed: documents.length, total: candidates.length });

  // 近重复聚簇：以 contentHash 作为簇内标识（Worker 不知道 main 的 documentId）。
  const clusters = clusterByHamming(
    documents.map((document) => ({ id: document.contentHash, hash: document.simhash })),
    DUPLICATE_HAMMING_THRESHOLD,
  );

  ctx.emitProgress({ stage: "chunking", completed: 0, total: documents.length });

  const outputDocuments: FetchPrepareResult["documents"] = [];
  const outputChunks: FetchPrepareResult["chunks"] = [];
  const chunkedHashes = new Set<string>();
  let skippedKnown = 0;

  for (const document of documents) {
    throwIfAborted(ctx.signal);
    const knownDocumentId = knownByHash.get(document.contentHash);
    outputDocuments.push({
      candidate_id: document.candidateId,
      url: document.url,
      ...(document.canonicalUrl ? { canonical_url: document.canonicalUrl } : {}),
      title: document.title,
      content_hash: document.contentHash,
      simhash: document.simhash,
      media_type: document.mediaType,
      fetch_method: document.fetchMethod,
      fetched_at: new Date(now()).toISOString(),
      ...(document.publishedAt ? { published_at: document.publishedAt } : {}),
      text: document.text,
      text_length: document.text.length,
      ...(knownDocumentId ? { duplicate_of: knownDocumentId } : {}),
      trust_zone: params.policy.trust_zone,
    });

    // 已知指纹 → main 手里已有它的全部 chunk，重复回传只会让它做一次无谓的去重写入。
    if (knownDocumentId) {
      skippedKnown += 1;
      continue;
    }
    // 同批内的逐字重复同样只切一次，否则 chunk_id 会撞（id 由 contentHash + 序号构成）。
    if (chunkedHashes.has(document.contentHash)) continue;
    chunkedHashes.add(document.contentHash);

    chunkDocument(document).forEach((chunk, index) => {
      outputChunks.push({
        chunk_id: `${document.contentHash.slice(0, 16)}_${index}`,
        content_hash: document.contentHash,
        ...(chunk.page === undefined ? {} : { page: chunk.page }),
        start_offset: chunk.startOffset,
        end_offset: chunk.endOffset,
        ...(chunk.headingPath.length > 0 ? { heading_path: chunk.headingPath } : {}),
        text: chunk.text,
        text_hash: sha256Hex(chunk.text),
        lexical_score: 0,
      });
    });
  }

  ctx.emitProgress({ stage: "ranking", completed: 0, total: outputChunks.length });

  // 打分放在全部块就位之后：BM25 的 IDF 需要本批的语料统计，逐篇打分会得到互不可比的分数。
  const titleByHash = new Map(documents.map((document) => [document.contentHash, document.title]));
  const scorableChunks = outputChunks.map((chunk) => ({
    chunkId: chunk.chunk_id,
    text: chunk.text,
    title: titleByHash.get(chunk.content_hash) ?? "",
    headingPath: chunk.heading_path ?? [],
  }));
  const scores = scoreChunks(
    buildQueryText(params.objective, params.subquestions),
    scorableChunks,
  );
  const objectiveScores = scoreChunks(params.objective, scorableChunks);
  const subquestionScores = new Map(
    params.subquestions.map((subquestion) => [
      subquestion.id,
      scoreChunks(subquestion.text, scorableChunks),
    ]),
  );
  for (const chunk of outputChunks) {
    chunk.lexical_score = scores.get(chunk.chunk_id) ?? 0;
    chunk.objective_score = objectiveScores.get(chunk.chunk_id) ?? 0;
    chunk.subquestion_scores = Object.fromEntries(
      params.subquestions.map((subquestion) => [
        subquestion.id,
        subquestionScores.get(subquestion.id)?.get(chunk.chunk_id) ?? 0,
      ]),
    );
  }

  return {
    operation_id: params.operation_id,
    documents: outputDocuments,
    chunks: outputChunks,
    duplicate_clusters: clusters.map((cluster, index) => ({
      cluster_id: `cluster_${index}`,
      representative_hash: cluster.representativeId,
      member_hashes: cluster.memberIds,
    })),
    failures,
    stats: {
      http_fetches: httpFetches,
      // 用 budget.used 而不是「成功的 Browser 文档数」：进程已经起过就算消耗，
      // 包括探针判定 policy 未生效而放弃的那次——否则失败重试等于无限额度。
      browser_fetches: browserBudget.used,
      total_bytes: totalBytes,
      duration_ms: Math.max(0, now() - startedAt),
      skipped_known: skippedKnown,
    },
  };
}
const MAX_DOCUMENT_TITLE_CHARS = 300;

/// 网页标题属于不可信正文元数据。超长标题通常是畸形 HTML 或站点把整段内容塞进
/// `<title>`，此时回退到搜索结果标题；最终无论来自哪条路径都限制长度。
function safeDocumentTitle(extracted: string, candidate: string, fallback: string): string {
  const clean = (value: string): string => value.replace(/\s+/gu, " ").trim();
  const extractedClean = clean(extracted);
  const candidateClean = clean(candidate);
  const extractedPoints = [...extractedClean];
  const preferred =
    extractedPoints.length > 0 && extractedPoints.length <= MAX_DOCUMENT_TITLE_CHARS
      ? extractedClean
      : candidateClean || clean(fallback);
  const points = [...preferred];
  return points.length <= MAX_DOCUMENT_TITLE_CHARS
    ? preferred
    : `${points.slice(0, MAX_DOCUMENT_TITLE_CHARS).join("")}…`;
}
