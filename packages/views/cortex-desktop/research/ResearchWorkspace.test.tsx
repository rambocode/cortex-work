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
    runCalls: [] as string[],
    deleted: [] as string[],
    listeners: [] as Array<(e: ResearchEvent) => void>,
  };
  const bridge: ResearchBridgeLike = {
    async create(request) {
      return makeSummary({ sessionId: "new-1", objective: request.objective });
    },
    async rerun(): Promise<never> {
      throw new Error("本用例不该重跑");
    },
    async run(sessionId) {
      state.runCalls.push(sessionId);
    },
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

  // 这是「点了开始却毫无反应」的根因所在：会话必须**先进列表再启动**。
  // 反过来的话，编排在会话入列表之前就开始发事件，而 ui-store 会把不在列表里的会话的事件
  // 全部丢弃——用户看到的就是一个几分钟不动的界面。
  it("新建：先把会话放进列表并选中，再发起 run", async () => {
    const { bridge, state } = makeBridge();
    render(<ResearchWorkspace bridge={bridge} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "新建研究" }));
    fireEvent.change(screen.getByLabelText("研究目标"), { target: { value: "调查 B" } });
    fireEvent.click(screen.getByRole("button", { name: "开始研究" }));

    // 运行视图（而不是表单）已经在中栏，且列表里有这个会话。
    await waitFor(() => expect(screen.queryByLabelText("研究目标")).toBeNull());
    expect(useResearchUiStore.getState().sessions.map((s) => s.sessionId)).toEqual(["new-1"]);
    await waitFor(() => expect(state.runCalls).toEqual(["new-1"]));
  });

  it("启动失败时把原因显示在会话视图上（表单此时已卸载）", async () => {
    const { bridge } = makeBridge();
    const failing: ResearchBridgeLike = {
      ...bridge,
      async run() {
        throw new Error("尚未配置研究搜索服务");
      },
    };
    render(<ResearchWorkspace bridge={failing} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "新建研究" }));
    fireEvent.change(screen.getByLabelText("研究目标"), { target: { value: "调查 B" } });
    fireEvent.click(screen.getByRole("button", { name: "开始研究" }));

    expect(await screen.findByText("启动失败：尚未配置研究搜索服务")).toBeTruthy();
  });

  // 详情（真实计划 / 轮次 / 报告）只存在于 main，事件里不带。不随事件重新拉一次的话，
  // 用户会一直看着 create 时落的那份种子计划，报告永远不出现。
  it("轮次与结束事件会重新拉一次 full 详情", async () => {
    const { bridge, state, emit } = makeBridge([makeSummary({ sessionId: "s1", objective: "调查 A" })]);
    render(<ResearchWorkspace bridge={bridge} onClose={() => {}} />);
    fireEvent.click(await screen.findByText("调查 A"));
    await waitFor(() => expect(state.getCalls).toHaveLength(1));

    emit({ type: "round", sessionId: "s1", roundIndex: 0 });
    await waitFor(() => expect(state.getCalls).toHaveLength(2), { timeout: 3000 });

    emit({ type: "done", sessionId: "s1", status: "completed" });
    await waitFor(() => expect(state.getCalls).toHaveLength(3), { timeout: 3000 });
    // 始终只拉 full：证据正文只由右栏在用户展开时拉。
    expect(state.getCalls.every(([, detail]) => detail === "full")).toBe(true);
  });

  it("同一批连续事件只触发一次重新拉取（防抖，别把 SQLite 打穿）", async () => {
    const { bridge, state, emit } = makeBridge([makeSummary({ sessionId: "s1", objective: "调查 A" })]);
    render(<ResearchWorkspace bridge={bridge} onClose={() => {}} />);
    fireEvent.click(await screen.findByText("调查 A"));
    await waitFor(() => expect(state.getCalls).toHaveLength(1));

    for (let i = 0; i < 5; i += 1) emit({ type: "round", sessionId: "s1", roundIndex: i });
    await waitFor(() => expect(state.getCalls).toHaveLength(2), { timeout: 3000 });
    expect(state.getCalls).toHaveLength(2);
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
