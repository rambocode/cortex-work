// 写作 PDF IPC 域(U5)。两条能力:
//   1) writing:pdfData（invoke,渲染端 PDF 阅读器用)：读 PDF 原始字节 → base64 交渲染端在中栏渲染页面。
//   2) readWritePdfText（主进程内部函数,非 IPC）：按页抽取 PDF 文本,供 U4 检索索引喂料。
//      渲染端不需要文本抽取(它自己渲染文本层),故文本抽取不暴露成 IPC,只被 writing-retrieval.ts 调用。
//
// 抽取用 pdfjs 的 legacy build 在主进程(Node)跑,禁 worker/禁字体渲染(disableWorker/disableFontFace):
// legacy build 专为非浏览器环境设计,配合下方 DOMMatrix 等最小 polyfill 即可解析文本(照 Kun write-pdf-text-service)。
// pdfjs 加载或解析失败时抽取返回 ok:false —— 检索侧据此跳过该文件,PDF 不入索引但不阻断其余文件(计划 Risks)。
//
// 字符预算/裁剪逻辑抽成纯函数(buildPdfTextPages / pdfTextContentToPageText / compactPdfText)便于就近单测,
// 无需真的跑 pdfjs 即可覆盖「按页累计到全局上限即截断」的边界。

import { ipcMain } from "electron";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { WritingPdfDataRequest, WritingPdfDataResult } from "./writing-pdf-types";

// ── 规模上限(与 Kun 同量级)──────────────────────────────────────────────
const MAX_PDF_DATA_BYTES = 96 * 1024 * 1024; // 渲染端可加载的 PDF 上限(超限给可读错误,不读盘)
const MAX_PDF_TEXT_BYTES = 64 * 1024 * 1024; // 参与文本抽取的 PDF 上限
const MAX_PDF_TEXT_PAGES = 300; // 抽取的最大页数(超出置 truncated)
const MAX_PDF_TEXT_CHARS = 1_000_000; // 抽取的全局字符上限(累计到即截断)

// 单页抽取结果:1-based 页码 + 该页文本 + 该文本在「全部页拼接」中的字符区间(charStart/charEnd,供定位)。
export interface WritingPdfTextPage {
  page: number;
  text: string;
  charStart: number;
  charEnd: number;
}

// PDF 文本抽取结果:ok 时给逐页文本 + 是否有文本层(hasText)+ 是否被上限截断(truncated);失败给可读 message。
export type WritingPdfTextResult =
  | {
      ok: true;
      path: string;
      size: number;
      mtimeMs: number;
      pageCount: number;
      pages: WritingPdfTextPage[];
      hasText: boolean;
      truncated: boolean;
    }
  | {
      ok: false;
      message: string;
    };

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

// 抽取结果缓存(键含 size+mtime,文件变动即失效);去重同一文件的并发抽取(共享 Promise)。
const pdfTextCache = new Map<string, Promise<WritingPdfTextResult>>();
let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

// pdfjs 在 Node 下引用了若干浏览器全局(仅解析文本时不真的用到,给最小占位即可避免 ReferenceError)。
function ensurePdfJsNodePolyfills(): void {
  const target = globalThis as unknown as Record<string, unknown>;
  target.DOMMatrix ??= class DOMMatrix {};
  target.ImageData ??= class ImageData {};
  target.Path2D ??= class Path2D {};
}

async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    ensurePdfJsNodePolyfills();
    pdfJsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfJsModulePromise;
}

