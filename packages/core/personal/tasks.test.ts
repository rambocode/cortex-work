import { describe, it, expect } from "vitest";
import {
  isAvailable,
  isTodayEligible,
  normalizeTag,
  canTransition,
  localDay,
  shouldAcceptDelegationWriteback,
} from "./tasks";
import type { TaskMeta } from "../desktop/types";

// 构造最小任务，仅覆盖被测字段。
function task(partial: Partial<TaskMeta>): TaskMeta {
  return {
    id: "t1",
    title: "t",
    status: "active",
    tags: [],
    source: "manual",
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

const TODAY = "2026-07-01";

describe("isAvailable", () => {
  it("active 无 defer → 可用", () => {
    expect(isAvailable(task({ status: "active" }), TODAY)).toBe(true);
  });
  it("active defer 到未来 → 不可用", () => {
    expect(isAvailable(task({ status: "active", deferDate: "2026-07-02" }), TODAY)).toBe(false);
  });
  it("in-progress defer 到过去 → 可用", () => {
    expect(isAvailable(task({ status: "in-progress", deferDate: "2026-06-30" }), TODAY)).toBe(true);
  });
  it("done/dropped/waiting → 一律不可用", () => {
    expect(isAvailable(task({ status: "done" }), TODAY)).toBe(false);
    expect(isAvailable(task({ status: "dropped" }), TODAY)).toBe(false);
    expect(isAvailable(task({ status: "waiting" }), TODAY)).toBe(false);
  });
});

describe("isTodayEligible（KTD7：状态门控 + defer>due→due 优先）", () => {
  it("AE5：defer=明天的 active 今天不进", () => {
    expect(isTodayEligible(task({ deferDate: "2026-07-02" }), TODAY)).toBe(false);
  });
  it("AE5：到明天自动进（今天=明天视角）", () => {
    expect(isTodayEligible(task({ deferDate: "2026-07-02" }), "2026-07-02")).toBe(true);
  });
  it("AE5：逾期 due 持续进", () => {
    expect(isTodayEligible(task({ dueDate: "2026-06-30" }), TODAY)).toBe(true);
  });
  it("done 且 flagged → 不进（状态门控）", () => {
    expect(isTodayEligible(task({ status: "done", flagged: true }), TODAY)).toBe(false);
  });
  it("defer=下周但 due=昨天 → 进（defer>due，due 优先）", () => {
    expect(isTodayEligible(task({ deferDate: "2026-07-08", dueDate: "2026-06-30" }), TODAY)).toBe(true);
  });
  it("纯 active 无日期无 flag → 不进 Today", () => {
    expect(isTodayEligible(task({}), TODAY)).toBe(false);
  });
  it("flagged 的 active → 进", () => {
    expect(isTodayEligible(task({ flagged: true }), TODAY)).toBe(true);
  });
});

describe("normalizeTag", () => {
  it("trim + 小写归一", () => {
    expect(normalizeTag(" @Email ")).toBe("@email");
    expect(normalizeTag("@email")).toBe("@email");
  });
  it("空/纯空白 → null", () => {
    expect(normalizeTag("")).toBeNull();
    expect(normalizeTag("   ")).toBeNull();
  });
});

describe("canTransition（状态机；in-progress 仅 agent 驱动到达）", () => {
  it("done→active 恢复（用户）", () => {
    expect(canTransition("done", "active", "user")).toBe(true);
  });
  it("用户手动 active→in-progress 拒绝（仅 agent）", () => {
    expect(canTransition("active", "in-progress", "user")).toBe(false);
    expect(canTransition("waiting", "in-progress", "agent")).toBe(true);
  });
  it("waiting→active 取消委派（用户）", () => {
    expect(canTransition("waiting", "active", "user")).toBe(true);
  });
  it("in-progress→done 用户确认", () => {
    expect(canTransition("in-progress", "done", "user")).toBe(true);
  });
  it("waiting→done 无直接边（成功走 in-progress）", () => {
    expect(canTransition("waiting", "done", "user")).toBe(false);
    expect(canTransition("waiting", "done", "agent")).toBe(false);
  });
  it("同态 → false", () => {
    expect(canTransition("active", "active", "user")).toBe(false);
  });
});

describe("shouldAcceptDelegationWriteback（U12 数据安全核心）", () => {
  const deleg = { sessionId: "s1", state: "running" as const };
  it("waiting + sessionId 匹配 → 接受", () => {
    expect(shouldAcceptDelegationWriteback({ status: "waiting", delegation: deleg }, "s1")).toBe(true);
  });
  it("in-progress + 匹配 → 接受", () => {
    expect(shouldAcceptDelegationWriteback({ status: "in-progress", delegation: deleg }, "s1")).toBe(true);
  });
  it("任务已删(undefined) → 丢弃", () => {
    expect(shouldAcceptDelegationWriteback(undefined, "s1")).toBe(false);
  });
  it("已 dropped/done/active(终态或回退) → 丢弃，不复活", () => {
    expect(shouldAcceptDelegationWriteback({ status: "dropped", delegation: deleg }, "s1")).toBe(false);
    expect(shouldAcceptDelegationWriteback({ status: "done", delegation: deleg }, "s1")).toBe(false);
    expect(shouldAcceptDelegationWriteback({ status: "active", delegation: deleg }, "s1")).toBe(false);
  });
  it("sessionId 不符（后一次委派）→ 丢弃，不 clobber", () => {
    expect(shouldAcceptDelegationWriteback({ status: "waiting", delegation: { sessionId: "s2", state: "running" } }, "s1")).toBe(false);
  });
});

describe("localDay", () => {
  it("格式化为本地 YYYY-MM-DD 零填充", () => {
    expect(localDay(new Date(2026, 6, 1))).toBe("2026-07-01");
    expect(localDay(new Date(2026, 0, 9))).toBe("2026-01-09");
  });
});
