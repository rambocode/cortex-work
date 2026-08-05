import { promises as fsp } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CACHE_MAX_ENTRIES,
  cacheStats,
  clearCache,
  listSpriteMetas,
  pruneSprites,
  readManifest,
  readSpriteMeta,
  spriteFilePath,
  touchSprite,
  writeManifest,
  writeSprite,
  type SpriteMeta,
} from "./petdex-cache";

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), "petdex-cache-"));
});
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

function meta(slug: string, over: Partial<SpriteMeta> = {}): SpriteMeta {
  return {
    slug,
    displayName: slug,
    revision: "r1",
    width: 1536,
    height: 1872,
    cols: 8,
    rows: 9,
    bytes: 1000,
    fetchedAt: 1,
    lastUsedAt: 1,
    ...over,
  };
}

describe("manifest 读写", () => {
  it("往返一致", async () => {
    await writeManifest(root, { fetchedAt: 5, etag: "e", total: 1, pets: [] });
    expect(await readManifest(root)).toEqual({ fetchedAt: 5, etag: "e", total: 1, pets: [] });
  });

  it("不存在 → null", async () => {
    expect(await readManifest(root)).toBeNull();
  });

  // 损坏的缓存不能让整个图鉴打不开,只当作「没有缓存」。
  it("损坏 JSON → null 而非抛错", async () => {
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(join(root, "manifest.json"), "{ not json");
    expect(await readManifest(root)).toBeNull();
  });
});

describe("sprite 读写", () => {
  it("写入后可读回元信息", async () => {
    await writeSprite(root, Buffer.from("img"), meta("cat"));
    expect(await readSpriteMeta(root, "cat")).toMatchObject({ slug: "cat", cols: 8, rows: 9 });
  });

  // 元信息在、图不在 = 假命中,会让渲染端拿到一个 404 的 URL。
  it("图被删掉后视为未缓存", async () => {
    await writeSprite(root, Buffer.from("img"), meta("cat"));
    await fsp.rm(spriteFilePath(root, "cat"));
    expect(await readSpriteMeta(root, "cat")).toBeNull();
  });

  it("touch 刷新 lastUsedAt", async () => {
    await writeSprite(root, Buffer.from("img"), meta("cat", { lastUsedAt: 1 }));
    await touchSprite(root, "cat");
    expect((await readSpriteMeta(root, "cat"))!.lastUsedAt).toBeGreaterThan(1);
  });
});

describe("LRU 淘汰", () => {
  async function seed(count: number) {
    for (let i = 0; i < count; i++) {
      await writeSprite(root, Buffer.from("x"), meta(`p${i}`, { lastUsedAt: i + 1 }));
    }
  }

  it("未超上限时不动任何文件", async () => {
    await seed(5);
    await pruneSprites(root);
    expect((await listSpriteMetas(root)).length).toBe(5);
  });

  it("超出条数上限时从最旧的开始删", async () => {
    await seed(CACHE_MAX_ENTRIES + 5);
    await pruneSprites(root);
    const left = (await listSpriteMetas(root)).map((m) => m.slug);
    expect(left.length).toBe(CACHE_MAX_ENTRIES);
    expect(left).not.toContain("p0"); // 最旧的被淘汰
    expect(left).toContain(`p${CACHE_MAX_ENTRIES + 4}`); // 最新的留着
  });

  // 当前选中的宠物被淘汰 = 用户重启后自己的宠物没了,这是不能接受的。
  it("当前选中的宠物即使最旧也不被淘汰", async () => {
    await seed(CACHE_MAX_ENTRIES + 5);
    await pruneSprites(root, "p0");
    expect((await listSpriteMetas(root)).map((m) => m.slug)).toContain("p0");
  });

  it("恒定保留最近使用的 3 只", async () => {
    await seed(CACHE_MAX_ENTRIES + 5);
    await pruneSprites(root);
    const left = (await listSpriteMetas(root)).map((m) => m.slug);
    const newest = CACHE_MAX_ENTRIES + 4;
    expect(left).toEqual(expect.arrayContaining([`p${newest}`, `p${newest - 1}`, `p${newest - 2}`]));
  });
});

describe("统计与清空", () => {
  it("统计条数与总字节", async () => {
    await writeSprite(root, Buffer.from("a"), meta("a", { bytes: 100 }));
    await writeSprite(root, Buffer.from("b"), meta("b", { bytes: 250 }));
    expect(await cacheStats(root)).toEqual({ entries: 2, bytes: 350 });
  });

  it("清空后统计归零", async () => {
    await writeSprite(root, Buffer.from("a"), meta("a"));
    await clearCache(root);
    expect(await cacheStats(root)).toEqual({ entries: 0, bytes: 0 });
  });

  it("空目录统计不抛错", async () => {
    expect(await cacheStats(root)).toEqual({ entries: 0, bytes: 0 });
  });
});
