// 写作重型导出(U6)编排层单测:HTML 文档构造 + exportWritingDocument 各格式成功/取消/失败路径 +
// 复制富文本。electron 仅需存根(clipboard 捕获、ipcMain 存根),导出编排走注入的假 runtime,
// 不触真实对话框/隐藏窗口/html-to-docx。
import { describe, expect, it, vi } from "vitest";

// vi.hoisted 供 mock 工厂引用捕获用的 spy(clipboard.write)。
const { clipboardWrite } = vi.hoisted(() => ({ clipboardWrite: vi.fn() }));

// 模块顶层 import electron:存根 ipcMain/clipboard/dialog/BrowserWindow,使 import 不炸。
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  clipboard: { write: clipboardWrite },
  dialog: { showSaveDialog: vi.fn() },
  BrowserWindow: Object.assign(class {}, { fromWebContents: vi.fn() }),
}));

import {
  buildWritingExportHtmlDocument,
  copyWritingDocumentAsRichText,
  defaultExportPath,
  exportWritingDocument,
  type WritingExportRuntime,
} from "./writing-export";
import type { WritingExportFormat } from "./writing-export-types";

// 造一个假 runtime:记录 writeArtifact 调用,保存对话框可配返回(取消/给路径),各产出返回定值。
function makeRuntime(overrides?: Partial<WritingExportRuntime>): {
  runtime: WritingExportRuntime;
  writes: { path: string; data: string | Buffer }[];
} {
  const writes: { path: string; data: string | Buffer }[] = [];
  const runtime: WritingExportRuntime = {
    showSaveDialog: async (defaultPath) => ({ canceled: false, filePath: defaultPath }),
    renderHtmlToBuffer: async () => Buffer.from("PDFPNG"),
    convertHtmlToDocx: async () => Buffer.from("DOCX"),
    writeArtifact: async (path, data) => {
      writes.push({ path, data });
    },
    readImage: async () => Buffer.from([1]),
    ...overrides,
  };
  return { runtime, writes };
}

const SRC = "/space/docs/note.md";

describe("buildWritingExportHtmlDocument", () => {
  it("md 文档:含 DOCTYPE/标题/样式/markdown-body 与渲染出的标题", async () => {
    const html = await buildWritingExportHtmlDocument({ sourcePath: SRC, content: "# 你好\n\n正文" });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>note</title>");
    expect(html).toContain('<article class="markdown-body">');
    expect(html).toContain("<h1>你好</h1>");
    expect(html).toContain(".document-shell");
  });

  it("非 md 文档:走纯文本 pre 降级", async () => {
    const html = await buildWritingExportHtmlDocument({ sourcePath: "/space/a.txt", content: "a < b" });
    expect(html).toContain('<pre class="plain-text">a &lt; b</pre>');
  });
});

describe("defaultExportPath", () => {
  it("同目录同名换扩展名", () => {
    expect(defaultExportPath(SRC, "docx")).toBe("/space/docs/note.docx");
    expect(defaultExportPath(SRC, "pdf")).toBe("/space/docs/note.pdf");
    expect(defaultExportPath(SRC, "png")).toBe("/space/docs/note.png");
    expect(defaultExportPath(SRC, "html")).toBe("/space/docs/note.html");
  });
});

describe("exportWritingDocument 各格式成功路径", () => {
  const cases: { format: WritingExportFormat; expectData: string }[] = [
    { format: "html", expectData: "<!DOCTYPE html>" },
    { format: "docx", expectData: "DOCX" },
    { format: "pdf", expectData: "PDFPNG" },
    { format: "png", expectData: "PDFPNG" },
  ];
  for (const c of cases) {
    it(`${c.format}:落盘并回报路径`, async () => {
      const { runtime, writes } = makeRuntime();
      const res = await exportWritingDocument({ path: SRC, content: "# t", format: c.format }, runtime);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.format).toBe(c.format);
        expect(res.path).toBe(`/space/docs/note.${c.format}`);
      }
      expect(writes).toHaveLength(1);
      expect(String(writes[0]!.data)).toContain(c.expectData);
    });
  }
});

describe("exportWritingDocument 边界", () => {
  it("缺 path:失败不落盘", async () => {
    const { runtime, writes } = makeRuntime();
    const res = await exportWritingDocument({ path: "", content: "x", format: "html" }, runtime);
    expect(res).toEqual({ ok: false, message: "缺少文件路径" });
    expect(writes).toHaveLength(0);
  });

  it("用户取消保存对话框:canceled 且不落盘", async () => {
    const { runtime, writes } = makeRuntime({ showSaveDialog: async () => ({ canceled: true }) });
    const res = await exportWritingDocument({ path: SRC, content: "x", format: "pdf" }, runtime);
    expect(res).toEqual({ ok: false, canceled: true });
    expect(writes).toHaveLength(0);
  });

  it("html-to-docx 失败:回可读 message 且不落盘(不留半成品)", async () => {
    const { runtime, writes } = makeRuntime({
      convertHtmlToDocx: async () => {
        throw new Error("docx boom");
      },
    });
    const res = await exportWritingDocument({ path: SRC, content: "x", format: "docx" }, runtime);
    expect(res).toEqual({ ok: false, message: "docx boom" });
    expect(writes).toHaveLength(0);
  });

  it("无扩展名的对话框路径:补上目标扩展名", async () => {
    const { runtime, writes } = makeRuntime({
      showSaveDialog: async () => ({ canceled: false, filePath: "/out/report" }),
    });
    const res = await exportWritingDocument({ path: SRC, content: "x", format: "html" }, runtime);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe("/out/report.html");
    expect(writes[0]!.path).toBe("/out/report.html");
  });
});

describe("copyWritingDocumentAsRichText", () => {
  it("写系统剪贴板(html + text)并回 ok", async () => {
    clipboardWrite.mockClear();
    const res = await copyWritingDocumentAsRichText({ path: SRC, content: "# 标题" });
    expect(res).toEqual({ ok: true });
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    const arg = clipboardWrite.mock.calls[0]![0] as { html: string; text: string };
    expect(arg.text).toBe("# 标题");
    expect(arg.html).toContain('<article class="markdown-body">');
    expect(arg.html).toContain("<h1>标题</h1>");
  });

  it("缺 path:回可读 message", async () => {
    const res = await copyWritingDocumentAsRichText({ path: "", content: "x" });
    expect(res).toEqual({ ok: false, message: "缺少文件路径" });
  });
});
