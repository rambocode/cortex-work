import { describe, expect, it } from "vitest";
import type { AgentProjectInfo, ProjectMeta, SessionMeta, TimelineEvent } from "../desktop/types";
import { groupEventsByDay } from "./timeline";
import { buildHeatmapWeeks, homeHeatLevel, latestActiveProjectId, mergeProjectRows, type WorkspaceProjectRow } from "./home";

function ev(partial: Partial<TimelineEvent> & { ts: number }): TimelineEvent {
  return { id: `e-${partial.ts}`, projectId: "p1", kind: "run", title: "t", ...partial };
}

// 2026-06-10 是周三。
const TODAY = new Date(2026, 5, 10, 9, 0, 0).getTime();

describe("buildHeatmapWeeks", () => {
  it("返回恰好 N 周 × 7 天,周一起始,今天在最后一周", () => {
    const weeks = buildHeatmapWeeks(26, [], TODAY);
    expect(weeks).toHaveLength(26);
    for (const w of weeks) expect(w.cells).toHaveLength(7);
    // 今天所在周：周一 2026-06-08 … 周日 2026-06-14。
    const last = weeks.at(-1)!;
    expect(last.cells[0]?.day).toBe("2026-06-08");
    expect(last.cells[6]?.day).toBe("2026-06-14");
    expect(last.cells.map((c) => c.day)).toContain("2026-06-10");
    // 第一周往前推 25 周：2025-12-15（周一）。
    expect(weeks[0]?.cells[0]?.day).toBe("2025-12-15");
  });

  it("今天之后的格子标记 inFuture,今天及以前不标", () => {
    const weeks = buildHeatmapWeeks(2, [], TODAY);
    const cells = weeks.flatMap((w) => w.cells);
    const today = cells.find((c) => c.day === "2026-06-10");
    const tomorrow = cells.find((c) => c.day === "2026-06-11");
    const yesterday = cells.find((c) => c.day === "2026-06-09");
    expect(today?.inFuture).toBe(false);
    expect(yesterday?.inFuture).toBe(false);
    expect(tomorrow?.inFuture).toBe(true);
  });

  it("按 dayKey 命中当天统计", () => {
    const groups = groupEventsByDay([
      ev({ ts: TODAY, files: ["a.ts"] }),
      ev({ ts: TODAY + 60_000 }),
      ev({ ts: TODAY - 86400_000, kind: "session.created" }),
    ]);
    const weeks = buildHeatmapWeeks(2, groups, TODAY);
    const cells = weeks.flatMap((w) => w.cells);
    expect(cells.find((c) => c.day === "2026-06-10")?.stats?.runs).toBe(2);
    expect(cells.find((c) => c.day === "2026-06-09")?.stats?.sessions).toBe(1);
    expect(cells.find((c) => c.day === "2026-06-08")?.stats).toBeUndefined();
  });

  it("今天是周一时为最后一周首格,周日时为末格", () => {
    const monday = new Date(2026, 5, 8, 12, 0).getTime(); // 2026-06-08 周一
    const sunday = new Date(2026, 5, 14, 12, 0).getTime(); // 2026-06-14 周日
    expect(buildHeatmapWeeks(1, [], monday)[0]?.cells[0]?.day).toBe("2026-06-08");
    expect(buildHeatmapWeeks(1, [], sunday)[0]?.cells[6]?.day).toBe("2026-06-14");
    expect(buildHeatmapWeeks(1, [], sunday)[0]?.cells[6]?.inFuture).toBe(false);
  });

  it("包含某月 1 号的周标注月份", () => {
    // 2026-06-01 是周一,其所在周应标注 6 月。
    const weeks = buildHeatmapWeeks(4, [], TODAY);
    const labeled = weeks.filter((w) => w.monthLabel);
    expect(labeled.map((w) => w.monthLabel)).toContain("6月");
    const juneWeek = weeks.find((w) => w.cells.some((c) => c.day === "2026-06-01"));
    expect(juneWeek?.monthLabel).toBe("6月");
  });
});

