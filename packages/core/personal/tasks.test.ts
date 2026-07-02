import { describe, it, expect } from "vitest";
import {
  isAvailable,
  isTodayEligible,
  normalizeTag,
  canTransition,
  localDay,
  shouldAcceptDelegationWriteback,
  projectMode,
  sequentialAvailableIds,
  matchedTaskIds,
} from "./tasks";
import type { TaskMeta, TaskProject } from "../desktop/types";

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

describe("projectMode（U8/KTD5：读时默认 parallel、旧档兼容）", () => {
  it("无 mode → parallel", () => {
    expect(projectMode({})).toBe("parallel");
    expect(projectMode({ mode: undefined })).toBe("parallel");
  });
  it("显式 mode 原样返回", () => {
    expect(projectMode({ mode: "sequential" })).toBe("sequential");
    expect(projectMode({ mode: "parallel" })).toBe("parallel");
  });
});

describe("sequentialAvailableIds（U8/R23：顺序项目可用集收窄）", () => {
  it("[A,B,C] 全 active → 仅队首 A 可用（AE7）", () => {
    const ids = sequentialAvailableIds([task({ id: "A" }), task({ id: "B" }), task({ id: "C" })], TODAY);
    expect([...ids]).toEqual(["A"]);
  });
  it("队首 A 完成后 → 可用集解锁到 B（AE7）", () => {
    const ids = sequentialAvailableIds(
      [task({ id: "A", status: "done" }), task({ id: "B" }), task({ id: "C" })],
      TODAY,
    );
    expect([...ids]).toEqual(["B"]);
  });
  it("队首及其子树可用（子任务组内并行），后续顶层任务阻塞", () => {
    const ids = sequentialAvailableIds(
      [
        task({ id: "A" }),
        task({ id: "A1", parentTaskId: "A" }),
        task({ id: "A2", parentTaskId: "A" }),
        task({ id: "B" }),
      ],
      TODAY,
    );
    expect(ids.has("A")).toBe(true);
    expect(ids.has("A1")).toBe(true);
    expect(ids.has("A2")).toBe(true);
    expect(ids.has("B")).toBe(false);
  });
  it("队首 defer 未到 → 整体阻塞（空集），后续任务不抢跑", () => {
    const ids = sequentialAvailableIds(
      [task({ id: "A", deferDate: "2026-07-02" }), task({ id: "B" }), task({ id: "C" })],
      TODAY,
    );
    expect(ids.size).toBe(0);
  });
  it("顶层任务全部完结（done/dropped）→ 空集", () => {
    const ids = sequentialAvailableIds(
      [task({ id: "A", status: "done" }), task({ id: "B", status: "dropped" })],
      TODAY,
    );
    expect(ids.size).toBe(0);
  });
  it("队首子树内 defer 未到的子任务被排除，队首仍可用", () => {
    const ids = sequentialAvailableIds(
      [task({ id: "A" }), task({ id: "A1", parentTaskId: "A", deferDate: "2026-07-02" })],
      TODAY,
    );
    expect(ids.has("A")).toBe(true);
    expect(ids.has("A1")).toBe(false);
  });
  it("空任务列表 → 空集", () => {
    expect(sequentialAvailableIds([], TODAY).size).toBe(0);
  });
});

