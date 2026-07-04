// pi-rpc.ts 单测。U1:mapPiEvent 事件映射（AgentSessionEvent → PiSessionEvent）。
// 事件形状取自 @earendil-works/pi-coding-agent 0.79.2 实测 + .d.ts 契约。

import { EventEmitter } from "node:events";

import { describe, expect, it, vi, beforeEach } from "vitest";

const spawnMock = vi.fn();
const traceMock = vi.fn();
// ../log 桩:断言 U4 盲区补点(命令超时 / 未产终态 / 补发 / crashed)经 scoped logger 落盘。
const logMocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() },
}));
vi.mock("../log", () => ({ createLogger: () => logMocks.logger, isDevEnv: () => true }));
vi.mock("./pi-locate", () => ({ resolvePiBinary: () => "/fake/resources/pi/pi" }));
vi.mock("child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
// pi-rpc 经 ./pi-providers 引入 safeId,后者顶层 import electron app —— mock 掉避免加载真 electron。
vi.mock("electron", () => ({ app: {} }));
vi.mock("../ipc/agent-trace", () => ({ recordAgentTrace: (...args: unknown[]) => traceMock(...args) }));

import { mapPiEvent, PiRpcSession, buildRpcArgs, spawnPiRpc, sanitizeAskQuestionEnvelope, type RpcTransport } from "./pi-rpc";
import type { PiSessionEvent, PiOpenRequest } from "../ipc/types";

// child_process.spawn 返回值的最小替身:child 本体是 EventEmitter（close/error 可真实 emit）,
// stdin 带 on/writable/write（生产 spawnPiRpc 会绑 stdin 'error' 监听并做可写性守卫）。
function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 4321,
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), writable: true }),
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    kill: vi.fn(),
  });
}

beforeEach(() => {
  traceMock.mockReset();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild());
  for (const fn of Object.values(logMocks.logger)) fn.mockReset();
});

