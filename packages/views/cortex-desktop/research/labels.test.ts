// 文案/可用性映射的契约测试：枚举全覆盖 + 按钮可用性完全由 core 的状态机决定。
import { describe, expect, it } from "vitest";
import { FETCH_FAILURE_CODES } from "@cortex-work/core/research/evidence";
import { RESEARCH_SESSION_STATUSES } from "@cortex-work/core/research/session-status";
import {
  FETCH_FAILURE_LABELS,
  RESEARCH_MODE_LABELS,
  RESEARCH_STAGE_LABELS,
  RESEARCH_STATUS_META,
  canCancelSession,
  canPauseSession,
  canRerunSession,
  canResumeSession,
  canStartSession,
  isTerminalSession,
} from "./labels";

describe("labels 枚举覆盖", () => {
  it("11 个 status 都有中文标签与配色", () => {
    expect(Object.keys(RESEARCH_STATUS_META).sort()).toEqual([...RESEARCH_SESSION_STATUSES].sort());
    for (const status of RESEARCH_SESSION_STATUSES) {
      const meta = RESEARCH_STATUS_META[status];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.tone.length).toBeGreaterThan(0);
    }
  });

  it("每个 FetchFailureCode 都有中文说明", () => {
    expect(Object.keys(FETCH_FAILURE_LABELS).sort()).toEqual([...FETCH_FAILURE_CODES].sort());
  });

  it("mode / stage 都有中文标签", () => {
    expect(Object.keys(RESEARCH_MODE_LABELS)).toHaveLength(3);
    expect(Object.keys(RESEARCH_STAGE_LABELS)).toHaveLength(5);
  });
});

describe("按钮可用性判定（由 core 状态机推导，不另立规则）", () => {
  it("只有 5 个运行阶段可暂停", () => {
    const pausable = RESEARCH_SESSION_STATUSES.filter(canPauseSession);
    expect(pausable).toEqual(["planning", "searching", "fetching", "evaluating", "reporting"]);
  });

  it("终态不可暂停、不可取消、不可恢复", () => {
    for (const status of ["completed", "cancelled", "failed"] as const) {
      expect(isTerminalSession(status)).toBe(true);
      expect(canPauseSession(status)).toBe(false);
      expect(canCancelSession(status)).toBe(false);
      expect(canResumeSession(status)).toBe(false);
    }
  });

  it("created 与运行阶段可取消", () => {
    expect(canCancelSession("created")).toBe(true);
    expect(canCancelSession("searching")).toBe(true);
  });

  it("paused / interrupted 可恢复，运行中不可", () => {
    expect(canResumeSession("paused")).toBe(true);
    expect(canResumeSession("interrupted")).toBe(true);
    expect(canResumeSession("searching")).toBe(false);
  });

  /// 回归：新建时的自动 run 可能失败（如未配搜索服务），会话就停在 created。
  /// 此时暂停/恢复都不适用（它们的起点是运行中或已暂停），必须另有「开始」才不会
  /// 让会话变成只能删掉重建的死局。
  it("created 可开始，其余状态都不可", () => {
    expect(canStartSession("created")).toBe(true);
    for (const status of RESEARCH_SESSION_STATUSES.filter((s) => s !== "created")) {
      expect(canStartSession(status)).toBe(false);
    }
  });
});

/// 重跑只在终态可用。
///
/// 终态是状态机里的死路（completed / cancelled / failed 都没有出口），此前用户只能
/// 删掉重建——而删掉会连报告一起没。重跑给的是「用同一批参数再跑一次」，旧会话保留。
describe("canRerunSession", () => {
  it("三个终态都可重跑", () => {
    expect(canRerunSession("completed")).toBe(true);
    expect(canRerunSession("cancelled")).toBe(true);
    expect(canRerunSession("failed")).toBe(true);
  });

  it("非终态一律不可重跑（还在跑的东西该用暂停/取消）", () => {
    for (const status of RESEARCH_SESSION_STATUSES.filter((s) => !isTerminalSession(s))) {
      expect(canRerunSession(status)).toBe(false);
    }
  });
});
