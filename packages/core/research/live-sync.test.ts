// @vitest-environment jsdom
// useResearchLiveSync 的挂载 / 扇出 / 退订测试。
//
// 需要 DOM（renderHook），而 core 的 vitest 默认跑在 node 环境，故文件头单独声明。
// 这里的断言不只是「hook 能跑」，还钉死两条正确性硬约束：
//   1. onEvent 订阅必须先于 list() 发起——反过来会漏掉这段窗口期内到达的事件；
//   2. 每个事件对两个 store 各扇出恰好一次——applyEvent 的 report_delta 是增量拼接、
//      activity 是环形追加，都非幂等，调两次报告会翻倍。
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useResearchBackgroundStore } from "./background-watch";
import { useResearchLiveSync } from "./live-sync";
import { useResearchUiStore } from "./ui-store";
import type { ResearchEvent, ResearchSessionSummary } from "./types";

/// 两个 store 的真实 action，测试用替身覆盖后由 afterEach 还原
/// （zustand 的 action 不在 reset() 覆盖范围内，不还原会污染后续用例）。
const realUi = {
  setSessions: useResearchUiStore.getState().setSessions,
  applyEvent: useResearchUiStore.getState().applyEvent,
};
const realBackground = {
  seed: useResearchBackgroundStore.getState().seed,
  apply: useResearchBackgroundStore.getState().apply,
};

afterEach(() => {
  useResearchUiStore.setState({ ...realUi });
  useResearchBackgroundStore.setState({ ...realBackground });
  useResearchUiStore.getState().reset();
  useResearchBackgroundStore.getState().reset();
});

/// 用替身接管两个 store 的写入口，返回 spy 供计数断言。
function stubStores() {
  const setSessions = vi.fn();
  const applyEvent = vi.fn();
  const seed = vi.fn();
  const apply = vi.fn();
  useResearchUiStore.setState({ setSessions, applyEvent });
  useResearchBackgroundStore.setState({ seed, apply });
  return { setSessions, applyEvent, seed, apply };
}

/// 手写桥替身：记录调用顺序、暴露 emit 手动推事件。
function makeBridge(sessions: ResearchSessionSummary[] = []) {
  const calls: string[] = [];
  const listeners: Array<(event: ResearchEvent) => void> = [];
  const off = vi.fn();
  const bridge = {
    async list() {
      calls.push("list");
      return sessions;
    },
    onEvent(listener: (event: ResearchEvent) => void) {
      calls.push("onEvent");
      listeners.push(listener);
      // 退订真的把监听器摘掉（与真实桥同语义），这样「卸载后事件不再落 store」
      // 断言的就是实现有没有调 off，而不是替身自己装的样子。
      return () => {
        off();
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
  const emit = (event: ResearchEvent) => listeners.forEach((l) => l(event));
  return { bridge, calls, emit, off };
}

const SUMMARY: ResearchSessionSummary = {
  sessionId: "s1",
  consumer: "deep_research",
  objective: "调查 A",
  mode: "deep",
  status: "searching",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
  roundCount: 0,
  documentCount: 0,
  chunkCount: 0,
};

describe("useResearchLiveSync 门控", () => {
  it("未启用时不订阅也不 list（大多数用户没开这个功能，不该为此多打一次 IPC）", () => {
    const { bridge, calls } = makeBridge();
    renderHook(() => useResearchLiveSync(bridge, false));
    expect(calls).toEqual([]);
  });

  it("无桥（Web 端 / 旧壳）时同样不订阅", () => {
    expect(() => renderHook(() => useResearchLiveSync(null, true))).not.toThrow();
  });
});

describe("useResearchLiveSync 生命周期", () => {
  it("订阅先于 list 发起（否则漏掉窗口期内到达的事件）", () => {
    const { bridge, calls } = makeBridge();
    renderHook(() => useResearchLiveSync(bridge, true));
    expect(calls).toEqual(["onEvent", "list"]);
  });

  it("list 结果同时灌入 ui-store 与后台观察 store", async () => {
    const { setSessions, seed } = stubStores();
    const { bridge } = makeBridge([SUMMARY]);
    renderHook(() => useResearchLiveSync(bridge, true));

    await vi.waitFor(() => expect(setSessions).toHaveBeenCalledTimes(1));
    expect(setSessions).toHaveBeenCalledWith([SUMMARY]);
    expect(seed).toHaveBeenCalledWith([SUMMARY]);
  });

  it("每个事件对两个 store 各扇出恰好一次（applyEvent 非幂等，多调一次报告就翻倍）", () => {
    const { applyEvent, apply } = stubStores();
    const { bridge, emit } = makeBridge();
    renderHook(() => useResearchLiveSync(bridge, true));

    const event: ResearchEvent = { type: "report_delta", sessionId: "s1", delta: "半句" };
    emit(event);
    expect(applyEvent).toHaveBeenCalledTimes(1);
    expect(applyEvent).toHaveBeenCalledWith(event);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(event);
  });

  it("连续事件逐条扇出，不吞不重（增量拼接依赖每条都恰好落一次）", () => {
    const { applyEvent } = stubStores();
    const { bridge, emit } = makeBridge();
    renderHook(() => useResearchLiveSync(bridge, true));

    emit({ type: "report_delta", sessionId: "s1", delta: "一" });
    emit({ type: "report_delta", sessionId: "s1", delta: "二" });
    emit({ type: "report_delta", sessionId: "s1", delta: "三" });
    expect(applyEvent).toHaveBeenCalledTimes(3);
  });

  it("卸载时调用 onEvent 返回的退订函数（否则重挂载会累积监听器）", () => {
    const { bridge, off } = makeBridge();
    const { unmount } = renderHook(() => useResearchLiveSync(bridge, true));
    expect(off).not.toHaveBeenCalled();
    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("卸载后到达的事件不再写 store（退订后仍被调到说明泄漏）", () => {
    const { applyEvent } = stubStores();
    const { bridge, emit } = makeBridge();
    const { unmount } = renderHook(() => useResearchLiveSync(bridge, true));
    unmount();
    emit({ type: "report_delta", sessionId: "s1", delta: "迟到" });
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it("list 失败：展示错误但订阅照常存活（后续事件仍能补上状态）", async () => {
    const { applyEvent } = stubStores();
    const { bridge, emit, calls } = makeBridge();
    const failing = {
      ...bridge,
      async list(): Promise<ResearchSessionSummary[]> {
        calls.push("list");
        throw new Error("主进程未就绪");
      },
    };
    renderHook(() => useResearchLiveSync(failing, true));

    await vi.waitFor(() =>
      expect(useResearchUiStore.getState().error).toBe("加载研究列表失败：主进程未就绪"),
    );
    expect(useResearchUiStore.getState().loading).toBe(false);
    emit({ type: "report_delta", sessionId: "s1", delta: "还能收到" });
    expect(applyEvent).toHaveBeenCalledTimes(1);
  });
});