// 可控的 fake transport:记录写出的行,手动注入 stdout/exit/error。
function fakeTransport() {
  let stdoutCb: (chunk: string) => void = () => {};
  let exitCb: (code: number | null, stderrTail?: string) => void = () => {};
  let errorCb: (err: Error) => void = () => {};
  const writes: string[] = [];
  const transport: RpcTransport = {
    write: (line) => writes.push(line),
    onStdout: (cb) => {
      stdoutCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    onError: (cb) => {
      errorCb = cb;
    },
    kill: vi.fn(),
  };
  return {
    transport,
    writes,
    emit: (chunk: string) => stdoutCb(chunk),
    exit: (code: number | null, stderrTail?: string) => exitCb(code, stderrTail),
    error: (e: Error) => errorCb(e),
    lastCmd: () => JSON.parse(writes[writes.length - 1].trim()) as Record<string, unknown>,
  };
}

describe("mapPiEvent", () => {
  it("message_update/text_delta → text 增量", () => {
    expect(
      mapPiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: {} },
        message: {},
      }),
    ).toEqual({ type: "text", delta: "Hello" });
  });

  it("message_update/thinking_delta → reasoning 增量", () => {
    expect(
      mapPiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "思考中", partial: {} },
      }),
    ).toEqual({ type: "reasoning", delta: "思考中" });
  });

  it("message_update 的其它增量（start/text_start/toolcall_delta）→ null", () => {
    expect(mapPiEvent({ type: "message_update", assistantMessageEvent: { type: "start" } })).toBeNull();
    expect(
      mapPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }),
    ).toBeNull();
    expect(
      mapPiEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{" } }),
    ).toBeNull();
  });

  it("message_update/error → error 事件（防御性分支:取 errorMessage,回退 reason）", () => {
    expect(
      mapPiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "error", reason: "error", error: { errorMessage: "provider failed" } },
      }),
    ).toEqual({ type: "error", error: "provider failed" });
    // 无 errorMessage 时回退到 reason 文本
    expect(
      mapPiEvent({ type: "message_update", assistantMessageEvent: { type: "error", reason: "aborted" } }),
    ).toEqual({ type: "error", error: "aborted" });
  });

  it("message_end/stopReason=error|aborted → error 事件（run 失败的真实载体）", () => {
    // 取 errorMessage
    expect(
      mapPiEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider failed" } }),
    ).toEqual({ type: "error", error: "provider failed" });
    // 无 errorMessage 时回退 diagnostics 末项的 error.message
    expect(
      mapPiEvent({
        type: "message_end",
        message: {
          stopReason: "error",
          diagnostics: [{ type: "provider_transport_failure", error: { message: "WebSocket error" } }],
        },
      }),
    ).toEqual({ type: "error", error: "WebSocket error" });
    // aborted 同样产出 error 事件（回退到 stopReason 文本）
    expect(mapPiEvent({ type: "message_end", message: { stopReason: "aborted" } })).toEqual({
      type: "error",
      error: "aborted",
    });
  });

  it("message_end 正常最终收尾（stop/length）→ result；toolUse 中间轮仍忽略", () => {
    expect(mapPiEvent({ type: "message_end", message: { stopReason: "stop" } })).toEqual({
      type: "result",
      willRetry: false,
    });
    expect(mapPiEvent({ type: "message_end", message: { stopReason: "length" } })).toEqual({
      type: "result",
      willRetry: false,
    });
    expect(mapPiEvent({ type: "message_end", message: { stopReason: "toolUse" } })).toBeNull();
    expect(mapPiEvent({ type: "message_end" })).toBeNull();
  });

  it("tool_execution_start → tool-start（name/toolCallId/detail + 完整 input）", () => {
    expect(
      mapPiEvent({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_0", args: { command: "echo hi" } }),
    ).toEqual({
      type: "tool-start",
      name: "bash",
      toolCallId: "call_0",
      detail: "echo hi",
      input: { command: "echo hi" },
    });
  });

  it("tool_execution_start 无可读 args → detail 省略(input 仍透传)", () => {
    expect(mapPiEvent({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_1", args: {} })).toEqual({
      type: "tool-start",
      name: "bash",
      toolCallId: "call_1",
      input: {},
    });
  });

  it("tool_execution_end → tool-end（isError 归一为布尔;空 result 无 output）", () => {
    expect(
      mapPiEvent({ type: "tool_execution_end", toolName: "bash", toolCallId: "call_0", result: {}, isError: false }),
    ).toEqual({ type: "tool-end", name: "bash", toolCallId: "call_0", isError: false });
    expect(
      mapPiEvent({ type: "tool_execution_end", toolName: "edit", toolCallId: "call_2", isError: true }),
    ).toEqual({ type: "tool-end", name: "edit", toolCallId: "call_2", isError: true });
  });

  it("tool_execution_end result 归一化为 output:string 原样、content 数组拼 text 块、超长截断", () => {
    expect(
      mapPiEvent({ type: "tool_execution_end", toolName: "bash", toolCallId: "c1", result: "raw out", isError: false }),
    ).toMatchObject({ output: "raw out" });
    expect(
      mapPiEvent({
        type: "tool_execution_end",
        toolName: "bash",
        toolCallId: "c2",
        result: { content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] },
        isError: false,
      }),
    ).toMatchObject({ output: "line1\nline2" });
    const long = mapPiEvent({
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "c3",
      result: "z".repeat(20_000),
      isError: false,
    }) as { output: string };
    expect(long.output.length).toBe(8_001); // 8000 + 截断省略号
    expect(long.output.endsWith("…")).toBe(true);
  });

  it("turn_end → turn-end", () => {
    expect(mapPiEvent({ type: "turn_end", message: {}, toolResults: [] })).toEqual({ type: "turn-end" });
  });

  it("agent_end → result（willRetry 透传）", () => {
    expect(mapPiEvent({ type: "agent_end", messages: [], willRetry: false })).toEqual({
      type: "result",
      willRetry: false,
    });
    expect(mapPiEvent({ type: "agent_end", messages: [], willRetry: true })).toEqual({
      type: "result",
      willRetry: true,
    });
    // willRetry 缺省按 false
    expect(mapPiEvent({ type: "agent_end", messages: [] })).toEqual({ type: "result", willRetry: false });
  });

  it("compaction_start / compaction_end → compaction（带 phase/reason）", () => {
    expect(mapPiEvent({ type: "compaction_start", reason: "threshold" })).toEqual({
      type: "compaction",
      phase: "start",
      reason: "threshold",
    });
    expect(mapPiEvent({ type: "compaction_end", reason: "manual", aborted: false })).toEqual({
      type: "compaction",
      phase: "end",
      reason: "manual",
    });
  });

  it("auto_retry_start → retry（attempt/maxAttempts/error）", () => {
    expect(
      mapPiEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 5, delayMs: 1000, errorMessage: "429" }),
    ).toEqual({ type: "retry", attempt: 2, maxAttempts: 5, error: "429" });
  });

  it("queue_update → queue（统计待注入数量）", () => {
    expect(mapPiEvent({ type: "queue_update", steering: ["a", "b"], followUp: ["c"] })).toEqual({
      type: "queue",
      steering: 2,
      followUp: 1,
    });
    expect(mapPiEvent({ type: "queue_update", steering: [], followUp: [] })).toEqual({
      type: "queue",
      steering: 0,
      followUp: 0,
    });
  });

  it("session_info_changed / thinking_level_changed → 状态事件", () => {
    expect(mapPiEvent({ type: "session_info_changed", name: "调试会话" })).toEqual({
      type: "session-info",
      name: "调试会话",
    });
    expect(mapPiEvent({ type: "thinking_level_changed", level: "high" })).toEqual({
      type: "thinking-level",
      level: "high",
    });
  });

  it("被忽略的边界/响应事件 → null", () => {
    for (const type of ["agent_start", "turn_start", "message_start", "auto_retry_end", "response"]) {
      expect(mapPiEvent({ type })).toBeNull();
    }
  });

  it("非对象 / 缺字段 → null 且不抛", () => {
    expect(mapPiEvent(null)).toBeNull();
    expect(mapPiEvent("nope")).toBeNull();
    expect(mapPiEvent(42)).toBeNull();
    expect(mapPiEvent({})).toBeNull();
    expect(mapPiEvent({ type: "message_update" })).toBeNull(); // 无 assistantMessageEvent
  });
});

