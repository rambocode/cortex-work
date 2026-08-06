// 事件泵单测。三类断言:
//   1. 映射语义与旧路径一致(R2)——含 stopReason error|aborted 的错误路径与忽略清单(KTD5);
//   2. **handle() 永不抛**——它在 pi 的 agent loop 栈上执行,抛出会打断整轮对话;
//   3. IPC 序列化边界——in-process 拿到的是活对象,不净化会在 webContents.send 处炸。

import { describe, expect, it, vi } from "vitest";

const logMocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() },
}));
vi.mock("../../log", () => ({ createLogger: () => logMocks.logger, isDevEnv: () => true }));
// rpc-shared 的传递依赖:agent-trace 等。
vi.mock("electron", () => ({ app: {} }));
vi.mock("child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../ipc/agent-trace", () => ({ recordAgentTrace: vi.fn(), recordStreamDelta: vi.fn() }));

import { AGENT_TURN_EVENT_TYPES, createPiEventPump, isAgentTurnEvent, sanitizePiSessionEvent } from "./events";
import type { PiSessionEvent } from "../../ipc/types";

function collect() {
  const events: Array<{ ev: PiSessionEvent; runId?: string }> = [];
  return { events, sink: (ev: PiSessionEvent, runId?: string) => events.push({ ev, runId }) };
}

describe("createPiEventPump", () => {
  it("把 AgentSessionEvent 映射成归一化事件并带上当前 runId", () => {
    const { events, sink } = collect();
    const pump = createPiEventPump({ onEvent: sink, getRunId: () => "run-1" });
    pump.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
    expect(events).toEqual([{ ev: { type: "text", delta: "hi" }, runId: "run-1" }]);
  });

  it("错误路径:stopReason=error/aborted 映射为 error 事件(KTD5 明确要求覆盖)", () => {
    const { events, sink } = collect();
    const pump = createPiEventPump({ onEvent: sink });
    pump.handle({ type: "message_end", message: { stopReason: "error", errorMessage: "response.result is not a function" } });
    pump.handle({ type: "message_end", message: { stopReason: "aborted" } });
    expect(events.map((e) => e.ev)).toEqual([
      { type: "error", error: "response.result is not a function" },
      { type: "error", error: "aborted" },
    ]);
  });

  it("忽略清单里的事件不产出任何东西", () => {
    const { events, sink } = collect();
    const pump = createPiEventPump({ onEvent: sink });
    for (const raw of [
      { type: "entry_appended", entry: {} },
      { type: "bash_execution_update", delta: "x" },
      { type: "summarization_retry_scheduled", attempt: 1 },
      { type: "agent_start" },
      { type: "message_end", message: { stopReason: "toolUse" } },
      null,
      "not-an-object",
    ]) {
      pump.handle(raw);
    }
    expect(events).toEqual([]);
  });

  it("stopped 之后丢弃残余事件(防重开同会话时串台)", () => {
    const { events, sink } = collect();
    let stopped = false;
    const pump = createPiEventPump({ onEvent: sink, isStopped: () => stopped });
    pump.handle({ type: "agent_end", willRetry: false });
    stopped = true;
    pump.handle({ type: "agent_end", willRetry: false });
    expect(events).toHaveLength(1);
  });

  it("sink 抛错时 handle() 不抛,并走 onFault(异常边界第 2 道闸)", () => {
    const faults: unknown[] = [];
    const pump = createPiEventPump({
      onEvent: () => {
        throw new Error("renderer 已销毁");
      },
      onFault: (err) => faults.push(err),
    });
    expect(() => pump.handle({ type: "agent_end", willRetry: false })).not.toThrow();
    expect(faults).toHaveLength(1);
  });

  it("onFault 自身抛错也不允许冒泡", () => {
    const pump = createPiEventPump({
      onEvent: () => {
        throw new Error("boom");
      },
      onFault: () => {
        throw new Error("fault handler 也炸了");
      },
    });
    expect(() => pump.handle({ type: "agent_end", willRetry: false })).not.toThrow();
  });

  it("attach 订阅 AgentSession 并回传退订函数", () => {
    const { events, sink } = collect();
    const pump = createPiEventPump({ onEvent: sink });
    let listener: ((e: unknown) => void) | undefined;
    const unsub = vi.fn();
    const off = pump.attach({
      subscribe: (l) => {
        listener = l;
        return unsub;
      },
    });
    listener?.({ type: "agent_settled" });
    expect(events.map((e) => e.ev)).toEqual([{ type: "settled" }]);
    off();
    expect(unsub).toHaveBeenCalled();
  });
});

describe("sanitizePiSessionEvent", () => {
  it("循环引用的工具入参被丢弃,但事件本身保留", () => {
    const cyclic: Record<string, unknown> = { path: "/a" };
    cyclic.self = cyclic;
    const out = sanitizePiSessionEvent({ type: "tool-start", name: "read", toolCallId: "t1", input: cyclic });
    expect(out).toEqual({ type: "tool-start", name: "read", toolCallId: "t1" });
  });

  it("普通入参原样保留(经 JSON 往返,可结构化克隆)", () => {
    const out = sanitizePiSessionEvent({ type: "tool-start", name: "read", toolCallId: "t1", input: { path: "/a" } });
    expect(out).toEqual({ type: "tool-start", name: "read", toolCallId: "t1", input: { path: "/a" } });
  });

  it("非 tool-start 事件原样返回(零拷贝)", () => {
    const ev: PiSessionEvent = { type: "text", delta: "x" };
    expect(sanitizePiSessionEvent(ev)).toBe(ev);
  });
});

describe("isAgentTurnEvent", () => {
  it("覆盖「agent 真在跑一轮」的全部类型", () => {
    expect([...AGENT_TURN_EVENT_TYPES].sort()).toEqual(
      ["error", "reasoning", "result", "text", "tool-end", "tool-start", "turn-end"].sort(),
    );
    expect(isAgentTurnEvent({ type: "notify", message: "x" })).toBe(false);
    expect(isAgentTurnEvent({ type: "text", delta: "x" })).toBe(true);
  });
});
