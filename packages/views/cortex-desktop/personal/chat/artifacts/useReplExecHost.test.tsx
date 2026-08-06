// REPL 执行宿主测试:formatReplOutput 各分支 + hook 的订阅/分流/并发排队/卸载中止。
// 真 iframe 执行 jsdom 测不了,executor 用 stub 注入。

import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopBridge, PiUiRequest } from "@cortex-work/core";

import { formatReplOutput } from "./replRuntime";
import { REPL_MAX_CONCURRENT, useReplExecHost, type ReplExecutor } from "./useReplExecHost";

describe("formatReplOutput", () => {
  it("console 行 + 返回值 + 错误栈的组合格式;空输出给占位", () => {
    expect(
      formatReplOutput(
        [
          { level: "log", text: "步骤1" },
          { level: "warn", text: "留神" },
          { level: "error", text: "坏了" },
        ],
        '"结果"',
        undefined,
      ),
    ).toBe('步骤1\n[warn] 留神\n[error] 坏了\n=> "结果"');
    expect(formatReplOutput([], undefined, { message: "boom", stack: "at x" })).toBe("boom\nat x");
    expect(formatReplOutput([], undefined, undefined)).toBe("(无输出)");
  });
});

// 假 bridge:捕获订阅回调与回写。
function makeBridge() {
  let handler: ((uiSessionId: string, request: PiUiRequest) => void) | undefined;
  const responses: Array<{ uiSessionId: string; id: string; payload: unknown }> = [];
  const off = vi.fn();
  const bridge = {
    onPiUiRequest: (cb: (uiSessionId: string, request: PiUiRequest) => void) => {
      handler = cb;
      return off;
    },
    piUiResponse: (uiSessionId: string, id: string, payload: unknown) => {
      responses.push({ uiSessionId, id, payload });
      return Promise.resolve();
    },
  } as unknown as DesktopBridge;
  const emit = (id: string, code: string): void =>
    handler?.("s1", { type: "extension_ui_request", id, method: "jsrepl", envelope: { title: "t", code } });
  const emitConfirm = (id: string): void =>
    handler?.("s1", { type: "extension_ui_request", id, method: "confirm", title: "t", message: "m" });
  return { bridge, responses, emit, emitConfirm, off };
}

// 可手动结算的 stub executor。
function makeExecutor() {
  const running = new Map<string, (r: { ok: boolean; output: string }) => void>();
  const aborted: string[] = [];
  const executor: ReplExecutor = (_code, execId) => {
    let settle!: (r: { ok: boolean; output: string }) => void;
    const promise = new Promise<{ ok: boolean; output: string }>((resolve) => {
      settle = resolve;
    });
    running.set(execId, settle);
    return {
      promise,
      abort: () => {
        aborted.push(execId);
        settle({ ok: false, output: "执行已中止" });
      },
    };
  };
  return { executor, running, aborted };
}

describe("useReplExecHost", () => {
  it("只消费 jsrepl;完成后经 piUiResponse 回写 JSON({ok, output})", async () => {
    const { bridge, responses, emit, emitConfirm } = makeBridge();
    const { executor, running } = makeExecutor();
    renderHook(() => useReplExecHost(bridge, executor));
    act(() => {
      emitConfirm("c1"); // confirm 不归本宿主管
      emit("e1", "1+1");
    });
    expect(running.size).toBe(1);
    await act(async () => running.get("e1")!({ ok: true, output: "2" }));
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ uiSessionId: "s1", id: "e1" });
    expect(JSON.parse((responses[0]!.payload as { value: string }).value)).toEqual({ ok: true, output: "2" });
  });

  it("并发上限排队:第 N+1 个等前面结算后才开跑", async () => {
    const { bridge, emit } = makeBridge();
    const { executor, running } = makeExecutor();
    renderHook(() => useReplExecHost(bridge, executor));
    act(() => {
      for (let i = 0; i < REPL_MAX_CONCURRENT + 1; i++) emit(`e${i}`, "x");
    });
    expect(running.size).toBe(REPL_MAX_CONCURRENT); // 超出的在队列里
    await act(async () => running.get("e0")!({ ok: true, output: "" }));
    expect(running.has(`e${REPL_MAX_CONCURRENT}`)).toBe(true); // 让位后补队
  });

  it("卸载:在途 abort、排队项回写「宿主已卸载」,pi 侧不用干等超时", async () => {
    const { bridge, responses, emit, off } = makeBridge();
    const { executor, aborted } = makeExecutor();
    const { unmount } = renderHook(() => useReplExecHost(bridge, executor));
    act(() => {
      for (let i = 0; i < REPL_MAX_CONCURRENT + 2; i++) emit(`e${i}`, "x");
    });
    unmount();
    await act(async () => {});
    expect(off).toHaveBeenCalled();
    expect(aborted).toHaveLength(REPL_MAX_CONCURRENT);
    // 全部请求(在途中止 + 排队卸载)都有回写,无一悬挂。
    expect(responses).toHaveLength(REPL_MAX_CONCURRENT + 2);
  });
});
