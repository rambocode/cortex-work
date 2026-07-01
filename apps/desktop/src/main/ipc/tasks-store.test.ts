// 真任务 store 核心单测：原子写、并发串行不丢、CRUD、project reparent、迁移幂等，
// 以及关键的数据安全区分——ENOENT(安全空态) vs 解析失败/结构非法(损坏→隔离 .corrupt + 拒写)。
// electron 绑定层（ipcMain.handle / broadcast）人工验证。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fsp } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TasksStore, newTaskId, emptyTasks, type TasksStoreDeps } from "./tasks-store";

let dir: string;
let file: string;

function makeStore(): TasksStore {
  const deps: TasksStoreDeps = { tasksStorePath: () => file };
  return new TasksStore(deps);
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), "tasks-store-"));
  file = join(dir, "tasks.json");
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("newTaskId", () => {
  it("生成 task-/proj- 前缀且唯一", () => {
    const a = newTaskId();
    const b = newTaskId();
    expect(a.startsWith("task-")).toBe(true);
    expect(a).not.toBe(b);
    expect(newTaskId("proj").startsWith("proj-")).toBe(true);
  });
});

describe("TasksStore happy path", () => {
  it("add 后 list 能取回；含 main 生成的 id/status=active/时间戳", async () => {
    const store = makeStore();
    const meta = await store.add({ title: "  写方案  ", projectId: "p1" });
    expect(meta.id.startsWith("task-")).toBe(true);
    expect(meta.status).toBe("active");
    expect(meta.title).toBe("写方案"); // trim
    expect(meta.projectId).toBe("p1");
    expect(meta.source).toBe("manual"); // 缺省
    expect(meta.tags).toEqual([]);
    expect(meta.updatedAt).toBe(meta.createdAt);

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(meta.id);
  });

  it("写盘后可被新实例冷读取回——原子写落盘有效", async () => {
    const store = makeStore();
    const meta = await store.add({ title: "persisted", source: "capture" });
    await store.flush();

    const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
    expect(parsed.version).toBe(1);
    expect(parsed.tasks).toHaveLength(1);

    const fresh = makeStore();
    const list = await fresh.list();
    expect(list[0].id).toBe(meta.id);
    expect(list[0].source).toBe("capture");
  });
});

