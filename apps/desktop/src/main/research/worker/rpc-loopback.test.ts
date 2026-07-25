// main 的 ResearchRpcClient ↔ Worker 的 ResearchRpcServer 端到端互通测试（收口验证补齐）。
//
// 为什么需要这个文件：两侧各自的单测都用「手写的对端样例行」做断言，样例是人写的，
// 一旦两边对同一条协议的理解发生分歧（成帧、id 关联、错误信封、result 形状），
// 两个单测**可以同时全绿**而生产环境完全跑不通。本文件把两个**真实现**对接，
// 中间只放一对内存管道，任何一侧的协议漂移都会在这里立刻暴露。
//
// 零 mock 框架：管道是手写的 WorkerTransport 实现，handler 也是真的 runHello / runRerank。
//
// **成帧契约在这里被固化**：WorkerTransport.writeLine 的注释写着「实现负责成帧，调用方不加
// 换行」，而 ResearchRpcServer.feed 按 LF 切行。所以管道必须补 "\n"——这正是生产
// utilityProcess 承载里 postMessage ↔ parentPort 的等价物（那边靠消息边界成帧）。
import { describe, expect, it } from "vitest";
import { RESEARCH_PROTOCOL_VERSION } from "@cortex-work/core/research/protocol";
import { ResearchRpcServer, type WorkerMethodHandlers } from "../../../worker/research/rpc-server";
import { runHello } from "../../../worker/research/methods/hello";
import { runRerank } from "../../../worker/research/methods/rerank";
import { ResearchRpcClient, WorkerRpcError, type WorkerProgressEvent } from "./rpc-client";
import type { WorkerTransport } from "./transport";

/// 把 client 与 server 用内存管道对接后的一整套句柄。
interface Loopback {
  client: ResearchRpcClient;
  server: ResearchRpcServer;
  events: WorkerProgressEvent[];
  /// client 侧看到的所有出站行（调试用）。
  toWorker: string[];
}

/// 建立一对内存管道并接上两侧真实现。handlers 可覆盖，默认给最小可用实现。
function createLoopback(overrides: Partial<WorkerMethodHandlers> = {}): Loopback {
  const toWorker: string[] = [];
  const events: WorkerProgressEvent[] = [];
  // server 在构造前就要能往 client 方向写，故用 late-bound 变量而不是构造参数互引。
  let deliverToClient: (line: string) => void = () => {};

  const transport: WorkerTransport = {
    writeLine: (line) => {
      toWorker.push(line);
      server.feed(`${line}\n`);
    },
    onLine: (cb) => {
      deliverToClient = cb;
    },
    onExit: () => {},
    onError: () => {},
    kill: () => {},
  };

  const handlers: WorkerMethodHandlers = {
    hello: (params) => runHello(params, { workerVersion: "0.0.0-test", browserAvailable: false }),
    doctor: () => ({
      ok: true,
      node_version: "v20.0.0",
      pdf_available: true,
      browser_available: false,
      issues: [],
    }),
    fetch_prepare: () => {
      throw new Error("本测试不覆盖 fetch_prepare（有网络依赖）");
    },
    rerank: (params) => runRerank(params),
    ...overrides,
  };

  const server = new ResearchRpcServer({
    write: (line) => deliverToClient(line),
    handlers,
  });

  const client = new ResearchRpcClient(transport, {
    timeoutMs: 2_000,
    onEvent: (event) => events.push(event),
  });

  return { client, server, events, toWorker };
}

