// direct-search.ts 的纯函数测试：请求构造、响应归一、畸形输入容错。
//
// 这一层是「逃生阀」的契约边界：商业搜索 API 的响应完全不可控（字段可能缺、可能改名、
// 可能塞进任意文本），所以解析必须在畸形输入下给出可用结果而不是抛错或放行脏数据。
import { describe, expect, it } from "vitest";

import {
  DIRECT_SEARCH_PROVIDERS,
  buildDirectSearchCall,
  isDirectSearchProviderId,
  parseDirectSearchResults,
  toDirectSearchBatchResponse,
  type DirectSearchProviderId,
} from "./direct-search";
import { SEARCH_LIMITS } from "./search-api";

describe("DIRECT_SEARCH_PROVIDERS", () => {
  it("每个 provider 的 host 都写死为 https，不可由用户覆盖", () => {
    for (const provider of Object.values(DIRECT_SEARCH_PROVIDERS)) {
      expect(provider.endpoint.startsWith("https://")).toBe(true);
      expect(new URL(provider.endpoint).hostname).toBe(provider.host);
    }
  });

  it("provider id 与表键一致（避免下拉展示与查表用两个来源）", () => {
    for (const [key, provider] of Object.entries(DIRECT_SEARCH_PROVIDERS)) {
      expect(provider.id).toBe(key);
    }
  });
});

describe("isDirectSearchProviderId", () => {
  it.each([
    ["brave", true],
    ["tavily", true],
    ["google", false],
    ["", false],
    ["BRAVE", false],
  ])("%s → %s", (value, expected) => {
    expect(isDirectSearchProviderId(value)).toBe(expected);
  });
});

describe("buildDirectSearchCall", () => {
  it("brave：key 走 X-Subscription-Token 头，绝不进 URL", () => {
    const call = buildDirectSearchCall("brave", { query_id: "q1", text: "cortex 研究" }, "SECRET");
    expect(call.url).toContain("api.search.brave.com");
    expect(call.url).not.toContain("SECRET");
    expect(call.init.headers["X-Subscription-Token"]).toBe("SECRET");
    expect(call.init.method).toBe("GET");
    expect(call.init.body).toBeUndefined();
  });

  it("tavily：key 走 Authorization 头，绝不进 URL 或 body", () => {
    const call = buildDirectSearchCall("tavily", { query_id: "q1", text: "cortex" }, "SECRET");
    expect(call.url).not.toContain("SECRET");
    expect(call.init.headers.Authorization).toBe("Bearer SECRET");
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBeDefined();
    expect(call.init.body).not.toContain("SECRET");
  });

  it("limit 被夹到 maxResultsPerQuery 以内", () => {
    const call = buildDirectSearchCall(
      "brave",
      { query_id: "q1", text: "x", limit: 999 },
      "k",
    );
    expect(new URL(call.url).searchParams.get("count")).toBe(String(SEARCH_LIMITS.maxResultsPerQuery));
  });

  it("查询文本超长时按 code point 截断，不切坏代理对", () => {
    const long = "😀".repeat(SEARCH_LIMITS.maxQueryChars + 50);
    const call = buildDirectSearchCall("brave", { query_id: "q1", text: long }, "k");
    const sent = new URL(call.url).searchParams.get("q") ?? "";
    expect([...sent].length).toBe(SEARCH_LIMITS.maxQueryChars);
    expect(sent.endsWith("😀")).toBe(true);
  });

  it("time_range 映射到各家的时效参数", () => {
    const brave = buildDirectSearchCall("brave", { query_id: "q", text: "x", time_range: "week" }, "k");
    expect(new URL(brave.url).searchParams.get("freshness")).toBe("pw");

    const tavily = buildDirectSearchCall("tavily", { query_id: "q", text: "x", time_range: "week" }, "k");
    expect(JSON.parse(tavily.init.body ?? "{}").days).toBe(7);
  });

  it("time_range=all 不发时效参数（两家都用「不传 = 不限」表达）", () => {
    const brave = buildDirectSearchCall("brave", { query_id: "q", text: "x", time_range: "all" }, "k");
    expect(new URL(brave.url).searchParams.has("freshness")).toBe(false);

    const tavily = buildDirectSearchCall("tavily", { query_id: "q", text: "x", time_range: "all" }, "k");
    expect(JSON.parse(tavily.init.body ?? "{}").days).toBeUndefined();
  });

  it("news 类别映射到 tavily 的 topic=news", () => {
    const call = buildDirectSearchCall("tavily", { query_id: "q", text: "x", categories: ["news"] }, "k");
    expect(JSON.parse(call.init.body ?? "{}").topic).toBe("news");
  });

  it("域名 allow/block 列表透传到 tavily", () => {
    const call = buildDirectSearchCall(
      "tavily",
      { query_id: "q", text: "x", domain_allowlist: ["a.com"], domain_blocklist: ["b.com"] },
      "k",
    );
    const body = JSON.parse(call.init.body ?? "{}");
    expect(body.include_domains).toEqual(["a.com"]);
    expect(body.exclude_domains).toEqual(["b.com"]);
  });
});

