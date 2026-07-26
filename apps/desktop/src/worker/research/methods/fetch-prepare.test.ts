// fetch_prepare 单测：抓取编排的行为契约。抓取函数经 deps 注入，用手写替身，不起真网络。
// 真网络闭环见 ../fetch-prepare.integration.test.ts。
import { describe, expect, it } from "vitest";
import { parseWorkerResult } from "@cortex-work/core/research/protocol";
import { runFetchPrepare, type FetchPrepareDeps } from "./fetch-prepare";
import type { MethodContext } from "../rpc-server";
import type { FetchPrepareParams } from "../rpc-server";
import type { SafeRequestResult } from "../net/safe-request";

const ARTICLE = `<!DOCTYPE html><html><head><title>Apache 许可证说明</title>
<link rel="canonical" href="https://example.com/a">
<meta property="og:published_time" content="2026-06-01T00:00:00Z"></head>
<body><nav>导航噪声</nav><article>
<h1>许可证</h1>
<p>${"This project is licensed under the Apache-2.0 license. ".repeat(6)}</p>
<h2>细节</h2>
<p>${"开源桌面 AI agent 的许可证通常是 MIT 或 Apache-2.0，具体以仓库为准。".repeat(4)}</p>
</article></body></html>`;

/// 造一个成功的 HTTP 响应。
function htmlResponse(url: string, html = ARTICLE): SafeRequestResult {
  const body = Buffer.from(html, "utf8");
  return {
    ok: true,
    finalUrl: url,
    status: 200,
    mediaType: "text/html",
    headers: { "content-type": "text/html" },
    body,
    bytes: body.length,
    redirects: [],
  };
}

/// 造一个测试用的 MethodContext，记录进度事件。
function makeContext(signal?: AbortSignal): {
  ctx: MethodContext;
  progress: Array<{ stage: string; completed: number; total: number }>;
} {
  const progress: Array<{ stage: string; completed: number; total: number }> = [];
  return {
    ctx: {
      signal: signal ?? new AbortController().signal,
      emitProgress: (update) => progress.push(update),
    },
    progress,
  };
}

/// 造 fetch_prepare 参数。
function makeParams(overrides: Partial<FetchPrepareParams> = {}): FetchPrepareParams {
  return {
    operation_id: "op_1",
    objective: "开源桌面 AI agent 的许可证",
    subquestions: [{ id: "sq_1", text: "许可证是什么 license" }],
    candidates: [
      {
        candidate_id: "c_1",
        query_id: "q_1",
        title: "Apache 许可证说明",
        url: "https://example.com/a",
        domain: "example.com",
        engines: ["duckduckgo"],
        server_score: 0.9,
      },
    ],
    known_fingerprints: [],
    policy: {
      trust_zone: "public_web",
      allow_search_server: true,
      allow_cloud_model: true,
      allow_cross_session_reuse: true,
    },
    limits: {
      max_documents: 10,
      max_browser_fetches: 0,
      max_total_bytes: 50 * 1024 * 1024,
      max_duration_ms: 60_000,
      http_concurrency: 6,
      per_host_concurrency: 2,
      request_timeout_ms: 20_000,
    },
    ...overrides,
  };
}

/// 造只按 URL 应答的假抓取函数。
function fetcher(map: Record<string, SafeRequestResult>): FetchPrepareDeps["fetch"] {
  return async (input) =>
    map[input.url] ?? { ok: false, code: "http_error", message: "404", httpStatus: 404 };
}