describe("rpc-client ↔ rpc-server 端到端", () => {
  it("hello 握手：client 发的行能被 server 解析，server 回的行能被 client 校验通过", async () => {
    const { client } = createLoopback();

    const result = await client.request("hello", {
      protocol_version: RESEARCH_PROTOCOL_VERSION,
      desktop_version: "0.1.48",
    });

    expect(result.worker_version).toBe("0.0.0-test");
    expect(result.max_protocol_version).toBe(RESEARCH_PROTOCOL_VERSION);
    expect(result.methods).toContain("fetch_prepare");
  });

  it("握手闸真的生效：未 hello 就发业务请求，client 收到 not_ready 错误码", async () => {
    const { client } = createLoopback();

    await expect(
      client.request("rerank", {
        operation_id: "op_1",
        query: "任意",
        subquestions: [],
        chunks: [{ chunk_id: "c", text: "任意" }],
        top_k: 5,
      }),
    ).rejects.toMatchObject({ code: "not_ready" });
  });

  it("rerank 往返：真打分结果通过协议校验，排序与直接调用一致", async () => {
    const { client } = createLoopback();
    await client.request("hello", {
      protocol_version: RESEARCH_PROTOCOL_VERSION,
      desktop_version: "0.1.48",
    });

    const params = {
      operation_id: "op_rerank",
      query: "开源桌面 AI agent 许可证",
      subquestions: [{ id: "sq_2", text: "它们的许可证分别是什么" }],
      chunks: [
        { chunk_id: "ch_1", text: "This project is licensed under the Apache-2.0 license." },
        { chunk_id: "ch_2", text: "Unrelated marketing copy." },
      ],
      top_k: 10,
    };

    const overWire = await client.request("rerank", params);
    // 直接调用 runRerank 的结果作为基准：证明「过了一趟 JSONL + 两次 zod 校验」没有丢字段、
    // 没有改顺序、没有把 number 变成 string。
    expect(overWire).toEqual(runRerank(params));
    expect(overWire.ranked[0]?.chunk_id).toBe("ch_1");
  });

  it("id 关联正确：并发多请求各自拿到自己的响应，不串台", async () => {
    const { client } = createLoopback({
      // 用 chunk 数量当回声，验证第 N 个响应确实回到第 N 个 Promise。
      rerank: (params) =>
        new Promise((resolve) => {
          // 刻意让先发的请求后完成，逼出「按 id 关联」而不是「按到达顺序关联」。
          const delay = params.chunks.length === 1 ? 20 : 0;
          setTimeout(() => resolve(runRerank(params)), delay);
        }),
    });
    await client.request("hello", {
      protocol_version: RESEARCH_PROTOCOL_VERSION,
      desktop_version: "0.1.48",
    });

    const first = client.request("rerank", {
      operation_id: "op_a",
      query: "a",
      subquestions: [],
      chunks: [{ chunk_id: "only", text: "a" }],
      top_k: 5,
    });
    const second = client.request("rerank", {
      operation_id: "op_b",
      query: "b",
      subquestions: [],
      chunks: [
        { chunk_id: "x", text: "b" },
        { chunk_id: "y", text: "b" },
      ],
      top_k: 5,
    });

    const [a, b] = await Promise.all([first, second]);
    expect(a.operation_id).toBe("op_a");
    expect(b.operation_id).toBe("op_b");
    expect(client.pendingCount).toBe(0);
  });

  it("进度事件穿透：server 的 emitProgress 被 client 的 onEvent 收到，且不占 pending", async () => {
    const { client, events } = createLoopback({
      rerank: (params, ctx) => {
        ctx.emitProgress({ stage: "ranking", completed: 1, total: 2 });
        return runRerank(params);
      },
    });
    await client.request("hello", {
      protocol_version: RESEARCH_PROTOCOL_VERSION,
      desktop_version: "0.1.48",
    });

    await client.request("rerank", {
      operation_id: "op_evt",
      query: "q",
      subquestions: [],
      chunks: [{ chunk_id: "c", text: "q" }],
      top_k: 5,
    });

    expect(events).toEqual([
      { operation_id: "op_evt", stage: "ranking", completed: 1, total: 2 },
    ]);
    expect(client.pendingCount).toBe(0);
  });

  it("handler 抛错 → server 的 internal_error 信封 → client 侧是带 code 的 WorkerRpcError", async () => {
    const { client } = createLoopback({
      rerank: () => {
        throw new Error("打分器炸了");
      },
    });
    await client.request("hello", {
      protocol_version: RESEARCH_PROTOCOL_VERSION,
      desktop_version: "0.1.48",
    });

    const err = await client
      .request("rerank", {
        operation_id: "op_err",
        query: "q",
        subquestions: [],
        chunks: [{ chunk_id: "c", text: "q" }],
        top_k: 5,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WorkerRpcError);
    expect((err as WorkerRpcError).code).toBe("internal_error");
    expect((err as WorkerRpcError).message).toContain("打分器炸了");
  });

  it("协议版本闸：main 请求高于 Worker 支持的版本时，握手被 protocol_mismatch 拒绝", async () => {
    const { client } = createLoopback();

    await expect(
      client.request("hello", {
        protocol_version: RESEARCH_PROTOCOL_VERSION + 1,
        desktop_version: "9.9.9",
      }),
    ).rejects.toMatchObject({ code: "protocol_mismatch" });
  });

  it("cancel 是 client 可直接发的请求：server 幂等应答 ok", async () => {
    const { client } = createLoopback();
    await client.request("hello", {
      protocol_version: RESEARCH_PROTOCOL_VERSION,
      desktop_version: "0.1.48",
    });

    // 取消一个根本不存在的 operation 也必须成功——否则 main 在竞态下（operation 刚结束）
    // 会把正常的取消当成错误上报。
    await expect(client.request("cancel", { operation_id: "op_不存在" })).resolves.toEqual({
      ok: true,
    });
  });

  it("shutdown 不受握手闸限制，且 client 能拿到 ack", async () => {
    let graceSeen: number | undefined = -1;
    const toWorker: string[] = [];
    let deliverToClient: (line: string) => void = () => {};
    const transport: WorkerTransport = {
      writeLine: (line) => {
        toWorker.push(line);
        server.feed(`${line}\n`);
      },
      onLine: (cb) => {
        deliverToClient = cb;
      },
      onExit: () => {},
      onError: () => {},
      kill: () => {},
    };
    const server = new ResearchRpcServer({
      write: (line) => deliverToClient(line),
      handlers: {
        hello: (params) => runHello(params, { workerVersion: "x", browserAvailable: false }),
        doctor: () => {
          throw new Error("未覆盖");
        },
        fetch_prepare: () => {
          throw new Error("未覆盖");
        },
        rerank: (params) => runRerank(params),
      },
      onShutdown: (graceMs) => {
        graceSeen = graceMs;
      },
    });
    const client = new ResearchRpcClient(transport, { timeoutMs: 2_000 });

    await expect(client.request("shutdown", { grace_ms: 3_000 })).resolves.toEqual({ ok: true });
    expect(graceSeen).toBe(3_000);
  });
});
