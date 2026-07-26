// 窄同步检索面的契约测试。
//
// 这一面是「agent 联网」与「会话内检索」的共同入口，风险点集中在三处：
//   1. 准入闸不可绕过（用户关掉的开关必须真的关得掉）；
//   2. URL 安全闸必须在进 Worker 之前拦住明显非法的地址，且给出可读原因；
//   3. 预算（条数 / 字符 / 超时）必须真的生效——它决定一次交互式调用会往模型上下文里塞多少。
//
// 全部用手写替身，零网络、零 Electron、零 Worker 进程。
import { describe, expect, it, vi } from "vitest";
import type { ResearchEngineSettings } from "@cortex-work/core/research/settings";
import { QUICK_RETRIEVAL_LIMITS } from "@cortex-work/core/research/quick-types";
import type { SearchBatchRequest, SearchBatchResponse } from "@cortex-work/core/research/search-api";

import { QuickRetrieval, type QuickRetrievalDeps } from "./quick-retrieval";
import { ResearchDisabledError, SearchServerNotConfiguredError } from "./consumer-gate";

const ENABLED: ResearchEngineSettings = {
  enabled: true,
  deepResearchEnabled: true,
  chatEnabled: true,
  chatAutoRetrieve: false,
  slidesEnabled: false,
  writingEnabled: false,
  memoryEnabled: false,
};

/// 搜索响应替身：n 条同域或跨域结果。
function searchResponse(
  items: Array<{ url: string; title?: string; domain?: string; score?: number }>,
  errors: Array<{ provider: string; code: string }> = [],
): SearchBatchResponse {
  return {
    request_id: "req",
    results: [
      {
        query_id: "q1",
        items: items.map((item, i) => ({
          url: item.url,
          title: item.title ?? `T${i}`,
          domain: item.domain ?? new URL(item.url).hostname,
          engines: ["searxng"],
          score: item.score ?? 1 - i / 100,
        })),
        errors,
      },
    ],
    stats: {
      provider_count: 1,
      raw_result_count: items.length,
      returned_result_count: items.length,
      cache_hit: false,
      duration_ms: 5,
    },
  };
}

/// Worker fetch_prepare 结果替身（协议是 snake_case）。
function workerResult(
  documents: Array<{ url: string; text: string; title?: string; duplicateOf?: string }>,
  failures: Array<{ candidate_id: string; url: string; code: string; message: string }> = [],
) {
  return {
    documents: documents.map((doc, i) => ({
      candidate_id: `c${i}`,
      canonical_url: doc.url,
      title: doc.title ?? `D${i}`,
      content_hash: `hash${i}`,
      media_type: "text/html",
      fetch_method: "http" as const,
      fetched_at: "2026-07-26T00:00:00Z",
      text_length: doc.text.length,
      text: doc.text,
      trust_zone: "public_web" as const,
      ...(doc.duplicateOf ? { duplicate_of: doc.duplicateOf } : {}),
      chunks: [],
    })),
    chunks: [],
    duplicate_clusters: [],
    failures,
    stats: {
      http_fetches: documents.length,
      browser_fetches: 0,
      total_bytes: 100,
      duration_ms: 20,
      skipped_known: 0,
    },
  };
}

interface Overrides {
  settings?: ResearchEngineSettings;
  searchBatch?: (r: SearchBatchRequest, s?: AbortSignal) => Promise<SearchBatchResponse>;
  workerRequest?: (method: string, params: unknown) => Promise<unknown>;
  blockedDomains?: readonly string[];
  searchClientNull?: boolean;
}

function makeQuick(overrides: Overrides = {}): QuickRetrieval {
  let counter = 0;
  const deps: QuickRetrievalDeps = {
    settings: () => overrides.settings ?? ENABLED,
    createSearchClient: () =>
      overrides.searchClientNull
        ? null
        : { searchBatch: overrides.searchBatch ?? (async () => searchResponse([])) },
    workerProvider: {
      ensure: async () => ({
        request: (async (method: string, params: unknown) =>
          overrides.workerRequest
            ? await overrides.workerRequest(method, params)
            : workerResult([])) as never,
      }),
      stop: async () => {},
    },
    newId: () => `id-${++counter}`,
    ...(overrides.blockedDomains ? { blockedDomains: () => overrides.blockedDomains! } : {}),
  };
  return new QuickRetrieval(deps);
}

