// Browser 降级接线的行为契约（U6 接入 fetch_prepare）。
//
// 这里锁死的最重要一条是**安全红线**：`blocked_by_policy` 绝不触发 Browser 降级。
// HTTP 层拒绝一个 URL 是安全判定（私网 / 非法 scheme / userinfo / 端口 / 域名黑名单），
// 若允许它降级到 Browser 重试，等于给 SSRF 防线开了一条绕行道——而 U0 S6 已实测
// `agent-browser read` 对简单页面根本不起 Chrome、走自带 HTTP 客户端，那条路上没有我们的
// DNS 钉扎保护。
import { describe, expect, it, vi } from "vitest";

import type { BrowserFetchResult } from "../browser/agent-browser-adapter";
import type { SafeRequestResult } from "../net/safe-request";
import { runFetchPrepare } from "./fetch-prepare";

/// 构造一个最小可用的 fetch_prepare 入参；单候选，Browser 相关字段可覆盖。
function makeParams(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: "op_1",
    objective: "测试目标",
    subquestions: [{ id: "sq_1", text: "子问题" }],
    candidates: [
      {
        candidate_id: "c_1",
        query_id: "q_1",
        title: "T",
        url: "https://example.com/a",
        domain: "example.com",
        engines: ["ddg"],
        server_score: 0.9,
      },
    ],
    known_fingerprints: [],
    policy: {
      trust_zone: "public_web" as const,
      allow_search_server: true,
      allow_cloud_model: true,
      allow_cross_session_reuse: true,
    },
    limits: {
      max_documents: 10,
      max_browser_fetches: 5,
      max_total_bytes: 10_000_000,
      max_duration_ms: 60_000,
      http_concurrency: 4,
      per_host_concurrency: 2,
      request_timeout_ms: 5_000,
    },
    agent_browser_binary: "/fake/agent-browser",
    allowed_domains: ["example.com"],
    ...overrides,
  };
}

function makeCtx() {
  return {
    signal: new AbortController().signal,
    emitProgress: () => {},
  };
}

/// HTTP 层固定返回某个失败码的假抓取函数。
function failingFetch(code: string, httpStatus?: number) {
  return vi.fn(
    async (): Promise<SafeRequestResult> =>
      ({
        ok: false,
        code,
        message: `stub ${code}`,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      }) as SafeRequestResult,
  );
}

const browserOk: BrowserFetchResult = {
  ok: true,
  url: "https://example.com/a",
  finalUrl: "https://example.com/a",
  title: "浏览器抓到的标题",
  text: "这是一段只有浏览器渲染后才拿得到的正文内容，长度足够生成一个证据片段供后续引用。",
  browserLaunched: true,
};

describe("Browser 降级的触发条件", () => {
  it("HTTP 抽不出正文（empty_content）时降级到 Browser 并产出 Document", async () => {
    const browserFetch = vi.fn(async () => browserOk);
    const result = await runFetchPrepare(makeParams(), makeCtx(), {
      fetch: failingFetch("empty_content"),
      browserFetch,
    });

    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.fetch_method).toBe("browser");
    expect(result.documents[0]?.title).toBe("浏览器抓到的标题");
    expect(result.stats.browser_fetches).toBe(1);
    // 降级成功后不应再留下一条 failure——同一个候选不能既失败又成功。
    expect(result.failures).toHaveLength(0);
  });

  it.each([403, 429])("HTTP %i（疑似反爬）时降级到 Browser", async (status) => {
    const browserFetch = vi.fn(async () => browserOk);
    const result = await runFetchPrepare(makeParams(), makeCtx(), {
      fetch: failingFetch("http_error", status),
      browserFetch,
    });

    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(result.documents).toHaveLength(1);
  });

  it("HTTP 404 不降级（页面确实不存在，起浏览器纯属浪费额度）", async () => {
    const browserFetch = vi.fn(async () => browserOk);
    const result = await runFetchPrepare(makeParams(), makeCtx(), {
      fetch: failingFetch("http_error", 404),
      browserFetch,
    });

    expect(browserFetch).not.toHaveBeenCalled();
    expect(result.failures).toHaveLength(1);
    expect(result.stats.browser_fetches).toBe(0);
  });
});