describe("mergeProjectRows", () => {
  const proj = (id: string, path: string): ProjectMeta => ({ id, name: path.split("/").pop()!, path, addedAt: 1000 });
  const sess = (id: string, projectId: string, updatedAt: number): SessionMeta => ({
    id,
    projectId,
    title: "S",
    agent: "claude",
    createdAt: updatedAt,
    updatedAt,
  });
  const wsRow = (path: string, lastActive: number, agents: ("claude" | "codex")[] = ["claude"]): WorkspaceProjectRow => {
    const p = proj(`id-${path}`, path);
    return { project: p, sessionCount: 1, latest: sess(`s-${path}`, p.id, lastActive), lastActive, agents };
  };
  const scan = (path: string, lastActive: number, agents: ("claude" | "codex")[]): AgentProjectInfo => ({
    path,
    name: path.split("/").pop()!,
    agents,
    lastActive,
  });

  it("同 path 合并:agents 并集、lastActive 取 max、保留工作区跳转信息", () => {
    const rows = mergeProjectRows([wsRow("/a", 100, ["claude"])], [scan("/a", 200, ["codex"])]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: "/a", inWorkspace: true, lastActive: 200, sessionCount: 1 });
    expect(rows[0]?.agents.sort()).toEqual(["claude", "codex"]);
    expect(rows[0]?.latest?.id).toBe("s-/a");
  });

  it("纯扫描项目标记 inWorkspace=false,合并后按 lastActive 倒序", () => {
    const rows = mergeProjectRows([wsRow("/a", 100)], [scan("/b", 300, ["codex"]), scan("/c", 50, ["claude"])]);
    expect(rows.map((r) => r.path)).toEqual(["/b", "/a", "/c"]);
    expect(rows[0]).toMatchObject({ inWorkspace: false, sessionCount: 0, name: "b" });
  });

  it("path 比较忽略尾部斜杠", () => {
    const rows = mergeProjectRows([wsRow("/a/b", 100)], [scan("/a/b/", 200, ["claude"])]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastActive).toBe(200);
  });
});

describe("latestActiveProjectId", () => {
  const sess = (id: string, projectId: string | undefined, updatedAt: number): SessionMeta => ({
    id,
    projectId,
    title: "S",
    agent: "claude",
    createdAt: updatedAt,
    updatedAt,
  });

  it("空数组返回 undefined", () => {
    expect(latestActiveProjectId([])).toBeUndefined();
  });

  it("取 updatedAt 最大的会话的 projectId", () => {
    const sessions = [sess("a", "p1", 100), sess("b", "p2", 300), sess("c", "p3", 200)];
    expect(latestActiveProjectId(sessions)).toBe("p2");
  });

  it("最近会话为无项目会话时返回 undefined", () => {
    const sessions = [sess("a", "p1", 100), sess("b", undefined, 300), sess("c", "p3", 200)];
    expect(latestActiveProjectId(sessions)).toBeUndefined();
  });
});

describe("homeHeatLevel", () => {
  const stats = (runs: number, sessions: number) => ({ runs, sessions, files: 0, commits: 0, notes: 0 });

  it("score = runs + sessions,与时间线日历同档位", () => {
    expect(homeHeatLevel(undefined)).toBe(0);
    expect(homeHeatLevel(stats(0, 0))).toBe(0);
    expect(homeHeatLevel(stats(1, 0))).toBe(1);
    expect(homeHeatLevel(stats(1, 1))).toBe(1);
    expect(homeHeatLevel(stats(2, 1))).toBe(2);
    expect(homeHeatLevel(stats(5, 0))).toBe(2);
    expect(homeHeatLevel(stats(5, 1))).toBe(3);
    expect(homeHeatLevel(stats(10, 0))).toBe(3);
    expect(homeHeatLevel(stats(10, 1))).toBe(4);
  });
});
