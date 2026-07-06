// 写作检索 PDF 分支纯核心单测(U5):chunkWritingPdf 页码定位 + buildWritingIndex 判别联合分派 +
// retrieveFromIndex 命中 PDF 片段并回带 pdf location。全纯函数,不碰 fs/pdfjs。
import { describe, expect, it } from "vitest";
import {
  buildQueryModelFromText,
  buildWritingIndex,
  chunkWritingPdf,
  clampSnippetCount,
  retrieveFromIndex,
} from "./writing-retrieval-core";

// 足够长的一页文本(超过 MIN_CHUNK_CHARS=48),含关键词「量子纠缠」。
const PAGE_TEXT =
  "量子纠缠是量子力学中最反直觉的现象之一。两个纠缠粒子无论相距多远,测量其一即刻决定另一个的状态,这正是量子纠缠的核心。";

describe("chunkWritingPdf", () => {
  it("一页一块,location 用页码区间,title 标注文件名+页码", () => {
    const chunks = chunkWritingPdf("/space/paper.pdf", "paper.pdf", [
      { page: 1, text: PAGE_TEXT },
      { page: 3, text: "太短" }, // < MIN_CHUNK_CHARS 被丢弃
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.location).toEqual({ kind: "pdf", pageStart: 1, pageEnd: 1 });
    expect(chunks[0]!.title).toBe("paper.pdf 第1页");
  });

  it("空文本页跳过", () => {
    expect(chunkWritingPdf("/space/a.pdf", "a.pdf", [{ page: 1, text: "   " }])).toEqual([]);
  });
});

describe("buildWritingIndex 判别联合分派", () => {
  it("PDF 输入(pdfPages)走页切块,文本输入(content)走行切块", () => {
    const index = buildWritingIndex([
      { path: "/space/paper.pdf", relativePath: "paper.pdf", pdfPages: [{ page: 2, text: PAGE_TEXT }] },
      { path: "/space/note.md", relativePath: "note.md", content: `# 经典力学\n\n${PAGE_TEXT}` },
    ]);
    expect(index.files).toBe(2);
    const pdfChunk = index.chunks.find((c) => c.path.endsWith(".pdf"));
    const mdChunk = index.chunks.find((c) => c.path.endsWith(".md"));
    expect(pdfChunk!.location).toEqual({ kind: "pdf", pageStart: 2, pageEnd: 2 });
    expect(mdChunk!.location.kind).toBe("text");
  });
});

describe("retrieveFromIndex 命中 PDF 片段", () => {
  it("查询命中 PDF 页 → 片段带 pdf location 与页码", () => {
    const index = buildWritingIndex([
      { path: "/space/paper.pdf", relativePath: "docs/paper.pdf", pdfPages: [{ page: 5, text: PAGE_TEXT }] },
    ]);
    const query = buildQueryModelFromText("量子纠缠");
    const snippets = retrieveFromIndex(index, query, clampSnippetCount(3));
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets[0]!.path).toBe("docs/paper.pdf");
    expect(snippets[0]!.location).toEqual({ kind: "pdf", pageStart: 5, pageEnd: 5 });
  });
});
