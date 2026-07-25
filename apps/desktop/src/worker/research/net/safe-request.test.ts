// safe-request 单测：SSRF 防线的行为契约（spec §12.3、§19.2.1、§19.2.2）。
//
// 零 mock 框架：request 工厂与 DNS lookup 都是注入参数，这里用 EventEmitter 拼手写替身，
// 因此可以真实驱动 data/end/error 事件，覆盖「边收边计数、超限立即 destroy」这类时序分支。
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  MAX_HTML_BYTES,
  safeRequest,
  type HttpRequestFn,
  type RequestOptions,
  type ResponseLike,
} from "./safe-request";
import type { DnsLookupFn } from "./dns-guard";

/// 假 ClientRequest：记录 end/destroy 调用，可被外部 emit error。
class FakeRequest extends EventEmitter {
  ended = false;
  destroyed = false;
  end(): void {
    this.ended = true;
  }
  destroy(err?: Error): void {
    this.destroyed = true;
    if (err) this.emit("error", err);
  }
}

/// 假 IncomingMessage：destroy 后不再投递数据（模拟真实 socket 被掐断）。
class FakeResponse extends EventEmitter {
  destroyed = false;
  constructor(
    readonly statusCode: number,
    readonly headers: Record<string, string>,
  ) {
    super();
  }
  destroy(): void {
    this.destroyed = true;
  }
}

interface Exchange {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Array<string | Buffer>;
  /// 请求层错误（连接失败 / TLS 失败），与响应二选一。
  error?: Error & { code?: string };
  /// 永不响应，用于超时用例。
  hang?: boolean;
}

/// 按脚本逐次应答的假 request 工厂。
function scriptedRequester(exchanges: Exchange[]): {
  fn: HttpRequestFn;
  calls: RequestOptions[];
  requests: FakeRequest[];
  responses: FakeResponse[];
} {
  const calls: RequestOptions[] = [];
  const requests: FakeRequest[] = [];
  const responses: FakeResponse[] = [];

  const fn: HttpRequestFn = (options, onResponse) => {
    const index = calls.length;
    calls.push(options);
    const req = new FakeRequest();
    requests.push(req);
    const exchange = exchanges[index];

    queueMicrotask(() => {
      if (!exchange || exchange.hang) return;
      if (exchange.error) {
        req.emit("error", exchange.error);
        return;
      }
      const res = new FakeResponse(exchange.status ?? 200, exchange.headers ?? {});
      responses.push(res);
      onResponse(res as unknown as ResponseLike);
      queueMicrotask(() => {
        for (const chunk of exchange.chunks ?? []) {
          if (res.destroyed) return;
          res.emit("data", Buffer.from(chunk));
        }
        if (!res.destroyed) res.emit("end");
      });
    });

    return req;
  };

  return { fn, calls, requests, responses };
}

/// 按主机名返回地址的假 DNS。
function lookupMap(map: Record<string, string>): DnsLookupFn {
  return async (host) => {
    const address = map[host];
    if (!address) throw new Error(`ENOTFOUND ${host}`);
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };
}

const html = { "content-type": "text/html; charset=utf-8" };

describe("safeRequest 正常路径", () => {
  it("200 文本返回正文、状态与媒体类型", async () => {
    const requester = scriptedRequester([{ status: 200, headers: html, chunks: ["<p>hi</p>"] }]);
    const result = await safeRequest(
      { url: "https://example.com/a" },
      { request: requester.fn, lookup: lookupMap({ "example.com": "93.184.216.34" }) },
    );

    expect(result).toMatchObject({ ok: true, status: 200, mediaType: "text/html" });
    if (!result.ok) return;
    expect(result.body.toString("utf8")).toBe("<p>hi</p>");
    expect(result.finalUrl).toBe("https://example.com/a");
  });

  it("把连接钉死在已验证的 IP，并禁用共享 agent（防 DNS rebinding / 全局 agent 被改）", async () => {
    const requester = scriptedRequester([{ status: 200, headers: html, chunks: ["ok"] }]);
    await safeRequest(
      { url: "https://example.com/a" },
      { request: requester.fn, lookup: lookupMap({ "example.com": "93.184.216.34" }) },
    );

    const options = requester.calls[0]!;
    expect(options.hostname).toBe("example.com");
    expect(options.port).toBe(443);
    expect(options.agent).toBe(false);

    // 传给 agent 的自定义 lookup 必须直接回吐已验证地址，不再触发第二次 DNS 查询。
    const pinned = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      options.lookup("example.com", { all: false }, (err, address, family) => {
        if (err) reject(err);
        else resolve({ address: address as string, family: family as number });
      });
    });
    expect(pinned).toEqual({ address: "93.184.216.34", family: 4 });
  });
});

