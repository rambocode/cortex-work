// 文档采集纯函数单测:扩展名/大小校验(anydoc 全格式)、去重键、File→PendingDocFile(srcPath 优先 / data 兜底)。
import { describe, expect, it } from "vitest";
import {
  MAX_DOC_BYTES,
  checkDocFile,
  docDedupeKey,
  docExtOf,
  fileToPendingDocFile,
  isAcceptedDoc,
  isBinaryDoc,
  mergeReferencedLocalDocs,
  pendingDocFromPath,
} from "./docIntake";

describe("docExtOf / isAcceptedDoc", () => {
  it("识别受支持扩展名(大小写无关)", () => {
    expect(docExtOf("报表.XLSX")).toBe("xlsx");
    expect(isAcceptedDoc("a.pdf")).toBe(true);
    expect(isAcceptedDoc("a.md")).toBe(true);
  });
  it("anydoc 新增格式(旧 Office/ODF/RTF/EPUB) → 支持", () => {
    for (const n of ["a.doc", "a.xls", "a.ppt", "a.docm", "a.ppsx", "a.odt", "a.ods", "a.odp", "a.rtf", "a.epub"]) {
      expect(isAcceptedDoc(n)).toBe(true);
    }
  });
  it("未知扩展名 → 不支持", () => {
    expect(isAcceptedDoc("a.zip")).toBe(false);
    expect(isAcceptedDoc("a.exe")).toBe(false);
    expect(isAcceptedDoc("noext")).toBe(false);
  });
});

describe("isBinaryDoc(全集减纯文本,区分文本注入 vs 文档通道)", () => {
  it("二进制文档 → true", () => {
    for (const n of ["a.pdf", "b.docx", "c.xlsx", "d.pptx", "e.doc", "f.rtf", "g.epub", "h.odt"]) {
      expect(isBinaryDoc(n)).toBe(true);
    }
  });
  it("文本类/其他 → false", () => {
    for (const n of ["a.md", "b.txt", "c.csv", "d.ts", "e.zip"]) expect(isBinaryDoc(n)).toBe(false);
  });
});

describe("pendingDocFromPath(应用内拖入:已知路径作 srcPath)", () => {
  it("用 srcPath、status ready、按扩展名补 MIME、不读 data", () => {
    const p = pendingDocFromPath("/proj/report.xlsx", "report.xlsx");
    expect(p.srcPath).toBe("/proj/report.xlsx");
    expect(p.data).toBeUndefined();
    expect(p.status).toBe("ready");
    expect(p.name).toBe("report.xlsx");
    expect(p.mimeType).toMatch(/spreadsheetml/);
  });
});

describe("mergeReferencedLocalDocs(文本中显式引用的本地文档)", () => {
  it("识别反引号包裹的 macOS / Windows 绝对路径并转成待发文档", () => {
    const docs = mergeReferencedLocalDocs(
      "读取 `/Users/mike/Downloads/招标 文件.pdf` 和 `C:\\Users\\mike\\合同.docx`",
      [],
    );
    expect(docs.map((doc) => ({ name: doc.name, path: doc.srcPath }))).toEqual([
      { name: "招标 文件.pdf", path: "/Users/mike/Downloads/招标 文件.pdf" },
      { name: "合同.docx", path: "C:\\Users\\mike\\合同.docx" },
    ]);
  });

  it("忽略 URL、相对路径和不支持格式，并与已有附件按 srcPath 去重", () => {
    const existing = [pendingDocFromPath("/tmp/a.pdf", "a.pdf")];
    const docs = mergeReferencedLocalDocs(
      "`/tmp/a.pdf` `https://example.com/b.pdf` `docs/c.pdf` `/tmp/archive.zip`",
      existing,
    );
    expect(docs).toEqual(existing);
  });
});

describe("checkDocFile", () => {
  it("不支持格式 → type", () => {
    expect(checkDocFile({ name: "a.zip", size: 10 })).toBe("type");
  });
  it("超大 → size", () => {
    expect(checkDocFile({ name: "a.pdf", size: MAX_DOC_BYTES + 1 })).toBe("size");
  });
  it("合规 → null", () => {
    expect(checkDocFile({ name: "a.pdf", size: 10 })).toBeNull();
  });
});

describe("docDedupeKey", () => {
  it("name + size", () => {
    expect(docDedupeKey("a.pdf", 5)).toBe("a.pdf:5");
  });
});

describe("fileToPendingDocFile", () => {
  it("Electron File.path 存在 → 用 srcPath,不读 data", async () => {
    const f = Object.assign(new File(["x"], "a.pdf", { type: "application/pdf" }), { path: "/abs/a.pdf" });
    const p = await fileToPendingDocFile(f);
    expect(p.srcPath).toBe("/abs/a.pdf");
    expect(p.data).toBeUndefined();
    expect(p.status).toBe("ready");
    expect(p.name).toBe("a.pdf");
  });
  it("无 path(粘贴来源)→ 读 data", async () => {
    const f = new File(["hello"], "b.txt", { type: "text/plain" });
    const p = await fileToPendingDocFile(f);
    expect(p.srcPath).toBeUndefined();
    expect(p.data).toBeInstanceOf(ArrayBuffer);
    expect(p.mimeType).toBe("text/plain");
  });
  it("空 type 按扩展名补 MIME", async () => {
    const f = Object.assign(new File(["x"], "c.docx", { type: "" }), { path: "/abs/c.docx" });
    const p = await fileToPendingDocFile(f);
    expect(p.mimeType).toMatch(/wordprocessingml/);
  });
});
