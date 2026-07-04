// design: 前缀守卫的回归锁:设计工作台的 CLI 事件绝不能进入个人会话的
// recovered-run 重建路径(messages.ts:handleCliEvent/handleCliExit)。
// 一旦守卫丢失,设计回合会以 sessionIdHint 伪造 runningBySession(phantom run)。
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePersonalStore } from "../store/personal";
import {
  __handleCliEventForTest,
  __handleCliExitForTest,
  __resetPersonalMessageRunsForTest,
} from "./messages";

beforeEach(() => {
  __resetPersonalMessageRunsForTest();
  usePersonalStore.setState({ sessions: [], projects: [], runningBySession: {} });
});

afterEach(() => {
  __resetPersonalMessageRunsForTest();
});

describe("design: runId 前缀守卫", () => {
  it("design 事件带 sessionIdHint 也不重建 recovered run", () => {
    const qc = new QueryClient();
    __handleCliEventForTest(
      qc,
      "design:doc1:r_abc",
      { type: "init", sessionId: "agent-native-session" },
      "design-doc1",
    );
    __handleCliEventForTest(qc, "design:doc1:r_abc", { type: "text", delta: "hello" }, "design-doc1");
    // 守卫生效:个人会话运行态零污染。
    expect(usePersonalStore.getState().runningBySession).toEqual({});
  });

  it("design 退出事件不触发 finalizeRun 的 sessionIdHint 兜底", () => {
    const qc = new QueryClient();
    // 预置一个同名 runningBySession 假想态,验证 exit 守卫不去动它。
    usePersonalStore.setState({ runningBySession: { "design-doc1": "design:doc1:r_abc" } });
    __handleCliExitForTest(qc, "design:doc1:r_abc", 0, undefined, "design-doc1");
    expect(usePersonalStore.getState().runningBySession).toEqual({
      "design-doc1": "design:doc1:r_abc",
    });
  });

  it("普通 runId 不受守卫影响(recovered-run 行为保持)", () => {
    const qc = new QueryClient();
    usePersonalStore.setState({
      sessions: [
        {
          id: "s1",
          title: "t",
          agent: "claude",
          createdAt: 1,
          updatedAt: 1,
        } as never,
      ],
    });
    __handleCliEventForTest(qc, "run-1", { type: "init", sessionId: "x" }, "s1");
    expect(usePersonalStore.getState().runningBySession.s1).toBe("run-1");
  });
});
