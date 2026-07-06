// 写作检索 IPC 域(U4):按空间根维护内存索引,渲染端发助手回合时查询 top-k 片段注入 prompt。
// 索引驻内存(Map<root, index>),md/txt 全量读;失效走两条路——显式 writingRetrievalInvalidate(root)
// (WritingWorkspace 的 watch dirChanged 挂钩)+ TTL 兜底。打分核心是纯函数(writing-retrieval-core.ts,已单测)。
//
// 只读:仅扫描/读取给定 root 下的文本文件构建索引,不写盘、不越出 root(路径过滤见 scanTextFiles)。
// 跨进程契约:writing:retrieve(invoke)↔ WritingRetrievalRequest/Result;writing:retrievalInvalidate(send)。

import { ipcMain } from "electron";
import { open as openFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import type { WritingRetrievalRequest } from "./writing-retrieval-types";
import type { WritingRetrievalContext } from "./writing-retrieval-types";
import {
  buildQueryModelFromText,
  buildWritingIndex,
  clampSnippetCount,
  retrieveFromIndex,
  type WritingIndexInput,
  type WritingRetrievalIndex,
} from "./writing-retrieval-core";
// PDF 文本抽取(U5):检索索引接 PDF 分支——抽取失败/无文本层则跳过该文件(见 buildIndexForRoot)。
import { readWritePdfText } from "./writing-pdf";

// ── 扫描/索引规模上限(防超大空间拖垮索引构建)──────────────────────────────
const INDEX_TTL_MS = 30_000; // 显式失效为主,TTL 仅作兜底(漏挂 watch 时也能自愈)
const MAX_SCAN_ENTRIES = 8_000;
const MAX_INDEX_FILES = 160;
const MAX_FILE_BYTES = 600_000;

// 参与索引的纯文本扩展(与写作空间文本档口径一致)。
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt", ".text"]);
// PDF 参与索引(U5):文本抽取由 readWritePdfText 完成,失败则跳过该文件。
const PDF_EXTENSION = ".pdf";
// 扫描时收集的可索引扩展(文本 + PDF)。
const INDEXABLE_EXTENSIONS = new Set([...TEXT_EXTENSIONS, PDF_EXTENSION]);

// 扫描时跳过的目录(依赖/构建产物/VCS 等,避免索引噪声与开销)。
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "out", "build", ".next",
  "coverage", ".cache", ".idea", ".pnpm-store", ".turbo", ".venv", ".vscode",
  ".yarn", "log", "logs", "target", "temp", "tmp", "vendor", "venv",
]);

type CacheEntry = { index: WritingRetrievalIndex; builtAt: number };
const indexCache = new Map<string, CacheEntry>();
// 并发去重:同一 root 同时多次检索只构建一次索引(共享 in-flight Promise)。
const inFlight = new Map<string, Promise<WritingRetrievalIndex>>();

// 归一化 root 作为缓存键 + 扫描起点(resolve 消解 . / ..,统一路径形态)。
function resolveRoot(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return "";
  return resolve(value);
}

// 递归扫描 root 下的文本文件(带条目/文件数上限;跳过噪声目录),返回绝对路径列表。
async function scanTextFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const stack = [root];
  let scanned = 0;

  while (stack.length > 0 && scanned < MAX_SCAN_ENTRIES && files.length < MAX_INDEX_FILES) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue; // 不可读目录跳过,不阻断整体索引
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    for (const entry of entries) {
      scanned += 1;
      if (scanned >= MAX_SCAN_ENTRIES || files.length >= MAX_INDEX_FILES) break;
      if (entry.name === ".DS_Store") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(path);
        continue;
      }
      if (entry.isFile() && INDEXABLE_EXTENSIONS.has(extname(path).toLowerCase())) files.push(path);
    }
  }
  return files;
}

// 读单个可索引文件:限制读取字节数;含 NUL 字节视为二进制丢弃(防误索引到伪装成 .txt 的二进制)。
async function readTextFile(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) return "";
  const maxBytes = Math.min(info.size, MAX_FILE_BYTES);
  const handle = await openFile(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return "";
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

// 构建某空间根的索引:扫描 → 逐文件读(PDF 走文本抽取)→ 纯核心切块/统计。单文件失败跳过,不阻断整体。
async function buildIndexForRoot(root: string): Promise<WritingRetrievalIndex> {
  const files = await scanTextFiles(root);
  const inputs: WritingIndexInput[] = [];
  for (const path of files) {
    try {
      const relativePath = (relative(root, path) || basename(path)).replaceAll("\\", "/");
      // PDF 分支(U5):抽取失败或无文本层(扫描件)→ 跳过该文件,不入索引也不报错。
      if (extname(path).toLowerCase() === PDF_EXTENSION) {
        const res = await readWritePdfText({ path });
        if (!res.ok || !res.hasText) continue;
        inputs.push({ path, relativePath, pdfPages: res.pages.map((p) => ({ page: p.page, text: p.text })) });
        continue;
      }
      const content = await readTextFile(path);
      if (!content) continue;
      inputs.push({ path, relativePath, content });
    } catch {
      /* 单文件不可读 / 抽取抛错 → 跳过,保持检索健壮 */
    }
  }
  return buildWritingIndex(inputs);
}

// 取索引:缓存新鲜直接用;否则构建(并发去重),写回缓存。
async function loadIndex(root: string): Promise<WritingRetrievalIndex> {
  const cached = indexCache.get(root);
  if (cached && Date.now() - cached.builtAt <= INDEX_TTL_MS) return cached.index;
  const existing = inFlight.get(root);
  if (existing) return existing;

  const build = buildIndexForRoot(root)
    .then((index) => {
      indexCache.set(root, { index, builtAt: Date.now() });
      return index;
    })
    .finally(() => {
      inFlight.delete(root);
    });
  inFlight.set(root, build);
  return build;
}

// 执行一次检索:空 root/空查询/空索引/无命中 → null(渲染端静默不注入)。导出供就近测试。
export async function writingRetrieve(req: WritingRetrievalRequest): Promise<WritingRetrievalContext | null> {
  const root = resolveRoot(req.root);
  if (!root) return null;
  const query = buildQueryModelFromText(req.query ?? "");
  if (query.terms.length === 0) return null;

  const index = await loadIndex(root);
  if (index.chunks.length === 0) return null;

  const snippets = retrieveFromIndex(index, query, clampSnippetCount(req.k));
  if (snippets.length === 0) return null;

  return {
    source: "bm25-keyword",
    query: query.text,
    keywords: query.terms.slice(0, 12),
    snippets,
    indexedFiles: index.files,
    indexedChunks: index.chunks.length,
  };
}

// 失效某空间根的索引(watch dirChanged 触发):清缓存 + 在建 Promise,下次检索重建。导出供就近测试。
export function writingRetrievalInvalidate(root: string): void {
  const resolved = resolveRoot(root);
  if (!resolved) return;
  indexCache.delete(resolved);
  inFlight.delete(resolved);
}

// 清空全部索引缓存(测试隔离用;运行时无需)。
export function clearWritingRetrievalCache(): void {
  indexCache.clear();
  inFlight.clear();
}

// 注册检索 IPC:retrieve(invoke,失败回可读 message 不抛)+ retrievalInvalidate(send,fire-and-forget)。
export function registerWritingRetrievalHandlers(): void {
  ipcMain.handle("writing:retrieve", async (_event, req: WritingRetrievalRequest) => {
    try {
      return { ok: true as const, context: await writingRetrieve(req) };
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.on("writing:retrievalInvalidate", (_event, root: string) => {
    writingRetrievalInvalidate(root);
  });
}