describe("PiRpcSession ready", () => {
  it("pi 就绪前退出时抛出带 stderr tail 的退出原因", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeTransport();
      const session = new PiRpcSession(f.transport, vi.fn());
      const assertion = expect(session.ready({ tries: 3, intervalMs: 10 })).rejects.toThrow("退出码 1: missing config");

      f.exit(1, "missing config");
      await vi.runAllTimersAsync();

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PiRpcSession", () => {
  it("send 写出带 id 的命令行,收到同 id 的 response 即 resolve", async () => {
    const f = fakeTransport();
    const s = new PiRpcSession(f.transport, vi.fn());
    const p = s.send({ type: "get_state" });
    const cmd = f.lastCmd();
    expect(cmd.type).toBe("get_state");
    expect(typeof cmd.id).toBe("string");
    expect(f.writes[0].endsWith("\n")).toBe(true);
    f.emit(JSON.stringify({ type: "response", id: cmd.id, command: "get_state", success: true, data: { ok: 1 } }) + "\n");
    await expect(p).resolves.toMatchObject({ success: true, data: { ok: 1 } });
  });

  it("send 超时 → reject,且超时后迟到的同 id response 被安全忽略（pending 已摘除,不二次结算/不误当事件）", async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    try {
      const f = fakeTransport();
      const s = new PiRpcSession(f.transport, onEvent);
      const p = s.send({ type: "get_state" }, 100);
      const id = f.lastCmd().id;
      const assertion = expect(p).rejects.toThrow(/超时/);
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      // 超时已 delete pending:迟到的同 id response 既不二次结算,也不被误当事件推 onEvent。
      f.emit(JSON.stringify({ type: "response", id, command: "get_state", success: true, data: {} }) + "\n");
      expect(onEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prompt 用默认短超时通道:收到 preflight ack（response 行）即 resolve,不等 agent_end", async () => {
    const f = fakeTransport();
    const s = new PiRpcSession(f.transport, vi.fn());
    const p = s.prompt("跑个任务");
    const cmd = f.lastCmd();
    expect(cmd).toMatchObject({ type: "prompt", message: "跑个任务" });
    // pi 受理 prompt 后立即回 response（ack）,该 send 随即 resolve;run 完成另由 agent_end 事件表达。
    f.emit(JSON.stringify({ type: "response", id: cmd.id, command: "prompt", success: true }) + "\n");
    await expect(p).resolves.toMatchObject({ success: true });
  });

  it("prompt 带 images:payload 含协议内置 images 字段;无图不含 images 键(回归)", () => {
    const f = fakeTransport();
    const s = new PiRpcSession(f.transport, vi.fn());
    void s.prompt("看图", "run-2", [{ type: "image", data: "AAAA", mimeType: "image/png" }]).catch(() => {});
    expect(f.lastCmd()).toMatchObject({
      type: "prompt",
      message: "看图",
      images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
    void s.prompt("纯文本").catch(() => {});
    expect(f.lastCmd()).not.toHaveProperty("images");
    s.stop();
  });

  it("compact 用较长有界超时:60s 内不超时（远超默认 30s）,越过 5min 才超时", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeTransport();
      const s = new PiRpcSession(f.transport, vi.fn());
      let settled = false;
      const p = s.compact("保留要点").then(
        () => (settled = true),
        () => (settled = true),
      );
      expect(f.lastCmd()).toMatchObject({ type: "compact", customInstructions: "保留要点" });
      await vi.advanceTimersByTimeAsync(60_000); // 1min:若是默认 30s 早超时了
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(5 * 60_000); // 越过 5min → 超时
      await p;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("LF 行缓冲:一次多行 + 跨 chunk 半行 都能正确分帧成事件", () => {
    const events: PiSessionEvent[] = [];
    const f = fakeTransport();
    new PiRpcSession(f.transport, (e) => events.push(e));
    f.emit(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "A" } }) +
        "\n" +
        JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "B" } }) +
        "\n",
    );
    f.emit('{"type":"message_update","assistantMessageEvent":{"type":"text_delta",');
    f.emit('"delta":"C"}}\n');
    expect(events).toEqual([
      { type: "text", delta: "A" },
      { type: "text", delta: "B" },
      { type: "text", delta: "C" },
    ]);
  });

  it("response 行只 resolve 请求,不进 onEvent", async () => {
    const onEvent = vi.fn();
    const f = fakeTransport();
    const s = new PiRpcSession(f.transport, onEvent);
    const p = s.abort();
    f.emit(JSON.stringify({ type: "response", id: f.lastCmd().id, command: "abort", success: true }) + "\n");
    await p;
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("非 response 行 → 经 mapPiEvent 推给 onEvent", () => {
    const onEvent = vi.fn();
    const f = fakeTransport();
    new PiRpcSession(f.transport, onEvent);
    f.emit(JSON.stringify({ type: "agent_end", messages: [], willRetry: false }) + "\n");
    expect(onEvent).toHaveBeenCalledWith({ type: "result", willRetry: false }, undefined);
  });

  it("text_delta 后仅有 message_end(stop) 也会按当前 runId 发 result 收尾", () => {
    const onEvent = vi.fn();
    const f = fakeTransport();
    const s = new PiRpcSession(f.transport, onEvent);
    void s.prompt("需要思考的问题", "run-pi").catch(() => {});
    f.emit(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "最终答案", partial: {} },
        message: {},
      }) + "\n",
    );
    f.emit(JSON.stringify({ type: "message_end", message: { stopReason: "stop" } }) + "\n");
    expect(onEvent).toHaveBeenCalledWith({ type: "text", delta: "最终答案" }, "run-pi");
    expect(onEvent).toHaveBeenCalledWith({ type: "result", willRetry: false }, "run-pi");
    s.stop();
  });

  it("notify 走事件流(非对话框回写通道),setStatus 丢弃", () => {
    const events: PiSessionEvent[] = [];
    const onUi = vi.fn();
    const f = fakeTransport();
    new PiRpcSession(f.transport, (e) => events.push(e), onUi);
    f.emit(
      JSON.stringify({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi", notifyType: "warning" }) +
        "\n",
    );
    f.emit(JSON.stringify({ type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "k", statusText: "x" }) + "\n");
    expect(onUi).not.toHaveBeenCalled(); // notify/setStatus 都不进对话框队列
    expect(events).toContainEqual({ type: "notify", message: "hi", level: "warning" });
  });

  // 扩展命令(/cmd)由 pi 即时执行后提前返回、不跑 agent → 无 agent_end。补发 result 收尾防永久卡「思考中」。
  describe("扩展命令收尾", () => {
    it("带 notify 输出:response 落定即补发 result(无需等宽限)", async () => {
      const events: PiSessionEvent[] = [];
      const f = fakeTransport();
      const s = new PiRpcSession(f.transport, (e) => events.push(e));
      const p = s.prompt("/memory-index-sessions", "run-x");
      const cmd = f.lastCmd();
      // 真实顺序:handler 跑完(发 notify) → 才回 prompt response。
      f.emit(JSON.stringify({ type: "extension_ui_request", id: "n1", method: "notify", message: "✅ 完成" }) + "\n");
      f.emit(JSON.stringify({ type: "response", id: cmd.id, command: "prompt", success: true }) + "\n");
      await p;
      await Promise.resolve(); // 让 prompt 内部 .then(scheduleExtensionCommandFinalize) 跑完
      expect(events).toContainEqual({ type: "notify", message: "✅ 完成", level: "info" });
      expect(events).toContainEqual({ type: "result", willRetry: false });
    });

    it("无 notify 输出:宽限后仍无 agent 活动 → 补发 result", async () => {
      vi.useFakeTimers();
      try {
        const events: PiSessionEvent[] = [];
        const f = fakeTransport();
        const s = new PiRpcSession(f.transport, (e) => events.push(e));
        const p = s.prompt("/quietcmd", "run-z");
        const cmd = f.lastCmd();
        f.emit(JSON.stringify({ type: "response", id: cmd.id, command: "prompt", success: true }) + "\n");
        await p;
        await Promise.resolve();
        expect(events.filter((e) => e.type === "result")).toHaveLength(0); // 宽限未到,先不补
        vi.advanceTimersByTime(1600);
        expect(events.filter((e) => e.type === "result")).toEqual([{ type: "result", willRetry: false }]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("/cmd 实际起了 agent 轮(命中文本事件):不补发 result,避免双收尾", async () => {
      vi.useFakeTimers();
      try {
        const events: PiSessionEvent[] = [];
        const f = fakeTransport();
        const s = new PiRpcSession(f.transport, (e) => events.push(e));
        const p = s.prompt("/skill:foo", "run-y");
        const cmd = f.lastCmd();
        f.emit(JSON.stringify({ type: "response", id: cmd.id, command: "prompt", success: true }) + "\n");
        await p;
        await Promise.resolve();
        // 宽限窗内到达 agent 文本事件 → 取消补发。
        f.emit(
          JSON.stringify({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "嗨", partial: {} },
            message: {},
          }) + "\n",
        );
        vi.advanceTimersByTime(3000);
        expect(events.some((e) => e.type === "text")).toBe(true);
        expect(events.filter((e) => e.type === "result")).toHaveLength(0); // 无补发(真实 result 另由 agent_end 表达)
      } finally {
        vi.useRealTimers();
      }
    });

    it("普通(非 /)prompt:不触发扩展命令补发", async () => {
      vi.useFakeTimers();
      try {
        const events: PiSessionEvent[] = [];
        const f = fakeTransport();
        const s = new PiRpcSession(f.transport, (e) => events.push(e));
        const p = s.prompt("普通问题", "run-n");
        const cmd = f.lastCmd();
        f.emit(JSON.stringify({ type: "response", id: cmd.id, command: "prompt", success: true }) + "\n");
        await p;
        await Promise.resolve();
        vi.advanceTimersByTime(3000);
        expect(events.filter((e) => e.type === "result")).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("ready: get_state 返回 sessionId 即就绪", async () => {
    const f = fakeTransport();
    const s = new PiRpcSession(f.transport, vi.fn());
    const p = s.ready({ tries: 3, intervalMs: 1000 });
    await Promise.resolve();
    const cmd = f.lastCmd();
    expect(cmd.type).toBe("get_state");
    f.emit(
      JSON.stringify({ type: "response", id: cmd.id, command: "get_state", success: true, data: { sessionId: "sess-1" } }) +
        "\n",
    );
    await expect(p).resolves.toEqual({ sessionId: "sess-1" });
  });

  it("ready: 进程在就绪前退出 → reject", async () => {
    const f = fakeTransport();
    const s = new PiRpcSession(f.transport, vi.fn());
    f.exit(1);
    await expect(s.ready({ tries: 2, intervalMs: 50 })).rejects.toThrow(/退出/);
  });

  it("ready: 轮询 tries 次都拿不到 sessionId → 抛 就绪超时（恰好发 tries 次 get_state）", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeTransport();
      const s = new PiRpcSession(f.transport, vi.fn());
      const assertion = expect(s.ready({ tries: 2, intervalMs: 10 })).rejects.toThrow(/就绪超时/);
      await vi.advanceTimersByTimeAsync(10); // 第1次 get_state 超时
      await vi.advanceTimersByTimeAsync(10); // 第2次 get_state 超时 → 循环耗尽
      await assertion;
      const getStateCount = f.writes.filter((w) => (JSON.parse(w.trim()) as { type: string }).type === "get_state").length;
      expect(getStateCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("命令封装写出正确的 type 与参数（含 snake_case 映射）", () => {
    const f = fakeTransport();
    const s = new PiRpcSession(f.transport, vi.fn());
    const ps = [
      s.prompt("hi"),
      s.steer("wait"),
      s.followUp("more"),
      s.abort(),
      s.fork("e1"),
      s.getForkMessages(),
      s.setModel("anthropic", "claude"),
      s.setThinkingLevel("high"),
      s.compact("保留要点"),
      s.getState(),
      s.getSessionStats(),
      s.newSession("parent.jsonl"),
      s.switchSession("/sess/x.jsonl"),
      s.getLastAssistantText(),
    ];
    ps.forEach((p) => void p.catch(() => {}));
    const cmds = f.writes.map((w) => JSON.parse(w.trim()));
    expect(cmds.map((c) => c.type)).toEqual([
      "prompt",
      "steer",
      "follow_up",
      "abort",
      "fork",
      "get_fork_messages",
      "set_model",
      "set_thinking_level",
      "compact",
      "get_state",
      "get_session_stats",
      "new_session",
      "switch_session",
      "get_last_assistant_text",
    ]);
    expect(cmds[0]).toMatchObject({ type: "prompt", message: "hi" });
    expect(cmds[2]).toMatchObject({ type: "follow_up", message: "more" });
    expect(cmds[4]).toMatchObject({ type: "fork", entryId: "e1" });
    expect(cmds[6]).toMatchObject({ type: "set_model", provider: "anthropic", modelId: "claude" });
    expect(cmds[7]).toMatchObject({ type: "set_thinking_level", level: "high" });
    expect(cmds[8]).toMatchObject({ type: "compact", customInstructions: "保留要点" });
    expect(cmds[11]).toMatchObject({ type: "new_session", parentSession: "parent.jsonl" });
    expect(cmds[12]).toMatchObject({ type: "switch_session", sessionPath: "/sess/x.jsonl" });
    s.stop(); // reject 掉上面未 await 的 pending（已 catch）
  });

  it("stop() 调 transport.kill,后续 send 被拒", async () => {
    const f = fakeTransport();
    const s = new PiRpcSession(f.transport, vi.fn());
    s.stop();
    expect(f.transport.kill).toHaveBeenCalled();
    await expect(s.send({ type: "get_state" })).rejects.toThrow(/退出/);
  });

  it("进程非正常退出 → onEvent crashed,且 pending 被拒", async () => {
    const onEvent = vi.fn();
    const f = fakeTransport();
    const s = new PiRpcSession(f.transport, onEvent);
    const p = s.prompt("x");
    f.exit(1);
    await expect(p).rejects.toThrow(/退出/);
    expect(onEvent).toHaveBeenCalledWith({ type: "crashed", error: "退出码 1" });
  });

  it("stop() 后进程退出不再上报 crashed", () => {
    const onEvent = vi.fn();
    const f = fakeTransport();
    const s = new PiRpcSession(f.transport, onEvent);
    s.stop();
    onEvent.mockClear();
    f.exit(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("stop() 后到来的 stdout 不再触发 onEvent（防重开同 uiSessionId 串场）", () => {
    const onEvent = vi.fn();
    const f = fakeTransport();
    const s = new PiRpcSession(f.transport, onEvent);
    s.stop();
    f.emit(JSON.stringify({ type: "agent_end", messages: [], willRetry: false }) + "\n");
    f.emit(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "残余" } }) + "\n");
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("error 与 close 先后到达 → crashed 只上报一次（exited 去重）", () => {
    const onEvent = vi.fn();
    const f = fakeTransport();
    new PiRpcSession(f.transport, onEvent);
    f.error(new Error("spawn ENOENT")); // 先 error
    f.exit(null); // 再 close —— 应被 exited 去重,不二次上报
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: "crashed", error: "spawn ENOENT" });
  });

  it("非 0 退出带 stderr → crashed.error 含 stderr tail（崩溃诊断）", () => {
    const onEvent = vi.fn();
    const f = fakeTransport();
    new PiRpcSession(f.transport, onEvent);
    f.exit(1, "provider auth failed");
    expect(onEvent).toHaveBeenCalledWith({ type: "crashed", error: "退出码 1: provider auth failed" });
  });
});

describe("buildRpcArgs", () => {
  const base: PiOpenRequest = { uiSessionId: "u1", cwd: "/proj" };

  it("基础:--mode rpc + --no-extensions + --no-skills,无 -p/--model/--session", () => {
    const args = buildRpcArgs(base);
    expect(args.slice(0, 2)).toEqual(["--mode", "rpc"]);
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--no-skills");
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--session");
  });

  it("插件 Skill:--no-skills 随 useOwnSkills gate（=true 时省略,放开 pi 原生发现,与 claude adapter 对齐）", () => {
    expect(buildRpcArgs({ ...base, useOwnSkills: true })).not.toContain("--no-skills");
    expect(buildRpcArgs({ ...base, useOwnSkills: false })).toContain("--no-skills");
    expect(buildRpcArgs(base)).toContain("--no-skills"); // 缺省 = 关
  });

  it("插件 Skill:useOwnSkills=true 时原生发现 + --skill 注入并存", () => {
    const args = buildRpcArgs({ ...base, useOwnSkills: true, skillPaths: ["/a/code-review"] });
    expect(args).not.toContain("--no-skills");
    expect(args.join(" ")).toContain("--skill /a/code-review");
  });

  it("插件 Skill:skillPaths 逐个 --skill 注入；缺省仅 --no-skills", () => {
    expect(buildRpcArgs(base)).not.toContain("--skill");
    const args = buildRpcArgs({ ...base, skillPaths: ["/a/code-review", "/b/bug-hunt"] });
    expect(args).toContain("--no-skills");
    const joined = args.join(" ");
    expect(joined).toContain("--skill /a/code-review");
    expect(joined).toContain("--skill /b/bug-hunt");
  });

  it("运行模式 plan:toolWhitelist → --tools 逗号拼接,与 --skill 共存", () => {
    expect(buildRpcArgs(base)).not.toContain("--tools"); // 缺省(accept-edits/full-auto)不收窄
    const args = buildRpcArgs({
      ...base,
      toolWhitelist: ["read", "grep", "find", "ls"],
      skillPaths: ["/a/code-review"],
    });
    expect(args.join(" ")).toContain("--tools read,grep,find,ls");
    expect(args.join(" ")).toContain("--skill /a/code-review"); // 不互斥
  });

  it("自定义供应商:-e/-a/--provider + --model 透传", () => {
    const args = buildRpcArgs({
      ...base,
      model: "deepseek-chat",
      piExtensionPath: "/d/deepseek.mjs",
      provider: { id: "deepseek", baseUrl: "https://api.deepseek.com", models: [] },
    });
    expect(args.join(" ")).toContain("-e /d/deepseek.mjs");
    expect(args).toContain("-a");
    expect(args.join(" ")).toContain("--provider deepseek");
    expect(args.join(" ")).toContain("--model deepseek-chat");
  });

  it("无 extension:不加 -e/-a/--provider", () => {
    const args = buildRpcArgs(base);
    expect(args).not.toContain("-e");
    expect(args).not.toContain("-a");
    expect(args).not.toContain("--provider");
  });

  it("多 -e 共存（阶段3）:provider + 追加 extension 各一个 -e,-a 仅一次,--provider 仍在", () => {
    const args = buildRpcArgs({
      ...base,
      piExtensionPath: "/d/deepseek.js",
      extraExtensionPaths: ["/d/approval.js", "/d/sample-tools.js"],
      provider: { id: "deepseek", baseUrl: "https://api.deepseek.com", models: [] },
    });
    const eIdx = args.reduce<number[]>((acc, a, i) => (a === "-e" ? [...acc, i] : acc), []);
    expect(eIdx).toHaveLength(3); // provider + 2 追加
    expect(args[eIdx[0]! + 1]).toBe("/d/deepseek.js");
    expect(args).toContain("/d/approval.js");
    expect(args).toContain("/d/sample-tools.js");
    expect(args.filter((a) => a === "-a")).toHaveLength(1); // 信任只加一次
    expect(args.join(" ")).toContain("--provider deepseek"); // provider 注入不变
  });

  it("仅追加 extension（无 provider）:加 -e/-a,不加 --provider", () => {
    const args = buildRpcArgs({ ...base, extraExtensionPaths: ["/d/approval.js"] });
    expect(args.join(" ")).toContain("-e /d/approval.js");
    expect(args).toContain("-a");
    expect(args).not.toContain("--provider");
  });

  it("扩展市场（U3）:extensionPaths 折入 -e 批次,与 provider/追加扩展共存,-a 仅一次", () => {
    const args = buildRpcArgs({
      ...base,
      piExtensionPath: "/d/provider.js",
      extraExtensionPaths: ["/d/approval.js"],
      extensionPaths: ["/e/market-a.js", "/e/market-b.js"],
      provider: { id: "deepseek", baseUrl: "https://api.deepseek.com", models: [] },
    });
    const eIdx = args.reduce<number[]>((acc, a, i) => (a === "-e" ? [...acc, i] : acc), []);
    expect(eIdx).toHaveLength(4); // provider + 1 追加 + 2 市场
    expect(args).toContain("/e/market-a.js");
    expect(args).toContain("/e/market-b.js");
    expect(args.filter((a) => a === "-a")).toHaveLength(1); // 整批信任只一次
  });

  it("扩展市场（U3）:仅 extensionPaths（无 provider/追加）也加 -e/-a,不加 --provider", () => {
    const args = buildRpcArgs({ ...base, extensionPaths: ["/e/market-a.js"] });
    expect(args.join(" ")).toContain("-e /e/market-a.js");
    expect(args).toContain("-a");
    expect(args).not.toContain("--provider");
  });

  it("appendSystemPrompt → --append-system-prompt 透传（阶段4 持久 system prompt）", () => {
    const args = buildRpcArgs({ ...base, appendSystemPrompt: "你是资深工程师" });
    const i = args.indexOf("--append-system-prompt");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("你是资深工程师");
  });

  it("无 appendSystemPrompt → 不加 --append-system-prompt", () => {
    expect(buildRpcArgs(base)).not.toContain("--append-system-prompt");
  });

  it("thinkingLevel → --thinking 透传（阶段5 思考强度初值）", () => {
    const args = buildRpcArgs({ ...base, thinkingLevel: "high" });
    const i = args.indexOf("--thinking");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("high");
  });

  it("无 thinkingLevel → 不加 --thinking", () => {
    expect(buildRpcArgs(base)).not.toContain("--thinking");
  });
});

describe("spawnPiRpc", () => {
  it("记录 pi-rpc spawn/stderr/exit trace", () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const t = spawnPiRpc(["--mode", "rpc"], { cwd: "/p", env: { FOO: "1" } as NodeJS.ProcessEnv });
    t.onExit(() => undefined);
    child.stderr.emit("data", "panic\n");
    child.emit("close", 1);

    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "pi-rpc", phase: "spawn", agent: "pi" }),
    );
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "pi-rpc", phase: "stderr", data: expect.objectContaining({ chunk: "panic\n" }) }),
    );
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "pi-rpc", phase: "exit", data: expect.objectContaining({ code: 1 }) }),
    );
  });

  it("spawn 二进制 + stdio=[pipe,pipe,pipe];write 走 stdin", () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const t = spawnPiRpc(["--mode", "rpc"], { cwd: "/p", env: { FOO: "1" } as NodeJS.ProcessEnv });
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe("/fake/resources/pi/pi");
    expect(args).toEqual(["--mode", "rpc"]);
    expect(opts).toMatchObject({ cwd: "/p", stdio: ["pipe", "pipe", "pipe"] });
    t.write('{"x":1}\n');
    expect(child.stdin.write).toHaveBeenCalledWith('{"x":1}\n');
  });

  it("onStdout 绑定到子进程 stdout 的 data 事件", () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const t = spawnPiRpc(["--mode", "rpc"], { env: {} as NodeJS.ProcessEnv });
    const chunks: string[] = [];
    t.onStdout((c) => chunks.push(c));
    child.stdout.emit("data", "line\n");
    expect(chunks).toEqual(["line\n"]);
  });

  it("kill 调 child.kill(SIGTERM)", () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      spawnMock.mockReturnValueOnce(child);
      const t = spawnPiRpc(["--mode", "rpc"], { env: {} as NodeJS.ProcessEnv });
      t.kill();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers(); // 丢弃 3s 兜底 SIGKILL timer,避免误杀
    }
  });

  it("捕获 stderr tail,onExit 回带（供崩溃诊断）", () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const t = spawnPiRpc(["--mode", "rpc"], { env: {} as NodeJS.ProcessEnv });
    let got: { code: number | null; tail?: string } | null = null;
    t.onExit((code, tail) => (got = { code, tail }));
    child.stderr.emit("data", "panic: boom\n");
    child.emit("close", 1);
    expect(got).toEqual({ code: 1, tail: "panic: boom" });
  });

  it("stdin 不可写时 write 静默跳过（不抛、不调底层 write）", () => {
    const child = fakeChild();
    child.stdin.writable = false;
    spawnMock.mockReturnValueOnce(child);
    const t = spawnPiRpc(["--mode", "rpc"], { env: {} as NodeJS.ProcessEnv });
    expect(() => t.write('{"x":1}\n')).not.toThrow();
    expect(child.stdin.write).not.toHaveBeenCalled();
  });

  it("stdin 绑定 'error' 监听:EPIPE 不冒泡成未捕获异常", () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    spawnPiRpc(["--mode", "rpc"], { env: {} as NodeJS.ProcessEnv });
    // 若没绑 'error' 监听,EventEmitter 的 emit('error') 会抛
    expect(() => child.stdin.emit("error", new Error("EPIPE"))).not.toThrow();
  });
});

