// process-manager 单测：Worker 生命周期（握手、版本闸、崩溃、主动停止、两段式 kill）。
// 传手写假 WorkerTransport，可真实 emit exit/error 驱动分支；零 mock 框架。
import { describe, expect, it } from "vitest";
import { RESEARCH_PROTOCOL_VERSION } from "@cortex-work/core/research/protocol";
import { ResearchWorkerProcess, type ResearchWorkerEvent } from "./process-manager";
import { FakeWorkerTransport } from "./fake-transport";

function helloResponse(id: string, maxVersion = RESEARCH_PROTOCOL_VERSION): string {
  return JSON.stringify({
    type: "response",
    id,
    result: {
      worker_version: "0.1.0",
      max_protocol_version: maxVersion,
      methods: ["hello", "doctor", "fetch_prepare", "rerank", "cancel", "shutdown"],
      browser_available: false,
    },
  });
}

function setup(options: { killDelayMs?: number; timeoutMs?: number } = {}) {
  const transport = new FakeWorkerTransport();
  const events: ResearchWorkerEvent[] = [];
  const worker = new ResearchWorkerProcess({
    createTransport: () => transport,
    desktopVersion: "0.1.48",
    timeoutMs: options.timeoutMs ?? 5_000,
    killDelayMs: options.killDelayMs ?? 3_000,
    onEvent: (event) => events.push(event),
  });
  return { transport, events, worker };
}

/// 起一个已完成握手的 worker。
async function started(options?: { killDelayMs?: number; timeoutMs?: number }) {
  const context = setup(options);
  const startPromise = context.worker.start();
  const helloId = (JSON.parse(context.transport.writes[0]!) as { id: string }).id;
  context.transport.emitLine(helloResponse(helloId));
  await startPromise;
  return context;
}

describe("ResearchWorkerProcess 启动握手", () => {
  it("start 先发 hello，带上当前协议版本与 desktop 版本", async () => {
    const { transport, worker } = setup();
    const startPromise = worker.start();

    const hello = JSON.parse(transport.writes[0]!) as Record<string, unknown>;
    expect(hello).toMatchObject({
      type: "request",
      method: "hello",
      params: { protocol_version: RESEARCH_PROTOCOL_VERSION, desktop_version: "0.1.48" },
    });

    transport.emitLine(helloResponse((hello as { id: string }).id));
    await expect(startPromise).resolves.toBeUndefined();
    expect(worker.isRunning).toBe(true);
  });

  it("Worker 支持的最高协议版本低于当前版本 → 启动失败并停掉进程（不降级）", async () => {
    const { transport, worker, events } = setup();
    const startPromise = worker.start();
    const helloId = (JSON.parse(transport.writes[0]!) as { id: string }).id;
    transport.emitLine(helloResponse(helloId, RESEARCH_PROTOCOL_VERSION - 1));

    await expect(startPromise).rejects.toThrow(/协议/);
    expect(transport.killed).toBeGreaterThan(0);
    expect(worker.isRunning).toBe(false);
    // 主动停掉的不算崩溃。
    expect(events.filter((event) => event.type === "crashed")).toHaveLength(0);
  });

  it("重复 start 不会重复 fork", async () => {
    const { worker, transport } = await started();
    await worker.start();
    const helloCount = transport.writes.filter(
      (line) => (JSON.parse(line) as { method?: string }).method === "hello",
    ).length;
    expect(helloCount).toBe(1);
  });

  it("握手期间 Worker 就崩掉 → start 失败并上报 crashed", async () => {
    const { transport, worker, events } = setup();
    const startPromise = worker.start();
    transport.emitExit(1, "worker stderr tail");

    await expect(startPromise).rejects.toThrow();
    expect(events.filter((event) => event.type === "crashed")).toHaveLength(1);
  });
});

describe("ResearchWorkerProcess 崩溃与停止", () => {
  it("非预期退出 → 上报 crashed（含 stderr 尾）且全部 pending 被 reject", async () => {
    const { transport, worker, events } = await started();
    const pending = worker.request("doctor", {});
    transport.emitExit(139, "SIGSEGV in pdfjs");

    await expect(pending).rejects.toThrow();
    const crashed = events.filter((event) => event.type === "crashed");
    expect(crashed).toHaveLength(1);
    expect(String((crashed[0] as { error: Error }).error.message)).toContain("SIGSEGV in pdfjs");
    expect(worker.isRunning).toBe(false);
  });

  it("transport error 与随后的 exit 只上报一次 crashed（去重）", async () => {
    const { transport, events } = await started();
    transport.emitError(new Error("spawn 失败"));
    transport.emitExit(null);
    expect(events.filter((event) => event.type === "crashed")).toHaveLength(1);
  });

  it("崩溃后不自动重启（由上层 service 决定）", async () => {
    const { transport, worker } = await started();
    transport.emitExit(1);
    expect(transport.writes.filter((line) => line.includes('"hello"'))).toHaveLength(1);
    expect(worker.isRunning).toBe(false);
  });

  it("主动 stop 不上报 crashed", async () => {
    const { transport, worker, events } = await started();
    const stopPromise = worker.stop();
    transport.emitExit(0);
    await stopPromise;
    expect(events.filter((event) => event.type === "crashed")).toHaveLength(0);
    expect(worker.isRunning).toBe(false);
  });

  it("stop 先请求优雅退出（shutdown）再 kill", async () => {
    const { transport, worker } = await started();
    const stopPromise = worker.stop();
    expect(transport.writes.some((line) => line.includes('"shutdown"'))).toBe(true);
    transport.emitExit(0);
    await stopPromise;
    expect(transport.killed).toBeGreaterThan(0);
  });

  it("两段式 kill：宽限期内没退出就强杀", async () => {
    const { transport, worker } = await started({ killDelayMs: 20 });
    const stopPromise = worker.stop();
    expect(transport.forceKilled).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(transport.forceKilled).toBe(1);
    transport.emitExit(null);
    await stopPromise;
  });

  it("正常退出会清掉强杀定时器（不会在进程消失后再杀一次）", async () => {
    const { transport, worker } = await started({ killDelayMs: 20 });
    const stopPromise = worker.stop();
    transport.emitExit(0);
    await stopPromise;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(transport.forceKilled).toBe(0);
  });

  it("stop 之后再发请求直接失败，不会静默挂起", async () => {
    const { transport, worker } = await started();
    const stopPromise = worker.stop();
    transport.emitExit(0);
    await stopPromise;
    await expect(worker.request("doctor", {})).rejects.toThrow(/未启动|已停止/);
  });
});

describe("ResearchWorkerProcess 事件转发", () => {
  it("Worker 的进度事件被转发给上层", async () => {
    const { transport, events } = await started();
    transport.emitLine(
      JSON.stringify({
        type: "event",
        event: "progress",
        operation_id: "op_1",
        stage: "chunking",
        completed: 2,
        total: 5,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "progress",
        progress: expect.objectContaining({ operation_id: "op_1", stage: "chunking" }),
      }),
    );
  });
});