describe("safeRequest URL 策略（第一道闸）", () => {
  it("非 http/https 被拒且不发起任何连接", async () => {
    const requester = scriptedRequester([]);
    const result = await safeRequest(
      { url: "file:///etc/passwd" },
      { request: requester.fn, lookup: lookupMap({}) },
    );
    expect(result).toMatchObject({ ok: false, code: "blocked_by_policy" });
    expect(requester.calls).toHaveLength(0);
  });

  it("URL 带 userinfo 被拒", async () => {
    const requester = scriptedRequester([]);
    const result = await safeRequest(
      { url: "https://user:pass@example.com/a" },
      { request: requester.fn, lookup: lookupMap({ "example.com": "93.184.216.34" }) },
    );
    expect(result).toMatchObject({ ok: false, code: "blocked_by_policy" });
    expect(requester.calls).toHaveLength(0);
  });

  it("非 80/443 端口被拒", async () => {
    const requester = scriptedRequester([]);
    const result = await safeRequest(
      { url: "http://example.com:8080/internal" },
      { request: requester.fn, lookup: lookupMap({ "example.com": "93.184.216.34" }) },
    );
    expect(result).toMatchObject({ ok: false, code: "blocked_by_policy" });
    expect(requester.calls).toHaveLength(0);
  });

  it("allowedPorts 可注入（集成测试的本地假站要跑在随机端口上）", async () => {
    const requester = scriptedRequester([{ status: 200, headers: html, chunks: ["ok"] }]);
    const result = await safeRequest(
      { url: "http://example.com:8123/x", allowedPorts: [8123] },
      { request: requester.fn, lookup: lookupMap({ "example.com": "93.184.216.34" }) },
    );
    expect(result.ok).toBe(true);
    expect(requester.calls[0]!.port).toBe(8123);
  });

  it("首跳解析到私网即拒，不发起连接", async () => {
    const requester = scriptedRequester([]);
    const result = await safeRequest(
      { url: "https://internal.example/a" },
      { request: requester.fn, lookup: lookupMap({ "internal.example": "10.0.0.5" }) },
    );
    expect(result).toMatchObject({ ok: false, code: "blocked_by_policy" });
    expect(requester.calls).toHaveLength(0);
  });
});

