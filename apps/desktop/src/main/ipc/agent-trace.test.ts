import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  onMock: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
    on: mocks.onMock,
  },
}));

import {
  __resetAgentTraceForTest,
  agentTraceClear,
  agentTraceList,
  recordAgentTrace,
  recordStreamDelta,
  registerAgentTraceHandlers,
  sanitizeTraceData,
} from "./agent-trace";

beforeEach(() => {
  mocks.handlers.clear();
  mocks.onMock.mockReset();
  __resetAgentTraceForTest();
});

describe("agent trace buffer", () => {
  it("保留最近 500 条 trace 事件", () => {
    for (let i = 0; i < 505; i += 1) {
      recordAgentTrace({ scope: "cli", phase: "event", summary: `event-${i}` });
    }

    const events = agentTraceList();
    expect(events).toHaveLength(500);
    expect(events[0]?.summary).toBe("event-5");
    expect(events.at(-1)?.summary).toBe("event-504");
  });

  it("脱敏 secret 字段并限制长文本", () => {
    const sanitized = sanitizeTraceData({
      apiKey: "sk-secret",
      Authorization: "Bearer token",
      env: {
        CORTEX_PI_KEY: "pi-secret",
        PATH: "/usr/bin",
      },
      nested: {
        token: "secret-token",
        prompt: "x".repeat(5000),
      },
    });

    expect(sanitized).toMatchObject({
      apiKey: "[redacted]",
      Authorization: "[redacted]",
      env: { CORTEX_PI_KEY: "[redacted]", PATH: "/usr/bin" },
      nested: { token: "[redacted]" },
    });
    expect((sanitized as { nested: { prompt: string } }).nested.prompt).toHaveLength(4001);
  });

  it("clear 清空内存 trace", () => {
    recordAgentTrace({ scope: "cli", phase: "start", summary: "start" });
    expect(agentTraceList()).toHaveLength(1);

    agentTraceClear();

    expect(agentTraceList()).toHaveLength(0);
  });
});

