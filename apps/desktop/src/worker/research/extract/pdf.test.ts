// pdf 抽取单测：pdfjs 模块经 loadPdfJs 注入，用手写替身驱动，不起真 pdfjs。
import { describe, expect, it } from "vitest";
import { extractPdfDocument, type PdfJsLike } from "./pdf";

/// 手写 pdfjs 替身：按页返回 text items，并记录 getDocument 收到的参数。
function fakePdfJs(pages: string[][]): { module: PdfJsLike; params: unknown[] } {
  const params: unknown[] = [];
  const module: PdfJsLike = {
    getDocument: (options) => {
      params.push(options);
      return {
        promise: Promise.resolve({
          numPages: pages.length,
          getPage: async (pageNumber: number) => ({
            getTextContent: async () => ({
              items: (pages[pageNumber - 1] ?? []).map((str) => ({ str })),
            }),
            cleanup: () => {},
          }),
          destroy: async () => {},
        }),
      };
    },
  };
  return { module, params };
}

const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

describe("extractPdfDocument", () => {
  it("逐页抽取文本并压缩空白", async () => {
    const fake = fakePdfJs([["第一页", "  内容  "], ["第二页内容"]]);
    const result = await extractPdfDocument(bytes, { loadPdfJs: async () => fake.module });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pageCount).toBe(2);
    expect(result.pages.map((p) => [p.page, p.text])).toEqual([
      [1, "第一页 内容"],
      [2, "第二页内容"],
    ]);
    expect(result.hasText).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it("以 Node 安全配置调用 getDocument（禁 worker / 禁字体 / 禁 eval）", async () => {
    const fake = fakePdfJs([["x"]]);
    await extractPdfDocument(bytes, { loadPdfJs: async () => fake.module });
    expect(fake.params[0]).toMatchObject({
      disableFontFace: true,
      disableWorker: true,
      isEvalSupported: false,
      useSystemFonts: false,
    });
  });

  it("超过页数上限时截断并置 truncated", async () => {
    const fake = fakePdfJs([["a"], ["b"], ["c"]]);
    const result = await extractPdfDocument(bytes, {
      loadPdfJs: async () => fake.module,
      maxPages: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.pageCount).toBe(3);
  });

  it("超过字符预算时截断", async () => {
    const fake = fakePdfJs([["a".repeat(50)], ["b".repeat(50)]]);
    const result = await extractPdfDocument(bytes, {
      loadPdfJs: async () => fake.module,
      maxChars: 60,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
  });

  it("扫描件（无文本层）返回 empty_content 而不是空文档", async () => {
    const fake = fakePdfJs([[], []]);
    const result = await extractPdfDocument(bytes, { loadPdfJs: async () => fake.module });
    expect(result).toMatchObject({ ok: false, code: "empty_content" });
  });

  it("pdfjs 加载或解析失败归类为 internal_error，不抛出", async () => {
    const result = await extractPdfDocument(bytes, {
      loadPdfJs: async () => {
        throw new Error("pdfjs 不可用");
      },
    });
    expect(result).toMatchObject({ ok: false, code: "internal_error" });
    expect((result as { message: string }).message).toContain("pdfjs 不可用");
  });

  it("解析中途抛错也被捕获（损坏的 PDF）", async () => {
    const broken: PdfJsLike = {
      getDocument: () => ({ promise: Promise.reject(new Error("Invalid PDF structure")) }),
    };
    const result = await extractPdfDocument(bytes, { loadPdfJs: async () => broken });
    expect(result).toMatchObject({ ok: false, code: "internal_error" });
  });
});