describe("runFetchPrepare 主流程", () => {
  it("抓取 → 抽取 → 分块 → 打分，产出协议合法的结果", async () => {
    const { ctx, progress } = makeContext();
    const result = await runFetchPrepare(makeParams(), ctx, {
      fetch: fetcher({ "https://example.com/a": htmlResponse("https://example.com/a") }),
    });

    expect(parseWorkerResult("fetch_prepare", result)).toEqual(result);
    expect(result.operation_id).toBe("op_1");
    expect(result.documents).toHaveLength(1);
    expect(result.failures).toHaveLength(0);

    const doc = result.documents[0]!;
    expect(doc).toMatchObject({
      candidate_id: "c_1",
      url: "https://example.com/a",
      canonical_url: "https://example.com/a",
      title: "Apache 许可证说明",
      media_type: "text/html",
      fetch_method: "http",
      trust_zone: "public_web",
      published_at: "2026-06-01T00:00:00Z",
    });
    expect(doc.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.simhash).toMatch(/^[0-9a-f]{16}$/);
    expect(doc.text).not.toContain("导航噪声");
    expect(doc.text_length).toBe(doc.text.length);

    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) {
      expect(chunk.content_hash).toBe(doc.content_hash);
      expect(chunk.text_hash).toMatch(/^[0-9a-f]{64}$/);
      // offset 往返一致性：切块必须能定位回归一后的正文。
      expect(doc.text.slice(chunk.start_offset, chunk.end_offset)).toBe(chunk.text);
    }
    expect(result.chunks.some((chunk) => (chunk.heading_path?.length ?? 0) > 0)).toBe(true);
    expect(result.chunks.some((chunk) => chunk.lexical_score > 0)).toBe(true);
    expect(result.chunks.some((chunk) => (chunk.objective_score ?? 0) > 0)).toBe(true);
    expect(result.chunks.some((chunk) => (chunk.subquestion_scores?.sq_1 ?? 0) > 0)).toBe(true);

    expect(result.stats).toMatchObject({ http_fetches: 1, browser_fetches: 0, skipped_known: 0 });
    expect(result.stats.total_bytes).toBeGreaterThan(0);
    expect(progress.map((item) => item.stage)).toContain("fetching");
  });

  it("页面标题异常超长时回退到搜索候选标题", async () => {
    const html = ARTICLE.replace(
      "<title>Apache 许可证说明</title>",
      `<title>${"异常标题".repeat(20_000)}</title>`,
    );
    const result = await runFetchPrepare(makeParams(), makeContext().ctx, {
      fetch: fetcher({ "https://example.com/a": htmlResponse("https://example.com/a", html) }),
    });

    expect(result.documents[0]?.title).toBe("Apache 许可证说明");
  });

  it("抓取失败按有限错误码逐 URL 上报，不影响其它候选", async () => {
    const params = makeParams({
      candidates: [
        ...makeParams().candidates,
        {
          candidate_id: "c_2",
          query_id: "q_1",
          title: "内网",
          url: "http://10.0.0.5/internal",
          domain: "10.0.0.5",
          engines: ["brave"],
          server_score: 0.4,
        },
      ],
    });
    const { ctx } = makeContext();
    const result = await runFetchPrepare(params, ctx, {
      fetch: fetcher({
        "https://example.com/a": htmlResponse("https://example.com/a"),
        "http://10.0.0.5/internal": {
          ok: false,
          code: "blocked_by_policy",
          message: "resolved address is in a forbidden range",
        },
      }),
    });

    expect(result.documents).toHaveLength(1);
    expect(result.failures).toEqual([
      expect.objectContaining({ candidate_id: "c_2", code: "blocked_by_policy" }),
    ]);
  });

  it("命中 known_fingerprints 时不产出 chunk，只标 duplicate_of 并计入 skipped_known", async () => {
    // 先跑一次拿到 content_hash，再把它当作「已知指纹」重跑。
    const { ctx } = makeContext();
    const first = await runFetchPrepare(makeParams(), ctx, {
      fetch: fetcher({ "https://example.com/a": htmlResponse("https://example.com/a") }),
    });
    const knownHash = first.documents[0]!.content_hash;

    const second = await runFetchPrepare(
      makeParams({ known_fingerprints: [{ document_id: "doc_prev", content_hash: knownHash }] }),
      makeContext().ctx,
      { fetch: fetcher({ "https://example.com/a": htmlResponse("https://example.com/a") }) },
    );

    expect(second.documents[0]).toMatchObject({ duplicate_of: "doc_prev" });
    expect(second.chunks).toHaveLength(0);
    expect(second.stats.skipped_known).toBe(1);
  });

  it("近重复文档归入 duplicate_clusters（按内容哈希标识）", async () => {
    const near = ARTICLE.replace("具体以仓库为准", "具体请以仓库声明为准");
    const params = makeParams({
      candidates: [
        ...makeParams().candidates,
        {
          candidate_id: "c_2",
          query_id: "q_1",
          title: "转载",
          url: "https://mirror.example/a",
          domain: "mirror.example",
          engines: ["brave"],
          server_score: 0.5,
        },
      ],
    });
    const result = await runFetchPrepare(params, makeContext().ctx, {
      fetch: fetcher({
        "https://example.com/a": htmlResponse("https://example.com/a"),
        "https://mirror.example/a": htmlResponse("https://mirror.example/a", near),
      }),
    });

    expect(result.documents).toHaveLength(2);
    expect(result.duplicate_clusters).toHaveLength(1);
    expect(result.duplicate_clusters[0]!.member_hashes.length).toBeGreaterThan(0);
  });
});