describe("QuickRetrieval 准入闸", () => {
  it("总开关关闭时 discover 抛 ResearchDisabledError", async () => {
    const quick = makeQuick({ settings: { ...ENABLED, enabled: false } });
    await expect(quick.discover({ consumer: "chat", query: "x" })).rejects.toBeInstanceOf(
      ResearchDisabledError,
    );
  });

  it("Consumer 灰度开关关闭时 discover 抛 ResearchDisabledError", async () => {
    const quick = makeQuick({ settings: { ...ENABLED, chatEnabled: false } });
    await expect(quick.discover({ consumer: "chat", query: "x" })).rejects.toBeInstanceOf(
      ResearchDisabledError,
    );
  });

  it("prepare 同样受闸（别只在 discover 上把门，绕一步就进去了）", async () => {
    const quick = makeQuick({ settings: { ...ENABLED, chatEnabled: false } });
    await expect(
      quick.prepare({ consumer: "chat", objective: "o", urls: ["https://a.com"] }),
    ).rejects.toBeInstanceOf(ResearchDisabledError);
  });

  it("准入闸在触网之前：开关关闭时一次搜索都不发", async () => {
    const searchBatch = vi.fn(async () => searchResponse([]));
    const quick = makeQuick({ settings: { ...ENABLED, enabled: false }, searchBatch });
    await expect(quick.discover({ consumer: "chat", query: "x" })).rejects.toThrow();
    expect(searchBatch).not.toHaveBeenCalled();
  });

  it("搜索后端未配置时抛 SearchServerNotConfiguredError（与「未开启」区分开）", async () => {
    const quick = makeQuick({ searchClientNull: true });
    await expect(quick.discover({ consumer: "chat", query: "x" })).rejects.toBeInstanceOf(
      SearchServerNotConfiguredError,
    );
  });
});

describe("QuickRetrieval.discover", () => {
  it("只发一条查询，limit 被夹到 maxLeads 以内", async () => {
    const searchBatch = vi.fn(async (_r: SearchBatchRequest, _s?: AbortSignal) =>
      searchResponse([{ url: "https://a.com/1" }]),
    );
    await makeQuick({ searchBatch }).discover({ consumer: "chat", query: "cortex", limit: 999 });

    const sent = searchBatch.mock.calls[0]![0];
    expect(sent.queries).toHaveLength(1);
    expect(sent.queries[0]!.text).toBe("cortex");
    expect(sent.queries[0]!.limit).toBe(QUICK_RETRIEVAL_LIMITS.maxLeads);
  });

  it("**不抓取任何页面**（只搜不抓是这个方法的全部意义）", async () => {
    const workerRequest = vi.fn(async (_method: string, _params: unknown) => workerResult([]));
    await makeQuick({
      searchBatch: async () => searchResponse([{ url: "https://a.com/1" }]),
      workerRequest,
    }).discover({ consumer: "chat", query: "x" });
    expect(workerRequest).not.toHaveBeenCalled();
  });

  it("按单域名配额收敛（同站连着 5 条不该占满 agent 的上下文）", async () => {
    const items = Array.from({ length: 5 }, (_v, i) => ({ url: `https://same.com/${i}` }));
    const result = await makeQuick({ searchBatch: async () => searchResponse(items) }).discover({
      consumer: "chat",
      query: "x",
    });
    expect(result.leads.length).toBeLessThanOrEqual(3);
  });

  it("域名黑名单命中的线索被剔除", async () => {
    const result = await makeQuick({
      blockedDomains: ["spam.com"],
      searchBatch: async () =>
        searchResponse([{ url: "https://spam.com/x" }, { url: "https://ok.com/y" }]),
    }).discover({ consumer: "chat", query: "x" });
    expect(result.leads.map((l) => l.domain)).toEqual(["ok.com"]);
  });

  it("搜索源局部失败转成可展示的 warning，而不是静默少几条", async () => {
    const result = await makeQuick({
      searchBatch: async () =>
        searchResponse([{ url: "https://a.com/1" }], [{ provider: "brave", code: "rate_limited" }]),
    }).discover({ consumer: "chat", query: "x" });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("brave");
    expect(result.warnings[0]).toContain("rate_limited");
    // 有 warning 不代表没结果：局部失败下仍要把拿到的线索交出去。
    expect(result.leads).toHaveLength(1);
  });
});

