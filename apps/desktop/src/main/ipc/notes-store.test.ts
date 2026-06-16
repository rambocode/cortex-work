// 闪记存储核心（不依赖 electron）的单测：原子写、并发串行、坏文件回退、
// 无 projectId 存取、list 过滤、update 字段级合并、delete 仅删自身。
// electron 绑定层（ipcMain.handle / broadcast）人工验证。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fsp } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  NotesStore,
  newNoteId,
  type NotesStoreDeps,
} from "./notes-store";

let dir: string;
let file: string;

function makeStore(): NotesStore {
  const deps: NotesStoreDeps = { notesStorePath: () => file };
  return new NotesStore(deps);
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), "notes-store-"));
  file = join(dir, "notes.json");
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("newNoteId", () => {
  it("生成 note- 前缀且唯一", () => {
    const a = newNoteId();
    const b = newNoteId();
    expect(a.startsWith("note-")).toBe(true);
    expect(b.startsWith("note-")).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("NotesStore happy path", () => {
  it("add 后 list 能取回；含 main 生成的 id/status/时间戳", async () => {
    const store = makeStore();
    const meta = await store.add({ projectId: "p1", content: "hello" });
    expect(meta.id.startsWith("note-")).toBe(true);
    expect(meta.status).toBe("draft");
    expect(meta.projectId).toBe("p1");
    expect(meta.content).toBe("hello");
    expect(meta.createdAt).toBeTypeOf("number");
    expect(meta.updatedAt).toBe(meta.createdAt);

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(meta.id);
  });

  it("写盘后内容可被新实例（冷读）取回——原子写落盘有效", async () => {
    const store = makeStore();
    const meta = await store.add({ content: "persisted" });
    await store.flush();

    const raw = await fsp.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.notes).toHaveLength(1);
    // JSON.stringify(data, null, 2) → 2 空格缩进,人类可读
    expect(raw).toContain("\n  \"version\": 1");

    const fresh = makeStore();
    const list = await fresh.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(meta.id);
  });
});

describe("NotesStore 并发 / 边界", () => {
  it("并发两次 add 串行不交错、不丢", async () => {
    const store = makeStore();
    const [a, b] = await Promise.all([
      store.add({ content: "first" }),
      store.add({ content: "second" }),
    ]);
    expect(a.id).not.toBe(b.id);
    await store.flush();

    const fresh = makeStore();
    const list = await fresh.list();
    expect(list).toHaveLength(2);
    const ids = list.map((n) => n.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it("坏文件（非法 JSON）回退空列表,不抛错", async () => {
    await fsp.writeFile(file, "{ this is not json", "utf8");
    const store = makeStore();
    const list = await store.list();
    expect(list).toEqual([]);
  });

  it("version 不匹配的文件回退空列表", async () => {
    await fsp.writeFile(file, JSON.stringify({ version: 2, notes: [] }), "utf8");
    const store = makeStore();
    expect(await store.list()).toEqual([]);
  });

  it("无 projectId（未归类）可存取", async () => {
    const store = makeStore();
    const meta = await store.add({ content: "unassigned" });
    expect(meta.projectId).toBeUndefined();
    const list = await store.list();
    expect(list[0].projectId).toBeUndefined();
  });
});

describe("NotesStore list 过滤", () => {
  it("无 projectId 返回全部；有 projectId 严格相等过滤（不含 undefined）", async () => {
    const store = makeStore();
    await store.add({ projectId: "p1", content: "a" });
    await store.add({ projectId: "p2", content: "b" });
    await store.add({ content: "c" }); // 未归类

    expect(await store.list()).toHaveLength(3);
    const p1 = await store.list("p1");
    expect(p1).toHaveLength(1);
    expect(p1[0].content).toBe("a");
    // 未归类不应被任何 projectId 过滤命中
    expect(await store.list("p2")).toHaveLength(1);
  });
});

describe("NotesStore update", () => {
  it("字段级合并并刷新 updatedAt", async () => {
    const store = makeStore();
    const meta = await store.add({ content: "orig", projectId: "p1" });
    const created = meta.createdAt;
    await new Promise((r) => setTimeout(r, 2));

    const updated = await store.update(meta.id, { content: "edited" });
    expect(updated).not.toBeNull();
    expect(updated!.content).toBe("edited");
    expect(updated!.projectId).toBe("p1"); // 未传的字段保留
    expect(updated!.createdAt).toBe(created); // createdAt 不变
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(created);

    const fresh = makeStore();
    const list = await fresh.list();
    expect(list[0].content).toBe("edited");
  });

  it("找不到 id 返回 null", async () => {
    const store = makeStore();
    expect(await store.update("missing", { content: "x" })).toBeNull();
  });

  it("conversationIds / docPaths 由调用方传完整数组（整体替换,不 merge）", async () => {
    const store = makeStore();
    const meta = await store.add({ content: "x" });
    await store.update(meta.id, { conversationIds: ["c1"], docPaths: ["d1"] });
    const after = await store.update(meta.id, { conversationIds: ["c1", "c2"] });
    expect(after!.conversationIds).toEqual(["c1", "c2"]);
    expect(after!.docPaths).toEqual(["d1"]); // 未传则保留
  });
});

describe("NotesStore delete", () => {
  it("仅删自身,不触碰其它", async () => {
    const store = makeStore();
    const a = await store.add({ content: "a" });
    const b = await store.add({ content: "b" });
    await store.delete(a.id);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(b.id);

    await store.flush();
    const fresh = makeStore();
    expect((await fresh.list()).map((n) => n.id)).toEqual([b.id]);
  });

  it("删不存在的 id 不抛错", async () => {
    const store = makeStore();
    await store.add({ content: "a" });
    await expect(store.delete("missing")).resolves.toBeUndefined();
    expect(await store.list()).toHaveLength(1);
  });
});
