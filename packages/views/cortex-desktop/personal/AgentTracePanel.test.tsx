import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTraceEvent, DesktopBridge } from "@cortex-work/core";
import { AgentTracePanel } from "./AgentTracePanel";

afterEach(() => cleanup());

function trace(over: Partial<AgentTraceEvent>): AgentTraceEvent {
  return {
    id: "trace-1",
    ts: 1,
    scope: "cli",
    phase: "start",
    summary: "pi start",
    ...over,
  };
}

describe("AgentTracePanel", () => {
  it("加载历史 trace,实时追加事件,并支持暂停和清空", async () => {
    const listeners: Array<(event: AgentTraceEvent) => void> = [];
    const agentTraceClear = vi.fn(async () => undefined);
    const bridge = {
      agentTraceList: vi.fn(async () => [trace({ id: "trace-1", summary: "history event" })]),
      agentTraceClear,
      onAgentTrace: vi.fn((cb: (event: AgentTraceEvent) => void) => {
        listeners[0] = cb;
        return () => {
          listeners.length = 0;
        };
      }),
    } as unknown as DesktopBridge;

    render(<AgentTracePanel bridge={bridge} />);

    expect(await screen.findByText("history event")).toBeTruthy();
    listeners[0]?.(trace({ id: "trace-2", phase: "event", summary: "live event" }));
    expect(await screen.findByText("live event")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    listeners[0]?.(trace({ id: "trace-3", phase: "event", summary: "paused event" }));
    expect(screen.queryByText("paused event")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    await waitFor(() => expect(agentTraceClear).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("history event")).toBeNull();
    expect(screen.queryByText("live event")).toBeNull();
  });

  it("以实时 console log 形式展示彩色标签,点击日志行展开 data", async () => {
    const bridge = {
      agentTraceList: vi.fn(async () => [
        trace({
          id: "trace-console",
          ts: 1,
          scope: "pi-rpc",
          phase: "error",
          summary: "tool failed",
          runId: "run-1",
          sessionId: "session-1",
          agent: "pi",
          data: { cwd: "/proj", reason: "boom" },
        }),
      ]),
      onAgentTrace: vi.fn(() => () => undefined),
    } as unknown as DesktopBridge;

    render(<AgentTracePanel bridge={bridge} />);

    const row = await screen.findByRole("listitem", { name: /tool failed/ });
    expect(row.className).toContain("pw-trace-line");
    expect(row.textContent).toContain("[PI-RPC]");
    expect(row.textContent).toContain("[ERROR]");
    expect(row.textContent).toContain("run=run-1");
    expect(row.textContent).toContain("session=session-1");
    expect(row.querySelector('[data-scope="pi-rpc"]')).toBeTruthy();
    expect(row.querySelector('[data-phase="error"]')).toBeTruthy();
    expect(screen.queryByText(/"reason": "boom"/)).toBeNull();

    fireEvent.click(row);

    expect(await screen.findByText(/"reason": "boom"/)).toBeTruthy();
  });
});
