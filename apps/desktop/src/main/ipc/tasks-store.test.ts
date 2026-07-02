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

  it("normalizeData：旧 project 无 mode 读后补 parallel；已有 mode 不覆盖（U8/KTD5）", async () => {
    const store = await seedRaw([
      { id: "a", name: "旧", kind: "project" }, // 无 mode → 默认 parallel（旧档兼容）
      { id: "b", name: "顺序", kind: "project", mode: "sequential" }, // 已有 mode 保留
    ]);
    const projs = await store.listProjects();
    expect(projs.find((p) => p.id === "a")!.mode).toBe("parallel");
    expect(projs.find((p) => p.id === "b")!.mode).toBe("sequential");
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

  it("updateProject：切换 mode 落库，省略 mode 时不动既有值（U8/KTD5）", async () => {
    const store = makeStore();
    const b = await store.addProject("B"); // 新建默认无 mode（读为 parallel）
    const seq = await store.updateProject(b.id, { mode: "sequential" });
    expect(seq!.mode).toBe("sequential");
    // 仅改名（省略 mode）→ mode 保持 sequential 不被清
    const renamed = await store.updateProject(b.id, { name: "B2" });
    expect(renamed!.name).toBe("B2");
    expect(renamed!.mode).toBe("sequential");
    // 切回并行
    const par = await store.updateProject(b.id, { mode: "parallel" });
    expect(par!.mode).toBe("parallel");
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

  it("U14 子日重复（每 30 分钟）：done 滚动时提醒时刻 +30 分、清 firedAt、回 active（日期不动）", async () => {
    const store = makeStore();
    const t = await store.add({ title: "r4" });
    const at = new Date(2026, 7, 14, 9, 0, 0, 0).getTime();
    await store.update(t.id, {
      dueDate: "2026-08-14",
      repeat: { kind: "minutely", interval: 30 },
      reminder: { at, firedAt: 123 },
    });
    const done = await store.update(t.id, { status: "done" });
    expect(done!.status).toBe("active");
    expect(done!.dueDate).toBe("2026-08-14");
    expect(done!.reminder).toEqual({ at: at + 30 * 60_000, firedAt: undefined });
    expect(done!.completedAt).toBeUndefined();
  });

  it("U14 日期类重复（每天）+ 提醒：done 滚动时日期 +1 天、提醒同步平移一天、清 firedAt", async () => {
    const store = makeStore();
    const t = await store.add({ title: "r5" });
    const at = new Date(2026, 6, 1, 9, 0, 0, 0).getTime(); // 2026-07-01 09:00
    await store.update(t.id, { dueDate: "2026-07-01", repeat: { kind: "daily" }, reminder: { at, firedAt: 7 } });
    const done = await store.update(t.id, { status: "done" });
    expect(done!.status).toBe("active");
    expect(done!.dueDate).toBe("2026-07-02");
    expect(done!.reminder).toEqual({ at: new Date(2026, 6, 2, 9, 0, 0, 0).getTime(), firedAt: undefined });
  });
});

describe("TasksStore 附件（U13）", () => {
  const ref = (path: string) => ({ path, name: "a.pdf", mimeType: "application/pdf", sizeBytes: 3 });

  it("新任务读取 attachments 为 undefined（旧档零迁移，不填默认）", async () => {
    const store = makeStore();
    const t = await store.add({ title: "无附件" });
    expect(t.attachments).toBeUndefined();
    const [got] = await store.list();
    expect(got.attachments).toBeUndefined();
  });

  it("addAttachment 追加引用（写回 attachments + 刷新 updatedAt）", async () => {
    const store = makeStore();
    const t = await store.add({ title: "带附件" });
    const a = await store.addAttachment(t.id, ref("/root/task/x1.pdf"));
    expect(a!.attachments).toEqual([ref("/root/task/x1.pdf")]);
    const b = await store.addAttachment(t.id, ref("/root/task/x2.pdf"));
    expect(b!.attachments?.map((x) => x.path)).toEqual(["/root/task/x1.pdf", "/root/task/x2.pdf"]);
    expect(b!.updatedAt).toBeGreaterThanOrEqual(t.updatedAt);
  });

  it("并发 addAttachment 不丢引用（mutate 串行锁内 append）", async () => {
    const store = makeStore();
    const t = await store.add({ title: "并发" });
    await Promise.all([
      store.addAttachment(t.id, ref("/root/task/a.pdf")),
      store.addAttachment(t.id, ref("/root/task/b.pdf")),
      store.addAttachment(t.id, ref("/root/task/c.pdf")),
    ]);
    const [got] = await store.list();
    expect(got.attachments?.map((x) => x.path).sort()).toEqual([
      "/root/task/a.pdf",
      "/root/task/b.pdf",
      "/root/task/c.pdf",
    ]);
  });

  it("removeAttachment 按 path 移除，仅去目标引用", async () => {
    const store = makeStore();
    const t = await store.add({ title: "移除" });
    await store.addAttachment(t.id, ref("/root/task/keep.pdf"));
    await store.addAttachment(t.id, ref("/root/task/drop.pdf"));
    const r = await store.removeAttachment(t.id, "/root/task/drop.pdf");
    expect(r!.attachments?.map((x) => x.path)).toEqual(["/root/task/keep.pdf"]);
  });

  it("任务不存在时 add/removeAttachment 返回 null", async () => {
    const store = makeStore();
    expect(await store.addAttachment("nope", ref("/root/x.pdf"))).toBeNull();
    expect(await store.removeAttachment("nope", "/root/x.pdf")).toBeNull();
  });
});

describe("TasksStore markReminderFired（U11 锁内条件写，防复活 correctness P2）", () => {
  it("提醒仍存在且 at 匹配且未触发 → 写 firedAt 返回 true", async () => {
    const store = makeStore();
    const t = await store.add({ title: "r" });
    await store.update(t.id, { reminder: { at: 1000 } });
    expect(await store.markReminderFired(t.id, 1000, 5000)).toBe(true);
    expect((await store.list()).find((x) => x.id === t.id)!.reminder!.firedAt).toBe(5000);
  });

  it("提醒已删（删除瞬间旧 Cron 触发）→ no-op false，绝不复活", async () => {
    const store = makeStore();
    const t = await store.add({ title: "r2" });
    await store.update(t.id, { reminder: { at: 1000 } });
    await store.update(t.id, { reminder: undefined }); // 用户删提醒
    expect(await store.markReminderFired(t.id, 1000, 5000)).toBe(false);
    expect((await store.list()).find((x) => x.id === t.id)!.reminder).toBeUndefined(); // 未复活
  });

  it("at 不匹配（用户改了时间）或已 firedAt → no-op false", async () => {
    const store = makeStore();
    const t = await store.add({ title: "r3" });
    await store.update(t.id, { reminder: { at: 2000 } });
    expect(await store.markReminderFired(t.id, 1000, 5000)).toBe(false); // 旧 at 不匹配
    await store.markReminderFired(t.id, 2000, 5000); // 正常写一次
    expect(await store.markReminderFired(t.id, 2000, 9000)).toBe(false); // 已 firedAt → 不再写
    expect((await store.list()).find((x) => x.id === t.id)!.reminder!.firedAt).toBe(5000);
  });

  it("任务不存在 → false", async () => {
    const store = makeStore();
    expect(await store.markReminderFired("nope", 1000, 5000)).toBe(false);
  });
});

describe("子任务层级（U2）", () => {
  it("add 带 parentId 落 parentTaskId；父不存在则降级顶层", async () => {
    const store = makeStore();
    const parent = await store.add({ title: "父" });
    const child = await store.add({ title: "子", parentId: parent.id });
    expect(child.parentTaskId).toBe(parent.id);
    // 父不存在 → 降级顶层（parentTaskId undefined），不悬空
    const orphan = await store.add({ title: "游离", parentId: "ghost" });
    expect(orphan.parentTaskId).toBeUndefined();
  });

  it("update 改 parentTaskId 到合法父 → 变；到自身后代 → 拒绝、数据不变", async () => {
    const store = makeStore();
    const a = await store.add({ title: "A" });
    const b = await store.add({ title: "B", parentId: a.id });
    const c = await store.add({ title: "C" });
    // 合法：C 挂到 A 下
    const moved = await store.update(c.id, { parentTaskId: a.id });
    expect(moved!.parentTaskId).toBe(a.id);
    // 成环：把 A 挂到它的后代 B 下 → 拒绝
    await expect(store.update(a.id, { parentTaskId: b.id })).rejects.toThrow(/自身或其子级/);
    expect((await store.list()).find((x) => x.id === a.id)!.parentTaskId).toBeUndefined();
    // 父不存在 → 拒绝
    await expect(store.update(c.id, { parentTaskId: "ghost" })).rejects.toThrow(/不存在/);
    // 提升到顶层：parentTaskId undefined 合法、无需校验
    const promoted = await store.update(b.id, { parentTaskId: undefined });
    expect(promoted!.parentTaskId).toBeUndefined();
  });

  it("delete 父 → 级联删整棵后代子树；删叶子仅删自身", async () => {
    const store = makeStore();
    const root = await store.add({ title: "root" });
    const child = await store.add({ title: "child", parentId: root.id });
    const grand = await store.add({ title: "grand", parentId: child.id });
    const solo = await store.add({ title: "solo" });
    await store.delete(root.id);
    const ids = (await store.list()).map((t) => t.id);
    expect(ids).toEqual([solo.id]); // root/child/grand 全删，solo 留
    expect(ids).not.toContain(child.id);
    expect(ids).not.toContain(grand.id);
    // 删叶子仅删自身
    await store.delete(solo.id);
    expect(await store.list()).toHaveLength(0);
  });
});

// ── 项目管理扩展（参照 IFocus）：成员/岗位/模板 CRUD、阶段孤儿清理、旧档兼容 ──────────
describe("TasksStore 团队成员（资源管理）", () => {
  it("成员 CRUD：add trim 姓名/岗位、update 局部改、role 空串清除岗位", async () => {
    const store = makeStore();
    expect(await store.listMembers()).toEqual([]); // 旧档无 members → 空库

    const m = await store.addMember({ name: "  jone ", role: " 开发 " });
    expect(m.id.startsWith("member-")).toBe(true);
    expect(m).toMatchObject({ name: "jone", role: "开发" });

    const renamed = await store.updateMember(m.id, { name: "jone2" });
    expect(renamed).toMatchObject({ name: "jone2", role: "开发" }); // role 省略不改

    const cleared = await store.updateMember(m.id, { role: "" });
    expect(cleared!.role).toBeUndefined(); // 空串 = 清除岗位

    expect(await store.updateMember("member-nope", { name: "x" })).toBeNull();
  });

  it("deleteMember 级联把任务 memberIds 与工时分配 memberHours 里的该 id 一并移除（防悬空引用）", async () => {
    const store = makeStore();
    const a = await store.addMember({ name: "a" });
    const b = await store.addMember({ name: "b" });
    const t1 = await store.add({ title: "t1" });
    const t2 = await store.add({ title: "t2" });
    await store.update(t1.id, { memberIds: [a.id, b.id], memberHours: { [a.id]: 8, [b.id]: 4 } });
    await store.update(t2.id, { memberIds: [b.id] });

    await store.deleteMember(a.id);
    expect((await store.listMembers()).map((m) => m.id)).toEqual([b.id]);
    const tasks = await store.list();
    expect(tasks.find((t) => t.id === t1.id)!.memberIds).toEqual([b.id]);
    expect(tasks.find((t) => t.id === t1.id)!.memberHours).toEqual({ [b.id]: 4 }); // a 的工时被清
    expect(tasks.find((t) => t.id === t2.id)!.memberIds).toEqual([b.id]); // 未引用者不动

    // 删掉 b 后 t1 的工时分配表整体清空（不留空对象）。
    await store.deleteMember(b.id);
    const after = await store.list();
    expect(after.find((t) => t.id === t1.id)!.memberHours).toBeUndefined();
    expect(after.find((t) => t.id === t1.id)!.memberIds).toEqual([]);
  });
});

describe("TasksStore 岗位标签库", () => {
  it("未 set 时 listJobTypes 为 undefined（默认表由 core resolve，不落盘）", async () => {
    const store = makeStore();
    expect(await store.listJobTypes()).toBeUndefined();
  });

  it("setJobTypes 整表替换（trim + 去空项）并落盘，含删空 []", async () => {
    const store = makeStore();
    expect(await store.setJobTypes([" 开发 ", "", "运营"])).toEqual(["开发", "运营"]);
    expect(await store.listJobTypes()).toEqual(["开发", "运营"]);
    await store.setJobTypes([]);
    expect(await store.listJobTypes()).toEqual([]); // 删空是有效状态，不回退 undefined
  });
});

describe("TasksStore 自定义阶段模板", () => {
  it("模板 CRUD：add 清洗阶段名、update 局部改、delete 移除", async () => {
    const store = makeStore();
    const tpl = await store.addStageTemplate({ name: " 我的模板 ", description: "", stages: [" a ", "", "b"] });
    expect(tpl.id.startsWith("tpl-")).toBe(true);
    expect(tpl).toMatchObject({ name: "我的模板", stages: ["a", "b"] });
    expect(tpl.description).toBeUndefined(); // 空串描述归 undefined

    const updated = await store.updateStageTemplate(tpl.id, { stages: ["x"] });
    expect(updated!.stages).toEqual(["x"]);
    expect(updated!.name).toBe("我的模板"); // 省略不改

    await store.deleteStageTemplate(tpl.id);
    expect(await store.listStageTemplates()).toEqual([]);
    expect(await store.updateStageTemplate(tpl.id, { name: "x" })).toBeNull();
  });
});

describe("TasksStore 项目阶段（stages）", () => {
  const mkStages = (ids: string[]) =>
    ids.map((id, i) => ({ id, name: id, status: "not-started" as const, order: i }));

  it("addProject 带 stages/note/status 一次落库", async () => {
    const store = makeStore();
    const p = await store.addProject("发布计划", { stages: mkStages(["s1", "s2"]), note: "描述", status: "active" });
    const got = (await store.listProjects()).find((x) => x.id === p.id)!;
    expect(got.stages!.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(got.note).toBe("描述");
    expect(got.status).toBe("active");
  });

  it("updateProject 替换 stages 收缩时清孤儿 stageId（同锁级联）", async () => {
    const store = makeStore();
    const p = await store.addProject("p", { stages: mkStages(["s1", "s2"]) });
    const t1 = await store.add({ title: "t1", projectId: p.id });
    const t2 = await store.add({ title: "t2", projectId: p.id });
    await store.update(t1.id, { stageId: "s1" });
    await store.update(t2.id, { stageId: "s2" });

    await store.updateProject(p.id, { stages: mkStages(["s2"]) }); // 删掉 s1
    const tasks = await store.list();
    expect(tasks.find((t) => t.id === t1.id)!.stageId).toBeUndefined(); // 孤儿清空
    expect(tasks.find((t) => t.id === t2.id)!.stageId).toBe("s2"); // 幸存阶段不动
  });

  it("updateProject 省略 stages/note/status 时不动既有值", async () => {
    const store = makeStore();
    const p = await store.addProject("p", { stages: mkStages(["s1"]), note: "n", status: "on-hold" });
    const next = await store.updateProject(p.id, { name: "p2" });
    expect(next!.stages!.map((s) => s.id)).toEqual(["s1"]);
    expect(next!.note).toBe("n");
    expect(next!.status).toBe("on-hold");
  });

  it("normalizeData 为缺 status/order 的旧 stages 补默认（读时零迁移）", async () => {
    await fsp.writeFile(
      file,
      JSON.stringify({
        version: 1,
        tasks: [],
        projects: [{ id: "p1", name: "旧项目", stages: [{ id: "s1", name: "调研" }, { id: "s2", name: "开发" }] }],
        archived: [],
      }),
      "utf8",
    );
    const store = makeStore();
    const p = (await store.listProjects())[0];
    expect(p.stages).toEqual([
      { id: "s1", name: "调研", status: "not-started", order: 0 },
      { id: "s2", name: "开发", status: "not-started", order: 1 },
    ]);
  });
});

describe("TasksStore 旧档兼容（无项目管理扩展字段）", () => {
  it("version=1 且无 members/jobTypes/stageTemplates 的旧档合法读取、不判损坏", async () => {
    await fsp.writeFile(
      file,
      JSON.stringify({ version: 1, tasks: [], projects: [{ id: "p", name: "p" }], archived: [] }),
      "utf8",
    );
    const store = makeStore();
    expect(await store.listMembers()).toEqual([]);
    expect(await store.listJobTypes()).toBeUndefined();
    expect(await store.listStageTemplates()).toEqual([]);
    expect((await store.listProjects())[0].stages).toBeUndefined();
    // 未触发任何 mutation 前不应生成 .corrupt。
    await expect(fsp.stat(file + ".corrupt")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
