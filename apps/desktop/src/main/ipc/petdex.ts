// petdex 公共宠物图鉴(https://petdex.dev)的主进程域:拉取 + 磁盘缓存 + 只读协议。
//
// 与相邻的 ipc/pet.ts 刻意分成两个域:那边是「状态镜像的单向广播」(全 send、零 invoke),
// 这边是「请求-响应的资源获取 + 磁盘缓存」,失败模型与生命周期完全不同,混在一起会让
// 45 行的 pet.ts 变成三百行的杂物间。
//
// 为什么 Desktop 走主进程而不是让渲染端直连(petdex 的 CORS 是全开的,直连技术上可行):
//   1. 离线兜底是宠物的核心价值——它是常驻 overlay,重启没网时不能变白板;渲染端直连
//      拿不到磁盘缓存,而 overlay 是 file:// 页面,storage 与主窗口不同源、无法共享。
//   2. 出网白名单/大小上限/超时集中在一处可审计(见 petdex-security.ts)。
// Web 端没有主进程,直连即可(见 views 侧的 petdexSource)。

import { ipcMain, protocol, app } from "electron";
import { createHash } from "crypto";
import { promises as fsp } from "fs";
import { basename } from "path";
import { detectPetdexGrid } from "@cortex-work/core/pet/grid";
import { petdexDir, petdexSpritesDir } from "../paths";
import { createLogger } from "../log";
import {
  cacheStats,
  clearCache,
  pruneSprites,
  readManifest,
  readSpriteMeta,
  spriteFilePath,
  touchSprite,
  writeManifest,
  writeSprite,
  writeSpriteMeta,
  type SpriteMeta,
} from "./petdex-cache";
import { assertPetdexAssetUrl, assertWithinSpritesDir, parseWebpSize, safeSlug } from "./petdex-security";
import type { PetdexCacheStats, PetdexEntry, PetdexManifestResult, PetdexSpriteRef } from "./types-petdex";

const log = createLogger("petdex");

const MANIFEST_URL = "https://assets.petdex.dev/manifests/petdex-v1.json";
/** 实测 manifest 1.4MB、单张 sprite 1.2~2.5MB,各留数倍余量。 */
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
const SPRITE_MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
/** 图鉴索引本地有效期。上游的 max-age=60 是给 CDN 边缘的;新增宠物不是分钟级需求。 */
const MANIFEST_TTL_MS = 6 * 60 * 60 * 1000;
/** sprite 本地有效期。过期后也只发条件请求,304 就继续用旧文件。 */
const SPRITE_TTL_MS = 24 * 60 * 60 * 1000;

/** 只读地把已缓存 sprite 提供给渲染进程的自定义协议。 */
export const PETDEX_SCHEME = "cortex-petdex";

const VALID_KINDS = new Set(["character", "creature", "object"]);

/** 显式带常规 UA:实测 petdex 会对 Python-urllib 之类的 UA 返 403,Node 默认 UA 同样有风险。 */
function userAgent(): string {
  return `CortexDesktop/${app.getVersion()} (+https://cortex.ai)`;
}

interface FetchResult {
  status: number;
  etag?: string;
  body: Buffer;
}

/**
 * 带上限的流式下载。累计超过 maxBytes 立即 cancel,不会把超大响应全量读进堆后才抛错
 * (这也是为什么不用 res.arrayBuffer()——那样 8MB 上限对一个声称 2GB 的响应毫无意义)。
 * 没有复用 media-gen 的 streamDownloadToBuffer:那个签名不支持自定义请求头,
 * 而这里必须带 UA 与 If-None-Match、并且要把响应的 ETag 读回来。
 */
async function fetchLimited(url: string, opts: { etag?: string; maxBytes: number }): Promise<FetchResult> {
  assertPetdexAssetUrl(url);
  const headers: Record<string, string> = { "user-agent": userAgent() };
  if (opts.etag) headers["if-none-match"] = opts.etag;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 304) return { status: 304, etag: opts.etag, body: Buffer.alloc(0) };
  if (!res.ok) throw new Error(`petdex: HTTP ${res.status} ${url}`);
  if (!res.body) throw new Error(`petdex: 响应缺少 body ${url}`);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > opts.maxBytes) {
      await reader.cancel();
      throw new Error(`petdex: 响应超过 ${opts.maxBytes} 字节上限 ${url}`);
    }
    chunks.push(value);
  }
  return { status: res.status, etag: res.headers.get("etag") ?? undefined, body: Buffer.concat(chunks) };
}

