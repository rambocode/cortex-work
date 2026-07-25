// rpc-server 单测：行缓冲、握手闸、错误信封、cancel 注册表。
//
// 核心用例是「把 PROTOCOL_FIXTURES 里方向为 to_worker 的每一行灌进 dispatch，断言产出的行
// 能过 parseWorkerOutbound」——这是「四端解析同一份样例」（spec §18 U0）在 TS Worker 端的落地。
import { describe, expect, it } from "vitest";
import { PROTOCOL_FIXTURES } from "@cortex-work/core/research/protocol-fixtures";
import {
  RESEARCH_PROTOCOL_VERSION,
  parseWorkerOutbound,
  parseWorkerResult,
  WORKER_METHODS,
  type WorkerMethod,
} from "@cortex-work/core/research/protocol";
import { ResearchRpcServer, type WorkerMethodHandlers } from "./rpc-server";

/// 各 method 的最小合法结果（形状取自 protocol 的 WORKER_RESULT_SCHEMAS）。
function stubHandlers(overrides: Partial<WorkerMethodHandlers> = {}): WorkerMethodHandlers {
  return {
    hello: () => ({
      worker_version: "0.1.0",
      max_protocol_version: RESEARCH_PROTOCOL_VERSION,
      methods: [...WORKER_METHODS],
      browser_available: true,
    }),
    doctor: async () => ({
      ok: true,
      node_version: "22.22.1",
      browser_available: true,
      pdf_available: true,
      issues: [],
    }),
    fetch_prepare: async (params) => ({
      operation_id: params.operation_id,
      documents: [],
      chunks: [],
      duplicate_clusters: [],
      failures: [],
      stats: {
        http_fetches: 0,
        browser_fetches: 0,
        total_bytes: 0,
        duration_ms: 1,
        skipped_known: 0,
      },
    }),
    rerank: async (params) => ({ operation_id: params.operation_id, ranked: [] }),
    ...overrides,
  };
}

/// 建一个把输出收进数组的 server。
function makeServer(overrides: Partial<WorkerMethodHandlers> = {}, onShutdown?: () => void) {
  const lines: string[] = [];
  const server = new ResearchRpcServer({
    write: (line) => lines.push(line),
    handlers: stubHandlers(overrides),
    ...(onShutdown ? { onShutdown } : {}),
  });
  return { server, lines, last: () => JSON.parse(lines[lines.length - 1]!) as Record<string, unknown> };
}

const helloLine = PROTOCOL_FIXTURES.find((f) => f.name === "hello:request")!.line;

/// 等待所有已排队的微任务/宏任务落地（handler 是 async 的）。
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("ResearchRpcServer × PROTOCOL_FIXTURES", () => {
  it("每一条 to_worker 样例都能被处理，且产出的行都能过 parseWorkerOutbound", async () => {
    const inbound = PROTOCOL_FIXTURES.filter((f) => f.direction === "to_worker");
    expect(inbound.length).toBeGreaterThan(0);

    const { server, lines } = makeServer();
    // 握手必须先行，否则业务请求会被 not_ready 拦下（那是另一个用例的断言）。
    server.feed(`${helloLine}\n`);
    await flush();

    for (const fixture of inbound) {
      if (fixture.name === "hello:request") continue;
      server.feed(`${fixture.line}\n`);
      await flush();
    }

    expect(lines.length).toBe(inbound.length);
    for (const line of lines) {
      const parsed = parseWorkerOutbound(JSON.parse(line));
      expect(parsed.type).toBe("response");
      if (parsed.type === "response") expect(parsed.error).toBeUndefined();
    }
  });

  it("每个 method 的 result 都能过 parseWorkerResult（按 method 二次校验）", async () => {
    const { server, lines } = makeServer();
    const inbound = PROTOCOL_FIXTURES.filter((f) => f.direction === "to_worker");

    server.feed(`${helloLine}\n`);
    await flush();
    for (const fixture of inbound) {
      if (fixture.name === "hello:request") continue;
      server.feed(`${fixture.line}\n`);
      await flush();
    }

    const methods = ["hello", ...inbound.filter((f) => f.name !== "hello:request").map((f) => f.forMethod)];
    lines.forEach((line, index) => {
      const parsed = JSON.parse(line) as { result: unknown };
      expect(() => parseWorkerResult(methods[index] as WorkerMethod, parsed.result)).not.toThrow();
    });
  });
});

