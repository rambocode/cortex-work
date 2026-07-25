// Search Server 客户端的契约测试：错误分类、响应上限、schema 拒绝、token 不泄漏。
//
// 全部用注入的假 fetchFn，零网络、零 Electron 依赖。
import { describe, expect, it, vi } from "vitest";
import type { SearchBatchRequest } from "@cortex-work/core/research/search-api";
import {
  MAX_SEARCH_RESPONSE_BYTES,
  SearchServerClient,
  SearchServerError,
} from "./search-server-client";

const TOKEN = "cortex-pat-super-secret-value";

const REQUEST: SearchBatchRequest = {
  request_id: "req_1",
  research_session_id: "ses_1",
  queries: [{ query_id: "q1", text: "cortex research engine" }],
};

/// 合法的最小响应体。
function okBody(requestId = "req_1"): unknown {
  return {
    request_id: requestId,
    results: [
      {
        query_id: "q1",
        items: [
          {
            url: "https://example.com/a",
            title: "A",
            domain: "example.com",
            engines: ["google"],
            score: 0.9,
          },
        ],
        errors: [],
      },
    ],
    stats: {
      provider_count: 1,
      raw_result_count: 1,
      returned_result_count: 1,
      cache_hit: false,
      duration_ms: 12,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchFn: typeof fetch): SearchServerClient {
  return new SearchServerClient(
    { baseUrl: "https://search.example.com/", workspaceId: "ws 1", token: TOKEN },
    { fetchFn, clientVersion: "9.9.9" },
  );
}

describe("SearchServerClient", () => {
  it("按契约拼 URL、带鉴权与客户端标识头，并返回已校验的响应", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse(okBody());
    }) as unknown as typeof fetch;

    const response = await makeClient(fetchFn).searchBatch(REQUEST);

    expect(calls[0]!.url).toBe(
      "https://search.example.com/api/workspaces/ws%201/research/search/batch",
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(headers["X-Client-Platform"]).toBe("desktop");
    expect(headers["X-Client-Version"]).toBe("9.9.9");
    expect(response.results[0]!.items[0]!.domain).toBe("example.com");
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [503, "unavailable"],
    [500, "http_error"],
  ])("HTTP %i 映射成 %s", async (status, code) => {
    const fetchFn = (async () => jsonResponse({ message: "nope" }, status)) as unknown as typeof fetch;
    const error = await makeClient(fetchFn)
      .searchBatch(REQUEST)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SearchServerError);
    expect((error as SearchServerError).code).toBe(code);
    expect((error as SearchServerError).httpStatus).toBe(status);
  });

  it("响应超过大小上限时拒绝，且不解析内容", async () => {
    const huge = "x".repeat(MAX_SEARCH_RESPONSE_BYTES + 1024);
    const fetchFn = (async () => jsonResponse(huge)) as unknown as typeof fetch;

    const error = await makeClient(fetchFn)
      .searchBatch(REQUEST)
      .catch((err: unknown) => err);

    expect((error as SearchServerError).code).toBe("too_large");
  });

  it("畸形响应被 zod 拒绝", async () => {
    const fetchFn = (async () =>
      jsonResponse({ request_id: "req_1", results: [], stats: { cache_hit: "yes" } })) as unknown as typeof fetch;

    const error = await makeClient(fetchFn)
      .searchBatch(REQUEST)
      .catch((err: unknown) => err);

    expect((error as SearchServerError).code).toBe("invalid_response");
  });

  it("request_id 不匹配时拒绝（spec §9.1 第 3 步）", async () => {
    const fetchFn = (async () => jsonResponse(okBody("req_other"))) as unknown as typeof fetch;

    const error = await makeClient(fetchFn)
      .searchBatch(REQUEST)
      .catch((err: unknown) => err);

    expect((error as SearchServerError).code).toBe("request_mismatch");
  });

  it("非 JSON 响应体被拒绝", async () => {
    const fetchFn = (async () => jsonResponse("<html>502</html>")) as unknown as typeof fetch;

    const error = await makeClient(fetchFn)
      .searchBatch(REQUEST)
      .catch((err: unknown) => err);

    expect((error as SearchServerError).code).toBe("invalid_response");
  });

  it("token 不出现在任何抛出的错误消息里（即使服务端把它回显在 body 中）", async () => {
    const bodies: unknown[] = [
      // 服务端错误里回显了鉴权头
      new Response(`unauthorized: Bearer ${TOKEN}`, { status: 401 }),
      // 200 但响应体畸形，且畸形内容里含 token
      new Response(JSON.stringify({ request_id: TOKEN }), { status: 200 }),
    ];

    for (const body of bodies) {
      const fetchFn = (async () => body) as unknown as typeof fetch;
      const error = await makeClient(fetchFn)
        .searchBatch(REQUEST)
        .catch((err: unknown) => err);
      const serialized = `${(error as Error).message}\n${(error as Error).stack ?? ""}`;
      expect(serialized).not.toContain(TOKEN);
    }
  });

  it("网络异常归类为 network_error，取消归类为 cancelled", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const networkError = await makeClient(failing)
      .searchBatch(REQUEST)
      .catch((err: unknown) => err);
    expect((networkError as SearchServerError).code).toBe("network_error");

    const controller = new AbortController();
    controller.abort();
    const cancelled = await makeClient(failing)
      .searchBatch(REQUEST, controller.signal)
      .catch((err: unknown) => err);
    expect((cancelled as SearchServerError).code).toBe("cancelled");
  });
});