describe("runFetchPrepare 预算与取消", () => {
  it("max_documents 限制抓取数量", async () => {
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      candidate_id: `c_${i}`,
      query_id: "q",
      title: `t${i}`,
      url: `https://example.com/p${i}`,
      domain: "example.com",
      engines: ["ddg"],
      server_score: 1 - i * 0.1,
    }));
    const map = Object.fromEntries(
      candidates.map((c) => [c.url, htmlResponse(c.url)]),
    ) as Record<string, SafeRequestResult>;

    const params = makeParams({ candidates, limits: { ...makeParams().limits, max_documents: 2 } });
    const result = await runFetchPrepare(params, makeContext().ctx, { fetch: fetcher(map) });
    expect(result.stats.http_fetches).toBe(2);
    expect(result.documents).toHaveLength(2);
  });

  it("超出 max_total_bytes 后停止继续抓取", async () => {
    const big = "x".repeat(4000);
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      candidate_id: `c_${i}`,
      query_id: "q",
      title: `t${i}`,
      url: `https://example.com/p${i}`,
      domain: "example.com",
      engines: ["ddg"],
      server_score: 1,
    }));
    const map = Object.fromEntries(
      candidates.map((c) => [
        c.url,
        htmlResponse(c.url, `<html><body><article><p>${big}</p></article></body></html>`),
      ]),
    ) as Record<string, SafeRequestResult>;

    const params = makeParams({
      candidates,
      limits: { ...makeParams().limits, max_total_bytes: 5000, http_concurrency: 1, per_host_concurrency: 1 },
    });
    const result = await runFetchPrepare(params, makeContext().ctx, { fetch: fetcher(map) });
    expect(result.documents.length).toBeLessThan(5);
    expect(result.stats.total_bytes).toBeGreaterThan(0);
  });

  it("取消信号会中止抓取并抛出（由 rpc-server 转成 cancelled 错误码）", async () => {
    const controller = new AbortController();
    const { ctx } = makeContext(controller.signal);
    controller.abort(new Error("cancelled"));

    await expect(
      runFetchPrepare(makeParams(), ctx, {
        fetch: fetcher({ "https://example.com/a": htmlResponse("https://example.com/a") }),
      }),
    ).rejects.toThrow();
  });

  it("把取消信号透传给抓取层（下游能立即掐断连接）", async () => {
    const controller = new AbortController();
    const { ctx } = makeContext(controller.signal);
    let seenSignal: AbortSignal | undefined;
    await runFetchPrepare(makeParams(), ctx, {
      fetch: async (input, deps) => {
        seenSignal = deps?.signal;
        return htmlResponse(input.url);
      },
    });
    expect(seenSignal).toBe(controller.signal);
  });
});

describe("runFetchPrepare PDF 路径", () => {
  it("PDF 响应走分页抽取，chunk 带页码", async () => {
    const pdfBytes = Buffer.from("%PDF-1.7 fake", "utf8");
    const result = await runFetchPrepare(
      makeParams({
        candidates: [
          {
            candidate_id: "c_pdf",
            query_id: "q",
            title: "白皮书",
            url: "https://example.com/doc.pdf",
            domain: "example.com",
            engines: ["ddg"],
            server_score: 0.8,
          },
        ],
      }),
      makeContext().ctx,
      {
        fetch: async () => ({
          ok: true,
          finalUrl: "https://example.com/doc.pdf",
          status: 200,
          mediaType: "application/pdf",
          headers: {},
          body: pdfBytes,
          bytes: pdfBytes.length,
          redirects: [],
        }),
        extractPdf: async () => ({
          ok: true,
          pageCount: 2,
          truncated: false,
          hasText: true,
          pages: [
            { page: 1, text: "第一页讲的是 Apache-2.0 许可证的适用范围与限制条款。".repeat(3), charStart: 0, charEnd: 10 },
            { page: 2, text: "第二页讲的是 MIT 许可证与它的兼容性问题以及注意事项。".repeat(3), charStart: 11, charEnd: 20 },
          ],
        }),
      },
    );

    expect(result.documents[0]).toMatchObject({ fetch_method: "pdf", media_type: "application/pdf" });
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks.every((chunk) => typeof chunk.page === "number")).toBe(true);
  });

  it("扫描件（无文本层）作为 empty_content 失败上报", async () => {
    const pdfBytes = Buffer.from("%PDF-1.7 scan", "utf8");
    const result = await runFetchPrepare(
      makeParams({
        candidates: [
          {
            candidate_id: "c_pdf",
            query_id: "q",
            title: "扫描件",
            url: "https://example.com/scan.pdf",
            domain: "example.com",
            engines: ["ddg"],
            server_score: 0.8,
          },
        ],
      }),
      makeContext().ctx,
      {
        fetch: async () => ({
          ok: true,
          finalUrl: "https://example.com/scan.pdf",
          status: 200,
          mediaType: "application/pdf",
          headers: {},
          body: pdfBytes,
          bytes: pdfBytes.length,
          redirects: [],
        }),
        extractPdf: async () => ({ ok: false, code: "empty_content", message: "没有文本层" }),
      },
    );
    expect(result.documents).toHaveLength(0);
    expect(result.failures[0]).toMatchObject({ code: "empty_content" });
  });
});