describe("safeRequest 重定向（spec §19.2.2）", () => {
  it("公网 URL 30x 跳私网被拒绝", async () => {
    const requester = scriptedRequester([
      { status: 302, headers: { location: "http://internal.example/secret" } },
      { status: 200, headers: html, chunks: ["should never be fetched"] },
    ]);
    const result = await safeRequest(
      { url: "https://example.com/a" },
      {
        request: requester.fn,
        lookup: lookupMap({ "example.com": "93.184.216.34", "internal.example": "169.254.169.254" }),
      },
    );

    expect(result).toMatchObject({ ok: false, code: "blocked_by_policy" });
    // 第二跳必须在建立连接**之前**就被拦下。
    expect(requester.calls).toHaveLength(1);
  });

  it("30x 跳非法端口同样被完整策略拦下", async () => {
    const requester = scriptedRequester([
      { status: 301, headers: { location: "http://example.com:22/" } },
    ]);
    const result = await safeRequest(
      { url: "https://example.com/a" },
      { request: requester.fn, lookup: lookupMap({ "example.com": "93.184.216.34" }) },
    );
    expect(result).toMatchObject({ ok: false, code: "blocked_by_policy" });
    expect(requester.calls).toHaveLength(1);
  });

  it("5 跳以内的重定向正常跟随，finalUrl 是最后一跳", async () => {
    const requester = scriptedRequester([
      { status: 302, headers: { location: "/b" } },
      { status: 302, headers: { location: "/c" } },
      { status: 200, headers: html, chunks: ["done"] },
    ]);
    const result = await safeRequest(
      { url: "https://example.com/a" },
      { request: requester.fn, lookup: lookupMap({ "example.com": "93.184.216.34" }) },
    );
    expect(result).toMatchObject({ ok: true, finalUrl: "https://example.com/c" });
    expect(requester.calls).toHaveLength(3);
  });

  it("超过 5 跳被拒", async () => {
    const redirect = { status: 302, headers: { location: "https://example.com/next" } };
    const requester = scriptedRequester(Array.from({ length: 8 }, () => redirect));
    const result = await safeRequest(
      { url: "https://example.com/a" },
      { request: requester.fn, lookup: lookupMap({ "example.com": "93.184.216.34" }) },
    );
    expect(result).toMatchObject({ ok: false, code: "blocked_by_policy" });
    // 1 次初始 + 最多 5 次重定向 = 6 次请求，第 6 次仍是 30x 才放弃。
    expect(requester.calls).toHaveLength(6);
  });

  it("30x 缺 Location 头按 http_error 处理", async () => {
    const requester = scriptedRequester([{ status: 302, headers: {} }]);
    const result = await safeRequest(
      { url: "https://example.com/a" },
      { request: requester.fn, lookup: lookupMap({ "example.com": "93.184.216.34" }) },
    );
    expect(result).toMatchObject({ ok: false, code: "http_error", httpStatus: 302 });
  });
});

describe("safeRequest 体积与超时", () => {
  it("超大响应边收边计数，超限立即 destroy 而不是收完再判", async () => {
    // 每块 1 MiB，总量远超 HTML 上限；断言消费的块数远小于总块数。
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const requester = scriptedRequester([
      { status: 200, headers: html, chunks: Array.from({ length: 40 }, () => chunk) },
    ]);
    const result = await safeRequest(
      { url: "https://example.com/big" },
      { request: requester.fn, lookup: lookupMap({ "example.com": "93.184.216.34" }) },
    );

    expect(result).toMatchObject({ ok: false, code: "too_large" });
    expect(requester.responses[0]!.destroyed).toBe(true);
  });

  it("content-length 已超限时直接拒绝且不读取正文", async () => {
    const requester = scriptedRequester([
      {
        status: 200,
        headers: { ...html, "content-length": String(MAX_HTML_BYTES + 1) },
        chunks: ["never read"],
      },
    ]);
    const result = await safeRequest(
      { url: "https://example.com/big" },
      { request: requester.fn, lookup: lookupMap({ "example.com": "93.184.216.34" }) },
    );
    expect(result).toMatchObject({ ok: false, code: "too_large" });
    expect(requester.responses[0]!.destroyed).toBe(true);
  });

  it("PDF 的上限比 HTML 宽（30 MiB）", async () => {
    const requester = scriptedRequester([
      {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": String(MAX_HTML_BYTES + 1) },
        chunks: [Buffer.alloc(16, 0x25)],
      },
    ]);
    const result = await safeRequest(
      { url: "https://example.com/doc.pdf" },
      { request: requester.fn, lookup: lookupMap({ "example.com": "93.184.216.34" }) },
    );
    expect(result).toMatchObject({ ok: true, mediaType: "application/pdf" });
  });

  it("不支持的媒体类型立即断流", async () => {
    const requester = scriptedRequester([
      { status: 200, headers: { "content-type": "image/png" }, chunks: ["PNG"] },
    ]);
    const result = await safeRequest(
      { url: "https://example.com/x.png" },
      { request: requester.fn, lookup: lookupMap({ "example.com": "93.184.216.34" }) },
    );
    expect(result).toMatchObject({ ok: false, code: "unsupported_media" });
    expect(requester.responses[0]!.destroyed).toBe(true);
  });

  it("超时后 destroy 请求并返回 timeout", async () => {
    const requester = scriptedRequester([{ hang: true }]);
    const result = await safeRequest(
      { url: "https://example.com/slow", timeoutMs: 10 },
      { request: requester.fn, lookup: lookupMap({ "example.com": "93.184.216.34" }) },
    );
    expect(result).toMatchObject({ ok: false, code: "timeout" });
    expect(requester.requests[0]!.destroyed).toBe(true);
  });
});

