// fetch_prepare 集成测试：起一个本地 node:http 假站，跑**真** safeRequest → 抽取 → 分块 → 打分 的闭环。
//
// 为什么能对 127.0.0.1 发起请求：`isForbiddenIp` 的禁止段是**参数**（core/research/url-safety
// 明确为此设计），这里传 `forbiddenRanges: []` 放行 loopback，`allowedPorts` 放行随机端口。
// 生产调用点两者都不传，走默认的「私网全禁 + 只允许 80/443」。
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFetchPrepare } from "./methods/fetch-prepare";
import type { FetchPrepareParams, MethodContext } from "./rpc-server";

const ARTICLE_HTML = `<!DOCTYPE html><html><head><title>Apache-2.0 许可证说明</title>
<link rel="canonical" href="https://example.com/article">
<meta property="og:published_time" content="2026-06-01T00:00:00Z"></head>
<body>
<nav>导航噪声 首页 关于</nav>
<article>
  <h1>许可证总览</h1>
  <p>${"This project is licensed under the Apache-2.0 license. ".repeat(8)}</p>
  <h2>兼容性</h2>
  <p>${"开源桌面 AI agent 的许可证通常是 MIT 或 Apache-2.0，二者可以互相兼容。".repeat(6)}</p>
</article>
<footer>页脚噪声 版权所有</footer>
</body></html>`;

let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/article") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ARTICLE_HTML);
      return;
    }
    if (path === "/hop1") {
      res.writeHead(302, { location: `${origin}/hop2` });
      res.end();
      return;
    }
    if (path === "/hop2") {
      res.writeHead(302, { location: "/article" });
      res.end();
      return;
    }
    if (path === "/loop") {
      res.writeHead(302, { location: `${origin}/loop` });
      res.end();
      return;
    }
    if (path === "/big") {
      // 不声明 content-length，逼抓取层「边收边计数」；对端断流后写入会报错，忽略即可。
      res.writeHead(200, { "content-type": "text/html" });
      res.on("error", () => {});
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      for (let i = 0; i < 16; i += 1) res.write(chunk);
      res.end();
      return;
    }
    if (path === "/doc.pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(Buffer.from("%PDF-1.7 这不是一个合法 PDF", "utf8"));
      return;
    }
    if (path === "/image") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<html><body>not found</body></html>");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/// 造一个只含给定 URL 的 fetch_prepare 参数。
function paramsFor(urls: string[]): FetchPrepareParams {
  return {
    operation_id: "op_int",
    objective: "开源桌面 AI agent 的许可证",
    subquestions: [{ id: "sq_1", text: "Apache-2.0 license 兼容性" }],
    candidates: urls.map((url, index) => ({
      candidate_id: `c_${index}`,
      query_id: "q_1",
      title: `候选 ${index}`,
      url,
      domain: "127.0.0.1",
      engines: ["local"],
      server_score: 1 - index * 0.05,
    })),
    known_fingerprints: [],
    policy: {
      trust_zone: "public_web",
      allow_search_server: true,
      allow_cloud_model: true,
      allow_cross_session_reuse: true,
    },
    limits: {
      max_documents: 20,
      max_browser_fetches: 0,
      max_total_bytes: 64 * 1024 * 1024,
      max_duration_ms: 30_000,
      http_concurrency: 4,
      per_host_concurrency: 4,
      request_timeout_ms: 5_000,
    },
  };
}

/// 集成用上下文：收集进度事件。
function makeContext(): { ctx: MethodContext; progress: string[] } {
  const progress: string[] = [];
  return {
    ctx: {
      signal: new AbortController().signal,
      emitProgress: (update) => progress.push(update.stage),
    },
    progress,
  };
}

/// 放行 loopback + 随机端口的注入依赖。
function loopbackDeps(): { forbiddenRanges: []; allowedPorts: number[] } {
  return { forbiddenRanges: [], allowedPorts: [(server.address() as AddressInfo).port] };
}

