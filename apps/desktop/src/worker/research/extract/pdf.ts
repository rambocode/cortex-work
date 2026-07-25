// PDF 文本抽取（spec §12.4）——pdfjs legacy build 在 Node 侧运行。
//
// 与写作侧 main/ipc/writing-pdf.ts 的关系：**纯函数完全复用**（compactPdfText /
// pdfTextContentToPageText / buildPdfTextPages 已下沉到 main/ipc/writing-pdf-core.ts），
// 本文件只负责「Worker 侧的加载与遍历」。不直接 import writing-pdf.ts 是因为那个文件顶层
// `import { ipcMain } from "electron"`，而 Worker 跑在 utilityProcess 里**禁止 import electron**。
//
// pdfjs 的 Node 配置照抄写作侧的既有实践（已在生产验证）：legacy build + 最小浏览器全局 polyfill
// + disableWorker/disableFontFace/isEvalSupported:false/useSystemFonts:false。
// `isEvalSupported: false` 尤其重要——PDF 是不可信输入，绝不允许它触发任何 eval 路径。
import {
  buildPdfTextPages,
  pdfTextContentToPageText,
  type WritingPdfTextPage,
} from "../../../main/ipc/writing-pdf-core";

/// 抽取上限（与写作侧同量级）。超出即截断并置 truncated，不报错——半篇 PDF 也有证据价值。
const DEFAULT_MAX_PAGES = 300;
const DEFAULT_MAX_CHARS = 1_000_000;

/// pdfjs 的最小可用形状。声明成接口而不是 `typeof import(...)` 是为了让测试能传手写替身，
/// 同时避免把 pdfjs 的类型定义拖进 Worker 的类型图。
export interface PdfJsLike {
  getDocument(options: unknown): {
    promise: Promise<{
      numPages: number;
      getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<{ items?: unknown[] }>;
        cleanup(): void;
      }>;
      destroy(): Promise<void>;
    }>;
  };
}

/// 抽取结果。失败码取协议的 fetch_failure 子集，调用方直接上报。
export type PdfExtractionResult =
  | {
      ok: true;
      pages: WritingPdfTextPage[];
      pageCount: number;
      truncated: boolean;
      hasText: boolean;
    }
  | { ok: false; code: "empty_content" | "internal_error"; message: string };

/// 可注入依赖：loadPdfJs 让单测无需真的加载 pdfjs（它有 ~8MB 体积与浏览器全局依赖）。
export interface PdfExtractDeps {
  loadPdfJs?: () => Promise<PdfJsLike>;
  maxPages?: number;
  maxChars?: number;
}

let pdfJsModulePromise: Promise<PdfJsLike> | null = null;

/// pdfjs 在 Node 下会引用若干浏览器全局；只解析文本时用不到实体实现，给最小占位即可避免
/// ReferenceError（与 main/ipc/writing-pdf.ts 的 ensurePdfJsNodePolyfills 同源）。
function ensurePdfJsNodePolyfills(): void {
  const target = globalThis as unknown as Record<string, unknown>;
  target.DOMMatrix ??= class DOMMatrix {};
  target.ImageData ??= class ImageData {};
  target.Path2D ??= class Path2D {};
}

/// 生产用的 pdfjs 加载器：懒加载 + 单例。懒加载让 Worker 冷启动不必付 pdfjs 的解析成本，
/// 也让 doctor 能单独探测「pdfjs 是否可用」。
export async function loadPdfJs(): Promise<PdfJsLike> {
  if (!pdfJsModulePromise) {
    ensurePdfJsNodePolyfills();
    pdfJsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<PdfJsLike>;
  }
  return pdfJsModulePromise;
}

/// 逐页抽取 PDF 文本。任何异常（pdfjs 缺失、PDF 损坏、加密）都归类成有限失败码，不抛出。
export async function extractPdfDocument(
  data: Uint8Array,
  deps: PdfExtractDeps = {},
): Promise<PdfExtractionResult> {
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;

  try {
    const pdfjs = await (deps.loadPdfJs ?? loadPdfJs)();
    const document = await pdfjs.getDocument({
      data,
      disableFontFace: true,
      disableWorker: true,
      isEvalSupported: false,
      useSystemFonts: false,
    }).promise;

    const pageCount = document.numPages;
    const rawPages: Array<{ page: number; text: string }> = [];
    try {
      const limit = Math.min(pageCount, maxPages);
      for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const text = pdfTextContentToPageText(await page.getTextContent());
        // 逐页 cleanup：不清理时 pdfjs 会把每页的渲染中间态留在内存里，长 PDF 会吃掉几百 MB。
        page.cleanup();
        if (text) rawPages.push({ page: pageNumber, text });
      }
    } finally {
      await document.destroy();
    }

    const built = buildPdfTextPages(rawPages, { maxChars, totalPageCount: pageCount, maxPages });
    if (!built.hasText) {
      // 扫描件没有文本层。首版不做 OCR，直接归为 empty_content 让上层跳过该来源。
      return { ok: false, code: "empty_content", message: "PDF 没有可抽取的文本层（可能是扫描件）" };
    }
    return {
      ok: true,
      pages: built.pages,
      pageCount,
      truncated: built.truncated,
      hasText: built.hasText,
    };
  } catch (err) {
    return {
      ok: false,
      code: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
