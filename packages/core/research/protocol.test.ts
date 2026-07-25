// Worker 协议的契约测试。这里锁死的是「四端共用同一份样例」这条约束：
// TS main（客户端）、TS worker（服务端）、将来的 Rust worker、以及协议文档，都必须能解析
// PROTOCOL_FIXTURES 里的每一行，且必须拒绝被篡改的变体。fixtures 一旦变更即视为破坏性协议变更。
import { describe, expect, it } from "vitest";

import {
  PROTOCOL_FIXTURES,
  type ProtocolFixture,
} from "./protocol-fixtures";
import {
  RESEARCH_PROTOCOL_VERSION,
  WORKER_METHODS,
  parseWorkerInbound,
  parseWorkerOutbound,
  parseWorkerResult,
  workerErrorResponse,
} from "./protocol";

/// 按方向选择解析器：main→worker 的行用 inbound 解析，worker→main 的行用 outbound。
function parseByDirection(fixture: ProtocolFixture): unknown {
  return fixture.direction === "to_worker"
    ? parseWorkerInbound(JSON.parse(fixture.line))
    : parseWorkerOutbound(JSON.parse(fixture.line));
}

describe("research worker protocol fixtures", () => {
  it("每条 fixture 都是单行 JSON（JSONL 不允许内嵌裸换行）", () => {
    for (const fixture of PROTOCOL_FIXTURES) {
      expect(fixture.line.includes("\n"), fixture.name).toBe(false);
      expect(() => JSON.parse(fixture.line), fixture.name).not.toThrow();
    }
  });

  it.each(PROTOCOL_FIXTURES.map((f) => [f.name, f] as const))(
    "%s 能被对应方向的解析器接受",
    (_name, fixture) => {
      expect(() => parseByDirection(fixture)).not.toThrow();
    },
  );

  it("覆盖了全部业务 method", () => {
    const covered = new Set(
      PROTOCOL_FIXTURES.filter((f) => f.direction === "to_worker").map(
        (f) => (JSON.parse(f.line) as { method?: string }).method,
      ),
    );
    for (const method of WORKER_METHODS) {
      expect(covered.has(method), `缺少 ${method} 的 fixture`).toBe(true);
    }
  });

  it("每条 fixture 的 method 至少有一条对应的响应样例", () => {
    const responded = new Set(
      PROTOCOL_FIXTURES.filter((f) => f.direction === "to_main").map((f) => f.forMethod),
    );
    // shutdown 只需 ack；cancel 只需 ack。二者与其余方法一样必须有响应样例。
    for (const method of WORKER_METHODS) {
      expect(responded.has(method), `缺少 ${method} 的响应 fixture`).toBe(true);
    }
  });
});

describe("parseWorkerInbound", () => {
  it("拒绝未知 method", () => {
    expect(() =>
      parseWorkerInbound({ type: "request", id: "r1", method: "rm_rf", params: {} }),
    ).toThrow();
  });

  it("拒绝缺 id 的请求（id 是应答关联的唯一依据）", () => {
    expect(() => parseWorkerInbound({ type: "request", method: "doctor", params: {} })).toThrow();
  });

  it("拒绝 type 不是 request 的入站消息", () => {
    expect(() =>
      parseWorkerInbound({ type: "response", id: "r1", method: "doctor", params: {} }),
    ).toThrow();
  });

  it("hello 缺 protocol_version 时拒绝", () => {
    expect(() =>
      parseWorkerInbound({
        type: "request",
        id: "h1",
        method: "hello",
        params: { desktop_version: "0.1.48" },
      }),
    ).toThrow();
  });

  it("fetch_prepare 缺 agent_browser_binary 仍可解析（Browser 不可用是合法状态）", () => {
    const base = JSON.parse(
      PROTOCOL_FIXTURES.find((f) => f.name === "fetch_prepare:request")!.line,
    ) as { params: Record<string, unknown> };
    delete base.params.agent_browser_binary;
    expect(() => parseWorkerInbound(base)).not.toThrow();
  });

  it("fetch_prepare 的 candidates 为空数组时拒绝（无候选就不该发请求）", () => {
    const base = JSON.parse(
      PROTOCOL_FIXTURES.find((f) => f.name === "fetch_prepare:request")!.line,
    ) as { params: Record<string, unknown> };
    base.params.candidates = [];
    expect(() => parseWorkerInbound(base)).toThrow();
  });
});

describe("parseWorkerOutbound", () => {
  it("拒绝同时带 result 与 error 的响应（语义二义）", () => {
    expect(() =>
      parseWorkerOutbound({ type: "response", id: "r1", result: {}, error: { code: "x", message: "y" } }),
    ).toThrow();
  });

  it("拒绝既无 result 也无 error 的响应", () => {
    expect(() => parseWorkerOutbound({ type: "response", id: "r1" })).toThrow();
  });

  it("错误响应必须带 code 与 message", () => {
    expect(() =>
      parseWorkerOutbound({ type: "response", id: "r1", error: { message: "boom" } }),
    ).toThrow();
  });

  it("接受进度事件（无 id，因为不关联任何请求应答）", () => {
    expect(() =>
      parseWorkerOutbound({
        type: "event",
        event: "progress",
        operation_id: "op_01",
        stage: "fetching",
        completed: 3,
        total: 10,
      }),
    ).not.toThrow();
  });
});