describe("matchedTaskIds（U5/R10：四档过滤纯函数）", () => {
  const P: TaskProject[] = [{ id: "p1", name: "并行", mode: "parallel" }];
  const SEQ: TaskProject[] = [{ id: "q1", name: "顺序", mode: "sequential" }];

  it("全部：含 done/dropped 一并命中", () => {
    const tasks = [
      task({ id: "a", projectId: "p1" }),
      task({ id: "b", projectId: "p1", status: "done" }),
      task({ id: "c", projectId: "p1", status: "dropped" }),
    ];
    expect([...matchedTaskIds(tasks, P, "all", TODAY)].sort()).toEqual(["a", "b", "c"]);
  });

  it("剩余：排除 done/dropped，保留 defer 未到的任务", () => {
    const tasks = [
      task({ id: "a", projectId: "p1" }),
      task({ id: "d", projectId: "p1", deferDate: "2026-07-02" }),
      task({ id: "b", projectId: "p1", status: "done" }),
    ];
    expect([...matchedTaskIds(tasks, P, "remaining", TODAY)].sort()).toEqual(["a", "d"]);
  });

  it("可用：defer 未到的任务被排除（在剩余出现、在可用消失）", () => {
    const tasks = [
      task({ id: "a", projectId: "p1" }),
      task({ id: "d", projectId: "p1", deferDate: "2026-07-02" }),
    ];
    expect([...matchedTaskIds(tasks, P, "remaining", TODAY)].sort()).toEqual(["a", "d"]);
    expect([...matchedTaskIds(tasks, P, "available", TODAY)]).toEqual(["a"]);
  });

  it("首先可用（并行）：跳过 defer 未到的队首，取首个可用项（AE5）", () => {
    // A defer 未到、B/C 可用 → 首先可用仅 B。
    const tasks = [
      task({ id: "A", projectId: "p1", deferDate: "2026-07-02" }),
      task({ id: "B", projectId: "p1" }),
      task({ id: "C", projectId: "p1" }),
    ];
    expect([...matchedTaskIds(tasks, P, "first-available", TODAY)]).toEqual(["B"]);
  });

  it("首先可用：每项目至多一条", () => {
    const projects: TaskProject[] = [
      { id: "p1", name: "一", mode: "parallel" },
      { id: "p2", name: "二", mode: "parallel" },
    ];
    const tasks = [
      task({ id: "a1", projectId: "p1" }),
      task({ id: "a2", projectId: "p1" }),
      task({ id: "b1", projectId: "p2" }),
    ];
    expect([...matchedTaskIds(tasks, projects, "first-available", TODAY)].sort()).toEqual(["a1", "b1"]);
  });

  it("首先可用（顺序）：为项目顺序首个可用项（AE7 派生）", () => {
    const tasks = [
      task({ id: "A", projectId: "q1" }),
      task({ id: "B", projectId: "q1" }),
    ];
    expect([...matchedTaskIds(tasks, SEQ, "first-available", TODAY)]).toEqual(["A"]);
  });

  it("首先可用（并行）：子任务因排序先于父时仍取顶层任务（队首=顶层动作，非抢跑的子）", () => {
    // 子 flagged → 组内排序可能排到父之前；first-available 应取顶层父，而非子（对齐 OmniFocus 队首语义）。
    const tasks = [
      task({ id: "child", projectId: "p1", parentTaskId: "parent", flagged: true }),
      task({ id: "parent", projectId: "p1" }),
    ];
    expect([...matchedTaskIds(tasks, P, "first-available", TODAY)]).toEqual(["parent"]);
  });

  it("首先可用（顺序）：子任务排序先于父时仍取顶层队首", () => {
    const tasks = [
      task({ id: "child", projectId: "q1", parentTaskId: "parent", flagged: true }),
      task({ id: "parent", projectId: "q1" }),
    ];
    expect([...matchedTaskIds(tasks, SEQ, "first-available", TODAY)]).toEqual(["parent"]);
  });

  it("首先可用：桶内无顶层可用（仅子可用）时回退取首个可用子", () => {
    // 父被 defer 压住不可用，仅子可用 → 无顶层可用 → 回退到首个可用项（子）。
    const tasks = [
      task({ id: "parent", projectId: "p1", deferDate: "2026-07-05" }),
      task({ id: "child", projectId: "p1", parentTaskId: "parent" }),
    ];
    expect([...matchedTaskIds(tasks, P, "first-available", TODAY)]).toEqual(["child"]);
  });

  it("可用（顺序项目）：仅队首及其子树，后续顶层阻塞（AE7）", () => {
    const tasks = [
      task({ id: "A", projectId: "q1" }),
      task({ id: "B", projectId: "q1" }),
    ];
    expect([...matchedTaskIds(tasks, SEQ, "available", TODAY)]).toEqual(["A"]);
    // A 完成 → 可用集解锁到 B。
    const after = [task({ id: "A", projectId: "q1", status: "done" }), task({ id: "B", projectId: "q1" })];
    expect([...matchedTaskIds(after, SEQ, "available", TODAY)]).toEqual(["B"]);
  });

  it("无项目（收件箱）任务按并行处理：可用取各自 isAvailable", () => {
    const tasks = [
      task({ id: "i1" }),
      task({ id: "i2", deferDate: "2026-07-02" }),
    ];
    expect([...matchedTaskIds(tasks, [], "available", TODAY)]).toEqual(["i1"]);
    // 首先可用：收件箱桶取首个可用项。
    expect([...matchedTaskIds(tasks, [], "first-available", TODAY)]).toEqual(["i1"]);
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
