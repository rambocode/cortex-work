// 文档抽取的纯逻辑:把一个本地文档文件抽成纯文本。
//  - 纯文本类(.txt/.csv/.md)直接 UTF-8 读取,不过 officeParser(更快、零依赖路径)。
//  - 二进制类(.pdf/.docx/.xlsx/.pptx)走 officeParser.parseOffice → toText。
//  - **不启用 OCR**(KTD8):扫描件/图片型 PDF 抽不出文本时返回 empty=true + 提示,由 agent 转述。
//  - 输出按字节上限截断(防恶意/超大文档把无界文本回传宿主)。
// parse 注入便于单测(默认绑 officeParser);本文件不直接 import electron,可在临时目录单测。

import { promises as fsp } from "fs";
import { extname } from "path";

// 抽取产出文本的字节上限;超出截断并附提示,而非无界回传(见 KTD9 / 安全 Risks)。
export const MAX_EXTRACT_TEXT_BYTES = 10 * 1024 * 1024; // 10MB
// 单次抽取超时(由 runner 在 fork 层强制 kill;此处仅作默认值传递)。
export const EXTRACT_TIMEOUT_MS = 30_000;

const PLAIN_EXTS = new Set(["txt", "csv", "md"]);
const OFFICE_EXTS = new Set(["pdf", "docx", "xlsx", "pptx"]);

export interface ExtractResult {
  text: string;
  truncated: boolean; // 文本超上限被截断
  empty: boolean; // 抽取结果为空(二进制类常见于扫描件/图片型 PDF)
  note?: string; // 给 agent 的提示(如「可能为扫描件」)
}

// 文档解析函数签名(officeParser.parseOffice 的最小子集);注入以便单测。
export type ParseOffice = (input: string, config?: { ocr?: boolean; outputErrorToConsole?: boolean }) => Promise<{
  toText(): string;
}>;

function extOf(p: string): string {
  return extname(p).replace(/^\./, "").toLowerCase();
}

// 按 UTF-8 字节截断(可能止于多字节中段,作为硬上限可接受)。
function capText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export async function extractDocText(
  absPath: string,
  opts: { maxBytes?: number; parse?: ParseOffice } = {},
): Promise<ExtractResult> {
  const maxBytes = opts.maxBytes ?? MAX_EXTRACT_TEXT_BYTES;
  const ext = extOf(absPath);

  if (PLAIN_EXTS.has(ext)) {
    const raw = await fsp.readFile(absPath, "utf8");
    const { text, truncated } = capText(raw, maxBytes);
    return { text, truncated, empty: text.trim().length === 0 };
  }

  if (OFFICE_EXTS.has(ext)) {
    const parse = opts.parse;
    if (!parse) throw new Error("extractDocText: 缺少 parse 实现(应注入 officeParser.parseOffice)");
    // ocr:false —— v1 不启用 OCR(库内置 tesseract 仅吃静态体积,不走该路径)。
    const ast = await parse(absPath, { ocr: false, outputErrorToConsole: false });
    const { text, truncated } = capText(ast.toText(), maxBytes);
    const empty = text.trim().length === 0;
    return {
      text,
      truncated,
      empty,
      // 二进制类抽取为空:最可能是扫描件/图片型(无文本层),v1 不做 OCR。
      note: empty ? "无可抽取文本,可能为扫描件/图片型文档(v1 不支持 OCR)" : undefined,
    };
  }

  throw new Error(`不支持的文档类型: ${ext || absPath}`);
}