describe("QuickRetrieval.prepare", () => {
  it("非法 URL 在进 Worker 之前就被拒，且给出可读原因", async () => {
    const workerRequest = vi.fn(async (_method: string, _params: unknown) => workerResult([]));
    const result = await makeQuick({ workerRequest }).prepare({
      consumer: "chat",
      objective: "o",
      urls: ["javascript:alert(1)", "http://127.0.0.1/admin", "ftp://a.com/x"],
    });

    expect(result.documents).toEqual([]);
    expect(result.failures).toHaveLength(3);
    for (const failure of result.failures) {
      expect(failure.reason.length).toBeGreaterThan(0);
    }
    // 全部被本地闸拦下 → 根本不该唤起 Worker。
    expect(workerRequest).not.toHaveBeenCalled();
  });

  it("私网地址被拒（SSRF 的第一道闸在这里，不能只靠 Worker）", async () => {
    const result = await makeQuick().prepare({
      consumer: "chat",
      objective: "o",
      urls: ["http://192.168.1.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data"],
    });
    expect(result.documents).toEqual([]);
    expect(result.failures).toHaveLength(3);
  });

  it("合法 URL 抓取后回正文，超长按预算截断", async () => {
    const long = "x".repeat(QUICK_RETRIEVAL_LIMITS.maxCharsPerDocument + 500);
    const result = await makeQuick({
      workerRequest: async () => workerResult([{ url: "https://a.com/p", text: long }]),
    }).prepare({ consumer: "chat", objective: "o", urls: ["https://a.com/p"] });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.url).toBe("https://a.com/p");
    expect(result.documents[0]!.text).toHaveLength(QUICK_RETRIEVAL_LIMITS.maxCharsPerDocument);
    expect(result.documents[0]!.truncated).toBe(true);
  });

  it("URL 数被夹到 maxUrls：超出部分不进 Worker 入参", async () => {
    const workerRequest = vi.fn(async (_method: string, _params: unknown) => workerResult([]));
    const urls = Array.from({ length: QUICK_RETRIEVAL_LIMITS.maxUrls + 5 }, (_v, i) =>
      `https://a${i}.com/p`,
    );
    await makeQuick({ workerRequest }).prepare({ consumer: "chat", objective: "o", urls });

    const params = workerRequest.mock.calls[0]![1] as { candidates: unknown[] };
    expect(params.candidates).toHaveLength(QUICK_RETRIEVAL_LIMITS.maxUrls);
  });

  it("**不开浏览器兜底**：max_browser_fetches 恒为 0（启动 Chrome 与交互式时延预算冲突）", async () => {
    const workerRequest = vi.fn(async (_method: string, _params: unknown) => workerResult([]));
    await makeQuick({ workerRequest }).prepare({
      consumer: "chat",
      objective: "o",
      urls: ["https://a.com/p"],
    });
    const params = workerRequest.mock.calls[0]![1] as { limits: { max_browser_fetches: number } };
    expect(params.limits.max_browser_fetches).toBe(0);
  });

  it("Worker 报告的抓取失败并入 failures", async () => {
    const result = await makeQuick({
      workerRequest: async () =>
        workerResult([], [
          { candidate_id: "c0", url: "https://a.com/p", code: "http_error", message: "HTTP 404" },
        ]),
    }).prepare({ consumer: "chat", objective: "o", urls: ["https://a.com/p"] });

    expect(result.failures).toEqual([{ url: "https://a.com/p", reason: "HTTP 404" }]);
  });

  it("重复文档（duplicate_of）不重复回传", async () => {
    const result = await makeQuick({
      workerRequest: async () =>
        workerResult([
          { url: "https://a.com/p", text: "content" },
          { url: "https://a.com/mirror", text: "", duplicateOf: "hash0" },
        ]),
    }).prepare({ consumer: "chat", objective: "o", urls: ["https://a.com/p", "https://a.com/mirror"] });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.url).toBe("https://a.com/p");
  });

  it("空 URL 列表不唤起 Worker", async () => {
    const workerRequest = vi.fn(async (_method: string, _params: unknown) => workerResult([]));
    const result = await makeQuick({ workerRequest }).prepare({
      consumer: "chat",
      objective: "o",
      urls: [],
    });
    expect(result).toEqual({ documents: [], failures: [] });
    expect(workerRequest).not.toHaveBeenCalled();
  });

  it("总字符预算封顶：多篇长文加起来不超过 maxTotalChars", async () => {
    const docs = Array.from({ length: QUICK_RETRIEVAL_LIMITS.maxUrls }, (_v, i) => ({
      url: `https://a${i}.com/p`,
      text: "x".repeat(QUICK_RETRIEVAL_LIMITS.maxCharsPerDocument),
    }));
    const result = await makeQuick({ workerRequest: async () => workerResult(docs) }).prepare({
      consumer: "chat",
      objective: "o",
      urls: docs.map((d) => d.url),
    });

    const total = result.documents.reduce((sum, d) => sum + d.text.length, 0);
    expect(total).toBeLessThanOrEqual(QUICK_RETRIEVAL_LIMITS.maxTotalChars);
  });
});
