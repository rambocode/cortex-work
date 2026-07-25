// session-status.ts 的状态机测试。状态机是崩溃恢复与 UI 展示的共同真源，
// 「哪些边不存在」和「哪些边存在」同样重要，所以这里用全矩阵驱动而不是抽查。
import { describe, expect, it } from "vitest";

import {
  canTransition,
  NON_TERMINAL_RESEARCH_STATUSES,
  RESEARCH_SESSION_STATUSES,
  resumeTargetFor,
  statusOnAppRestart,
  TERMINAL_RESEARCH_STATUSES,
  type ResearchSessionStatus,
} from "./session-status";

describe("RESEARCH_SESSION_STATUSES", () => {
  it("与 spec KTD8 逐字一致，且不存在 running", () => {
    expect(RESEARCH_SESSION_STATUSES).toEqual([
      "created",
      "planning",
      "searching",
      "fetching",
      "evaluating",
      "reporting",
      "completed",
      "paused",
      "cancelled",
      "failed",
      "interrupted",
    ]);
    expect(RESEARCH_SESSION_STATUSES).not.toContain("running");
  });

  it("非终态集合是 5 个运行阶段", () => {
    expect([...NON_TERMINAL_RESEARCH_STATUSES]).toEqual([
      "planning",
      "searching",
      "fetching",
      "evaluating",
      "reporting",
    ]);
  });

  it("终态集合是 completed/cancelled/failed", () => {
    expect([...TERMINAL_RESEARCH_STATUSES]).toEqual(["completed", "cancelled", "failed"]);
  });

  it("终态与非终态不相交，created/paused/interrupted 两边都不属于", () => {
    for (const status of NON_TERMINAL_RESEARCH_STATUSES) {
      expect(TERMINAL_RESEARCH_STATUSES).not.toContain(status);
    }
    for (const status of ["created", "paused", "interrupted"] as ResearchSessionStatus[]) {
      expect(NON_TERMINAL_RESEARCH_STATUSES).not.toContain(status);
      expect(TERMINAL_RESEARCH_STATUSES).not.toContain(status);
    }
  });
});

describe("statusOnAppRestart", () => {
  it.each([...NON_TERMINAL_RESEARCH_STATUSES])("非终态 %s 重启后一律变 interrupted", (status) => {
    expect(statusOnAppRestart(status)).toBe("interrupted");
  });

  it.each(["completed", "cancelled", "failed", "created", "paused", "interrupted"] as ResearchSessionStatus[])(
    "%s 重启后原样返回",
    (status) => {
      expect(statusOnAppRestart(status)).toBe(status);
    },
  );
});

describe("canTransition", () => {
  // 期望的完整邻接表（spec §9 状态图 + §9 正文的「非终态一律转 interrupted」）。
  // 测试里独立写一份，避免直接复用实现的表导致"自证正确"。
  const expectedEdges: Record<ResearchSessionStatus, ResearchSessionStatus[]> = {
    created: ["planning", "cancelled"],
    planning: ["searching", "paused", "cancelled", "failed", "interrupted"],
    searching: ["fetching", "paused", "cancelled", "failed", "interrupted"],
    fetching: ["evaluating", "paused", "cancelled", "failed", "interrupted"],
    evaluating: ["searching", "fetching", "reporting", "paused", "cancelled", "failed", "interrupted"],
    reporting: ["completed", "paused", "cancelled", "failed", "interrupted"],
    completed: [],
    paused: ["interrupted"],
    cancelled: [],
    failed: [],
    interrupted: ["planning", "searching", "fetching", "evaluating", "reporting"],
  };

  // 11×11 全矩阵：每一格都断言，漏一条边或多一条边都会红。
  for (const from of RESEARCH_SESSION_STATUSES) {
    for (const to of RESEARCH_SESSION_STATUSES) {
      const allowed = expectedEdges[from].includes(to);
      it(`${from} → ${to} 应为 ${allowed}`, () => {
        expect(canTransition(from, to)).toBe(allowed);
      });
    }
  }

  it.each([...TERMINAL_RESEARCH_STATUSES])("终态 %s 不能转出任何状态", (from) => {
    for (const to of RESEARCH_SESSION_STATUSES) {
      expect(canTransition(from, to)).toBe(false);
    }
  });

  it.each([...NON_TERMINAL_RESEARCH_STATUSES])("非终态 %s 都能被暂停", (from) => {
    expect(canTransition(from, "paused")).toBe(true);
  });

  it.each([...NON_TERMINAL_RESEARCH_STATUSES])("非终态 %s 都能被取消或失败", (from) => {
    expect(canTransition(from, "cancelled")).toBe(true);
    expect(canTransition(from, "failed")).toBe(true);
  });

  it("interrupted 能回到任意运行阶段", () => {
    for (const to of NON_TERMINAL_RESEARCH_STATUSES) {
      expect(canTransition("interrupted", to)).toBe(true);
    }
  });

  it("未知状态（脏持久化数据）一律返回 false 而不抛错", () => {
    expect(canTransition("running" as ResearchSessionStatus, "planning")).toBe(false);
    expect(canTransition("planning", "running" as ResearchSessionStatus)).toBe(false);
  });
});

// 两个导出函数之间的自洽性：statusOnAppRestart 会真的把状态写进 SQLite，
// 而编排层在落库前会用 canTransition 做守卫。若某条重启归一的边不在转移表里，
// 守卫会拒绝这次写入，Session 将永远卡在一个「进程已死却显示进行中」的状态。
describe("statusOnAppRestart 与 canTransition 自洽", () => {
  it.each([...RESEARCH_SESSION_STATUSES])(
    "%s 的重启归一结果必须是一条合法转移（或原地不动）",
    (status) => {
      const next = statusOnAppRestart(status);
      if (next === status) return;
      expect(canTransition(status, next)).toBe(true);
    },
  );
});

describe("resumeTargetFor", () => {
  it.each([...NON_TERMINAL_RESEARCH_STATUSES])("从 %s 中断的会话恢复回同一阶段", (status) => {
    expect(resumeTargetFor(status)).toBe(status);
  });

  it.each(["created", "paused", "interrupted"] as ResearchSessionStatus[])(
    "%s 缺少阶段信息时保守回到 planning",
    (status) => {
      expect(resumeTargetFor(status)).toBe("planning");
    },
  );

  it.each([...TERMINAL_RESEARCH_STATUSES])("终态 %s 无需恢复，原样返回", (status) => {
    expect(resumeTargetFor(status)).toBe(status);
  });

  it("恢复目标必须是 interrupted 的合法后继", () => {
    for (const status of NON_TERMINAL_RESEARCH_STATUSES) {
      expect(canTransition("interrupted", resumeTargetFor(status))).toBe(true);
    }
  });
});
