// rpc-client 单测：请求应答关联、超时、协议校验、进度事件旁路。
// 传手写假 WorkerTransport（见 ./fake-transport），零 mock 框架。
import { describe, expect, it } from "vitest";
import { ResearchRpcClient, WorkerRpcError } from "./rpc-client";
import { FakeWorkerTransport } from "./fake-transport";

const helloResult = {
  worker_version: "0.1.0",
  max_protocol_version: 1,
  methods: ["hello", "doctor", "fetch_prepare", "rerank", "cancel", "shutdown"],
  browser_available: false,
};

function setup(timeoutMs = 5_000) {
  const transport = new FakeWorkerTransport();
  const events: unknown[] = [];
  const client = new ResearchRpcClient(transport, {
    timeoutMs,
    onEvent: (event) => events.push(event),
  });
  return { transport, client, events };
}

describe("ResearchRpcClient 请求应答", () => {
  it("按 req_N 生成 id 并在收到同 id 响应时 resolve", async () => {
    const { transport, client } = setup();
    const pending = client.request("hello", { protocol_version: 1, desktop_version: "0.1.48" });

    const sent = transport.lastMessage();
    expect(sent).toMatchObject({
      type: "request",
      id: "req_1",
      method: "hello",
      params: { protocol_version: 1, desktop_version: "0.1.48" },
    });

    transport.emitLine(JSON.stringify({ type: "response", id: "req_1", result: helloResult }));
    await expect(pending).resolves.toEqual(helloResult);
  });

  it("id 单调递增，多个在途请求各自关联（响应乱序也正确）", async () => {
    const { transport, client } = setup();
    const first = client.request("hello", { protocol_version: 1, desktop_version: "0.1.48" });
    const second = client.request("doctor", {});

    expect(transport.writes.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual([
      "req_1",
      "req_2",
    ]);

    transport.emitLine(
      JSON.stringify({
        type: "response",
        id: "req_2",
        result: {
          ok: true,
          node_version: "22.22.1",
          browser_available: false,
          pdf_available: true,
          issues: [],
        },
      }),
    );
    transport.emitLine(JSON.stringify({ type: "response", id: "req_1", result: helloResult }));

    await expect(second).resolves.toMatchObject({ ok: true });
    await expect(first).resolves.toEqual(helloResult);
  });

  it("错误信封 reject 成带 code 的 WorkerRpcError", async () => {
    const { transport, client } = setup();
    const pending = client.request("doctor", {});
    transport.emitLine(
      JSON.stringify({
        type: "response",
        id: "req_1",
        error: { code: "not_ready", message: "尚未握手" },
      }),
    );
    await expect(pending).rejects.toBeInstanceOf(WorkerRpcError);
    await expect(pending).rejects.toMatchObject({ code: "not_ready" });
  });

  it("result 形状与 method 不符时 reject（按 method 二次校验）", async () => {
    const { transport, client } = setup();
    const pending = client.request("hello", { protocol_version: 1, desktop_version: "0.1.48" });
    transport.emitLine(
      JSON.stringify({ type: "response", id: "req_1", result: { worker_version: "0.1.0" } }),
    );
    await expect(pending).rejects.toThrow();
  });
});

describe("ResearchRpcClient 容错", () => {
  it("非 JSON 行静默丢弃，随后的正常响应仍能 resolve", async () => {
    const { transport, client } = setup();
    const pending = client.request("hello", { protocol_version: 1, desktop_version: "0.1.48" });
    transport.emitLine("worker started, listening...");
    transport.emitLine("{ 半条 JSON");
    transport.emitLine(JSON.stringify({ type: "response", id: "req_1", result: helloResult }));
    await expect(pending).resolves.toEqual(helloResult);
  });

  it("信封非法（result 与 error 同时出现）的行被丢弃，不会误 resolve", async () => {
    const { transport, client } = setup(80);
    const pending = client.request("doctor", {});
    transport.emitLine(
      JSON.stringify({
        type: "response",
        id: "req_1",
        result: { ok: true },
        error: { code: "internal_error", message: "x" },
      }),
    );
    // 该行被丢弃 ⇒ 请求继续挂着，直到超时。
    await expect(pending).rejects.toThrow(/超时/);
  });

  it("未知 id 的响应被忽略（迟到的旧请求响应不串台）", async () => {
    const { transport, client } = setup();
    transport.emitLine(JSON.stringify({ type: "response", id: "req_999", result: helloResult }));
    const pending = client.request("hello", { protocol_version: 1, desktop_version: "0.1.48" });
    transport.emitLine(JSON.stringify({ type: "response", id: "req_1", result: helloResult }));
    await expect(pending).resolves.toEqual(helloResult);
  });

  it("超时后 reject 并清掉 pending（后到的响应不再影响任何东西）", async () => {
    const { transport, client } = setup(30);
    const pending = client.request("doctor", {});
    await expect(pending).rejects.toThrow(/超时/);
    expect(client.pendingCount).toBe(0);
    expect(() =>
      transport.emitLine(JSON.stringify({ type: "response", id: "req_1", result: { ok: true } })),
    ).not.toThrow();
  });

  it("rejectAllPending 一次性了结全部在途请求", async () => {
    const { client } = setup();
    const first = client.request("doctor", {});
    const second = client.request("doctor", {});
    client.rejectAllPending(new Error("worker 已退出"));
    await expect(first).rejects.toThrow("worker 已退出");
    await expect(second).rejects.toThrow("worker 已退出");
    expect(client.pendingCount).toBe(0);
  });
});

describe("ResearchRpcClient 进度事件", () => {
  it("event 行走独立回调，不进 pending", async () => {
    const { transport, client, events } = setup();
    const pending = client.request("fetch_prepare", {
      operation_id: "op_1",
      objective: "x",
      subquestions: [],
      candidates: [
        {
          candidate_id: "c1",
          query_id: "q1",
          title: "t",
          url: "https://example.com",
          domain: "example.com",
          engines: [],
          server_score: 1,
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
        max_documents: 1,
        max_browser_fetches: 0,
        max_total_bytes: 1,
        max_duration_ms: 1,
        http_concurrency: 1,
        per_host_concurrency: 1,
        request_timeout_ms: 1,
      },
    });

    transport.emitLine(
      JSON.stringify({
        type: "event",
        event: "progress",
        operation_id: "op_1",
        stage: "fetching",
        completed: 1,
        total: 4,
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation_id: "op_1", stage: "fetching" });
    expect(client.pendingCount).toBe(1);

    transport.emitLine(
      JSON.stringify({
        type: "response",
        id: "req_1",
        result: {
          operation_id: "op_1",
          documents: [],
          chunks: [],
          duplicate_clusters: [],
          failures: [],
          stats: {
            http_fetches: 0,
            browser_fetches: 0,
            total_bytes: 0,
            duration_ms: 0,
            skipped_known: 0,
          },
        },
      }),
    );
    await expect(pending).resolves.toMatchObject({ operation_id: "op_1" });
  });
});
