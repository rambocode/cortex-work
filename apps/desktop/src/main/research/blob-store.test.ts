// ResearchBlobStore 的行为契约（默认轮，真临时目录）。
//
// 用真 fs 而不是假替身：这里要验证的恰恰是「gzip 往返、tmp+rename 原子写、GC 真的删文件」
// 这些只有真文件系统才能证伪的性质；目录经构造器注入，测试之间互不干扰。
import { promises as fsp } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResearchBlobStore } from "./blob-store";
import { fixtureHash } from "./repository-fixtures";

let root = "";
let store: ResearchBlobStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cre-blob-"));
  store = new ResearchBlobStore({
    blobsDir: () => join(root, "blobs"),
    tmpDir: () => join(root, "tmp"),
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ResearchBlobStore", () => {
  it("写入返回 blob: 引用，读回原文（含多字节与超长正文）", async () => {
    const hash = fixtureHash("doc1");
    const text = `标题\n${"正文段落 ".repeat(5000)}\nend`;
    const ref = await store.putBlob(hash, text);
    expect(ref).toBe(`blob:${hash}`);
    expect(await store.getBlob(ref)).toBe(text);
  });

  it("正文经 gzip 压缩落盘，不是明文", async () => {
    const hash = fixtureHash("doc1");
    await store.putBlob(hash, "PLAINTEXT_MARKER".repeat(200));
    const raw = await fsp.readFile(join(root, "blobs", `${hash}.gz`));
    expect(raw.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(raw.toString("latin1")).not.toContain("PLAINTEXT_MARKER");
  });

  it("不存在的 blob 返回 null", async () => {
    expect(await store.getBlob(`blob:${fixtureHash("nope")}`)).toBeNull();
  });

  it("同哈希重复写入是幂等的，不留下 tmp 残留", async () => {
    const hash = fixtureHash("doc1");
    await store.putBlob(hash, "第一次");
    await store.putBlob(hash, "第一次");
    expect(await fsp.readdir(join(root, "blobs"))).toEqual([`${hash}.gz`]);
    expect(await fsp.readdir(join(root, "tmp"))).toEqual([]);
  });

  it("拒绝非法 contentHash（路径穿越、大写、长度不符）", async () => {
    for (const bad of [
      "../../etc/passwd",
      `../${fixtureHash("doc1")}`,
      fixtureHash("doc1").toUpperCase(),
      "abc",
      `${fixtureHash("doc1")}/x`,
      "",
    ]) {
      await expect(store.putBlob(bad, "x")).rejects.toThrow(/contentHash/);
    }
  });

  it("拒绝畸形 contentRef（缺前缀或哈希非法）", async () => {
    for (const bad of ["blob:../x", `${fixtureHash("doc1")}`, "blob:", "file:///etc/passwd"]) {
      await expect(store.getBlob(bad)).rejects.toThrow(/contentRef/);
    }
  });

  it("gcOrphanBlobs 只删未被引用的 blob，返回删除数量", async () => {
    const kept = fixtureHash("doc1");
    const orphanA = fixtureHash("doc2");
    const orphanB = fixtureHash("doc3");
    await store.putBlob(kept, "保留");
    await store.putBlob(orphanA, "孤儿 A");
    await store.putBlob(orphanB, "孤儿 B");

    const removed = await store.gcOrphanBlobs(new Set([kept]));
    expect(removed).toBe(2);
    expect((await fsp.readdir(join(root, "blobs"))).sort()).toEqual([`${kept}.gz`]);
    expect(await store.getBlob(`blob:${kept}`)).toBe("保留");
  });

  it("gcOrphanBlobs 忽略不符合命名约定的文件，不误删", async () => {
    await fsp.mkdir(join(root, "blobs"), { recursive: true });
    await fsp.writeFile(join(root, "blobs", "README.txt"), "手工放进来的文件");
    await store.putBlob(fixtureHash("doc2"), "孤儿");

    expect(await store.gcOrphanBlobs(new Set())).toBe(1);
    expect((await fsp.readdir(join(root, "blobs"))).sort()).toEqual(["README.txt"]);
  });

  it("blobs 目录尚未创建时 GC 返回 0 而非抛错", async () => {
    expect(await store.gcOrphanBlobs(new Set())).toBe(0);
  });
});
