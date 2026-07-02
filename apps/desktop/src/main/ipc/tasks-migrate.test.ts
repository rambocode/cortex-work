// v1→v2 迁移编排的数据安全单测：强制 .bak 备份、迁移成功后才剥 todos、幂等、空/缺失短路。
// 用真实 TasksStore（不依赖 electron）+ 临时文件；仅 mock electron 使 paths.ts 的 `app` import 可解析。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/fake-userdata" } }));

import { migrateWorkspaceTodos } from "./tasks-migrate";
import { TasksStore } from "./tasks-store";

let dir: string;
let wsPath: string;
let tasksPath: string;

function makeStore(): TasksStore {
  return new TasksStore({ tasksStorePath: () => tasksPath });
}

async function writeWs(obj: unknown): Promise<void> {
  await fsp.writeFile(wsPath, JSON.stringify(obj, null, 2), "utf8");
}
async function readWs(): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(wsPath, "utf8"));
}
async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), "tasks-migrate-"));
  wsPath = join(dir, "personal-workspace.json");
  tasksPath = join(dir, "tasks.json");
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("migrateWorkspaceTodos", () => {
  it("迁移：建 .bak、tasks.json 落库、personal-workspace.todos 剥离、projects/sessions 保留", async () => {
    await writeWs({
      version: 1,
      projects: [{ id: "p1", name: "工作", path: "/x" }],
      sessions: [{ id: "s1" }],
      todos: [{ id: "old1", projectId: "p1", title: "回邮件", status: "done", detailPath: "/nonexistent.md", createdAt: 5, updatedAt: 9 }],
    });
    const store = makeStore();
    const migrated = await migrateWorkspaceTodos(store, wsPath);
    expect(migrated).toBe(true);

    // .bak 一定生成（改动源数据前）
    expect(await fileExists(wsPath + ".bak")).toBe(true);

    // tasks.json 落库：1 条 done 任务，按项目名建 task-project
    const tasks = await store.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe("done");
    expect(tasks[0]!.migratedFrom).toBe("old1");
    const projects = await store.listProjects();
    expect(projects.map((p) => p.name)).toEqual(["工作"]);
    expect(tasks[0]!.projectId).toBe(projects[0]!.id);

    // personal-workspace.todos 剥离，其它字段保留、版本不 bump
    const ws = await readWs();
    expect("todos" in ws).toBe(false);
    expect(ws.version).toBe(1); // 不 bump
    expect(ws.projects).toHaveLength(1);
    expect(ws.sessions).toHaveLength(1);
  });

  it("幂等：迁移后再调返回 false，不重复迁移、不再动源文件", async () => {
    await writeWs({
      version: 1,
      projects: [],
      sessions: [],
      todos: [{ id: "old1", title: "a", status: "open", detailPath: "", createdAt: 0, updatedAt: 0 }],
    });
    const store = makeStore();
    expect(await migrateWorkspaceTodos(store, wsPath)).toBe(true);
    expect((await store.list())).toHaveLength(1);
    // 第二次：todos 已剥离 → 短路 false，任务数不翻倍
    expect(await migrateWorkspaceTodos(store, wsPath)).toBe(false);
    expect((await store.list())).toHaveLength(1);
  });

  it("空 todos → 短路 false，不建 .bak、不写 tasks.json", async () => {
    await writeWs({ version: 1, projects: [], sessions: [], todos: [] });
    const store = makeStore();
    expect(await migrateWorkspaceTodos(store, wsPath)).toBe(false);
    expect(await fileExists(wsPath + ".bak")).toBe(false);
    expect(await fileExists(tasksPath)).toBe(false);
  });

  it("无 personal-workspace.json（全新安装）→ 短路 false", async () => {
    const store = makeStore();
    expect(await migrateWorkspaceTodos(store, wsPath)).toBe(false);
  });

  it("坏数据：detailPath 指向不存在文件 → 任务仍迁移、notes 空，不阻断", async () => {
    await writeWs({
      version: 1,
      projects: [],
      sessions: [],
      todos: [{ id: "a", title: "a", status: "open", detailPath: "/gone.md", createdAt: 0, updatedAt: 0 }],
    });
    const store = makeStore();
    expect(await migrateWorkspaceTodos(store, wsPath)).toBe(true);
    const tasks = await store.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.notes).toBeUndefined();
  });
});