describe("workerErrorResponse", () => {
  it("产出的错误信封自身可被 parseWorkerOutbound 接受", () => {
    const line = workerErrorResponse("r1", "invalid_params", "boom");
    expect(() => parseWorkerOutbound(JSON.parse(line))).not.toThrow();
    expect(line.includes("\n")).toBe(false);
  });
});

describe("RESEARCH_PROTOCOL_VERSION", () => {
  it("与 spec §12.1 的 protocol_version: 1 一致", () => {
    expect(RESEARCH_PROTOCOL_VERSION).toBe(1);
  });

  it("全部 hello fixture 都声明当前协议版本", () => {
    const hello = PROTOCOL_FIXTURES.find((f) => f.name === "hello:request")!;
    const parsed = JSON.parse(hello.line) as { params: { protocol_version: number } };
    expect(parsed.params.protocol_version).toBe(RESEARCH_PROTOCOL_VERSION);
  });
});

describe("fetch_prepare 的 prefetched 入参", () => {
  /// prefetched 让 main 把「自己已经抓好的 HTML」交给 Worker 走既有抽取管线。
  ///
  /// 为什么需要这条通道：反爬站点要靠服务端的 Camoufox 才抓得到，而那次请求要带 PAT——
  /// **凭据绝不能进 Worker 进程**（它解析的是不可信 HTML，一个解析漏洞就会升级成凭据泄漏）。
  /// 于是抓取留在 main、抽取留在 Worker，中间靠这个字段传 HTML。
  function fetchPrepareRequest(): { params: Record<string, unknown> } {
    return JSON.parse(
      PROTOCOL_FIXTURES.find((f) => f.name === "fetch_prepare:request")!.line,
    ) as { params: Record<string, unknown> };
  }

  it("接受 prefetched 数组", () => {
    const base = fetchPrepareRequest();
    base.params.prefetched = [
      { candidate_id: "c_1", html: "<html>正文</html>", final_url: "https://example.com/a" },
    ];
    expect(() => parseWorkerInbound(base)).not.toThrow();
  });

  it("prefetched 缺省时照常解析（向后兼容：旧 main 不会发这个字段）", () => {
    const base = fetchPrepareRequest();
    delete base.params.prefetched;
    expect(() => parseWorkerInbound(base)).not.toThrow();
  });

  it("prefetched 条目缺 html 时拒绝（没有正文就没有存在的意义）", () => {
    const base = fetchPrepareRequest();
    base.params.prefetched = [{ candidate_id: "c_1", final_url: "https://example.com/a" }];
    expect(() => parseWorkerInbound(base)).toThrow();
  });

  it("prefetched 条目缺 candidate_id 时拒绝（无法归属到候选）", () => {
    const base = fetchPrepareRequest();
    base.params.prefetched = [{ html: "<html>x</html>", final_url: "https://example.com/a" }];
    expect(() => parseWorkerInbound(base)).toThrow();
  });
});

describe("fetch_method 支持 stealth", () => {
  /// 服务端抓回来的文档要能与本地抓取区分开：它的可信度评估、缓存策略、
  /// 以及「这条证据是怎么来的」都与 http / browser 不同，混用一个值会让审计无从下手。
  ///
  /// 注意用 parseWorkerResult 而不是 parseWorkerOutbound：后者只校验响应**信封**
  /// （method 在信封解析时还不可知，见 protocol.ts 的两步设计），文档级字段要靠前者。
  function documentsOf(): Array<Record<string, unknown>> {
    const base = JSON.parse(
      PROTOCOL_FIXTURES.find((f) => f.name === "fetch_prepare:response")!.line,
    ) as { result: { documents: Array<Record<string, unknown>> } };
    return base.result.documents;
  }

  function resultWith(fetchMethod: string): unknown {
    const base = JSON.parse(
      PROTOCOL_FIXTURES.find((f) => f.name === "fetch_prepare:response")!.line,
    ) as { result: { documents: Array<Record<string, unknown>> } };
    base.result.documents[0]!.fetch_method = fetchMethod;
    return base.result;
  }

  it("fixture 里确实有文档可供改写（否则下面两条断言是空转）", () => {
    expect(documentsOf().length).toBeGreaterThan(0);
  });

  it("fetch_method 允许 stealth", () => {
    expect(() => parseWorkerResult("fetch_prepare", resultWith("stealth"))).not.toThrow();
  });

  it("未知的 fetch_method 仍然被拒", () => {
    expect(() => parseWorkerResult("fetch_prepare", resultWith("telepathy"))).toThrow();
  });
});
