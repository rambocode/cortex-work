// PDF 文本处理的**纯函数核心**：空白压缩、pdfjs textContent → 页文本、按字符预算裁页。
//
// 为什么从 writing-pdf.ts 里搬出来：CRE 的 Research Worker（src/worker/research/extract/pdf.ts）
// 跑在 utilityProcess 里，**禁止 import 任何 electron API**，而 writing-pdf.ts 顶层
// `import { ipcMain } from "electron"`。把不依赖 electron 的纯函数物理下沉到本文件，
// 写作侧与 Worker 侧共用同一份实现，避免两份 PDF 文本处理逻辑各自漂移。
//
// 本次搬迁是**零行为变更**：函数体逐字未改，writing-pdf.ts 改为 re-export 保持导出名不变，
// 既有 writing-pdf.test.ts 一行不改仍全绿即为证明。

// 单页抽取结果:1-based 页码 + 该页文本 + 该文本在「全部页拼接」中的字符区间(charStart/charEnd,供定位)。
export interface WritingPdfTextPage {
  page: number;
  text: string;
  charStart: number;
  charEnd: number;
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
// 边界:累计字符达 maxChars 即当页截断并置 truncated;总页数超 maxPages 也置 truncated。
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