describe("prefetched（main 已抓好的正文）", () => {
  /// main 把服务端 Camoufox 抓回的 HTML 经 prefetched 交过来，Worker 直接抽取、**不联网**。
  /// 这条通道存在的唯一理由是凭据隔离：那次抓取要带 PAT，而 PAT 绝不能进 Worker 进程。
  it("命中 prefetched 时不发任何网络请求，正文照常抽取", async () => {
    let networkCalls = 0;
    const deps: FetchPrepareDeps = {
      fetch: async () => {
        networkCalls += 1;
        throw new Error("命中 prefetched 时不该联网");
      },
    };
    const { ctx } = makeContext();
    const result = await runFetchPrepare(
      makeParams({
        prefetched: [
          { candidate_id: "c_1", html: ARTICLE, final_url: "https://example.com/a" },
        ],
      }),
      ctx,
      deps,
    );

    expect(networkCalls).toBe(0);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.fetch_method).toBe("stealth");
    expect(result.documents[0]!.text).toContain("Apache-2.0");
    expect(result.failures).toHaveLength(0);
    // 产出必须仍然符合协议（fetch_method 新增值已在 protocol 里放行）。
    expect(() => parseWorkerResult("fetch_prepare", result)).not.toThrow();
  });

  it("final_url 作为文档 url，canonical 仍以页面自报为准", async () => {
    const { ctx } = makeContext();
    const result = await runFetchPrepare(
      makeParams({
        prefetched: [
          { candidate_id: "c_1", html: ARTICLE, final_url: "https://example.com/redirected" },
        ],
      }),
      ctx,
      { fetch: async () => { throw new Error("不该联网"); } },
    );
    expect(result.documents[0]!.url).toBe("https://example.com/redirected");
    expect(result.documents[0]!.canonical_url).toBe("https://example.com/a");
  });

  /// prefetched 里抽不出正文时**必须报失败**，不能产出一篇空文档。
  /// 反爬站点常返回一个「请求异常」的壳页面（实测知乎那个 126 字的 JSON 错误体），
  /// 让它以「抓取成功」的姿态进证据库，比抓取失败更糟——它会被当成正文送进报告。
  it("prefetched 抽不出正文时报 empty_content 失败", async () => {
    const { ctx } = makeContext();
    const result = await runFetchPrepare(
      makeParams({
        prefetched: [
          { candidate_id: "c_1", html: "<html><body></body></html>", final_url: "https://example.com/a" },
        ],
      }),
      ctx,
      { fetch: async () => { throw new Error("不该联网"); } },
    );
    expect(result.documents).toHaveLength(0);
    expect(result.failures[0]!.code).toBe("empty_content");
  });

  it("prefetched 里没有的候选照常走网络抓取", async () => {
    let networkCalls = 0;
    const { ctx } = makeContext();
    const result = await runFetchPrepare(
      makeParams({
        candidates: [
          ...makeParams().candidates,
          {
            candidate_id: "c_2",
            query_id: "q_1",
            title: "另一篇",
            url: "https://example.com/b",
            domain: "example.com",
            engines: ["duckduckgo"],
            server_score: 0.5,
          },
        ],
        prefetched: [
          { candidate_id: "c_1", html: ARTICLE, final_url: "https://example.com/a" },
        ],
      }),
      ctx,
      {
        fetch: async () => {
          networkCalls += 1;
          return htmlResponse("https://example.com/b", ARTICLE.replace("许可证", "另一主题"));
        },
      },
    );
    // c_1 走 prefetched（0 次网络），c_2 走网络（1 次）。
    expect(networkCalls).toBe(1);
    expect(result.documents.map((d) => d.fetch_method).sort()).toEqual(["http", "stealth"]);
  });
});