describe("extension UI 请求路由 + respondUi 回写（阶段3 U1）", () => {
  it("extension_ui_request{confirm} 行 → onUiRequest 收到,不污染事件流", () => {
    const f = fakeTransport();
    const onEvent = vi.fn();
    const onUiRequest = vi.fn();
    new PiRpcSession(f.transport, onEvent, onUiRequest);
    f.emit(
      JSON.stringify({
        type: "extension_ui_request",
        id: "u-1",
        method: "confirm",
        title: "允许执行 bash?",
        message: "rm -rf /tmp/x",
      }) + "\n",
    );
    expect(onUiRequest).toHaveBeenCalledTimes(1);
    expect(onUiRequest.mock.calls[0]?.[0]).toMatchObject({
      id: "u-1",
      method: "confirm",
      title: "允许执行 bash?",
      message: "rm -rf /tmp/x",
    });
    expect(onEvent).not.toHaveBeenCalled(); // 不走事件流
  });

  it("respondUi 直写精确 JSONL（原始 id,绕 send/不带 req_N）", () => {
    const f = fakeTransport();
    const s = new PiRpcSession(f.transport, vi.fn(), vi.fn());
    s.respondUi("u-7", { confirmed: true });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toBe('{"type":"extension_ui_response","id":"u-7","confirmed":true}\n');
    s.respondUi("u-8", { cancelled: true });
    expect(JSON.parse(f.writes[1]!.trim())).toEqual({ type: "extension_ui_response", id: "u-8", cancelled: true });
  });

  it("respondUi 在 stopped 后静默不写", () => {
    const f = fakeTransport();
    const s = new PiRpcSession(f.transport, vi.fn(), vi.fn());
    s.stop();
    s.respondUi("u-9", { confirmed: false });
    expect(f.writes.filter((w) => w.includes("extension_ui_response"))).toHaveLength(0);
  });

  it("UI 请求与命令 response、普通事件三路互不串", () => {
    const f = fakeTransport();
    const onEvent = vi.fn();
    const onUiRequest = vi.fn();
    new PiRpcSession(f.transport, onEvent, onUiRequest);
    // 普通事件仍走 onEvent
    f.emit(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }) + "\n");
    expect(onEvent).toHaveBeenCalledWith({ type: "text", delta: "hi" }, undefined);
    expect(onUiRequest).not.toHaveBeenCalled();
    // UI 请求只走 onUiRequest
    f.emit(JSON.stringify({ type: "extension_ui_request", id: "x", method: "confirm", title: "t", message: "m" }) + "\n");
    expect(onUiRequest).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1); // 未再增
  });

  it("无 onUiRequest 回调（阶段1/2 用法）时 UI 请求被安全忽略,不抛", () => {
    const f = fakeTransport();
    new PiRpcSession(f.transport, vi.fn()); // 不传 onUiRequest
    expect(() =>
      f.emit(JSON.stringify({ type: "extension_ui_request", id: "x", method: "confirm", title: "t", message: "m" }) + "\n"),
    ).not.toThrow();
  });
});

