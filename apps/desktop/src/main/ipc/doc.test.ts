// doc:save 落盘 + assertDocPath 读侧闸门的纯函数单测(接收 root 入参 → 临时目录跑真实 fs)。
// 重点:扩展名 allowlist、magic-bytes 复核(PDF/ZIP/OLE/RTF 四组)、体积上限、srcPath/data 双来源、
// symlink 逃逸防护、根边界。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// doc.ts 顶层 import electron(ipcMain)与 ../paths(electron app)→ 必须 mock。
vi.mock("electron", () => ({
  ipcMain: { handle: () => {} },
  app: { getPath: () => "/tmp", isPackaged: false, getAppPath: () => "/app" },
}));

import { assertDocPath, extToDocExt, MAX_DOC_BYTES, saveDocInto, sniffDocMatches } from "./doc";

const PDF = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46]), Buffer.from("-1.7\n%abc")]); // %PDF-1.7
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(8)]); // PK\x03\x04 (OOXML/ODF/EPUB)
const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(8)]); // 旧 Office
const RTF = Buffer.from("{\\rtf1\\ansi hello}");
const TXT = Buffer.from("hello, 文档世界\n");
const ab = (b: Buffer): ArrayBuffer => new Uint8Array(b).buffer;

let base: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "doc-ipc-"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("extToDocExt", () => {
  it("支持的扩展名 → 归一", () => {
    expect(extToDocExt("a.PDF")).toBe("pdf");
    expect(extToDocExt("报表.xlsx")).toBe("xlsx");
    expect(extToDocExt("x.md")).toBe("md");
  });
  it("anydoc 新增格式(旧 Office/ODF/RTF/EPUB) → 归一", () => {
    for (const ext of ["doc", "xls", "ppt", "docm", "xlsm", "xlsb", "pptm", "ppsx", "odt", "ods", "odp", "rtf", "epub"]) {
      expect(extToDocExt(`a.${ext}`)).toBe(ext);
    }
  });
  it("HTML(.html/.htm) → 归一", () => {
    expect(extToDocExt("page.HTML")).toBe("html");
    expect(extToDocExt("page.htm")).toBe("htm");
  });
  it("未知扩展名 → null", () => {
    expect(extToDocExt("a.exe")).toBeNull();
    expect(extToDocExt("a.zip")).toBeNull();
    expect(extToDocExt("noext")).toBeNull();
  });
});

describe("sniffDocMatches", () => {
  it("PDF 头 / ZIP 头匹配,错配拒绝", () => {
    expect(sniffDocMatches(PDF, "pdf")).toBe(true);
    expect(sniffDocMatches(ZIP, "docx")).toBe(true);
    expect(sniffDocMatches(ZIP, "pdf")).toBe(false); // 非 %PDF
    expect(sniffDocMatches(TXT, "docx")).toBe(false); // 非 ZIP
  });
  it("ODF/EPUB 走 ZIP 头;旧 Office 走 OLE 头;RTF 走 {\\rtf", () => {
    expect(sniffDocMatches(ZIP, "odt")).toBe(true);
    expect(sniffDocMatches(ZIP, "epub")).toBe(true);
    expect(sniffDocMatches(OLE, "doc")).toBe(true);
    expect(sniffDocMatches(OLE, "xls")).toBe(true);
    expect(sniffDocMatches(OLE, "ppt")).toBe(true);
    expect(sniffDocMatches(RTF, "rtf")).toBe(true);
    expect(sniffDocMatches(TXT, "doc")).toBe(false); // 「exe/文本改名 .doc」拒绝
    expect(sniffDocMatches(ZIP, "doc")).toBe(false); // 新旧格式头不互通
    expect(sniffDocMatches(OLE, "docx")).toBe(false);
    expect(sniffDocMatches(TXT, "rtf")).toBe(false);
  });
  it("纯文本无 magic → 放行", () => {
    expect(sniffDocMatches(TXT, "txt")).toBe(true);
    expect(sniffDocMatches(TXT, "csv")).toBe(true);
    expect(sniffDocMatches(TXT, "md")).toBe(true);
  });
  it("HTML 无稳定 magic → 放行(可 DOCTYPE/空白/注释开头)", () => {
    expect(sniffDocMatches(TXT, "html")).toBe(true);
    expect(sniffDocMatches(Buffer.from("<!DOCTYPE html><p>x</p>"), "htm")).toBe(true);
  });
});

