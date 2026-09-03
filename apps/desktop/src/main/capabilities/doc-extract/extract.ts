// 文档抽取的纯逻辑:把一个本地文档文件抽成 Markdown/纯文本。
//  - 纯文本类(.txt/.csv/.md)直接 UTF-8 读取(直读非「解析」;csv 直读也比转 Markdown 表格省 token)。
//  - HTML(.html/.htm)UTF-8 读入后经 html-to-text 剥掉 script/style/svg 等,只回可读正文(不经 anydoc,
//    也不引 DOM 库;原因见 html-to-text.ts 文件头)。
//  - 二进制类(pdf/Office 新旧全系/OpenDocument/rtf/epub)走 @firecrawl/anydoc → GFM Markdown。
//  - **不启用 OCR**(KTD8):扫描件/图片型 PDF 抽不出文本时返回 empty=true + 提示,由 agent 转述。
//  - 输出按字节上限截断(防恶意/超大文档把无界文本回传宿主)。
// convert 注入便于单测(默认绑 anydoc.toMarkdown);本文件不直接 import electron,可在临时目录单测。

import { promises as fsp } from "fs";
import { extname } from "path";
import { htmlToText } from "./html-to-text";

// 抽取产出文本的字节上限;超出截断并附提示,而非无界回传(见 KTD9 / 安全 Risks)。
export const MAX_EXTRACT_TEXT_BYTES = 10 * 1024 * 1024; // 10MB
// 单次抽取超时(由 runner 在 fork 层强制 kill;此处仅作默认值传递)。
export const EXTRACT_TIMEOUT_MS = 30_000;

const PLAIN_EXTS = new Set(["txt", "csv", "md"]);
// HTML 单独一档:是文本但不能直读(原文满是标签/脚本,喂给模型既费 token 又干扰理解),要先剥成正文。
const HTML_EXTS = new Set(["html", "htm"]);
// anydoc 支持的二进制文档全集(与 ipc/doc.ts 的 DOC_EXTS 二进制部分同值,主进程落盘侧是权威闸门)。
const BINARY_DOC_EXTS = new Set([
  "pdf",
  "doc",
  "docx",
  "docm",
  "xls",
  "xlsx",
  "xlsm",
  "xlsb",
  "ppt",
  "pptx",
  "pptm",
  "ppsx",
  "ppsm",
  "pot",
  "pps",
  "odt",
  "ods",
  "odp",
  "rtf",
  "epub",
]);

export interface ExtractResult {
  text: string;
  truncated: boolean; // 文本超上限被截断
  empty: boolean; // 抽取结果为空(二进制类常见于扫描件/图片型 PDF)
  note?: string; // 给 agent 的提示(如「可能为扫描件」)
}

// 文档转换函数签名(anydoc.toMarkdown 的形状:路径进、Markdown 出);注入以便单测。
export type ConvertToMarkdown = (absPath: string) => Promise<string>;

function extOf(p: string): string {
  return extname(p).replace(/^\./, "").toLowerCase();
}

// 按 UTF-8 字节截断(可能止于多字节中段,作为硬上限可接受)。
function capText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

// 抽取入口:按扩展名分流到「直读」或注入的 convert(anydoc),统一做截断与 empty 检测。
export async function extractDocText(
  absPath: string,
  opts: { maxBytes?: number; convert?: ConvertToMarkdown } = {},
): Promise<ExtractResult> {
  const maxBytes = opts.maxBytes ?? MAX_EXTRACT_TEXT_BYTES;
  const ext = extOf(absPath);

  if (PLAIN_EXTS.has(ext)) {
    const raw = await fsp.readFile(absPath, "utf8");
    const { text, truncated } = capText(raw, maxBytes);
    return { text, truncated, empty: text.trim().length === 0 };
  }

  if (HTML_EXTS.has(ext)) {
    const raw = await fsp.readFile(absPath, "utf8");
    const { text, truncated } = capText(htmlToText(raw), maxBytes);
    const empty = text.trim().length === 0;
    return {
      text,
      truncated,
      empty,
      // 剥完标签为空:多半是纯脚本渲染的 SPA 壳或只有样式/脚本的页面,告诉 agent 别再猜内容。
      note: empty ? "HTML 无可见正文(可能为纯脚本渲染页面或仅含 script/style)" : undefined,
    };
  }

  if (BINARY_DOC_EXTS.has(ext)) {
    const convert = opts.convert;
    if (!convert) throw new Error("extractDocText: 缺少 convert 实现(应注入 anydoc.toMarkdown)");
    const markdown = await convert(absPath);
    const { text, truncated } = capText(markdown, maxBytes);
    const empty = text.trim().length === 0;
    return {
      text,
      truncated,
      empty,
      // 二进制类抽取为空:最可能是扫描件/图片型(无文本层),产品红线是不做 OCR。
      note: empty ? "无可抽取文本,可能为扫描件/图片型文档(不支持 OCR)" : undefined,
    };
  }

  throw new Error(`不支持的文档类型: ${ext || absPath}`);
}