describe("askquestion 信封归一（U3）", () => {
  const SENT = "@@CORTEX_ASKQ:test@@";
  const envelope = {
    groups: [{ question: "Q", options: [{ label: "A" }, { label: "B" }], recommended: 0, allowCustom: true }],
  };

  it("带本会话 sentinel 的 input → 归一 method:askquestion + 解析 envelope,不走事件流", () => {
    const f = fakeTransport();
    const onEvent = vi.fn();
    const onUiRequest = vi.fn();
    new PiRpcSession(f.transport, onEvent, onUiRequest, SENT);
    f.emit(
      JSON.stringify({ type: "extension_ui_request", id: "a1", method: "input", title: SENT + JSON.stringify(envelope) }) + "\n",
    );
    expect(onUiRequest).toHaveBeenCalledTimes(1);
    const req = onUiRequest.mock.calls[0]?.[0] as { method: string; id: string; envelope: { groups: Array<Record<string, unknown>> } };
    expect(req.method).toBe("askquestion");
    expect(req.id).toBe("a1");
    expect(req.envelope.groups[0]!.question).toBe("Q");
    expect(req.envelope.groups[0]!.id).toBe("g0"); // 缺 id 补 g{i}
    expect(req.envelope.groups[0]!.recommended).toBe(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("裸 input(无 sentinel) → 仍以 method:input 上抛(既有兜底不回归)", () => {
    const f = fakeTransport();
    const onUiRequest = vi.fn();
    new PiRpcSession(f.transport, vi.fn(), onUiRequest, SENT);
    f.emit(JSON.stringify({ type: "extension_ui_request", id: "b1", method: "input", title: "普通输入" }) + "\n");
    expect((onUiRequest.mock.calls[0]?.[0] as { method: string }).method).toBe("input");
  });

  it("伪造 sentinel / 畸形 JSON → 不改判 askquestion,透传裸 input", () => {
    const f = fakeTransport();
    const onUiRequest = vi.fn();
    new PiRpcSession(f.transport, vi.fn(), onUiRequest, SENT);
    f.emit(JSON.stringify({ type: "extension_ui_request", id: "c1", method: "input", title: SENT + "{坏 json" }) + "\n");
    expect((onUiRequest.mock.calls[0]?.[0] as { method: string }).method).toBe("input");
    f.emit(
      JSON.stringify({ type: "extension_ui_request", id: "c2", method: "input", title: "@@OTHER@@" + JSON.stringify(envelope) }) + "\n",
    );
    expect((onUiRequest.mock.calls[1]?.[0] as { method: string }).method).toBe("input");
  });

  it("未配置 sentinel(阶段3 confirm 用法)时 confirm 不受影响", () => {
    const f = fakeTransport();
    const onUiRequest = vi.fn();
    new PiRpcSession(f.transport, vi.fn(), onUiRequest); // 不传 sentinel
    f.emit(JSON.stringify({ type: "extension_ui_request", id: "d1", method: "confirm", title: "t", message: "m" }) + "\n");
    expect((onUiRequest.mock.calls[0]?.[0] as { method: string }).method).toBe("confirm");
  });
});

describe("sanitizeAskQuestionEnvelope（入站校验）", () => {
  it("正常信封 → 通过,补 id,clamp options≤3,保留 recommended", () => {
    const env = sanitizeAskQuestionEnvelope({
      groups: [{ question: "Q", options: [{ label: "1" }, { label: "2" }, { label: "3" }, { label: "4" }], recommended: 1 }],
    });
    expect(env).not.toBeNull();
    expect(env!.groups[0]!.options).toHaveLength(3); // clamp 到 3
    expect(env!.groups[0]!.id).toBe("g0");
    expect(env!.groups[0]!.recommended).toBe(0); // 推荐项已排到第一
    expect(env!.groups[0]!.options[0]!.label).toBe("2"); // 原 recommended(index1)移到首位
  });
  it("推荐项排到第一个:recommended 选项移到 options[0],recommended 归一为 0", () => {
    const env = sanitizeAskQuestionEnvelope({
      groups: [{ question: "q", options: [{ label: "A" }, { label: "B" }, { label: "C" }], recommended: 2 }],
    });
    expect(env!.groups[0]!.options.map((o) => o.label)).toEqual(["C", "A", "B"]);
    expect(env!.groups[0]!.recommended).toBe(0);
  });
  it("空 groups / 非对象 → null", () => {
    expect(sanitizeAskQuestionEnvelope({ groups: [] })).toBeNull();
    expect(sanitizeAskQuestionEnvelope({})).toBeNull();
    expect(sanitizeAskQuestionEnvelope(null)).toBeNull();
  });
  it("组数超上限 → null", () => {
    const groups = Array.from({ length: 13 }, () => ({ question: "q", options: [{ label: "a" }] }));
    expect(sanitizeAskQuestionEnvelope({ groups })).toBeNull();
  });
  it("组无选项且不允许自定义 → null(不可作答);允许自定义 → 通过", () => {
    expect(sanitizeAskQuestionEnvelope({ groups: [{ question: "q", options: [] }] })).toBeNull();
    const env = sanitizeAskQuestionEnvelope({ groups: [{ question: "q", options: [], allowCustom: true }] });
    expect(env!.groups[0]!.allowCustom).toBe(true);
  });
  it("recommended 越界 → 丢弃(无推荐)", () => {
    const env = sanitizeAskQuestionEnvelope({ groups: [{ question: "q", options: [{ label: "a" }], recommended: 5 }] });
    expect(env!.groups[0]!.recommended).toBeUndefined();
  });
  it("入站 id 不被信任:重复/自定义 id 一律按位置重写为 g{i}(防渲染 key 冲突/串组)", () => {
    const env = sanitizeAskQuestionEnvelope({
      groups: [
        { id: "dup", question: "Q0", options: [{ label: "a" }] },
        { id: "dup", question: "Q1", options: [{ label: "b" }] },
      ],
    });
    expect(env!.groups.map((g) => g.id)).toEqual(["g0", "g1"]);
  });
});

describe("U4 盲区补点落盘", () => {
  it("mapPiEvent 未知 message_end.stopReason → 记一条 warn(未产终态),已知值静默", () => {
    // 未映射的 stopReason:不产终态(返回 null)且落日志,便于定位 pi 协议漂移。
    expect(mapPiEvent({ type: "message_end", message: { stopReason: "mystery" } })).toBeNull();
    expect(logMocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(logMocks.logger.warn.mock.calls[0]![1]).toMatchObject({ stopReason: "mystery" });

    // 已知正常收尾值不噪声。
    logMocks.logger.warn.mockReset();
    mapPiEvent({ type: "message_end", message: { stopReason: "stop" } });
    mapPiEvent({ type: "message_end", message: { stopReason: "length" } });
    mapPiEvent({ type: "message_end", message: { stopReason: "toolUse" } });
    mapPiEvent({ type: "message_end" }); // 无 stopReason 也不噪声
    expect(logMocks.logger.warn).not.toHaveBeenCalled();
  });

  it("send 超时 → 记一条命令超时 warn(含命令类型与阈值)", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeTransport();
      const s = new PiRpcSession(f.transport, vi.fn());
      const p = s.send({ type: "get_state" }, 100);
      const assertion = expect(p).rejects.toThrow(/超时/);
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      expect(logMocks.logger.warn).toHaveBeenCalledWith("pi 命令超时", { command: "get_state", timeoutMs: 100 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("非主动退出(崩溃)→ 记一条 crashed warn", () => {
    const f = fakeTransport();
    new PiRpcSession(f.transport, vi.fn());
    f.exit(1, "boom");
    expect(logMocks.logger.warn).toHaveBeenCalledWith("pi 会话崩溃退出", { code: 1, detail: "退出码 1: boom" });
  });

  it("主动 stop 后的退出不记 crashed(主动停止不噪声)", () => {
    const f = fakeTransport();
    const s = new PiRpcSession(f.transport, vi.fn());
    s.stop();
    f.exit(0);
    expect(logMocks.logger.warn).not.toHaveBeenCalled();
  });
});
