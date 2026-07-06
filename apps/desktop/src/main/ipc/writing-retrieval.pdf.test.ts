// 写作检索 PDF 分支集成单测(U5):真实临时目录 + mock 掉 readWritePdfText(不跑 pdfjs)。
// 覆盖:PDF 有文本 → 入索引可检索(pdf location);抽取失败/无文本层 → 跳过该文件且不报错、不影响其它文件。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

// mock PDF 文本抽取:测试逐用例设定其返回,避免依赖真实 pdfjs。
vi.mock("./writing-pdf", () => ({
  readWritePdfText: vi.fn(),
}));

import { clearWritingRetrievalCache, writingRetrieve } from "./writing-retrieval";
import { readWritePdfText } from "./writing-pdf";

const mockReadPdf = vi.mocked(readWritePdfText);

const PDF_PAGE_TEXT =
  "The experiment measured superconductivity in a lanthanum hydride sample under extreme pressure, confirming zero electrical resistance.";

let ws = "";

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), "writing-retrieval-pdf-"));
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

beforeEach(() => {
  clearWritingRetrievalCache();
  mockReadPdf.mockReset();
});

describe("writingRetrieve PDF 分支", () => {
  it("PDF 有文本层 → 抽取入索引,检索命中带 pdf 页码定位", async () => {
    await writeFile(join(ws, "paper.pdf"), "%PDF-1.4 fake bytes", "utf8");
    mockReadPdf.mockResolvedValue({
      ok: true,
      path: join(ws, "paper.pdf"),
      size: 100,
      mtimeMs: 1,
      pageCount: 1,
      pages: [{ page: 7, text: PDF_PAGE_TEXT, charStart: 0, charEnd: PDF_PAGE_TEXT.length }],
      hasText: true,
      truncated: false,
    });

    const ctx = await writingRetrieve({ root: ws, query: "superconductivity lanthanum hydride", k: 3 });
    expect(ctx).not.toBeNull();
    const hit = ctx!.snippets.find((s) => s.path === "paper.pdf");
    expect(hit).toBeTruthy();
    expect(hit!.location).toEqual({ kind: "pdf", pageStart: 7, pageEnd: 7 });
    expect(mockReadPdf).toHaveBeenCalled();
  });

  it("抽取失败(ok:false)→ 跳过该 PDF,不报错;同目录 md 仍可检索", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-retrieval-pdf-fail-"));
    try {
      await writeFile(join(dir, "broken.pdf"), "not a real pdf", "utf8");
      await writeFile(
        join(dir, "note.md"),
        "# Optics\n\nRefraction bends light as it passes between media of different densities.\n",
        "utf8",
      );
      mockReadPdf.mockResolvedValue({ ok: false, message: "pdfjs parse failed" });

      // PDF 查询不命中(被跳过),但整体不抛错。
      const pdfCtx = await writingRetrieve({ root: dir, query: "superconductivity lanthanum", k: 3 });
      expect(pdfCtx).toBeNull();

      // md 仍正常索引与检索。
      const mdCtx = await writingRetrieve({ root: dir, query: "refraction light media", k: 3 });
      expect(mdCtx).not.toBeNull();
      expect(mdCtx!.snippets.some((s) => s.path === "note.md")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("无文本层(hasText:false,扫描件)→ 跳过 PDF", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writing-retrieval-pdf-scan-"));
    try {
      await writeFile(join(dir, "scanned.pdf"), "%PDF", "utf8");
      mockReadPdf.mockResolvedValue({
        ok: true,
        path: join(dir, "scanned.pdf"),
        size: 10,
        mtimeMs: 1,
        pageCount: 3,
        pages: [],
        hasText: false,
        truncated: false,
      });
      const ctx = await writingRetrieve({ root: dir, query: "superconductivity lanthanum", k: 3 });
      expect(ctx).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
