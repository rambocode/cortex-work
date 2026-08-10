import { describe, it, expect } from "vitest";
import { partitionArchivedSessions } from "./archivedSessions";
import type { SessionMeta } from "../desktop/types";

// 构造最小 SessionMeta;只关心 id/title/projectId/archivedAt,其余取默认。
function sess(p: Partial<SessionMeta> & { id: string }): SessionMeta {
  return {
    title: p.id,
    agent: "claude",
    createdAt: 0,
    updatedAt: 0,
    ...p,
  };
}

describe("partitionArchivedSessions", () => {
  it("按 projectId 分组,无项目组在末尾 (R2)", () => {
    const sessions = [
      sess({ id: "a", projectId: "p1", archivedAt: 100 }),
      sess({ id: "b", projectId: "p2", archivedAt: 100 }),
      sess({ id: "c", archivedAt: 100 }), // 无项目
    ];
    const { groups } = partitionArchivedSessions(sessions);
    expect(groups.map((g) => g.projectId)).toEqual(["p1", "p2", undefined]);
    expect(groups[2]!.sessions.map((s) => s.id)).toEqual(["c"]);
  });

  it("组内按 archivedAt 降序;同值以原始下标稳定排序 (R2/R5)", () => {
    const sessions = [
      sess({ id: "old", projectId: "p1", archivedAt: 100 }),
      sess({ id: "tieA", projectId: "p1", archivedAt: 300 }),
      sess({ id: "new", projectId: "p1", archivedAt: 500 }),
      sess({ id: "tieB", projectId: "p1", archivedAt: 300 }),
    ];
    const { groups } = partitionArchivedSessions(sessions);
    // 500 > 300(tieA 先于 tieB,原序兜底) > 100
    expect(groups[0]!.sessions.map((s) => s.id)).toEqual(["new", "tieA", "tieB", "old"]);
  });

  it("仅含未归档会话 → 两计数为 0、groups 为空", () => {
    const sessions = [sess({ id: "a" }), sess({ id: "b", projectId: "p1" })];
    const r = partitionArchivedSessions(sessions);
    expect(r.archivedTotal).toBe(0);
    expect(r.filteredTotal).toBe(0);
    expect(r.groups).toEqual([]);
  });

  it("side 子会话即使存档异常带 archivedAt 也不进入顶层归档列表", () => {
    const result = partitionArchivedSessions([
      sess({ id: "parent", archivedAt: 100 }),
      sess({ id: "child", relation: "side", parentSessionId: "parent", archivedAt: 200 }),
    ]);
    expect(result.archivedTotal).toBe(1);
    expect(result.groups.flatMap((group) => group.sessions).map((session) => session.id)).toEqual(["parent"]);
  });

  it("query 按标题过滤,大小写不敏感、首尾空白被 trim (R3)", () => {
    const sessions = [
      sess({ id: "1", title: "创建软件著作系统", projectId: "p1", archivedAt: 100 }),
      sess({ id: "2", title: "天气助手", projectId: "p1", archivedAt: 100 }),
    ];
    const r = partitionArchivedSessions(sessions, "  软件  ");
    expect(r.filteredTotal).toBe(1);
    expect(r.groups[0]!.sessions.map((s) => s.id)).toEqual(["1"]);

    const upper = partitionArchivedSessions(
      [sess({ id: "x", title: "DeepSeek Chat", archivedAt: 100 })],
      "deepseek",
    );
    expect(upper.filteredTotal).toBe(1);
  });

  it("query 命中 A 项目不命中 B → B 组被剔除(空组不保留) (R3)", () => {
    const sessions = [
      sess({ id: "a", title: "alpha", projectId: "p1", archivedAt: 100 }),
      sess({ id: "b", title: "beta", projectId: "p2", archivedAt: 100 }),
    ];
    const { groups } = partitionArchivedSessions(sessions, "alpha");
    expect(groups.map((g) => g.projectId)).toEqual(["p1"]);
  });

  it("空/纯空白 query 等价于不过滤,filteredTotal === archivedTotal (R3)", () => {
    const sessions = [
      sess({ id: "a", projectId: "p1", archivedAt: 100 }),
      sess({ id: "b", archivedAt: 100 }),
    ];
    for (const q of ["", "   "]) {
      const r = partitionArchivedSessions(sessions, q);
      expect(r.filteredTotal).toBe(2);
      expect(r.archivedTotal).toBe(2);
    }
  });

  it("archivedTotal 恒为过滤前总数,即便搜索过滤到 0 (R4)", () => {
    const sessions = [
      sess({ id: "a", title: "alpha", projectId: "p1", archivedAt: 100 }),
      sess({ id: "b", title: "beta", projectId: "p1", archivedAt: 100 }),
    ];
    const r = partitionArchivedSessions(sessions, "不存在的词");
    expect(r.archivedTotal).toBe(2);
    expect(r.filteredTotal).toBe(0);
    expect(r.groups).toEqual([]);
  });

  it("边界:空数组不抛错", () => {
    expect(partitionArchivedSessions([])).toEqual({
      groups: [],
      archivedTotal: 0,
      filteredTotal: 0,
    });
  });
});
