// 服务端 stealth 抓取客户端的测试。
//
// 重点守三件事：
//   1. **错误分类正确**——编排层据此决定「放弃这个候选」还是「稍后重排」，分错会让
//      一次浏览器槽位争用被误判成「这篇文章抓不到」；
//   2. **unconfigured 能被单独识别**——它不是错误，而是「整条 stealth 路径不可用」，
//      编排层要据此彻底跳过，而不是逐个候选各撞一次 5 秒往返；
//   3. **凭据绝不出现在任何对外文本里**——服务端可能把鉴权头回显进错误体。
import { describe, expect, it, vi } from "vitest";
import { StealthFetchClient, StealthFetchError } from "./stealth-fetch-client";

const CONFIG = {
  baseUrl: "http://127.0.0.1:28080",
  workspaceId: "ws-1",
  token: "mul_secret_token_value",
};

function clientWith(fetchFn: typeof fetch): StealthFetchClient {
  return new StealthFetchClient(CONFIG, { fetchFn });
}

/// 构造 fetch 替身。**显式声明入参**：`vi.fn(async () => ...)` 推出来的调用元组是 `[]`，
/// 于是 `mock.calls[0][0]` 在 typecheck 下直接报「长度 0 的元组没有下标 0」。
function fakeFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  return vi.fn((url: RequestInfo | URL, init?: RequestInit) =>
    impl(String(url), init ?? {}),
  ) as unknown as typeof fetch & {
    mock: { calls: Array<[string, RequestInit]> };
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("StealthFetchClient 正常路径", () => {
  it("打到正确的端点，带 Bearer 与 url", async () => {
    const fetchFn = fakeFetch(async () =>
      jsonResponse({ status: 200, html: "<html>正文</html>", final_url: "https://a.example/x" }),
    );
    const result = await clientWith(fetchFn).fetch("https://a.example/x");

    expect(result).toEqual({ status: 200, html: "<html>正文</html>", finalUrl: "https://a.example/x" });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:28080/api/workspaces/ws-1/research/fetch");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${CONFIG.token}` });
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://a.example/x" });
  });

  it("baseUrl 末尾多余的斜杠被归一化", async () => {
    const fetchFn = fakeFetch(async () => jsonResponse({ status: 200, html: "x", final_url: "" }));
    const client = new StealthFetchClient(
      { ...CONFIG, baseUrl: "http://127.0.0.1:28080///" },
      { fetchFn },
    );
    await client.fetch("https://a.example/x");
    expect(fetchFn.mock.calls[0]![0]).toBe(
      "http://127.0.0.1:28080/api/workspaces/ws-1/research/fetch",
    );
  });

  /// 目标页面自身是 404 时**不算抓取失败**：我们确实拿到了服务端的响应。
  /// 判定「这篇有没有正文」是抽取层的事，不是传输层的事。
  it("页面自身 404 仍算成功返回（status 原样透出）", async () => {
    const fetchFn = fakeFetch(async () =>
      jsonResponse({ status: 404, html: "<html>没有知识存在的荒原</html>", final_url: "https://a" }),
    );
    const result = await clientWith(fetchFn).fetch("https://a");
    expect(result.status).toBe(404);
  });
});

describe("StealthFetchClient 错误分类", () => {
  const cases: Array<{ serverCode: string; status: number; expected: string }> = [
    { serverCode: "fetch_unconfigured", status: 503, expected: "unconfigured" },
    { serverCode: "blocked_by_policy", status: 400, expected: "blocked_by_policy" },
    { serverCode: "busy", status: 429, expected: "busy" },
    { serverCode: "fetch_timeout", status: 504, expected: "timeout" },
    { serverCode: "fetch_unavailable", status: 503, expected: "unavailable" },
    { serverCode: "fetch_failed", status: 502, expected: "fetch_failed" },
  ];
  for (const c of cases) {
    it(`服务端 ${c.serverCode} → ${c.expected}`, async () => {
      const fetchFn = fakeFetch(async () =>
        jsonResponse({ error: { code: c.serverCode, message: "x" } }, c.status),
      );
      await expect(clientWith(fetchFn).fetch("https://a")).rejects.toMatchObject(
        { code: c.expected },
      );
    });
  }

  /// 服务端没回 code（或错误体不是 JSON）时按状态码兜底 —— 分类不能因此失效。
  const statusOnly: Array<{ status: number; expected: string }> = [
    { status: 401, expected: "unauthorized" },
    { status: 403, expected: "forbidden" },
    // 服务端对非成员统一回 404（见验收记录 §19.2.6），语义等同无权访问。
    { status: 404, expected: "forbidden" },
    { status: 429, expected: "busy" },
    { status: 504, expected: "timeout" },
    { status: 503, expected: "unavailable" },
    { status: 500, expected: "fetch_failed" },
  ];
  for (const c of statusOnly) {
    it(`无 code 时按状态码 ${c.status} → ${c.expected}`, async () => {
      const fetchFn = fakeFetch(async () => new Response("not json", { status: c.status }));
      await expect(clientWith(fetchFn).fetch("https://a")).rejects.toMatchObject(
        { code: c.expected },
      );
    });
  }
});

describe("StealthFetchClient 契约与红线", () => {
  it("缺 html 字段一律报错，不补空字符串降级", async () => {
    const fetchFn = fakeFetch(async () => jsonResponse({ status: 200, final_url: "https://a" }));
    await expect(clientWith(fetchFn).fetch("https://a")).rejects.toMatchObject(
      { code: "invalid_response" },
    );
  });

  it("响应不是 JSON 时报 invalid_response", async () => {
    const fetchFn = fakeFetch(async () => new Response("<html>", { status: 200 }));
    await expect(clientWith(fetchFn).fetch("https://a")).rejects.toMatchObject(
      { code: "invalid_response" },
    );
  });

  it("Content-Length 声明超限时不读 body", async () => {
    const textFn = vi.fn(async () => "x");
    const fetchFn = fakeFetch(async () => {
      const resp = new Response("x", {
        status: 200,
        headers: { "content-length": String(64 * 1024 * 1024) },
      });
      Object.defineProperty(resp, "text", { value: textFn });
      return resp;
    });
    await expect(clientWith(fetchFn).fetch("https://a")).rejects.toMatchObject(
      { code: "invalid_response" },
    );
    expect(textFn).not.toHaveBeenCalled();
  });

  /// 红线：服务端把鉴权头回显进错误体时，凭据不得出现在错误消息里
  /// （这条消息会显示给用户、并可能被截图外发）。
  it("错误消息里不出现 token 明文", async () => {
    const fetchFn = fakeFetch(async () => {
      throw new Error(`connect failed with Bearer ${CONFIG.token}`);
    });
    let caught: unknown;
    try {
      await clientWith(fetchFn).fetch("https://a");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StealthFetchError);
    expect((caught as Error).message).not.toContain(CONFIG.token);
  });

  it("调用方取消时归类为 cancelled 而不是故障", async () => {
    const controller = new AbortController();
    const fetchFn = fakeFetch(async () => {
      controller.abort();
      throw new Error("aborted");
    });
    await expect(
      clientWith(fetchFn).fetch("https://a", controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});
