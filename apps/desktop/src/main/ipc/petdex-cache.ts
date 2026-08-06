// petdex 图鉴的磁盘缓存。纯 fs 逻辑,**缓存根由调用方传入**(不直接读 paths),
// 这样单测可以指向临时目录,不必起 Electron —— 沿用 ipc/image.ts 的做法。
//
// 缓存是离线兜底的载体:宠物是常驻 overlay,重启电脑没网时不能变成白板。
// 所有网络失败路径都退回这里的旧副本,而不是报错。

import { promises as fsp } from "fs";
import { join } from "path";
import type { PetdexEntry } from "./types-petdex";

/** 磁盘上的图鉴索引。etag 用于下次条件请求,命中 304 就只更新 fetchedAt。 */
export interface CachedManifest {
  fetchedAt: number;
  etag?: string;
  total: number;
  pets: PetdexEntry[];
}

/** 单只 sprite 的旁挂元信息(与 <slug>.webp 同目录的 <slug>.json)。 */
export interface SpriteMeta {
  slug: string;
  displayName: string;
  etag?: string;
  /** 缓存击穿标记,拼进 URL 的 ?v=。内容变了它必须变,否则 Chromium 会用旧解码结果。 */
  revision: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
  bytes: number;
  fetchedAt: number;
  /** LRU 淘汰依据。 */
  lastUsedAt: number;
}

/** 缓存上限。sprite 单张 1.2~2.5MB,24 条约 50MB,对装饰性功能足够。 */
export const CACHE_MAX_ENTRIES = 24;
export const CACHE_MAX_BYTES = 200 * 1024 * 1024;
/** 无论如何都保留的最近使用条数:用户在图鉴里来回试宠物时不该反复重下。 */
const KEEP_RECENT = 3;

const manifestPathIn = (root: string) => join(root, "manifest.json");
const spritesDirIn = (root: string) => join(root, "sprites");
export const spriteFilePath = (root: string, slug: string) => join(spritesDirIn(root), `${slug}.webp`);
const metaFilePath = (root: string, slug: string) => join(spritesDirIn(root), `${slug}.json`);

/** tmp + rename 原子写:半截文件会让下次启动读到损坏 JSON(仿 ipc/pet-store.ts)。 */
async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  await fsp.mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(path, "utf8")) as T;
  } catch {
    return null; // 不存在或损坏一律当「没有缓存」,不阻断
  }
}

// ── manifest ────────────────────────────────────────────────────────────────

export async function readManifest(root: string): Promise<CachedManifest | null> {
  const m = await readJson<CachedManifest>(manifestPathIn(root));
  return Array.isArray(m?.pets) ? m : null;
}

export async function writeManifest(root: string, m: CachedManifest): Promise<void> {
  await writeAtomic(manifestPathIn(root), JSON.stringify(m));
}

// ── sprite ──────────────────────────────────────────────────────────────────

export async function readSpriteMeta(root: string, slug: string): Promise<SpriteMeta | null> {
  const meta = await readJson<SpriteMeta>(metaFilePath(root, slug));
  if (!meta) return null;
  // 元信息在但图没了(手工删过 / 写一半崩了)→ 当作没缓存,让调用方重下。
  try {
    await fsp.access(spriteFilePath(root, slug));
  } catch {
    return null;
  }
  return meta;
}

export async function writeSprite(root: string, bytes: Buffer, meta: SpriteMeta): Promise<void> {
  await fsp.mkdir(spritesDirIn(root), { recursive: true });
  // 先写图再写元信息:反过来的话中途崩溃会留下「元信息说有、图却没有」的假命中。
  await writeAtomic(spriteFilePath(root, meta.slug), bytes);
  await writeAtomic(metaFilePath(root, meta.slug), JSON.stringify(meta));
}

/** 只更新元信息,不碰图本身(条件请求命中 304 时用:内容没变,只需把有效期往后推)。 */
export async function writeSpriteMeta(root: string, meta: SpriteMeta): Promise<void> {
  await fsp.mkdir(spritesDirIn(root), { recursive: true });
  await writeAtomic(metaFilePath(root, meta.slug), JSON.stringify(meta));
}

/** 刷新最近使用时刻(LRU 依据)。失败静默——这只是淘汰排序的输入,不值得打断读取。 */
export async function touchSprite(root: string, slug: string): Promise<void> {
  const meta = await readSpriteMeta(root, slug);
  if (!meta) return;
  try {
    await writeAtomic(metaFilePath(root, slug), JSON.stringify({ ...meta, lastUsedAt: Date.now() }));
  } catch {
    /* 忽略 */
  }
}

export async function listSpriteMetas(root: string): Promise<SpriteMeta[]> {
  let names: string[];
  try {
    names = await fsp.readdir(spritesDirIn(root));
  } catch {
    return [];
  }
  const metas = await Promise.all(
    names.filter((n) => n.endsWith(".json")).map((n) => readJson<SpriteMeta>(join(spritesDirIn(root), n))),
  );
  return metas.filter((m): m is SpriteMeta => !!m?.slug);
}

async function removeSprite(root: string, slug: string): Promise<void> {
  await Promise.all([
    fsp.rm(spriteFilePath(root, slug), { force: true }),
    fsp.rm(metaFilePath(root, slug), { force: true }),
  ]);
}

/**
 * LRU 淘汰:按最近使用时刻从旧到新删,直到条数与总字节都回到上限内。
 * `pinned` 是当前选中的宠物 —— 它绝不能被淘汰,否则用户重启后自己的宠物没了。
 * 另外恒定保留最近使用的 KEEP_RECENT 只。
 */
export async function pruneSprites(root: string, pinned?: string): Promise<void> {
  const metas = await listSpriteMetas(root);
  const totalBytes = metas.reduce((sum, m) => sum + (m.bytes || 0), 0);
  if (metas.length <= CACHE_MAX_ENTRIES && totalBytes <= CACHE_MAX_BYTES) return;

  const byRecency = [...metas].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  const protectedSlugs = new Set(byRecency.slice(0, KEEP_RECENT).map((m) => m.slug));
  if (pinned) protectedSlugs.add(pinned);

  let entries = metas.length;
  let bytes = totalBytes;
  // 从最旧的开始考察
  for (const meta of [...byRecency].reverse()) {
    if (entries <= CACHE_MAX_ENTRIES && bytes <= CACHE_MAX_BYTES) break;
    if (protectedSlugs.has(meta.slug)) continue;
    await removeSprite(root, meta.slug);
    entries -= 1;
    bytes -= meta.bytes || 0;
  }
}

export async function cacheStats(root: string): Promise<{ entries: number; bytes: number }> {
  const metas = await listSpriteMetas(root);
  return { entries: metas.length, bytes: metas.reduce((sum, m) => sum + (m.bytes || 0), 0) };
}

/** 清空整个缓存目录(含 manifest)。用户在设置里主动点「清空」时调用。 */
export async function clearCache(root: string): Promise<void> {
  await fsp.rm(root, { recursive: true, force: true });
}