/** 上游条目瘦身 + 校验。字段缺失或 URL 不在白名单的条目直接丢弃,不让它进缓存。 */
function slimEntries(raw: unknown): PetdexEntry[] {
  const pets = (raw as { pets?: unknown[] })?.pets;
  if (!Array.isArray(pets)) throw new Error("petdex: manifest 结构异常(缺 pets 数组)");
  const out: PetdexEntry[] = [];
  for (const p of pets) {
    const e = p as Partial<PetdexEntry>;
    if (typeof e.slug !== "string" || typeof e.displayName !== "string") continue;
    if (typeof e.spritesheetUrl !== "string" || !VALID_KINDS.has(String(e.kind))) continue;
    try {
      safeSlug(e.slug);
      assertPetdexAssetUrl(e.spritesheetUrl);
    } catch {
      continue;
    }
    out.push({ slug: e.slug, displayName: e.displayName, kind: e.kind as PetdexEntry["kind"], spritesheetUrl: e.spritesheetUrl });
  }
  return out;
}

async function getManifest(opts?: { force?: boolean }): Promise<PetdexManifestResult> {
  const root = petdexDir();
  const cached = await readManifest(root);
  const fresh = cached && Date.now() - cached.fetchedAt < MANIFEST_TTL_MS;
  if (cached && fresh && !opts?.force) {
    return { pets: cached.pets, total: cached.total, fetchedAt: cached.fetchedAt, stale: false };
  }

  try {
    const res = await fetchLimited(MANIFEST_URL, { etag: cached?.etag, maxBytes: MANIFEST_MAX_BYTES });
    if (res.status === 304 && cached) {
      // 内容没变:只把有效期往后推,省掉 1.4MB 的重新解析。
      const next = { ...cached, fetchedAt: Date.now() };
      await writeManifest(root, next);
      return { pets: next.pets, total: next.total, fetchedAt: next.fetchedAt, stale: false };
    }
    const parsed = JSON.parse(res.body.toString("utf8")) as unknown;
    const pets = slimEntries(parsed);
    const next = { fetchedAt: Date.now(), etag: res.etag, total: pets.length, pets };
    await writeManifest(root, next);
    return { pets, total: pets.length, fetchedAt: next.fetchedAt, stale: false };
  } catch (err) {
    // 网络不可达时退回磁盘旧副本并标 stale,让 UI 提示「离线」而不是报错空白。
    if (cached) {
      log.warn("manifest 拉取失败,回退磁盘副本:", err);
      return { pets: cached.pets, total: cached.total, fetchedAt: cached.fetchedAt, stale: true };
    }
    throw err;
  }
}

function refOf(meta: SpriteMeta): PetdexSpriteRef {
  return {
    slug: meta.slug,
    displayName: meta.displayName,
    // ?v= 随内容变化,否则换了图 Chromium 仍会用旧的解码结果。
    url: `${PETDEX_SCHEME}://sprite/${meta.slug}.webp?v=${meta.revision}`,
    width: meta.width,
    height: meta.height,
    cols: meta.cols,
    rows: meta.rows,
    bytes: meta.bytes,
  };
}

function revisionOf(etag: string | undefined, bytes: Buffer): string {
  return createHash("sha1").update(etag ?? bytes).digest("hex").slice(0, 12);
}

