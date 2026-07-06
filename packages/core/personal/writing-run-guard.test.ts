// writing: 前缀守卫的回归锁:写作工作台的 CLI 事件绝不能进入个人会话的
// recovered-run 重建路径(messages.ts:handleCliEvent/handleCliExit)。
// 与 design-run-guard.test.ts 对称——写作 run 的 runId(writing:<spaceId>:<uid>)与
// sessionId(writing-<threadUuid>)一旦漏守卫,会以 sessionIdHint 伪造 runningBySession
// (phantom run),污染个人会话列表与运行态。写作事件由 writing-run-manager 独立消费。
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

describe("writing: runId 前缀守卫", () => {
  it("writing 事件带 sessionIdHint 也不重建 recovered run", () => {
    const qc = new QueryClient();
    __handleCliEventForTest(
      qc,
      "writing:ws-a:r_abc",
      { type: "init", sessionId: "agent-native-session" },
      "writing-thread-1",
    );
    __handleCliEventForTest(
      qc,
      "writing:ws-a:r_abc",
      { type: "text", delta: "hello" },
      "writing-thread-1",
    );
    // 守卫生效:个人会话运行态零污染。
    expect(usePersonalStore.getState().runningBySession).toEqual({});
  });

  it("writing 退出事件不触发 finalizeRun 的 sessionIdHint 兜底", () => {
    const qc = new QueryClient();
    // 预置一个同名 runningBySession 假想态,验证 exit 守卫不去动它。
    usePersonalStore.setState({ runningBySession: { "writing-thread-1": "writing:ws-a:r_abc" } });
    __handleCliExitForTest(qc, "writing:ws-a:r_abc", 0, undefined, "writing-thread-1");
    expect(usePersonalStore.getState().runningBySession).toEqual({
      "writing-thread-1": "writing:ws-a:r_abc",
    });
  });

  it("普通 runId 不受写作守卫影响(recovered-run 行为保持)", () => {
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
