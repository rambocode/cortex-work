// 候选选择（spec §8.2、KTD3）：把 Search Server 返回的一堆"线索"收敛成本轮真正要抓取的集合。
//
// 全部是**纯函数**，不碰时钟、不碰网络、不碰数据库——选择策略是研究质量的核心变量，
// 必须能被表驱动测试逐条钉死。
//
// 三条策略，顺序即优先级：
// 1. **去重**：按 canonicalizeUrl 归一后的 URL 判重（同一篇文章的 utm / fragment 变体只留一条）；
// 2. **域名多样性**：同一域名最多取 N 条，且按"每轮各域名取一条"的方式交替选取——
//    否则一个 SEO 强势站点会把整轮预算吃光，Coverage 的独立域名数永远达不到标准；
// 3. **预算截断**：最终数量不超过本 Session 还能抓取的文档数。
import { canonicalizeUrl } from "@cortex-work/core/research/url-safety";
import type { SearchCandidate } from "@cortex-work/core/research/evidence";
import type { SearchBatchResponse } from "@cortex-work/core/research/search-api";
import type { ResearchBudget } from "@cortex-work/core/research/types";

/// 单域名默认取样上限。3 是权衡值：太小会让"官方文档站有 5 篇相关页"的正常情况被砍掉，
/// 太大则失去多样性。调用方（Consumer 适配器）可覆盖。
const DEFAULT_MAX_PER_DOMAIN = 3;

/// selectCandidates 的入参。
export interface SelectCandidatesInput {
  candidates: readonly SearchCandidate[];
  /// 已经抓取过的 **canonical URL** 集合（本 Session 内 + 跨 Session 复用命中的）。
  alreadyFetched: ReadonlySet<string>;
  budget: ResearchBudget;
  /// 用户或 Consumer 配置的域名黑名单；命中该域名或其子域即剔除。
  blockedDomains?: readonly string[];
  maxPerDomain?: number;
}

/// 选出本轮要抓取的候选（保持"高分优先 + 域名交替"的确定性顺序）。
export function selectCandidates(input: SelectCandidatesInput): SearchCandidate[] {
  const limit = Math.max(0, Math.min(input.budget.maxDocuments, input.budget.maxCandidates));
  if (limit === 0) return [];

  const maxPerDomain = input.maxPerDomain ?? DEFAULT_MAX_PER_DOMAIN;
  const blocked = normalizeBlocklist(input.blockedDomains);

  // 第一步：清洗 + 去重。同一 canonical URL 只保留 serverScore 最高的一条。
  const byCanonical = new Map<string, { candidate: SearchCandidate; canonical: string; domain: string }>();
  for (const candidate of input.candidates) {
    const canonical = canonicalizeUrl(candidate.canonicalUrl ?? candidate.url);
    // canonicalizeUrl 对非 http/https 返回 null —— 那些 URL 抓取层根本不会处理，提前丢掉。
    if (canonical === null) continue;
    if (input.alreadyFetched.has(canonical)) continue;

    const domain = resolveDomain(candidate, canonical);
    if (isBlocked(domain, blocked)) continue;

    const existing = byCanonical.get(canonical);
    if (existing && existing.candidate.serverScore >= candidate.serverScore) continue;
    byCanonical.set(canonical, { candidate, canonical, domain });
  }

  // 第二步：按分数排序。同分时用 candidateId 兜底，保证同一输入永远得到同一输出。
  const ranked = [...byCanonical.values()].sort(
    (a, b) =>
      b.candidate.serverScore - a.candidate.serverScore ||
      a.candidate.candidateId.localeCompare(b.candidate.candidateId),
  );

  // 第三步：按域名分桶后逐轮取样（第 1 轮各域名取最高分的一条，第 2 轮取次高……）。
  // 这样"新域名的次高分"天然排在"老域名的第二条"之前，即多样性优先。
  const buckets = new Map<string, SearchCandidate[]>();
  for (const entry of ranked) {
    const bucket = buckets.get(entry.domain);
    if (bucket) bucket.push(entry.candidate);
    else buckets.set(entry.domain, [entry.candidate]);
  }

  const selected: SearchCandidate[] = [];
  for (let round = 0; round < maxPerDomain && selected.length < limit; round += 1) {
    for (const bucket of buckets.values()) {
      if (selected.length >= limit) break;
      const candidate = bucket[round];
      if (candidate) selected.push(candidate);
    }
  }
  return selected;
}

/// 把 Search Server 的 snake_case 响应映射成领域候选（spec §8.2）。
///
/// candidateId 由 main 铸造而非取远端字段：候选 id 会成为证据链的外键，
/// 让外部服务决定主键等于把数据完整性交给了不可信来源。
export function toSearchCandidates(
  response: SearchBatchResponse,
  deps: { newId: () => string },
): SearchCandidate[] {
  const candidates: SearchCandidate[] = [];
  for (const result of response.results) {
    for (const item of result.items) {
      const candidate: SearchCandidate = {
        candidateId: deps.newId(),
        queryId: result.query_id,
        title: item.title,
        url: item.url,
        domain: item.domain,
        engines: item.engines,
        serverScore: item.score,
        // Search Server 只检索公网，信任区固定；本地/企业来源不走这条路径（spec §8.2）。
        trustZone: "public_web",
      };
      if (item.canonical_url !== undefined) candidate.canonicalUrl = item.canonical_url;
      if (item.snippet !== undefined) candidate.snippet = item.snippet;
      if (item.published_at !== undefined) candidate.publishedAt = item.published_at;
      candidates.push(candidate);
    }
  }
  return candidates;
}

/// 归一化黑名单：小写、去空白、丢空项。
function normalizeBlocklist(domains: readonly string[] | undefined): string[] {
  return (domains ?? []).map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0);
}

/// 候选的域名。优先用远端给的 domain 字段，缺失或畸形时回退到 canonical URL 的 hostname
/// ——分桶键必须永远有值，否则一条脏数据会让多样性策略整体失效。
function resolveDomain(candidate: SearchCandidate, canonical: string): string {
  const declared = candidate.domain?.trim().toLowerCase() ?? "";
  if (declared.length > 0) return declared;
  try {
    return new URL(canonical).hostname.toLowerCase();
  } catch {
    return canonical;
  }
}

/// 域名是否命中黑名单。子域一并命中（`spam.com` 拦掉 `mirror.spam.com`），
/// 否则换个子域就能绕过整条规则。
function isBlocked(domain: string, blocked: readonly string[]): boolean {
  return blocked.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
}
