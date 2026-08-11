import { describe, expect, it } from "vitest";
import type { AgentProjectInfo, ProjectMeta, SessionMeta } from "../desktop/types";
import { latestActiveProjectId, mergeProjectRows, type WorkspaceProjectRow } from "./home";

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
