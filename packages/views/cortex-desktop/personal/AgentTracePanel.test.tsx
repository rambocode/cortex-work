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

  it("同 id 段事件原地更新为一行、内容实时生长(R4)", async () => {
    const listeners: Array<(event: AgentTraceEvent) => void> = [];
    const bridge = {
      agentTraceList: vi.fn(async () => []),
      onAgentTrace: vi.fn((cb: (event: AgentTraceEvent) => void) => {
        listeners[0] = cb;
        return () => undefined;
      }),
    } as unknown as DesktopBridge;

    render(<AgentTracePanel bridge={bridge} />);
    await waitFor(() => expect(bridge.onAgentTrace).toHaveBeenCalled());

    const seg = (over: Partial<AgentTraceEvent>): AgentTraceEvent =>
      trace({ id: "seg-1", scope: "pi", phase: "event", summary: "pi text", segmentType: "text", streaming: true, ...over });

    listeners[0]?.(seg({ ts: 1, deltaCount: 1, data: { text: "你好" } }));
    listeners[0]?.(seg({ ts: 2, deltaCount: 2, data: { text: "你好，世界" } }));

    // 只有一行(同 id upsert,未追加新行)。
    const rows = await screen.findAllByRole("listitem", { name: /pi text/ });
    expect(rows).toHaveLength(1);
    // 展开看到的是最新累积内容。
    fireEvent.click(rows[0]!);
    expect(await screen.findByText(/你好，世界/)).toBeTruthy();
  });

  it("展开后拖拽选择详情(指针移动)不折叠,纯点击仍正常折叠(可复制)", async () => {
    const bridge = {
      agentTraceList: vi.fn(async () => [
        trace({ id: "trace-copy", summary: "copyable", data: { reason: "boom" } }),
      ]),
      onAgentTrace: vi.fn(() => () => undefined),
    } as unknown as DesktopBridge;

    render(<AgentTracePanel bridge={bridge} />);

    const row = await screen.findByRole("listitem", { name: /copyable/ });
    // 纯点击展开。
    fireEvent.click(row);
    expect(await screen.findByText(/"reason": "boom"/)).toBeTruthy();

    // 模拟拖拽选择:按下与抬起坐标差超过阈值 → 视为选择手势,不折叠,详情仍可复制。
    fireEvent.mouseDown(row, { clientX: 10, clientY: 10 });
    fireEvent.click(row, { clientX: 80, clientY: 60 });
    expect(screen.queryByText(/"reason": "boom"/)).toBeTruthy();

    // 同一位置按下并点击(无移动) → 正常折叠。
    fireEvent.mouseDown(row, { clientX: 80, clientY: 60 });
    fireEvent.click(row, { clientX: 80, clientY: 60 });
    expect(screen.queryByText(/"reason": "boom"/)).toBeNull();
  });

  it("reasoning 与 text 段渲染为可区分的独立行(R6)", async () => {
    const bridge = {
      agentTraceList: vi.fn(async () => [
        trace({ id: "seg-r", scope: "pi", phase: "event", summary: "pi reasoning", segmentType: "reasoning", streaming: false, deltaCount: 3 }),
        trace({ id: "seg-t", scope: "pi", phase: "event", summary: "pi text", segmentType: "text", streaming: false, deltaCount: 5 }),
      ]),
      onAgentTrace: vi.fn(() => () => undefined),
    } as unknown as DesktopBridge;

    render(<AgentTracePanel bridge={bridge} />);

    const reasoningRow = await screen.findByRole("listitem", { name: /pi reasoning/ });
    const textRow = await screen.findByRole("listitem", { name: /pi text/ });
    expect(reasoningRow.textContent).toContain("[REASONING]");
    expect(textRow.textContent).toContain("[TEXT]");
    expect(reasoningRow.querySelector('[data-phase="reasoning"]')).toBeTruthy();
    expect(textRow.querySelector('[data-phase="text"]')).toBeTruthy();
  });
});
