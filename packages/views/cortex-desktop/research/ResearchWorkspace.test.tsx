import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useResearchUiStore } from "@cortex-work/core/research/ui-store";
import type {
  ResearchDetailLevel,
  ResearchEvent,
  ResearchSessionSummary,
} from "@cortex-work/core/research/types";
import type { ResearchBridgeLike } from "./bridge-like";
import { ResearchWorkspace } from "./ResearchWorkspace";
import { makeFullView, makeSummary } from "./testFixtures";

beforeEach(() => useResearchUiStore.getState().reset());
afterEach(() => cleanup());

/// 手写 bridge 替身：可控的 list 结果 + 记录订阅/退订次数 + 暴露 emit 手动推事件。
function makeBridge(sessions: ResearchSessionSummary[] = []) {
  const state = {
    listCalls: 0,
    unsubscribeCalls: 0,
    getCalls: [] as Array<[string, ResearchDetailLevel]>,
    deleted: [] as string[],
    listeners: [] as Array<(e: ResearchEvent) => void>,
  };
  const bridge: ResearchBridgeLike = {
    async create() {
      throw new Error("不应被调用");
    },
    async rerun(): Promise<never> {
      throw new Error("本用例不该重跑");
    },
    async run() {},
    async pause() {},
    async resume() {},
    async cancel() {},
    async get(sessionId, detail) {
      state.getCalls.push([sessionId, detail]);
      return makeFullView({ summary: makeSummary({ sessionId }) });
    },
    async list() {
      state.listCalls += 1;
      return sessions;
    },
    async delete(sessionId) {
      state.deleted.push(sessionId);
    },
    onEvent(listener) {
      state.listeners.push(listener);
      return () => {
        state.unsubscribeCalls += 1;
      };
    },
  };
  const emit = (event: ResearchEvent) => state.listeners.forEach((l) => l(event));
  return { bridge, state, emit };
}

describe("ResearchWorkspace 降级", () => {
  it("bridge 为 null 时渲染降级提示而不是崩溃，关闭按钮仍可用", () => {
    let closed = 0;
    render(<ResearchWorkspace bridge={null} onClose={() => (closed += 1)} />);
    expect(screen.getByText("深度研究只在桌面端可用")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(closed).toBe(1);
  });
});

describe("ResearchWorkspace 生命周期", () => {
  it("挂载时拉列表并渲染，卸载时调用 onEvent 返回的退订函数", async () => {
    const { bridge, state } = makeBridge([makeSummary({ sessionId: "s1", objective: "调查 A" })]);
    const { unmount } = render(<ResearchWorkspace bridge={bridge} onClose={() => {}} />);
    await waitFor(() => expect(state.listCalls).toBe(1));
    expect(await screen.findByText("调查 A")).toBeTruthy();
    expect(state.unsubscribeCalls).toBe(0);

    unmount();
    expect(state.unsubscribeCalls).toBe(1);
  });

  it("订阅到的事件经 ui-store 落到界面（stage 事件更新状态徽标）", async () => {
    const { bridge, emit } = makeBridge([makeSummary({ sessionId: "s1", status: "created" })]);
    render(<ResearchWorkspace bridge={bridge} onClose={() => {}} />);
    await screen.findByText("待开始");
    emit({ type: "stage", sessionId: "s1", stage: "searching" });
    expect(await screen.findByText("检索中")).toBeTruthy();
  });

  it("list 失败时展示错误而不是空白", async () => {
    const { bridge } = makeBridge();
    const failing: ResearchBridgeLike = {
      ...bridge,
      async list() {
        throw new Error("主进程未就绪");
      },
    };
    render(<ResearchWorkspace bridge={failing} onClose={() => {}} />);
    expect(await screen.findByText("加载研究列表失败：主进程未就绪")).toBeTruthy();
  });

  it("选中会话拉 full 详情（不是 evidence——证据由右栏按需加载）", async () => {
    const { bridge, state } = makeBridge([makeSummary({ sessionId: "s1", objective: "调查 A" })]);
    render(<ResearchWorkspace bridge={bridge} onClose={() => {}} />);
    fireEvent.click(await screen.findByText("调查 A"));
    await waitFor(() => expect(state.getCalls).toEqual([["s1", "full"]]));
    expect(state.getCalls.some(([, detail]) => detail === "evidence")).toBe(false);
  });

  it("删除会话：调 bridge.delete 并从列表移除", async () => {
    const { bridge, state } = makeBridge([makeSummary({ sessionId: "s1", objective: "调查 A" })]);
    render(<ResearchWorkspace bridge={bridge} onClose={() => {}} />);
    await screen.findByText("调查 A");
    fireEvent.click(screen.getByRole("button", { name: "删除研究" }));
    await waitFor(() => expect(state.deleted).toEqual(["s1"]));
    await waitFor(() => expect(screen.queryByText("调查 A")).toBeNull());
  });

  it("点新建切到创建表单，取消后回到运行视图", async () => {
    const { bridge } = makeBridge();
    render(<ResearchWorkspace bridge={bridge} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "新建研究" }));
    expect(screen.getByLabelText("研究目标")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消新建" }));
    expect(screen.queryByLabelText("研究目标")).toBeNull();
  });
});
