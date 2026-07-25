// ui-store 的行为契约测试：重点是 applyEvent 的每个分支（尤其 error 的 terminal 两态）。
import { beforeEach, describe, expect, it } from "vitest";
import { useResearchUiStore } from "./ui-store";
import type { ResearchSessionSummary, ResearchSessionView } from "./types";

function summary(patch: Partial<ResearchSessionSummary> = {}): ResearchSessionSummary {
  return {
    sessionId: "s1",
    consumer: "deep_research",
    objective: "调查 X",
    mode: "standard",
    status: "created",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    roundCount: 0,
    documentCount: 0,
    chunkCount: 0,
    ...patch,
  };
}

beforeEach(() => {
  useResearchUiStore.getState().reset();
});

describe("useResearchUiStore 基础动作", () => {
  it("setSessions 覆盖列表，并丢弃已不存在会话的 detail/警告缓存", () => {
    const st = useResearchUiStore.getState();
    st.setSessions([summary(), summary({ sessionId: "s2" })]);
    st.setDetail("s2", { summary: summary({ sessionId: "s2" }) } as ResearchSessionView);
    st.applyEvent({
      type: "error",
      sessionId: "s2",
      code: "fetch_failed",
      message: "抓取失败",
      terminal: false,
    });
    expect(useResearchUiStore.getState().detailCache.s2).toBeTruthy();

    useResearchUiStore.getState().setSessions([summary()]);
    const next = useResearchUiStore.getState();
    expect(next.sessions.map((s) => s.sessionId)).toEqual(["s1"]);
    expect(next.detailCache.s2).toBeUndefined();
    expect(next.warnings.s2).toBeUndefined();
  });

  it("selectSession 设置/清空当前会话", () => {
    useResearchUiStore.getState().selectSession("s1");
    expect(useResearchUiStore.getState().activeSessionId).toBe("s1");
    useResearchUiStore.getState().selectSession(null);
    expect(useResearchUiStore.getState().activeSessionId).toBeNull();
  });

  it("upsertSession 已存在则就地替换（保持顺序），不存在则插到列表头", () => {
    const st = useResearchUiStore.getState();
    st.setSessions([summary(), summary({ sessionId: "s2" })]);
    st.upsertSession(summary({ sessionId: "s2", status: "completed" }));
    expect(useResearchUiStore.getState().sessions.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
    expect(useResearchUiStore.getState().sessions[1]?.status).toBe("completed");

    useResearchUiStore.getState().upsertSession(summary({ sessionId: "s3" }));
    expect(useResearchUiStore.getState().sessions.map((s) => s.sessionId)).toEqual([
      "s3",
      "s1",
      "s2",
    ]);
  });

  it("removeSession 同时清理 detail/警告/进度，并在删掉当前会话时清空选中", () => {
    const st = useResearchUiStore.getState();
    st.setSessions([summary(), summary({ sessionId: "s2" })]);
    st.selectSession("s1");
    st.setDetail("s1", { summary: summary() } as ResearchSessionView);
    st.applyEvent({ type: "stage", sessionId: "s1", stage: "searching" });

    useResearchUiStore.getState().removeSession("s1");
    const next = useResearchUiStore.getState();
    expect(next.sessions.map((s) => s.sessionId)).toEqual(["s2"]);
    expect(next.detailCache.s1).toBeUndefined();
    expect(next.progress.s1).toBeUndefined();
    expect(next.activeSessionId).toBeNull();
  });

  it("setDetail 同时把 view.summary 回填到列表（保证列表与详情不漂移）", () => {
    const st = useResearchUiStore.getState();
    st.setSessions([summary()]);
    st.setDetail("s1", { summary: summary({ status: "completed", documentCount: 7 }) });
    const next = useResearchUiStore.getState();
    expect(next.detailCache.s1?.summary.documentCount).toBe(7);
    expect(next.sessions[0]?.status).toBe("completed");
  });

  it("setLoading / setError 独立可写", () => {
    useResearchUiStore.getState().setLoading(true);
    expect(useResearchUiStore.getState().loading).toBe(true);
    useResearchUiStore.getState().setError("列表加载失败");
    expect(useResearchUiStore.getState().error).toBe("列表加载失败");
    useResearchUiStore.getState().setError(null);
    expect(useResearchUiStore.getState().error).toBeNull();
  });
});

describe("applyEvent", () => {
  beforeEach(() => {
    useResearchUiStore.getState().setSessions([summary()]);
  });

  it("stage：落进度并把 status 推进到该阶段", () => {
    useResearchUiStore.getState().applyEvent({
      type: "stage",
      sessionId: "s1",
      stage: "fetching",
      progress: { completed: 3, total: 10 },
    });
    const next = useResearchUiStore.getState();
    expect(next.sessions[0]?.status).toBe("fetching");
    expect(next.progress.s1).toEqual({ stage: "fetching", completed: 3, total: 10 });
  });

  it("stage：已是终态的会话不会被乱序事件拉回运行中", () => {
    useResearchUiStore.getState().upsertSession(summary({ status: "completed" }));
    useResearchUiStore.getState().applyEvent({ type: "stage", sessionId: "s1", stage: "searching" });
    expect(useResearchUiStore.getState().sessions[0]?.status).toBe("completed");
  });

  it("round：roundCount 取 roundIndex+1 的最大值，并记录本轮决策", () => {
    const st = useResearchUiStore.getState();
    st.applyEvent({ type: "round", sessionId: "s1", roundIndex: 2, decision: "search_more" });
    expect(useResearchUiStore.getState().sessions[0]?.roundCount).toBe(3);
    expect(useResearchUiStore.getState().lastDecision.s1).toBe("search_more");
    // 乱序的旧轮次事件不得把计数改小。
    useResearchUiStore.getState().applyEvent({ type: "round", sessionId: "s1", roundIndex: 0 });
    expect(useResearchUiStore.getState().sessions[0]?.roundCount).toBe(3);
  });

  it("error + terminal:false：只追加警告，status 与 errorMessage 都不变", () => {
    useResearchUiStore.getState().applyEvent({ type: "stage", sessionId: "s1", stage: "fetching" });
    useResearchUiStore.getState().applyEvent({
      type: "error",
      sessionId: "s1",
      code: "http_error",
      message: "example.com 返回 503",
      terminal: false,
    });
    const next = useResearchUiStore.getState();
    expect(next.sessions[0]?.status).toBe("fetching");
    expect(next.sessions[0]?.errorMessage).toBeUndefined();
    expect(next.warnings.s1).toEqual([{ code: "http_error", message: "example.com 返回 503" }]);
  });

  it("error + terminal:true：置为 failed 并带上可展示错误", () => {
    useResearchUiStore.getState().applyEvent({
      type: "error",
      sessionId: "s1",
      code: "local_model_unavailable",
      message: "没有可用的本地模型",
      terminal: true,
    });
    const next = useResearchUiStore.getState();
    expect(next.sessions[0]?.status).toBe("failed");
    expect(next.sessions[0]?.errorMessage).toBe("没有可用的本地模型");
    // 终态错误不再进警告列表（它已经在 status 上表达）。
    expect(next.warnings.s1).toBeUndefined();
  });

  it("done：落终态状态并清掉进度", () => {
    useResearchUiStore.getState().applyEvent({ type: "stage", sessionId: "s1", stage: "reporting" });
    useResearchUiStore
      .getState()
      .applyEvent({ type: "done", sessionId: "s1", status: "completed" });
    const next = useResearchUiStore.getState();
    expect(next.sessions[0]?.status).toBe("completed");
    expect(next.progress.s1).toBeUndefined();
  });

  it("未知 sessionId 的事件一律忽略，不凭空造出会话", () => {
    const before = useResearchUiStore.getState().sessions;
    useResearchUiStore.getState().applyEvent({ type: "stage", sessionId: "ghost", stage: "planning" });
    useResearchUiStore.getState().applyEvent({ type: "done", sessionId: "ghost", status: "failed" });
    useResearchUiStore.getState().applyEvent({
      type: "error",
      sessionId: "ghost",
      code: "x",
      message: "y",
      terminal: false,
    });
    const next = useResearchUiStore.getState();
    expect(next.sessions).toEqual(before);
    expect(next.progress.ghost).toBeUndefined();
    expect(next.warnings.ghost).toBeUndefined();
  });

  it("警告列表按会话保留上限，避免长跑会话把内存吃满", () => {
    for (let i = 0; i < 60; i += 1) {
      useResearchUiStore.getState().applyEvent({
        type: "error",
        sessionId: "s1",
        code: "timeout",
        message: `第 ${i} 次超时`,
        terminal: false,
      });
    }
    const list = useResearchUiStore.getState().warnings.s1 ?? [];
    expect(list.length).toBe(50);
    // 保留的是最近的 50 条。
    expect(list[list.length - 1]?.message).toBe("第 59 次超时");
  });
});