describe("ResearchRpcServer 握手闸", () => {
  it("hello 之前的业务请求一律 not_ready", async () => {
    const { server, last } = makeServer();
    server.feed('{"type":"request","id":"d1","method":"doctor","params":{}}\n');
    await flush();
    expect(last()).toMatchObject({ type: "response", id: "d1", error: { code: "not_ready" } });
  });

  it("main 请求的协议版本高于 Worker 支持的最高版本 → protocol_mismatch，且不进入 ready", async () => {
    const { server, lines, last } = makeServer();
    server.feed(
      `{"type":"request","id":"h1","method":"hello","params":{"protocol_version":${RESEARCH_PROTOCOL_VERSION + 1},"desktop_version":"0.1.48"}}\n`,
    );
    await flush();
    expect(last()).toMatchObject({ error: { code: "protocol_mismatch" } });

    server.feed('{"type":"request","id":"d1","method":"doctor","params":{}}\n');
    await flush();
    expect(last()).toMatchObject({ error: { code: "not_ready" } });
    expect(lines).toHaveLength(2);
  });

  it("低于当前版本的 hello 可以接受（Worker 向后兼容旧 main）", async () => {
    const { server, last } = makeServer();
    server.feed(`${helloLine}\n`);
    await flush();
    expect(last()).toMatchObject({ result: { max_protocol_version: RESEARCH_PROTOCOL_VERSION } });
  });

  it("shutdown 不受握手闸限制（进程生命周期指令，不是业务请求）", async () => {
    let shutdownCalls = 0;
    const { server, last } = makeServer({}, () => {
      shutdownCalls += 1;
    });
    server.feed('{"type":"request","id":"s1","method":"shutdown","params":{"grace_ms":10}}\n');
    await flush();
    expect(last()).toMatchObject({ result: { ok: true } });
    expect(shutdownCalls).toBe(1);
  });
});

describe("ResearchRpcServer 行缓冲", () => {
  it("跨 chunk 的半行会被拼起来", async () => {
    const { server, last } = makeServer();
    server.feed(helloLine.slice(0, 20));
    server.feed(`${helloLine.slice(20)}\n`);
    await flush();
    expect(last()).toMatchObject({ type: "response", id: "hello_01" });
  });

  it("一个 chunk 里的多行会被逐条处理", async () => {
    const { server, lines } = makeServer();
    server.feed(
      `${helloLine}\n{"type":"request","id":"d1","method":"doctor","params":{}}\n`,
    );
    await flush();
    expect(lines).toHaveLength(2);
  });

  it("只按 LF 切分：payload 里的 U+2028 / U+2029 不当作行分隔", async () => {
    const { server, last } = makeServer();
    const line = JSON.stringify({
      type: "request",
      id: "r1",
      method: "rerank",
      params: {
        operation_id: "op_1",
        query: "行分隔 符 测试",
        subquestions: [],
        chunks: [{ chunk_id: "c1", text: "t" }],
        top_k: 1,
      },
    });
    server.feed(`${helloLine}\n`);
    await flush();
    server.feed(`${line}\n`);
    await flush();
    expect(last()).toMatchObject({ id: "r1", result: { operation_id: "op_1" } });
  });

  it("非 JSON 行静默丢弃，不产出任何响应", async () => {
    const { server, lines } = makeServer();
    server.feed("这不是 JSON\n{{{ 也不是 }}}\n\n");
    await flush();
    expect(lines).toHaveLength(0);
  });

  it("超长无换行输入不会无限撑大缓冲区", () => {
    const { server, lines } = makeServer();
    server.feed("x".repeat(3_000_000));
    expect(lines).toHaveLength(0);
    expect(server.bufferedBytes).toBeLessThanOrEqual(1_000_000);
  });
});

describe("ResearchRpcServer 错误信封", () => {
  it("未知 method → unknown_method", async () => {
    const { server, last } = makeServer();
    server.feed(`${helloLine}\n`);
    await flush();
    server.feed('{"type":"request","id":"x1","method":"teleport","params":{}}\n');
    await flush();
    expect(last()).toMatchObject({ id: "x1", error: { code: "unknown_method" } });
  });

  it("参数不合法 → invalid_params（空 candidates 在协议层就被拒）", async () => {
    const { server, last } = makeServer();
    server.feed(`${helloLine}\n`);
    await flush();
    server.feed(
      '{"type":"request","id":"f1","method":"fetch_prepare","params":{"operation_id":"op","objective":"o","subquestions":[],"candidates":[],"known_fingerprints":[],"policy":{"trust_zone":"public_web","allow_search_server":true,"allow_cloud_model":true,"allow_cross_session_reuse":true},"limits":{"max_documents":1,"max_browser_fetches":0,"max_total_bytes":1,"max_duration_ms":1,"http_concurrency":1,"per_host_concurrency":1,"request_timeout_ms":1}}}\n',
    );
    await flush();
    expect(last()).toMatchObject({ id: "f1", error: { code: "invalid_params" } });
  });

  it("handler 抛错 → internal_error，且不会崩掉 server", async () => {
    const { server, last } = makeServer({
      doctor: async () => {
        throw new Error("自检炸了");
      },
    });
    server.feed(`${helloLine}\n`);
    await flush();
    server.feed('{"type":"request","id":"d1","method":"doctor","params":{}}\n');
    await flush();
    expect(last()).toMatchObject({ id: "d1", error: { code: "internal_error", message: "自检炸了" } });

    server.feed('{"type":"request","id":"d2","method":"doctor","params":{}}\n');
    await flush();
    expect(last()).toMatchObject({ id: "d2" });
  });

  it("缺 id 的请求无法应答，直接丢弃", async () => {
    const { server, lines } = makeServer();
    server.feed('{"type":"request","method":"doctor","params":{}}\n');
    await flush();
    expect(lines).toHaveLength(0);
  });
});

