// 写作 PDF 文本抽取纯函数单测(U5):compactPdfText / pdfTextContentToPageText / buildPdfTextPages。
// 只覆盖字符预算与拼接边界,无需真跑 pdfjs(pdfjs 相关的 extractPdfText 走集成/手测)。
import { describe, expect, it } from "vitest";
import { buildPdfTextPages, compactPdfText, pdfTextContentToPageText } from "./writing-pdf";

describe("compactPdfText", () => {
  it("归一 CRLF、折叠行内空白、收敛连续空行", () => {
    expect(compactPdfText("a\r\nb")).toBe("a\nb");
    expect(compactPdfText("x   \t y")).toBe("x y");
    expect(compactPdfText("a\n\n\n\nb")).toBe("a\n\nb");
    expect(compactPdfText("  trim  ")).toBe("trim");
    expect(compactPdfText("")).toBe("");
  });
});

describe("pdfTextContentToPageText", () => {
  it("只取非空 str item,空格连接后压缩", () => {
    const content = {
      items: [
        { str: "Hello" },
        { str: "   " }, // 纯空白丢弃
        { str: "World" },
        { foo: 1 }, // 无 str 丢弃
        null,
      ],
    };
    expect(pdfTextContentToPageText(content)).toBe("Hello World");
  });

  it("空 items → 空串", () => {
    expect(pdfTextContentToPageText({ items: [] })).toBe("");
    expect(pdfTextContentToPageText({})).toBe("");
  });
});

describe("buildPdfTextPages", () => {
  it("逐页拼接并记录 charStart/charEnd(页间 +1 分隔)", () => {
    const { pages, truncated, hasText } = buildPdfTextPages(
      [
        { page: 1, text: "abc" },
        { page: 2, text: "de" },
      ],
      { maxChars: 1000, totalPageCount: 2, maxPages: 300 },
    );
    expect(hasText).toBe(true);
    expect(truncated).toBe(false);
    expect(pages).toEqual([
      { page: 1, text: "abc", charStart: 0, charEnd: 3 },
      { page: 2, text: "de", charStart: 4, charEnd: 6 }, // 上一页 3 + 1 分隔
    ]);
  });

  it("累计字符达上限 → 当页截断并置 truncated", () => {
    const { pages, truncated } = buildPdfTextPages(
      [
        { page: 1, text: "abcde" }, // 占 5
        { page: 2, text: "fghij" }, // 只剩 6-5-1=... 预算 8:remaining=8-6=2 → 截 "fg"
      ],
      { maxChars: 8, totalPageCount: 2, maxPages: 300 },
    );
    expect(truncated).toBe(true);
    expect(pages[0]).toMatchObject({ page: 1, text: "abcde" });
    expect(pages[1]?.text.length).toBeLessThanOrEqual(2);
  });

  it("总页数超 maxPages → 置 truncated", () => {
    const { truncated } = buildPdfTextPages([{ page: 1, text: "abc" }], {
      maxChars: 1000,
      totalPageCount: 500,
      maxPages: 300,
    });
    expect(truncated).toBe(true);
  });

  it("全空页 → hasText=false,pages 为空", () => {
    const { pages, hasText } = buildPdfTextPages(
      [
        { page: 1, text: "" },
        { page: 2, text: "" },
      ],
      { maxChars: 1000, totalPageCount: 2, maxPages: 300 },
    );
    expect(pages).toEqual([]);
    expect(hasText).toBe(false);
  });
});