describe("TasksStore 并发 / 缺失 vs 损坏", () => {
  it("并发两次 add 串行不交错、不丢更新", async () => {
    const store = makeStore();
    const [a, b] = await Promise.all([store.add({ title: "first" }), store.add({ title: "second" })]);
    expect(a.id).not.toBe(b.id);
    await store.flush();
    const fresh = makeStore();
    const ids = (await fresh.list()).map((t) => t.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it("文件缺失(ENOENT) → 安全空态，且随后 add 正常建文件", async () => {
    const store = makeStore();
    expect(await store.list()).toEqual([]); // 不抛、不隔离
    const meta = await store.add({ title: "x" });
    expect((await store.list())[0].id).toBe(meta.id);
  });

  it("解析失败(损坏) → 隔离 .corrupt + 拒绝读写，绝不覆盖", async () => {
    await fsp.writeFile(file, "{ this is not json", "utf8");
    const store = makeStore();
    // 读拒绝（不回退空态）
    await expect(store.list()).rejects.toThrow();
    // 原损坏文件被隔离到 .corrupt，原路径不再是那份损坏内容
    const corruptRaw = await fsp.readFile(file + ".corrupt", "utf8");
    expect(corruptRaw).toBe("{ this is not json");
    // 后续 mutate 仍被拒绝（corrupt 态持久，防二次抹掉）
    await expect(store.add({ title: "should-reject" })).rejects.toThrow();
    // 绝不落盘覆盖：原路径没有被写成 { tasks:[新增] }
    await expect(fsp.readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("结构非法(缺数组) → 同样隔离 + 拒绝", async () => {
    await fsp.writeFile(file, JSON.stringify({ version: 1, tasks: [] }), "utf8"); // 缺 projects/archived
    const store = makeStore();
    await expect(store.list()).rejects.toThrow();
    await expect(fsp.readFile(file + ".corrupt", "utf8")).resolves.toContain("version");
  });
});

describe("TasksStore update / delete", () => {
  it("update 字段级合并并刷新 updatedAt；找不到返回 null", async () => {
    const store = makeStore();
    const meta = await store.add({ title: "orig", projectId: "p1" });
    await new Promise((r) => setTimeout(r, 2));
    const updated = await store.update(meta.id, { status: "done" });
    expect(updated!.status).toBe("done");
    expect(updated!.projectId).toBe("p1"); // 未传保留
    expect(updated!.createdAt).toBe(meta.createdAt);
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(meta.createdAt);
    expect(await store.update("missing", { status: "done" })).toBeNull();
  });

  it("delete 物理移除自身", async () => {
    const store = makeStore();
    const a = await store.add({ title: "a" });
    const b = await store.add({ title: "b" });
    await store.delete(a.id);
    expect((await store.list()).map((t) => t.id)).toEqual([b.id]);
  });
});

describe("TasksStore project（KTD10 reparent→Inbox）", () => {
  it("deleteProject 把其下任务 reparent 到 Inbox（projectId 置空），不删任务", async () => {
    const store = makeStore();
    const proj = await store.addProject("工作");
    const t1 = await store.add({ title: "a", projectId: proj.id });
    const t2 = await store.add({ title: "b" }); // 本就无 project
    await store.deleteProject(proj.id);

    expect(await store.listProjects()).toEqual([]);
    const list = await store.list();
    expect(list).toHaveLength(2); // 任务未丢
    const reparented = list.find((t) => t.id === t1.id)!;
    expect(reparented.projectId).toBeUndefined(); // 落 Inbox
    expect(list.find((t) => t.id === t2.id)!.projectId).toBeUndefined();
  });
});

describe("TasksStore archive（U13/R27）", () => {
  it("done 任务归档：落 archived、从活动列表移除；active 拒绝归档", async () => {
    const store = makeStore();
    const a = await store.add({ title: "已完成事" });
    await store.update(a.id, { status: "done" });
    expect(await store.archive(a.id, "摘要：做完了")).toBe(true);
    expect(await store.list()).toHaveLength(0); // 移出活动列表
    const arch = await store.listArchived();
    expect(arch).toHaveLength(1);
    expect(arch[0]!.summary).toBe("摘要：做完了");
    expect(arch[0]!.originalStatus).toBe("done");

    const b = await store.add({ title: "在办" }); // active
    expect(await store.archive(b.id, "x")).toBe(false); // 拒绝归档在办任务
    expect(await store.list()).toHaveLength(1);
  });
});

describe("TasksStore migrateOnce（幂等）", () => {
  it("首次执行 build 并盖 migratedAt；二次为纯 no-op 返回 false", async () => {
    const store = makeStore();
    const seed = () => ({ ...emptyTasks(), migratedAt: Date.now(), tasks: [], projects: [{ id: "p", name: "旧" }] });
    expect(await store.migrateOnce(seed)).toBe(true);
    expect((await store.listProjects()).map((p) => p.name)).toEqual(["旧"]);
    // 二次：已有 migratedAt → no-op，不再重复 build
    expect(await store.migrateOnce(() => ({ ...emptyTasks(), migratedAt: Date.now(), projects: [{ id: "x", name: "不应出现" }] }))).toBe(false);
    expect((await store.listProjects()).map((p) => p.name)).toEqual(["旧"]);
  });
});

describe("TasksStore 层级（U2）", () => {
  // 写一份含旧格式（无 kind）project 的 tasks.json，触发读时归一化。
  async function seedRaw(projects: unknown[]): Promise<TasksStore> {
    await fsp.writeFile(file, JSON.stringify({ version: 1, tasks: [], projects, archived: [] }), "utf8");
    return makeStore();
  }

  it("normalizeData：旧 project 无 kind 读后为 project；已有 kind 不覆盖；幂等", async () => {
    const store = await seedRaw([
      { id: "a", name: "旧" }, // 无 kind
      { id: "b", name: "夹", kind: "folder" }, // 已有 kind
    ]);
    const projs = await store.listProjects();
    expect(projs.find((p) => p.id === "a")!.kind).toBe("project");
    expect(projs.find((p) => p.id === "b")!.kind).toBe("folder");
    // 幂等：再读一次结果不变
    expect((await store.listProjects()).find((p) => p.id === "a")!.kind).toBe("project");
  });

  it("addProject 带 parentId/kind 落库；parentId 指向不存在 → 降级顶层", async () => {
    const store = makeStore();
    const folder = await store.addProject("公司", { kind: "folder" });
    expect(folder.kind).toBe("folder");
    const child = await store.addProject("鲁尔", { parentId: folder.id, kind: "project" });
    expect(child.parentId).toBe(folder.id);
    const orphan = await store.addProject("野", { parentId: "ghost" });
    expect(orphan.parentId).toBeUndefined(); // 降级顶层
  });

  it("updateProject：rename 生效；reparent 到合法父生效", async () => {
    const store = makeStore();
    const a = await store.addProject("A", { kind: "folder" });
    const b = await store.addProject("B");
    const renamed = await store.updateProject(b.id, { name: "B2" });
    expect(renamed!.name).toBe("B2");
    const moved = await store.updateProject(b.id, { parentId: a.id });
    expect(moved!.parentId).toBe(a.id);
    // 提升到顶层
    const promoted = await store.updateProject(b.id, { parentId: null });
    expect(promoted!.parentId).toBeUndefined();
  });

  it("updateProject：reparent 成自身后代被拒、数据不变；不存在返回 null", async () => {
    const store = makeStore();
    const parent = await store.addProject("父", { kind: "folder" });
    const child = await store.addProject("子", { parentId: parent.id });
    await expect(store.updateProject(parent.id, { parentId: child.id })).rejects.toThrow();
    // 数据未变：父仍在顶层
    expect((await store.listProjects()).find((p) => p.id === parent.id)!.parentId).toBeUndefined();
    expect(await store.updateProject("ghost", { name: "x" })).toBeNull();
  });

  it("deleteProject（folder 含子项目 + 孙任务）：子项目上提到父级、任务回 Inbox、无悬空 parentId", async () => {
    const store = makeStore();
    const top = await store.addProject("顶层夹", { kind: "folder" });
    const mid = await store.addProject("中层夹", { parentId: top.id, kind: "folder" });
    const leaf = await store.addProject("叶项目", { parentId: mid.id, kind: "project" });
    const task = await store.add({ title: "t", projectId: leaf.id });

    // 删中层 folder → 叶项目上提到顶层夹（mid 的父）
    await store.deleteProject(mid.id);
    const projs = await store.listProjects();
    expect(projs.some((p) => p.id === mid.id)).toBe(false);
    expect(projs.find((p) => p.id === leaf.id)!.parentId).toBe(top.id); // 上提、无悬空
    // 叶项目仍在、任务仍挂它（删的是 folder、不含任务）
    expect((await store.list()).find((t) => t.id === task.id)!.projectId).toBe(leaf.id);

    // 删叶项目 → 其任务回 Inbox
    await store.deleteProject(leaf.id);
    expect((await store.list()).find((t) => t.id === task.id)!.projectId).toBeUndefined();
  });
});

describe("TasksStore 完成/丢弃时间戳（U10）", () => {
  it("置 done 写 completedAt；恢复 active 清空", async () => {
    const store = makeStore();
    const t = await store.add({ title: "x" });
    const done = await store.update(t.id, { status: "done" });
    expect(done!.completedAt).toBeGreaterThan(0);
    const back = await store.update(t.id, { status: "active" });
    expect(back!.completedAt).toBeUndefined();
  });

  it("done→dropped：清 completedAt、写 droppedAt", async () => {
    const store = makeStore();
    const t = await store.add({ title: "y" });
    await store.update(t.id, { status: "done" });
    const dropped = await store.update(t.id, { status: "dropped" });
    expect(dropped!.droppedAt).toBeGreaterThan(0);
    expect(dropped!.completedAt).toBeUndefined();
  });

  it("非状态变更的 update 不动时间戳", async () => {
    const store = makeStore();
    const t = await store.add({ title: "z" });
    await store.update(t.id, { status: "done" });
    const renamed = await store.update(t.id, { title: "z2" });
    expect(renamed!.completedAt).toBeGreaterThan(0); // 仍保留
  });
});

describe("TasksStore 重复滚动（U12）", () => {
  it("done 且有 repeat+due → 顺延日期回 active、不落 done、无 completedAt", async () => {
    const store = makeStore();
    const t = await store.add({ title: "r" });
    await store.update(t.id, { dueDate: "2026-07-01", deferDate: "2026-06-30", repeat: { kind: "daily" } });
    const done = await store.update(t.id, { status: "done" });
    expect(done!.status).toBe("active");
    expect(done!.dueDate).toBe("2026-07-02");
    expect(done!.deferDate).toBe("2026-07-01");
    expect(done!.completedAt).toBeUndefined();
  });

  it("结束重复（清 repeat）后 done → 正常完成留 completedAt", async () => {
    const store = makeStore();
    const t = await store.add({ title: "r2" });
    await store.update(t.id, { dueDate: "2026-07-01", repeat: { kind: "daily" } });
    await store.update(t.id, { repeat: undefined });
    const done = await store.update(t.id, { status: "done" });
    expect(done!.status).toBe("done");
    expect(done!.completedAt).toBeGreaterThan(0);
  });

  it("repeat 但无日期锚点 → 落正常 done（无从滚动）", async () => {
    const store = makeStore();
    const t = await store.add({ title: "r3" });
    await store.update(t.id, { repeat: { kind: "daily" } });
    const done = await store.update(t.id, { status: "done" });
    expect(done!.status).toBe("done");
  });
});