describe("ResearchRpcServer cancel 注册表", () => {
  /// 一个可以被 abort 打断的 handler。
  function slowFetchPrepare(): WorkerMethodHandlers["fetch_prepare"] {
    return (_params, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason as Error), { once: true });
      });
  }

  it("cancel 指定 operation → 该 operation 以 cancelled 错误码结束，cancel 自身回 ack", async () => {
    const { server, lines } = makeServer({ fetch_prepare: slowFetchPrepare() });
    server.feed(`${helloLine}\n`);
    await flush();

    const fetchLine = PROTOCOL_FIXTURES.find((f) => f.name === "fetch_prepare:request")!.line;
    server.feed(`${fetchLine}\n`);
    await flush();
    expect(lines).toHaveLength(1); // 只有 hello 的响应，fetch 还挂着

    server.feed('{"type":"request","id":"c1","method":"cancel","params":{"operation_id":"op_07"}}\n');
    await flush();

    const parsed = lines.slice(1).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed).toContainEqual(expect.objectContaining({ id: "c1", result: { ok: true } }));
    expect(parsed).toContainEqual(
      expect.objectContaining({ id: "req_07", error: expect.objectContaining({ code: "cancelled" }) }),
    );
  });

  it("cancel 不带 operation_id → 取消全部在途 operation", async () => {
    const { server, lines } = makeServer({ fetch_prepare: slowFetchPrepare() });
    server.feed(`${helloLine}\n`);
    await flush();

    const fetchLine = PROTOCOL_FIXTURES.find((f) => f.name === "fetch_prepare:request")!.line;
    server.feed(`${fetchLine}\n`);
    await flush();
    server.feed('{"type":"request","id":"c1","method":"cancel","params":{}}\n');
    await flush();

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed).toContainEqual(
      expect.objectContaining({ id: "req_07", error: expect.objectContaining({ code: "cancelled" }) }),
    );
  });

  it("取消一个不存在的 operation 仍回 ack（幂等，main 无需先查状态）", async () => {
    const { server, last } = makeServer();
    server.feed(`${helloLine}\n`);
    await flush();
    server.feed('{"type":"request","id":"c9","method":"cancel","params":{"operation_id":"nope"}}\n');
    await flush();
    expect(last()).toMatchObject({ id: "c9", result: { ok: true } });
  });
});

describe("ResearchRpcServer 兜底失败", () => {
  /// index.ts 的 uncaughtException / unhandledRejection 兜底会调用它：
  /// 进程级异常必须转成在途请求的错误响应，否则 main 侧那些 pending 只能等 30s 超时。
  it("failAllPending 为每个在途请求写一条错误响应并清空注册表", async () => {
    const { server, lines } = makeServer({
      fetch_prepare: () => new Promise(() => {}),
    });
    server.feed(`${helloLine}\n`);
    await flush();
    server.feed(`${PROTOCOL_FIXTURES.find((f) => f.name === "fetch_prepare:request")!.line}\n`);
    await flush();

    server.failAllPending("internal_error", "worker uncaughtException: boom");
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed).toContainEqual(
      expect.objectContaining({
        id: "req_07",
        error: expect.objectContaining({ code: "internal_error" }),
      }),
    );

    // 第二次调用不应再产出重复响应。
    const before = lines.length;
    server.failAllPending("internal_error", "again");
    expect(lines).toHaveLength(before);
  });
});

describe("ResearchRpcServer 进度事件", () => {
  it("handler 发的进度事件作为独立的 event 行输出（无 id，不占 pending）", async () => {
    const { server, lines } = makeServer({
      fetch_prepare: async (params, ctx) => {
        ctx.emitProgress({ stage: "fetching", completed: 1, total: 3 });
        return {
          operation_id: params.operation_id,
          documents: [],
          chunks: [],
          duplicate_clusters: [],
          failures: [],
          stats: { http_fetches: 0, browser_fetches: 0, total_bytes: 0, duration_ms: 0, skipped_known: 0 },
        };
      },
    });
    server.feed(`${helloLine}\n`);
    await flush();
    server.feed(`${PROTOCOL_FIXTURES.find((f) => f.name === "fetch_prepare:request")!.line}\n`);
    await flush();

    const events = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((msg) => msg.type === "event");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "progress",
      operation_id: "op_07",
      stage: "fetching",
      completed: 1,
      total: 3,
    });
    expect(events[0]!.id).toBeUndefined();
    expect(() => parseWorkerOutbound(events[0])).not.toThrow();
  });
});
