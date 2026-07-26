// 直连搜索客户端的契约测试：局部失败不整批失败、错误分类、串行节流、key 不泄漏。
//
// 全部用注入的假 fetchFn，零网络、零 Electron 依赖。
import { describe, expect, it, vi } from "vitest";
import type { SearchBatchRequest } from "@cortex-work/core/research/search-api";

import { DirectSearchClient } from "./direct-search-client";

const API_KEY = "tvly-super-secret-key-value";

function request(...queryIds: string[]): SearchBatchRequest {
  return {
    request_id: "req_1",
    research_session_id: "ses_1",
    queries: queryIds.map((id) => ({ query_id: id, text: `query ${id}` })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/// Tavily 形状的成功响应。
function tavilyBody(count: number): unknown {
  return {
    results: Array.from({ length: count }, (_v, i) => ({
      title: `T${i}`,
      url: `https://example.com/${i}`,
      content: `snippet ${i}`,
      score: 1 - i / 10,
    })),
  };
}

function makeClient(fetchFn: typeof fetch, provider: "brave" | "tavily" = "tavily") {
  return new DirectSearchClient(
    { provider, apiKey: API_KEY },
    // 节流间隔置 0：测试不该为验证串行而真的等 200ms。
    { fetchFn, throttleMs: 0 },
  );
}

describe("DirectSearchClient.searchBatch", () => {
  it("成功路径：结果归一成 SearchBatchResponse，request_id 回填", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(tavilyBody(2))) as unknown as typeof fetch;
    const response = await makeClient(fetchFn).searchBatch(request("q1"));

    expect(response.request_id).toBe("req_1");
    expect(response.results).toHaveLength(1);
    expect(response.results[0].query_id).toBe("q1");
    expect(response.results[0].items).toHaveLength(2);
    expect(response.results[0].errors).toEqual([]);
    expect(response.stats.cache_hit).toBe(false);
  });

  it("多条查询串行发送（商业 API 按请求计费且有 QPS 限制，不能并发打）", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchFn = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return jsonResponse(tavilyBody(1));
    }) as unknown as typeof fetch;

    await makeClient(fetchFn).searchBatch(request("q1", "q2", "q3"));
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
  });

  it("局部失败不整批失败：失败的查询只落 errors，其余照常返回", async () => {
    let call = 0;
    const fetchFn = vi.fn(async () => {
      call += 1;
      return call === 1 ? jsonResponse("upstream boom", 500) : jsonResponse(tavilyBody(1));
    }) as unknown as typeof fetch;

    const response = await makeClient(fetchFn).searchBatch(request("q1", "q2"));

    expect(response.results[0].items).toEqual([]);
    expect(response.results[0].errors).toEqual([{ provider: "tavily", code: "http_error" }]);
    expect(response.results[1].items).toHaveLength(1);
    expect(response.results[1].errors).toEqual([]);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [500, "http_error"],
    [503, "unavailable"],
  ])("HTTP %s → 错误码 %s", async (status, code) => {
    const fetchFn = vi.fn(async () => jsonResponse("x", status)) as unknown as typeof fetch;
    const response = await makeClient(fetchFn).searchBatch(request("q1"));
    expect(response.results[0].errors).toEqual([{ provider: "tavily", code }]);
  });

  it("非 JSON 响应 → invalid_response，不抛错", async () => {
    const fetchFn = vi.fn(async () => jsonResponse("<html>nope</html>")) as unknown as typeof fetch;
    const response = await makeClient(fetchFn).searchBatch(request("q1"));
    expect(response.results[0].errors).toEqual([{ provider: "tavily", code: "invalid_response" }]);
  });

  it("形状不认识的 JSON → 空结果但不算错误（远端演进不该炸整轮研究）", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ unexpected: true })) as unknown as typeof fetch;
    const response = await makeClient(fetchFn).searchBatch(request("q1"));
    expect(response.results[0].items).toEqual([]);
    expect(response.results[0].errors).toEqual([]);
  });

  it("网络异常 → network_error", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const response = await makeClient(fetchFn).searchBatch(request("q1"));
    expect(response.results[0].errors).toEqual([{ provider: "tavily", code: "network_error" }]);
  });

  it("调用方取消：立刻抛出，且不再发后续查询", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => {
      controller.abort();
      return jsonResponse(tavilyBody(1));
    }) as unknown as typeof fetch;

    await expect(
      makeClient(fetchFn).searchBatch(request("q1", "q2", "q3"), controller.signal),
    ).rejects.toThrow(/取消/);
    // 第一条已发出并在其中取消，后两条不得再发。
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("请求发出前就已取消：一次 fetch 都不发", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(tavilyBody(1))) as unknown as typeof fetch;
    await expect(
      makeClient(fetchFn).searchBatch(request("q1"), AbortSignal.abort()),
    ).rejects.toThrow(/取消/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("超大响应体 → too_large，且不解析", async () => {
    const huge = "x".repeat(3 * 1024 * 1024);
    const fetchFn = vi.fn(async () => jsonResponse(huge)) as unknown as typeof fetch;
    const response = await makeClient(fetchFn).searchBatch(request("q1"));
    expect(response.results[0].errors).toEqual([{ provider: "tavily", code: "too_large" }]);
  });

  it("超过 maxQueriesPerRequest 的查询被截断（与 Search Server 同限额）", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(tavilyBody(1))) as unknown as typeof fetch;
    const ids = Array.from({ length: 12 }, (_v, i) => `q${i}`);
    const response = await makeClient(fetchFn).searchBatch(request(...ids));
    expect(fetchFn).toHaveBeenCalledTimes(8);
    expect(response.results).toHaveLength(8);
  });

  it("API key 绝不出现在错误文本里（错误体回显凭据也会被擦掉）", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(`bad key: ${API_KEY}`, 401),
    ) as unknown as typeof fetch;
    const response = await makeClient(fetchFn).searchBatch(request("q1"));
    expect(JSON.stringify(response)).not.toContain(API_KEY);
  });

  it("brave：请求走 GET 且 key 在头里", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ web: { results: [{ title: "A", url: "https://a.com/x" }] } }),
    ) as unknown as typeof fetch;

    const response = await makeClient(fetchFn, "brave").searchBatch(request("q1"));
    expect(response.results[0].items[0].engines).toEqual(["brave"]);

    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain("api.search.brave.com");
    expect(String(url)).not.toContain(API_KEY);
    expect((init as RequestInit).method).toBe("GET");
  });
});