describe("parseDirectSearchResults", () => {
  it("brave：正常响应归一为 SearchResultItem，score 按名次递减", () => {
    const items = parseDirectSearchResults("brave", {
      web: {
        results: [
          { title: "A", url: "https://a.com/x", description: "desc A", page_age: "2026-07-01T00:00:00Z" },
          { title: "B", url: "https://b.com/y", description: "desc B" },
        ],
      },
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "A",
      url: "https://a.com/x",
      snippet: "desc A",
      domain: "a.com",
      engines: ["brave"],
      published_at: "2026-07-01T00:00:00Z",
    });
    // 名次越靠前分越高，且都是有限数（NaN/Infinity 会污染后续排序）。
    expect(items[0]!.score).toBeGreaterThan(items[1]!.score);
    expect(Number.isFinite(items[0]!.score)).toBe(true);
  });

  it("tavily：沿用服务端给的 score，缺失时按名次兜底", () => {
    const items = parseDirectSearchResults("tavily", {
      results: [
        { title: "A", url: "https://a.com/x", content: "c1", score: 0.9 },
        { title: "B", url: "https://b.com/y", content: "c2" },
      ],
    });
    expect(items[0]!.score).toBe(0.9);
    expect(Number.isFinite(items[1]!.score)).toBe(true);
    expect(items[0]!.engines).toEqual(["tavily"]);
  });

  it("丢弃 URL 缺失 / 非 http(s) / 畸形的条目", () => {
    const items = parseDirectSearchResults("brave", {
      web: {
        results: [
          { title: "no url", description: "x" },
          { title: "ftp", url: "ftp://a.com/x" },
          { title: "javascript", url: "javascript:alert(1)" },
          { title: "not a url", url: "###" },
          { title: "ok", url: "https://ok.com/p" },
        ],
      },
    });
    expect(items.map((i) => i.url)).toEqual(["https://ok.com/p"]);
  });

  it("同一 URL 只保留第一条（商业 API 也会回重复项）", () => {
    const items = parseDirectSearchResults("tavily", {
      results: [
        { title: "first", url: "https://a.com/x", score: 0.9 },
        { title: "dup", url: "https://a.com/x", score: 0.8 },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("first");
  });

  it.each([
    ["null", null],
    ["字符串", "boom"],
    ["数组", []],
    ["results 不是数组", { results: "x" }],
    ["brave 缺 web 段", {}],
  ])("畸形响应（%s）回空数组而不抛错", (_name, raw) => {
    expect(parseDirectSearchResults("brave", raw)).toEqual([]);
    expect(parseDirectSearchResults("tavily", raw)).toEqual([]);
  });

  it("结果数被夹到 maxResultsPerQuery 以内（防远端无视 limit）", () => {
    const results = Array.from({ length: SEARCH_LIMITS.maxResultsPerQuery + 10 }, (_v, i) => ({
      title: `t${i}`,
      url: `https://a.com/${i}`,
    }));
    expect(parseDirectSearchResults("tavily", { results })).toHaveLength(
      SEARCH_LIMITS.maxResultsPerQuery,
    );
  });

  it("标题缺失时用域名兜底（title 在 SearchResultItem 里是必填）", () => {
    const items = parseDirectSearchResults("tavily", { results: [{ url: "https://a.com/x" }] });
    expect(items[0]!.title).toBe("a.com");
  });
});

describe("toDirectSearchBatchResponse", () => {
  const provider: DirectSearchProviderId = "brave";

  it("拼出与 Search Server 同形的响应，request_id 回填", () => {
    const response = toDirectSearchBatchResponse({
      requestId: "req-1",
      provider,
      durationMs: 123,
      perQuery: [
        { queryId: "q1", items: [{ url: "https://a.com", title: "A", domain: "a.com", engines: ["brave"], score: 1 }] },
        { queryId: "q2", items: [], error: "timeout" },
      ],
    });
    expect(response.request_id).toBe("req-1");
    expect(response.results).toHaveLength(2);
    expect(response.results[1]!.errors).toEqual([{ provider: "brave", code: "timeout" }]);
    // 直连没有服务端缓存，恒 false —— 别让 UI 显示一个假的缓存命中。
    expect(response.stats.cache_hit).toBe(false);
    expect(response.stats.provider_count).toBe(1);
    expect(response.stats.returned_result_count).toBe(1);
    expect(response.stats.duration_ms).toBe(123);
  });

  it("产物能通过 Search Server 的响应 schema（两条路径下游完全同形）", async () => {
    const { parseSearchBatchResponse } = await import("./search-api");
    const response = toDirectSearchBatchResponse({
      requestId: "req-1",
      provider,
      durationMs: 10,
      perQuery: [{ queryId: "q1", items: [] }],
    });
    expect(() => parseSearchBatchResponse(response)).not.toThrow();
  });
});