async function ensureSprite(rawSlug: unknown): Promise<PetdexSpriteRef> {
  const slug = safeSlug(rawSlug);
  const root = petdexDir();
  const meta = await readSpriteMeta(root, slug);
  if (meta && Date.now() - meta.fetchedAt < SPRITE_TTL_MS) {
    void touchSprite(root, slug);
    return refOf(meta);
  }

  // 需要下载:从图鉴索引里查这只宠物的资源地址(URL 不接受渲染端传入,避免被当成任意出网通道)。
  const manifest = await getManifest();
  const entry = manifest.pets.find((p) => p.slug === slug);
  if (!entry) {
    if (meta) return refOf(meta); // 索引里没有但本地有:别把用户已装的宠物弄丢
    throw new Error(`petdex: 图鉴中没有 ${slug}`);
  }

  try {
    const res = await fetchLimited(entry.spritesheetUrl, { etag: meta?.etag, maxBytes: SPRITE_MAX_BYTES });
    if (res.status === 304 && meta) {
      // 内容没变:只把有效期往后推,别为了改时间戳把 2MB 的图重读重写一遍。
      const next = { ...meta, fetchedAt: Date.now(), lastUsedAt: Date.now() };
      await writeSpriteMeta(root, next);
      return refOf(next);
    }
    const size = parseWebpSize(res.body);
    const grid = size && detectPetdexGrid(size.width, size.height);
    if (!size || !grid) throw new Error(`petdex: ${slug} 不是可用的 sprite(尺寸/网格解析失败)`);

    const next: SpriteMeta = {
      slug,
      displayName: entry.displayName,
      etag: res.etag,
      revision: revisionOf(res.etag, res.body),
      width: size.width,
      height: size.height,
      cols: grid.cols,
      rows: grid.rows,
      bytes: res.body.byteLength,
      fetchedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    await writeSprite(root, res.body, next);
    await pruneSprites(root, slug);
    return refOf(next);
  } catch (err) {
    if (meta) {
      log.warn(`sprite ${slug} 刷新失败,继续用本地副本:`, err);
      return refOf(meta);
    }
    throw err;
  }
}

/** 只查本地、绝不联网。启动恢复选中宠物用——不能让开机变成一次强制下载。 */
async function peekSprite(rawSlug: unknown): Promise<PetdexSpriteRef | null> {
  const meta = await readSpriteMeta(petdexDir(), safeSlug(rawSlug));
  return meta ? refOf(meta) : null;
}

/**
 * 注册自定义协议的特权。**必须在 app.ready 之前、模块顶层调用。**
 *
 * 为什么不直接把本地绝对路径回传给渲染端:dev 下 pet-overlay 是 http://localhost 页面,
 * Chromium 禁止 http 页面加载 file:// 子资源(prod 的 file:// 页面反而可以)——那样会
 * 「本地开发白屏、打包正常」,是最难发现的一类问题。
 * corsEnabled:让渲染端可以给 <img crossOrigin="anonymous">,保持 canvas 不被污染。
 */
export function registerPetdexScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PETDEX_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

function registerProtocolHandler(): void {
  protocol.handle(PETDEX_SCHEME, async (request) => {
    try {
      // 形如 cortex-petdex://sprite/<slug>.webp?v=xxx
      const url = new URL(request.url);
      const slug = safeSlug(basename(url.pathname).replace(/\.webp$/i, ""));
      // 这条路径不经 IPC 参数校验,是任意文件读取的唯一闸门,必须再断言一次落在缓存目录内。
      const file = assertWithinSpritesDir(spriteFilePath(petdexDir(), slug), petdexSpritesDir());
      const body = await fsp.readFile(file);
      return new Response(body, {
        headers: {
          "content-type": "image/webp",
          // URL 带内容指纹(?v=),可以放心长缓存。
          "cache-control": "public, max-age=31536000, immutable",
          "access-control-allow-origin": "*",
        },
      });
    } catch (err) {
      log.warn("protocol 取图失败:", err);
      return new Response(null, { status: 404 });
    }
  });
}

export function registerPetdexHandlers(): void {
  registerProtocolHandler();
  ipcMain.handle("petdex:manifest", (_e, opts?: { force?: boolean }) => getManifest(opts));
  ipcMain.handle("petdex:ensure-sprite", (_e, slug: unknown) => ensureSprite(slug));
  ipcMain.handle("petdex:peek-sprite", (_e, slug: unknown) => peekSprite(slug));
  ipcMain.handle("petdex:cache-stats", (): Promise<PetdexCacheStats> => cacheStats(petdexDir()));
  ipcMain.handle("petdex:clear-cache", async (): Promise<PetdexCacheStats> => {
    await clearCache(petdexDir());
    return cacheStats(petdexDir());
  });
}