describe("fetch_prepare 真网络闭环（本地假站）", () => {
  it("正常 HTML：抓取 → 抽取 → 分块 → 打分，全链路产出可用证据", async () => {
    const { ctx, progress } = makeContext();
    const result = await runFetchPrepare(paramsFor([`${origin}/article`]), ctx, loopbackDeps());

    expect(result.failures).toEqual([]);
    expect(result.documents).toHaveLength(1);
    const doc = result.documents[0]!;
    expect(doc.title).toBe("Apache-2.0 许可证说明");
    expect(doc.canonical_url).toBe("https://example.com/article");
    expect(doc.published_at).toBe("2026-06-01T00:00:00Z");
    expect(doc.media_type).toBe("text/html");
    expect(doc.fetch_method).toBe("http");
    expect(doc.text).toContain("Apache-2.0");
    expect(doc.text).not.toContain("导航噪声");
    expect(doc.text).not.toContain("页脚噪声");

    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) {
      // 引用可回溯的根基：offset 必须能从落库正文切回块文本。
      expect(doc.text.slice(chunk.start_offset, chunk.end_offset)).toBe(chunk.text);
    }
    expect(result.chunks.some((chunk) => (chunk.heading_path ?? []).includes("许可证总览"))).toBe(true);
    expect(result.chunks.some((chunk) => chunk.lexical_score > 0)).toBe(true);
    expect(result.stats.http_fetches).toBe(1);
    expect(result.stats.total_bytes).toBeGreaterThan(0);
    expect(progress).toContain("fetching");
    expect(progress).toContain("ranking");
  });

  it("30x 链路：跟随重定向后拿到最终页", async () => {
    const { ctx } = makeContext();
    const result = await runFetchPrepare(paramsFor([`${origin}/hop1`]), ctx, loopbackDeps());
    expect(result.failures).toEqual([]);
    expect(result.documents[0]!.url).toBe(`${origin}/article`);
  });

  it("重定向死循环被跳数上限拦下", async () => {
    const { ctx } = makeContext();
    const result = await runFetchPrepare(paramsFor([`${origin}/loop`]), ctx, loopbackDeps());
    expect(result.documents).toHaveLength(0);
    expect(result.failures[0]).toMatchObject({ code: "blocked_by_policy" });
  });

  it("超大响应被中途掐断并归为 too_large", async () => {
    const { ctx } = makeContext();
    const result = await runFetchPrepare(paramsFor([`${origin}/big`]), ctx, loopbackDeps());
    expect(result.documents).toHaveLength(0);
    expect(result.failures[0]).toMatchObject({ code: "too_large" });
  });

  it("非法 PDF 归为失败而不是让 Worker 崩掉", async () => {
    const { ctx } = makeContext();
    const result = await runFetchPrepare(paramsFor([`${origin}/doc.pdf`]), ctx, loopbackDeps());
    expect(result.documents).toHaveLength(0);
    expect(result.failures[0]?.code).toBeDefined();
  });

  it("不支持的媒体类型与 404 各自归类，且不影响同批的正常候选", async () => {
    const { ctx } = makeContext();
    const result = await runFetchPrepare(
      paramsFor([`${origin}/article`, `${origin}/image`, `${origin}/missing`]),
      ctx,
      loopbackDeps(),
    );

    expect(result.documents).toHaveLength(1);
    const codes = result.failures.map((failure) => failure.code).sort();
    expect(codes).toEqual(["http_error", "unsupported_media"]);
    expect(result.failures.find((f) => f.code === "http_error")?.http_status).toBe(404);
  });

  it("默认策略（不放行 loopback）下同一批候选全部被拒——证明放行确实来自注入参数", async () => {
    const { ctx } = makeContext();
    const result = await runFetchPrepare(paramsFor([`${origin}/article`]), ctx, {});
    expect(result.documents).toHaveLength(0);
    expect(result.failures[0]).toMatchObject({ code: "blocked_by_policy" });
  });
});
