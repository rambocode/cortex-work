import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { useResearchUiStore } from "@cortex-work/core/research/ui-store";
import type { ResearchDetailLevel, ResearchEvent } from "@cortex-work/core/research/types";

import type { ResearchBridgeLike } from "./bridge-like";
import { makeFullView, makeReport, makeSummary } from "./testFixtures";
import { useResearchCompletionRelay } from "./useResearchCompletionRelay";

// 记录 appendLocalAgentMessage 的调用；hook 经 usePersonalActions 拿到它。
const appendCalls: Array<[string, string, string]> = [];
vi.mock("@cortex-work/core/personal/messages", () => ({
  usePersonalActions: () => ({
    appendLocalAgentMessage: async (sessionId: string, who: string, text: string) => {
      appendCalls.push([sessionId, who, text]);
    },
  }),
}));

function makeBridge(overrides: Partial<ResearchBridgeLike> = {}) {
  const listeners: Array<(e: ResearchEvent) => void> = [];
  const getCalls: Array<[string, ResearchDetailLevel]> = [];
  const bridge = {
    async get(sessionId: string, detail: ResearchDetailLevel) {
      getCalls.push([sessionId, detail]);
      return makeFullView({
        summary: makeSummary({ sessionId, objective: "调研备案要求", status: "completed", roundCount: 2, documentCount: 7 }),
        report: makeReport({ markdown: "# 报告", archivedPath: "/proj/research/调研备案要求.md" }),
      });
    },
    onEvent(listener: (e: ResearchEvent) => void) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    ...overrides,
  } as unknown as ResearchBridgeLike;
  return { bridge, listeners, getCalls, emit: (e: ResearchEvent) => listeners.slice().forEach((l) => l(e)) };
}

/// 造一个绑定了研究 r1 的聊天会话。
function seedBoundSession(): void {
  usePersonalStore.setState({
    sessions: [
      {
        id: "chat-1",
        title: "会话",
        agent: "claude",
        createdAt: 1,
        updatedAt: 1,
        researchSessions: [{ sessionId: "r1", objective: "调研备案要求", createdAt: 1 }],
        activeResearchSessionId: "r1",
      },
    ],
  });
}

beforeEach(() => {
  appendCalls.length = 0;
  useResearchUiStore.getState().reset();
  usePersonalStore.setState({ sessions: [] });
});
afterEach(() => cleanup());

describe("useResearchCompletionRelay", () => {
  it("done 事件命中绑定会话时，把状态/统计/报告路径写回该会话", async () => {
    seedBoundSession();
    const { bridge, emit, getCalls } = makeBridge();
    renderHook(() => useResearchCompletionRelay(bridge));

    emit({ type: "done", sessionId: "r1", status: "completed" });

    await waitFor(() => expect(appendCalls).toHaveLength(1));
    const [sessionId, who, text] = appendCalls[0]!;
    expect(sessionId).toBe("chat-1");
    // 非 "me" 才会渲染成 agent 侧气泡。
    expect(who).not.toBe("me");
    expect(text).toContain("深度研究已完成");
    expect(text).toContain("/proj/research/调研备案要求.md");
    expect(text).toContain("2 轮检索");
    // 只拉 full,绝不碰几 MB 的 evidence。
    expect(getCalls).toEqual([["r1", "full"]]);
  });

  it("研究未绑定任何会话时不写（agent 经 MCP 自主发起的研究不该冒出回执）", async () => {
    usePersonalStore.setState({ sessions: [] });
    const { bridge, emit } = makeBridge();
    renderHook(() => useResearchCompletionRelay(bridge));

    emit({ type: "done", sessionId: "r-unbound", status: "completed" });

    await new Promise((r) => setTimeout(r, 0));
    expect(appendCalls).toHaveLength(0);
  });

  it("done 重复到达只写一次（重连可能重推事件）", async () => {
    seedBoundSession();
    const { bridge, emit } = makeBridge();
    renderHook(() => useResearchCompletionRelay(bridge));

    emit({ type: "done", sessionId: "r1", status: "completed" });
    emit({ type: "done", sessionId: "r1", status: "completed" });

    await waitFor(() => expect(appendCalls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(appendCalls).toHaveLength(1);
  });

  it("非 done 事件一律忽略，且绝不调 applyEvent（那是 live-sync 的独占职责）", async () => {
    seedBoundSession();
    const applySpy = vi.spyOn(useResearchUiStore.getState(), "applyEvent");
    const { bridge, emit } = makeBridge();
    renderHook(() => useResearchCompletionRelay(bridge));

    emit({ type: "report_delta", sessionId: "r1", delta: "正文" });
    emit({ type: "status", sessionId: "r1", status: "searching" });

    await new Promise((r) => setTimeout(r, 0));
    expect(appendCalls).toHaveLength(0);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("详情拉取失败时退化成只报状态，而不是完全不写", async () => {
    seedBoundSession();
    const { bridge, emit } = makeBridge({
      async get(): Promise<never> {
        throw new Error("会话已删");
      },
    });
    renderHook(() => useResearchCompletionRelay(bridge));

    emit({ type: "done", sessionId: "r1", status: "failed" });

    await waitFor(() => expect(appendCalls).toHaveLength(1));
    expect(appendCalls[0]![2]).toContain("深度研究失败");
    expect(appendCalls[0]![2]).toContain("调研备案要求");
  });

  it("卸载时退订（研究跑几分钟,泄漏订阅会让回执重复写）", () => {
    const { bridge, listeners } = makeBridge();
    const { unmount } = renderHook(() => useResearchCompletionRelay(bridge));
    expect(listeners).toHaveLength(1);
    unmount();
    expect(listeners).toHaveLength(0);
  });

  it("无桥（Web 端）时零订阅、零写入", async () => {
    seedBoundSession();
    const { result } = renderHook(() => useResearchCompletionRelay(null));
    expect(result.current).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(appendCalls).toHaveLength(0);
  });
});