describe("Browser 降级的安全红线", () => {
  it("blocked_by_policy 绝不降级到 Browser（否则等于给 SSRF 防线开绕行道）", async () => {
    const browserFetch = vi.fn(async () => browserOk);
    const result = await runFetchPrepare(makeParams(), makeCtx(), {
      fetch: failingFetch("blocked_by_policy"),
      browserFetch,
    });

    expect(browserFetch).not.toHaveBeenCalled();
    expect(result.failures[0]?.code).toBe("blocked_by_policy");
    expect(result.stats.browser_fetches).toBe(0);
  });

  it("未提供 agent_browser_binary 时不降级", async () => {
    const browserFetch = vi.fn(async () => browserOk);
    const result = await runFetchPrepare(
      makeParams({ agent_browser_binary: undefined }),
      makeCtx(),
      { fetch: failingFetch("empty_content"), browserFetch },
    );

    expect(browserFetch).not.toHaveBeenCalled();
    expect(result.failures).toHaveLength(1);
  });

  it("allowed_domains 为空时不降级（Browser 路径必须有域名白名单）", async () => {
    const browserFetch = vi.fn(async () => browserOk);
    const result = await runFetchPrepare(makeParams({ allowed_domains: [] }), makeCtx(), {
      fetch: failingFetch("empty_content"),
      browserFetch,
    });

    expect(browserFetch).not.toHaveBeenCalled();
    expect(result.failures[0]?.code).toBe("empty_content");
  });

  it("action policy 未生效（policy_not_enforced）时保留原 HTTP 失败，不产出 Document", async () => {
    const browserFetch = vi.fn(
      async (): Promise<BrowserFetchResult> => ({
        ok: false,
        code: "policy_not_enforced",
        message: "探针未被拒绝",
      }),
    );
    const result = await runFetchPrepare(makeParams(), makeCtx(), {
      fetch: failingFetch("empty_content"),
      browserFetch,
    });

    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(result.documents).toHaveLength(0);
    // 降级失败时上报的应是**原始** HTTP 失败码，而不是 Browser 的内部码——
    // 对 main 而言这个候选就是「没抓到正文」，Browser 只是没能救回来。
    expect(result.failures[0]?.code).toBe("empty_content");
    // 已经起过浏览器进程，额度必须计入。
    expect(result.stats.browser_fetches).toBe(1);
  });
});

describe("Browser 预算", () => {
  it("max_browser_fetches 用尽后不再降级", async () => {
    const browserFetch = vi.fn(async () => browserOk);
    const params = makeParams({
      limits: { ...makeParams().limits, max_browser_fetches: 1 },
      candidates: [
        { candidate_id: "c_1", query_id: "q_1", title: "A", url: "https://example.com/a", domain: "example.com", engines: [], server_score: 0.9 },
        { candidate_id: "c_2", query_id: "q_1", title: "B", url: "https://example.com/b", domain: "example.com", engines: [], server_score: 0.8 },
        { candidate_id: "c_3", query_id: "q_1", title: "C", url: "https://example.com/c", domain: "example.com", engines: [], server_score: 0.7 },
      ],
    });

    const result = await runFetchPrepare(params, makeCtx(), {
      fetch: failingFetch("empty_content"),
      browserFetch,
    });

    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(result.stats.browser_fetches).toBe(1);
    // 没轮到额度的候选保留原始 HTTP 失败。
    expect(result.failures).toHaveLength(2);
  });

  it("max_browser_fetches 为 0 时完全不降级", async () => {
    const browserFetch = vi.fn(async () => browserOk);
    const result = await runFetchPrepare(
      makeParams({ limits: { ...makeParams().limits, max_browser_fetches: 0 } }),
      makeCtx(),
      { fetch: failingFetch("empty_content"), browserFetch },
    );

    expect(browserFetch).not.toHaveBeenCalled();
    expect(result.stats.browser_fetches).toBe(0);
    expect(result.failures[0]?.code).toBe("empty_content");
  });
});
