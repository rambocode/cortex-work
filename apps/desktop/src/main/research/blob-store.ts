// 研究正文的 blob 存储（spec §13.1、§19.3.4、§19.4）。
//
// 为什么正文不进 SQLite：Session list / get summary 要在 1000 篇文档下保持廉价（spec §19.4）。
// 元数据留在 SQLite，正文按内容哈希落在 `<research>/blobs/<sha256>.gz`，只有
// detail === "evidence" 或报告生成才会真正去读。内容哈希同时是跨 Session 复用的主键（KTD9）。
//
// 压缩用 node:zlib 的 gzip 而不是 spec §13.1 写的 `.zst`：zstd 在 Node 22 里虽有
// zstdCompress，但 Electron 内嵌版本的可用性尚未实测，而引入 npm 原生 addon 与
// KTD1「不再引入原生依赖」的取向相悖。gzip 是内置且跨版本稳定的，文本正文压缩率足够。
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip as gunzipCb, gzip as gzipCb } from "node:zlib";

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

/// contentHash 的合法形状：小写 sha256 十六进制。
///
/// **这是路径穿越的唯一防线**：contentHash 来自 Worker 响应与数据库，都属于「可能被篡改」的
/// 输入，一旦允许 `../` 或绝对路径，putBlob/getBlob 就变成了任意文件写/读。
/// 校验放在拼路径**之前**，绝不能靠 path.resolve 之后再判断前缀（那是易错的二次防线）。
const CONTENT_HASH_RE = /^[a-f0-9]{64}$/;

/// blob 文件后缀。改它等于换存储格式，必须配套迁移旧文件。
const BLOB_SUFFIX = ".gz";

/// contentRef 的前缀。用逻辑引用而不是直接存文件路径，
/// 这样将来换目录布局或压缩格式时，SQLite 里已有的 content_ref 不必整表重写。
const BLOB_REF_PREFIX = "blob:";

/// 目录由外部注入（生产传 paths.ts 的 researchBlobsDir / researchTmpDir，测试传临时目录）。
export interface BlobStoreDeps {
  blobsDir: () => string;
  tmpDir: () => string;
}

/// 按内容哈希寻址的正文存储。
export class ResearchBlobStore {
  constructor(private readonly deps: BlobStoreDeps) {}

  /// 写入正文，返回 contentRef（`blob:<sha256>`）。
  ///
  /// 调用方负责保证 contentHash 确实是 text 的 sha256——本类不重算，
  /// 因为哈希是抓取管线在流式处理时就算好的，重算等于把整篇正文再过一遍。
  async putBlob(contentHash: string, text: string): Promise<string> {
    assertContentHash(contentHash);
    const compressed = await gzip(Buffer.from(text, "utf8"));
    await this.writeAtomic(contentHash, compressed);
    return `${BLOB_REF_PREFIX}${contentHash}`;
  }

  /// 读取正文；文件不存在返回 null。contentRef 畸形则抛错（fail closed）——
  /// 「读不到」和「引用本身不可信」是两回事，后者必须让调用方看见。
  async getBlob(contentRef: string): Promise<string | null> {
    const hash = parseContentRef(contentRef);
    try {
      const compressed = await fsp.readFile(this.blobPath(hash));
      return (await gunzip(compressed)).toString("utf8");
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /// 删除未被任何授权对象引用的 blob（spec §19.3.4：用户删除 Session 后其 blob 可被 GC）。
  /// referencedHashes 由 ResearchRepository.listReferencedContentHashes() 提供。
  ///
  /// 只处理命名严格符合 `<64位小写hex>.gz` 的文件：目录里若有用户手工放进来的东西
  /// 或别的子系统的产物，一律不碰——GC 宁可漏删也不能误删。
  async gcOrphanBlobs(referencedHashes: ReadonlySet<string>): Promise<number> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.deps.blobsDir());
    } catch (err) {
      // 目录还没建（从未抓取过任何内容）不是错误，没有可回收的东西。
      if (isNotFound(err)) return 0;
      throw err;
    }

    let removed = 0;
    for (const entry of entries) {
      if (!entry.endsWith(BLOB_SUFFIX)) continue;
      const hash = entry.slice(0, -BLOB_SUFFIX.length);
      if (!CONTENT_HASH_RE.test(hash)) continue;
      if (referencedHashes.has(hash)) continue;
      try {
        await fsp.unlink(join(this.deps.blobsDir(), entry));
        removed += 1;
      } catch (err) {
        // 并发下别的路径可能刚删掉它；文件已不在即视为回收成功之外的无害竞态。
        if (!isNotFound(err)) throw err;
      }
    }
    return removed;
  }

  private blobPath(contentHash: string): string {
    return join(this.deps.blobsDir(), `${contentHash}${BLOB_SUFFIX}`);
  }

  /// tmp 落盘 + rename 就位（照 memory/memory-store.ts 的 writeScope 形态）。
  /// 为什么不直接写目标文件：写到一半掉电会留下一个「存在但内容截断」的 blob，
  /// 而它的文件名恰恰是内容哈希——后续复用会拿着错误正文当成命中，且永远不会被察觉。
  /// rename 在同一卷上是原子的，因此 blobs/ 与 tmp/ 必须同处 research/ 根下。
  private async writeAtomic(contentHash: string, data: Buffer): Promise<void> {
    const blobsDir = this.deps.blobsDir();
    const tmpDir = this.deps.tmpDir();
    await fsp.mkdir(blobsDir, { recursive: true });
    await fsp.mkdir(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, `${contentHash}.${process.pid}.${Date.now()}.tmp`);
    await fsp.writeFile(tmpPath, data);
    try {
      await fsp.rename(tmpPath, this.blobPath(contentHash));
    } catch (err) {
      await fsp.rm(tmpPath, { force: true });
      throw err;
    }
  }
}

/// 校验 contentHash 形状；不合法立刻抛错，绝不进入路径拼接。
function assertContentHash(contentHash: string): void {
  if (!CONTENT_HASH_RE.test(contentHash)) {
    throw new Error(`非法 contentHash（必须是 64 位小写十六进制）: ${contentHash}`);
  }
}

/// 解析 contentRef → contentHash。前缀与哈希两处都校验，任何一处不符即抛错。
function parseContentRef(contentRef: string): string {
  if (!contentRef.startsWith(BLOB_REF_PREFIX)) {
    throw new Error(`非法 contentRef（缺少 ${BLOB_REF_PREFIX} 前缀）: ${contentRef}`);
  }
  const hash = contentRef.slice(BLOB_REF_PREFIX.length);
  if (!CONTENT_HASH_RE.test(hash)) {
    throw new Error(`非法 contentRef（哈希段必须是 64 位小写十六进制）: ${contentRef}`);
  }
  return hash;
}

/// 统一识别「文件/目录不存在」。
function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}