describe("流式增量合并为段", () => {
  const textContent = (e: { data?: unknown }) => (e.data as { text?: string })?.text;
  const reasoningContent = (e: { data?: unknown }) => (e.data as { reasoning?: string })?.reasoning;

  it("连续同类 text 增量合并为一条、累积完整内容(Covers AE1)", () => {
    recordStreamDelta({ scope: "pi", segmentType: "text", delta: "你好", runId: "run-1", agent: "pi" });
    recordStreamDelta({ scope: "pi", segmentType: "text", delta: "，", runId: "run-1", agent: "pi" });
    recordStreamDelta({ scope: "pi", segmentType: "text", delta: "世界", runId: "run-1", agent: "pi" });

    const events = agentTraceList();
    expect(events).toHaveLength(1);
    expect(events[0]?.segmentType).toBe("text");
    expect(events[0]?.deltaCount).toBe(3);
    expect(events[0]?.streaming).toBe(true);
    expect(textContent(events[0]!)).toBe("你好，世界");
  });

  it("reasoning 与 text 各自成段、互不合并(Covers AE1/R6)", () => {
    for (let i = 0; i < 48; i += 1)
      recordStreamDelta({ scope: "pi", segmentType: "reasoning", delta: "r", runId: "run-1", agent: "pi" });
    for (let i = 0; i < 31; i += 1)
      recordStreamDelta({ scope: "pi", segmentType: "text", delta: "t", runId: "run-1", agent: "pi" });

    const events = agentTraceList();
    expect(events).toHaveLength(2);
    expect(events[0]?.segmentType).toBe("reasoning");
    expect(events[0]?.deltaCount).toBe(48);
    expect(reasoningContent(events[0]!)).toHaveLength(48);
    expect(events[1]?.segmentType).toBe("text");
    expect(events[1]?.deltaCount).toBe(31);
    // reasoning 段在 text 开始时已收尾
    expect(events[0]?.streaming).toBe(false);
    expect(events[1]?.streaming).toBe(true);
  });

  it("普通事件(tool)收尾打开段,之后 text 另起新段(Covers AE2)", () => {
    recordStreamDelta({ scope: "pi", segmentType: "text", delta: "前", runId: "run-1", agent: "pi" });
    recordAgentTrace({ scope: "pi", phase: "event", summary: "pi tool", runId: "run-1", agent: "pi" });
    recordStreamDelta({ scope: "pi", segmentType: "text", delta: "后", runId: "run-1", agent: "pi" });

    const events = agentTraceList();
    expect(events).toHaveLength(3);
    expect(events[0]?.segmentType).toBe("text");
    expect(events[0]?.streaming).toBe(false); // 被 tool 收尾
    expect(textContent(events[0]!)).toBe("前");
    expect(events[1]?.segmentType).toBeUndefined(); // 普通 tool 事件
    expect(events[2]?.segmentType).toBe("text");
    expect(textContent(events[2]!)).toBe("后");
  });

  it("不同 run 的增量互不串场(Covers AE3)", () => {
    recordStreamDelta({ scope: "pi", segmentType: "text", delta: "A1", runId: "run-A", agent: "pi" });
    recordStreamDelta({ scope: "pi", segmentType: "text", delta: "B1", runId: "run-B", agent: "pi" });
    recordStreamDelta({ scope: "pi", segmentType: "text", delta: "A2", runId: "run-A", agent: "pi" });
    recordStreamDelta({ scope: "pi", segmentType: "text", delta: "B2", runId: "run-B", agent: "pi" });

    const events = agentTraceList();
    expect(events).toHaveLength(2);
    const runA = events.find((e) => e.runId === "run-A");
    const runB = events.find((e) => e.runId === "run-B");
    expect(textContent(runA!)).toBe("A1A2");
    expect(textContent(runB!)).toBe("B1B2");
  });

  it("缓冲占用与增量数无关、仅与段数相关,先前事件不被挤出(Covers AE4/R8)", () => {
    recordAgentTrace({ scope: "pi", phase: "start", summary: "pi start", runId: "run-1", agent: "pi" });
    for (let i = 0; i < 2000; i += 1)
      recordStreamDelta({ scope: "pi", segmentType: "reasoning", delta: "x", runId: "run-1", agent: "pi" });
    for (let i = 0; i < 2000; i += 1)
      recordStreamDelta({ scope: "pi", segmentType: "text", delta: "y", runId: "run-1", agent: "pi" });

    const events = agentTraceList();
    // start(1) + reasoning 段(1) + text 段(1) = 3 条,而非 4001 条
    expect(events).toHaveLength(3);
    expect(events[0]?.phase).toBe("start"); // start 仍在缓冲内,未被挤出
  });

  it("非增量事件维持一事件一条(R7)", () => {
    recordAgentTrace({ scope: "cli", phase: "start", summary: "start" });
    recordAgentTrace({ scope: "cli", phase: "exit", summary: "exit" });
    expect(agentTraceList()).toHaveLength(2);
  });

  it("stderr 是旁路噪声,不收尾打开的 text 段(同段继续累积)", () => {
    recordStreamDelta({ scope: "cli", segmentType: "text", delta: "前", runId: "run-1", agent: "claude" });
    // 交错的 stderr 不应把 text 段切碎。
    recordAgentTrace({ scope: "cli", phase: "stderr", summary: "claude stderr", runId: "run-1", agent: "claude", data: { chunk: "warn" } });
    recordStreamDelta({ scope: "cli", segmentType: "text", delta: "后", runId: "run-1", agent: "claude" });

    const events = agentTraceList();
    // text 段(1,仍连续) + stderr(1) = 2 条;text 未被切成两段。
    const textSegs = events.filter((e) => e.segmentType === "text");
    expect(textSegs).toHaveLength(1);
    expect(textSegs[0]?.deltaCount).toBe(2);
    expect(textSegs[0]?.streaming).toBe(true);
    expect(textContent(textSegs[0]!)).toBe("前后");
  });

  it("clear 清空打开段,清空后续增量不复活旧段(另起新段)", () => {
    const first = recordStreamDelta({ scope: "pi", segmentType: "text", delta: "旧", runId: "run-1", agent: "pi" });
    agentTraceClear();
    expect(agentTraceList()).toHaveLength(0);

    const second = recordStreamDelta({ scope: "pi", segmentType: "text", delta: "新", runId: "run-1", agent: "pi" });
    const events = agentTraceList();
    expect(events).toHaveLength(1);
    expect(second.id).not.toBe(first.id); // 新段、新 id,非复活旧段
    expect(textContent(events[0]!)).toBe("新"); // 不从清空前的「旧」继续累积
  });
});

describe("registerAgentTraceHandlers", () => {
  it("dev 环境注册 list/clear/subscribe IPC", async () => {
    registerAgentTraceHandlers({ devMode: true });

    expect(mocks.handlers.has("agent-trace:list")).toBe(true);
    expect(mocks.handlers.has("agent-trace:clear")).toBe(true);
    expect(mocks.onMock).toHaveBeenCalledWith("agent-trace:subscribe", expect.any(Function));

    recordAgentTrace({ scope: "cli", phase: "start", summary: "start" });
    const list = (await mocks.handlers.get("agent-trace:list")?.({})) as unknown[];
    expect(list).toHaveLength(1);
  });

  it("非 dev 环境拒绝 trace 访问", async () => {
    registerAgentTraceHandlers({ devMode: false });

    await expect(mocks.handlers.get("agent-trace:list")?.({})).rejects.toThrow("Agent trace 仅在开发环境可用");
    await expect(mocks.handlers.get("agent-trace:clear")?.({})).rejects.toThrow("Agent trace 仅在开发环境可用");
  });
});
