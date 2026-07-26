// 后台观察的测试。
//
// 这一层的全部意义是「切走覆盖层之后还知道研究跑到哪了」，所以关键不变量是：
//   - 状态跟踪对重复事件幂等（事件会重发，计数器式实现会越加越多）；
//   - 完成通知一个会话只排一条，且必须能被消费掉（否则每次重渲染都弹）。
import { beforeEach, describe, expect, it } from "vitest";
import type { ResearchEvent, ResearchSessionSummary } from "./types";

import { useResearchBackgroundStore } from "./background-watch";

function summary(
  sessionId: string,
  status: ResearchSessionSummary["status"],
  objective = "目标",
): ResearchSessionSummary {
  return {
    sessionId,
    consumer: "deep_research",
    objective,
    mode: "standard",
    status,
    createdAt: "2026-07-26T00:00:00Z",
    updatedAt: "2026-07-26T00:00:00Z",
    roundCount: 0,
    documentCount: 0,
    chunkCount: 0,
  };
}

const store = () => useResearchBackgroundStore.getState();
const runningCount = () => Object.keys(store().running).length;

beforeEach(() => store().reset());

describe("seed", () => {
  it("只把运行中的会话计入在跑：终态与静止态（paused / created）都不算", () => {
    store().seed([
      summary("a", "searching"),
      summary("b", "completed"),
      // paused / created 是静止态，不在 NON_TERMINAL_RESEARCH_STATUSES 里——
      // 角标表达的是「还在跑几个」，暂停的会话没在跑。
      summary("c", "paused"),
      summary("d", "created"),
      summary("e", "reporting"),
    ]);
    expect(runningCount()).toBe(2);
  });

  it("记住研究目标（事件里不带目标原文，完成通知要靠它）", () => {
    store().seed([summary("a", "searching", "调研 X")]);
    store().apply({ type: "done", sessionId: "a", status: "completed" });
    expect(store().finished[0]?.objective).toBe("调研 X");
  });

  /// 事件流可能先于 list() 的快照到达。用快照整体覆盖会让已经结束的会话复活，
  /// 角标就停在一个永远不减的数字上。
  it("重复播种同一会话不会重复计数", () => {
    store().seed([summary("a", "searching")]);
    store().seed([summary("a", "searching")]);
    expect(runningCount()).toBe(1);
  });
});

describe("apply", () => {
  it("status 事件驱动在跑集合的增减", () => {
    store().apply({ type: "status", sessionId: "a", status: "searching" });
    expect(runningCount()).toBe(1);
    store().apply({ type: "status", sessionId: "a", status: "completed" });
    expect(runningCount()).toBe(0);
  });

  it("同一状态重复到达是幂等的", () => {
    for (let i = 0; i < 5; i += 1) {
      store().apply({ type: "status", sessionId: "a", status: "fetching" });
    }
    expect(runningCount()).toBe(1);
  });

  it("done 事件把会话移出在跑集合并排一条完成通知", () => {
    store().apply({ type: "status", sessionId: "a", status: "reporting" });
    store().apply({ type: "done", sessionId: "a", status: "completed" });
    expect(runningCount()).toBe(0);
    expect(store().finished).toEqual([{ sessionId: "a", objective: "", status: "completed" }]);
  });

  it("done 重发时只排一条通知（重试路径会重发）", () => {
    store().apply({ type: "done", sessionId: "a", status: "completed" });
    store().apply({ type: "done", sessionId: "a", status: "completed" });
    expect(store().finished).toHaveLength(1);
  });

  it("失败与取消同样排通知（用户需要知道它结束了，不只是成功才通知）", () => {
    store().apply({ type: "done", sessionId: "a", status: "failed" });
    store().apply({ type: "done", sessionId: "b", status: "cancelled" });
    expect(store().finished.map((f) => f.status)).toEqual(["failed", "cancelled"]);
  });

  it.each([
    ["stage", { type: "stage", sessionId: "a", stage: "searching" }],
    ["round", { type: "round", sessionId: "a", roundIndex: 1 }],
    ["report_delta", { type: "report_delta", sessionId: "a", delta: "x" }],
  ])("%s 事件不影响在跑集合（高频事件不该引起重渲染）", (_name, event) => {
    store().apply(event as ResearchEvent);
    expect(runningCount()).toBe(0);
    expect(store().finished).toHaveLength(0);
  });
});

describe("clearFinished", () => {
  it("消费后队列里不再有该条（不清的话每次重渲染都会再弹一次）", () => {
    store().apply({ type: "done", sessionId: "a", status: "completed" });
    store().apply({ type: "done", sessionId: "b", status: "failed" });
    store().clearFinished("a");
    expect(store().finished.map((f) => f.sessionId)).toEqual(["b"]);
  });
});
