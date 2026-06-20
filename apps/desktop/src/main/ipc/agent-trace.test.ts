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