// 纯函数:压缩 PDF 文本空白(CRLF 归一 + 行内多空白折叠 + 连续空行收敛),减少检索噪声。
export function compactPdfText(text = ""): string {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 纯函数:把 pdfjs getTextContent 的 items 拼成一页文本(仅取非空 str,空格连接后压缩)。
export function pdfTextContentToPageText(content: { items?: unknown[] }): string {
  const parts: string[] = [];
  for (const item of content.items ?? []) {
    if (!item || typeof item !== "object") continue;
    const value = (item as { str?: unknown }).str;
    if (typeof value === "string" && value.trim()) parts.push(value);
  }
  return compactPdfText(parts.join(" "));
}

// 纯函数:把逐页文本按全局字符预算裁成带偏移的 pages。
// 边界:累计字符达 MAX_PDF_TEXT_CHARS 即当页截断并置 truncated;总页数超 maxPages 也置 truncated。
export function buildPdfTextPages(
  rawPages: { page: number; text: string }[],
  opts: { maxChars: number; totalPageCount: number; maxPages: number },
): { pages: WritingPdfTextPage[]; truncated: boolean; hasText: boolean } {
  const pages: WritingPdfTextPage[] = [];
  let charOffset = 0;
  let truncated = false;

  for (const { page, text } of rawPages) {
    if (!text) continue;
    const remaining = opts.maxChars - charOffset;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    // 该页超出剩余预算 → 截断到剩余长度(截断后置 truncated,下一轮跳出)。
    const pageText = text.length > remaining ? text.slice(0, remaining).trim() : text;
    if (pageText) {
      pages.push({ page, text: pageText, charStart: charOffset, charEnd: charOffset + pageText.length });
      charOffset += pageText.length + 1; // +1 计入页间分隔占位,避免相邻页偏移黏连
    }
    if (text.length > remaining || charOffset >= opts.maxChars) {
      truncated = true;
      break;
    }
  }
  if (opts.totalPageCount > opts.maxPages) truncated = true;
  return { pages, truncated, hasText: pages.some((p) => p.text.trim().length > 0) };
}

// 用 pdfjs 逐页抽取文本(禁 worker/字体渲染)。仅解析文本层,扫描件(无文本层)hasText=false → 检索侧跳过。
async function extractPdfText(
  targetPath: string,
  size: number,
  mtimeMs: number,
): Promise<WritingPdfTextResult> {
  const pdfjs = await loadPdfJs();
  const bytes = await readFile(targetPath);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
  } as unknown as Parameters<PdfJsModule["getDocument"]>[0]);
  const document = await loadingTask.promise;
  const pageCount = document.numPages;
  const rawPages: { page: number; text: string }[] = [];

  try {
    const maxPages = Math.min(pageCount, MAX_PDF_TEXT_PAGES);
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = pdfTextContentToPageText(content);
      page.cleanup();
      if (text) rawPages.push({ page: pageNumber, text });
    }
  } finally {
    await document.destroy();
  }

  const { pages, truncated, hasText } = buildPdfTextPages(rawPages, {
    maxChars: MAX_PDF_TEXT_CHARS,
    totalPageCount: pageCount,
    maxPages: MAX_PDF_TEXT_PAGES,
  });

  return { ok: true, path: targetPath, size, mtimeMs, pageCount, pages, hasText, truncated };
}

// 主进程内部入口(供 U4 检索索引调用):按页抽取 PDF 文本。任何异常(非 .pdf/超限/pdfjs 失败)→ ok:false,
// 检索侧据此跳过该文件而不报错。带 size+mtime 缓存,避免同一 PDF 反复抽取。
export async function readWritePdfText(req: { path: string }): Promise<WritingPdfTextResult> {
  try {
    const info = await stat(req.path);
    if (info.isDirectory()) return { ok: false, message: "不能从目录抽取文本" };
    if (extname(req.path).toLowerCase() !== ".pdf") return { ok: false, message: "不是 PDF 文件" };
    if (info.size > MAX_PDF_TEXT_BYTES) return { ok: false, message: "PDF 过大,跳过文本抽取" };

    const cacheKey = `${req.path}:${info.size}:${info.mtimeMs}`;
    const cached = pdfTextCache.get(cacheKey);
    if (cached) return cached;

    const pending = extractPdfText(req.path, info.size, info.mtimeMs)
      .catch((err): WritingPdfTextResult => ({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      }))
      .finally(() => {
        // 简易 LRU:超过 32 条时删最旧,防长会话内存膨胀。
        if (pdfTextCache.size > 32) {
          const oldest = pdfTextCache.keys().next().value;
          if (oldest) pdfTextCache.delete(oldest);
        }
      });
    pdfTextCache.set(cacheKey, pending);
    return pending;
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// 清空文本抽取缓存(测试隔离用)。
export function clearWritingPdfTextCache(): void {
  pdfTextCache.clear();
}

// 读 PDF 原始字节交渲染端阅读器(writing:pdfData)。校验:是文件、.pdf 扩展、体积上限。
export async function readWritePdfData(req: WritingPdfDataRequest): Promise<WritingPdfDataResult> {
  try {
    const info = await stat(req.path);
    if (info.isDirectory()) return { ok: false, message: "不是文件" };
    if (extname(req.path).toLowerCase() !== ".pdf") return { ok: false, message: "不是 PDF 文件" };
    if (info.size > MAX_PDF_DATA_BYTES) return { ok: false, message: "PDF 过大,无法在写作台打开" };
    const bytes = await readFile(req.path);
    return {
      ok: true,
      path: req.path,
      base64: bytes.toString("base64"),
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// 注册 PDF IPC:pdfData(invoke,读字节)。文本抽取不注册 IPC(主进程内部直调)。
export function registerWritingPdfHandlers(): void {
  ipcMain.handle("writing:pdfData", async (_event, req: WritingPdfDataRequest) => readWritePdfData(req));
}