describe("safeRequest 错误分类", () => {
  it("4xx/5xx 归为 http_error 并带上状态码", async () => {
    const requester = scriptedRequester([{ status: 404, headers: html, chunks: ["nope"] }]);
    const result = await safeRequest(
      { url: "https://example.com/missing" },
      { request: requester.fn, lookup: lookupMap({ "example.com": "93.184.216.34" }) },
    );
    expect(result).toMatchObject({ ok: false, code: "http_error", httpStatus: 404 });
  });

  it("连接错误归为 connect_failure，TLS 错误归为 tls_failure", async () => {
    const connectErr = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const tlsErr = Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });

    const a = await safeRequest(
      { url: "https://example.com/a" },
      {
        request: scriptedRequester([{ error: connectErr }]).fn,
        lookup: lookupMap({ "example.com": "93.184.216.34" }),
      },
    );
    const b = await safeRequest(
      { url: "https://example.com/a" },
      {
        request: scriptedRequester([{ error: tlsErr }]).fn,
        lookup: lookupMap({ "example.com": "93.184.216.34" }),
      },
    );

    expect(a).toMatchObject({ ok: false, code: "connect_failure" });
    expect(b).toMatchObject({ ok: false, code: "tls_failure" });
  });

  it("DNS 解析失败归为 dns_failure", async () => {
    const requester = scriptedRequester([]);
    const result = await safeRequest(
      { url: "https://nope.invalid/a" },
      { request: requester.fn, lookup: lookupMap({}) },
    );
    expect(result).toMatchObject({ ok: false, code: "dns_failure" });
  });

  it("已 abort 的 signal 直接返回 cancelled，不发起连接", async () => {
    const controller = new AbortController();
    controller.abort();
    const requester = scriptedRequester([{ status: 200, headers: html, chunks: ["x"] }]);
    const result = await safeRequest(
      { url: "https://example.com/a" },
      {
        request: requester.fn,
        lookup: lookupMap({ "example.com": "93.184.216.34" }),
        signal: controller.signal,
      },
    );
    expect(result).toMatchObject({ ok: false, code: "cancelled" });
    expect(requester.calls).toHaveLength(0);
  });

  it("传输途中 abort 会掐断请求并返回 cancelled", async () => {
    const controller = new AbortController();
    const requester = scriptedRequester([{ hang: true }]);
    const pending = safeRequest(
      { url: "https://example.com/a", timeoutMs: 5_000 },
      {
        request: requester.fn,
        lookup: lookupMap({ "example.com": "93.184.216.34" }),
        signal: controller.signal,
      },
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(requester.requests[0]!.destroyed).toBe(true);
  });
});

describe("safeRequest 域名白名单", () => {
  it("allowlist 之外的域名被拒（Browser 降级前的同源判定）", async () => {
    const requester = scriptedRequester([]);
    const result = await safeRequest(
      { url: "https://other.com/a", allowlist: ["example.com"] },
      { request: requester.fn, lookup: lookupMap({ "other.com": "93.184.216.34" }) },
    );
    expect(result).toMatchObject({ ok: false, code: "blocked_by_policy" });
    expect(requester.calls).toHaveLength(0);
  });

  it("allowlist 在每一跳都重新生效", async () => {
    const requester = scriptedRequester([
      { status: 302, headers: { location: "https://other.com/b" } },
    ]);
    const result = await safeRequest(
      { url: "https://example.com/a", allowlist: ["example.com"] },
      {
        request: requester.fn,
        lookup: lookupMap({ "example.com": "93.184.216.34", "other.com": "93.184.216.35" }),
      },
    );
    expect(result).toMatchObject({ ok: false, code: "blocked_by_policy" });
    expect(requester.calls).toHaveLength(1);
  });
});