describe("saveDocInto", () => {
  it("data 来源:正常 PDF → 落盘 uuid.pdf", async () => {
    const { path, sizeBytes } = await saveDocInto(base, "sess1", "doc.pdf", { data: ab(PDF) });
    expect(existsSync(path)).toBe(true);
    expect(path).toMatch(/[/\\]sess1[/\\][0-9a-f-]+\.pdf$/);
    expect(sizeBytes).toBe(PDF.byteLength);
  });
  it("srcPath 来源:从本地路径直拷", async () => {
    const src = join(base, "src.txt");
    writeFileSync(src, TXT);
    const { path } = await saveDocInto(base, "sess1", "src.txt", { srcPath: src });
    expect(existsSync(path)).toBe(true);
    expect(path).toMatch(/\.txt$/);
  });
  it("旧二进制格式(.doc,OLE 头) → 落盘成功", async () => {
    const { path } = await saveDocInto(base, "sess1", "old.doc", { data: ab(OLE) });
    expect(existsSync(path)).toBe(true);
    expect(path).toMatch(/\.doc$/);
  });
  it(".doc 但字节是 ZIP(头不符) → 拒绝", async () => {
    await expect(saveDocInto(base, "sess1", "old.doc", { data: ab(ZIP) })).rejects.toThrow(/不符/);
  });
  it("完全不支持的扩展名(.zip) → 拒绝", async () => {
    await expect(saveDocInto(base, "sess1", "a.zip", { data: ab(ZIP) })).rejects.toThrow(/不支持/);
  });
  it("扩展名是 pdf 但字节不是 %PDF → 拒绝", async () => {
    await expect(saveDocInto(base, "sess1", "fake.pdf", { data: ab(TXT) })).rejects.toThrow(/不符/);
  });
  it("超体积上限 → 拒绝", async () => {
    await expect(saveDocInto(base, "sess1", "big.pdf", { data: new ArrayBuffer(MAX_DOC_BYTES + 1) })).rejects.toThrow(
      /过大/,
    );
  });
  it("非法 sessionId(路径穿越) → 拒绝", async () => {
    await expect(saveDocInto(base, "../evil", "doc.pdf", { data: ab(PDF) })).rejects.toThrow(/session id/);
  });
  it("缺来源 → 拒绝", async () => {
    await expect(saveDocInto(base, "sess1", "doc.pdf", {})).rejects.toThrow(/来源/);
  });
});

describe("assertDocPath", () => {
  it("刚落盘的文档 → 通过校验并返回真实路径(以 uuid.pdf 结尾)", async () => {
    const { path } = await saveDocInto(base, "sessR", "doc.pdf", { data: ab(PDF) });
    // assertDocPath 返回 realpath(macOS /var→/private/var),故不比对原始 path,只验证落在同名文件。
    const real = await assertDocPath(base, path);
    expect(real.endsWith(path.slice(path.lastIndexOf("/")))).toBe(true);
  });
  it("根外路径 → 拒绝(防任意文件读取)", async () => {
    await expect(assertDocPath(base, "/etc/passwd")).rejects.toThrow(/允许范围/);
  });
  it("符号链接(指向根外) → 拒绝(symlink 逃逸防护)", async () => {
    const { path } = await saveDocInto(base, "sessL", "doc.pdf", { data: ab(PDF) });
    const link = `${path}.link.pdf`;
    symlinkSync("/etc/passwd", link);
    await expect(assertDocPath(base, link)).rejects.toThrow(/允许范围/);
  });
  it("文件不存在 → reject", async () => {
    await expect(assertDocPath(base, join(base, "sessR", "nope.pdf"))).rejects.toThrow();
  });
});
