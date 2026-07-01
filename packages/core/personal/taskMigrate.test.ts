import { describe, it, expect } from "vitest";
import { migrateLegacyTodos, MAX_NOTE_CHARS, type LegacyTodo } from "./taskMigrate";

// 确定性 newId：便于断言。
function makeNewId() {
  let n = 0;
  return (prefix: "task" | "proj") => `${prefix}-${++n}`;
}
function deps(readBody: (p: string) => string | null = () => null) {
  return { readBody, now: 1000, newId: makeNewId() };
}
function todo(p: Partial<LegacyTodo>): LegacyTodo {
  return { id: "old1", title: "t", status: "open", ...p };
}

describe("migrateLegacyTodos", () => {
  it("AE8：done + projectId + 正文 → done 状态、按项目名建 task-project、正文接管", () => {
    const res = migrateLegacyTodos(
      [todo({ id: "old1", projectId: "p1", title: "回邮件", status: "done", detailPath: "/proj/tasks/old1.md" })],
      [{ id: "p1", name: "工作" }],
      deps((path) => (path === "/proj/tasks/old1.md" ? "邮件正文" : null)),
    );
    expect(res.projects).toEqual([{ id: "proj-1", name: "工作" }]);
    expect(res.tasks).toHaveLength(1);
    const t = res.tasks[0];
    expect(t.status).toBe("done");
    expect(t.projectId).toBe("proj-1");
    expect(t.notes).toBe("邮件正文");
    expect(t.migratedFrom).toBe("old1");
    expect(t.source).toBe("manual");
  });

  it("open → active", () => {
    const res = migrateLegacyTodos([todo({ status: "open" })], [], deps());
    expect(res.tasks[0].status).toBe("active");
  });

  it("孤儿 projectId（不在 projects[]）→ 落 Inbox（projectId 置空）", () => {
    const res = migrateLegacyTodos([todo({ projectId: "ghost" })], [{ id: "p1", name: "工作" }], deps());
    expect(res.tasks[0].projectId).toBeUndefined();
    expect(res.projects).toEqual([]);
  });

  it("detailPath 文件缺失/损坏（readBody 返回 null）→ 保任务、空正文，不丢不阻断", () => {
    const res = migrateLegacyTodos(
      [todo({ id: "a", detailPath: "/gone.md" }), todo({ id: "b", title: "second" })],
      [],
      deps(() => null),
    );
    expect(res.tasks).toHaveLength(2); // 单文件坏不阻断整体
    expect(res.tasks[0].notes).toBeUndefined();
  });

  it("同一旧 projectId 的多条 todo 复用同一 task-project（去重）", () => {
    const res = migrateLegacyTodos(
      [todo({ id: "a", projectId: "p1" }), todo({ id: "b", projectId: "p1" })],
      [{ id: "p1", name: "工作" }],
      deps(),
    );
    expect(res.projects).toHaveLength(1);
    expect(res.tasks[0].projectId).toBe(res.tasks[1].projectId);
  });

  it("正文超长按 MAX_NOTE_CHARS 截断", () => {
    const big = "x".repeat(MAX_NOTE_CHARS + 500);
    const res = migrateLegacyTodos([todo({ detailPath: "/big.md" })], [], deps(() => big));
    expect(res.tasks[0].notes!.length).toBe(MAX_NOTE_CHARS);
  });

  it("createdAt/updatedAt 保留；缺省回退 now", () => {
    const res = migrateLegacyTodos(
      [todo({ id: "a", createdAt: 5, updatedAt: 9 }), todo({ id: "b" })],
      [],
      deps(),
    );
    expect(res.tasks[0].createdAt).toBe(5);
    expect(res.tasks[0].updatedAt).toBe(9);
    expect(res.tasks[1].createdAt).toBe(1000); // now 回退
  });

  it("空 todos → 空结果", () => {
    const res = migrateLegacyTodos([], [{ id: "p1", name: "工作" }], deps());
    expect(res.tasks).toEqual([]);
    expect(res.projects).toEqual([]);
  });
});
