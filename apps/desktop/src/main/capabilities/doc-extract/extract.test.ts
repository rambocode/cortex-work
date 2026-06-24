// extractDocText 纯逻辑单测:纯文本直读 / Office 走注入 parse / 输出截断 / 扫描件空提示 / 不支持类型。
// 不依赖 officeParser 真实文件 —— Office 路径用注入的 fake parse 验证分派与封装。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { extractDocText, type ParseOffice } from "./extract";

let base: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "doc-extract-"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

function write(name: string, content: string): string {
  const p = join(base, name);
  writeFileSync(p, content, "utf8");
  return p;
}

const fakeParse = (text: string): ParseOffice => async () => ({ toText: () => text });

describe("extractDocText 纯文本类(直读,不过 officeParser)", () => {
  it(".txt/.csv/.md → 原文,empty=false", async () => {
    for (const ext of ["txt", "csv", "md"]) {
      const p = write(`a.${ext}`, `内容-${ext}`);
      const r = await extractDocText(p);
      expect(r.text).toBe(`内容-${ext}`);
      expect(r.empty).toBe(false);
      expect(r.truncated).toBe(false);
    }
  });

  it("空白文本 → empty=true", async () => {
    const p = write("blank.txt", "   \n\t ");
    const r = await extractDocText(p);
    expect(r.empty).toBe(true);
  });

  it("超出 maxBytes → 截断且 truncated=true", async () => {
    const p = write("big.txt", "x".repeat(1000));
    const r = await extractDocText(p, { maxBytes: 100 });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(100);
  });
});

describe("extractDocText Office 类(注入 parse)", () => {
  it("pdf 有文本 → 返回 toText,empty=false", async () => {
    const p = write("doc.pdf", "%PDF-fake"); // 内容不被读,parse 被注入替换
    const r = await extractDocText(p, { parse: fakeParse("解析出的正文") });
    expect(r.text).toBe("解析出的正文");
    expect(r.empty).toBe(false);
  });

  it("docx 抽取为空(扫描件) → empty=true + 扫描件提示", async () => {
    const p = write("scan.pdf", "%PDF-fake");
    const r = await extractDocText(p, { parse: fakeParse("   ") });
    expect(r.empty).toBe(true);
    expect(r.note).toMatch(/扫描件/);
  });

  it("Office 类缺 parse 注入 → 抛错", async () => {
    const p = write("x.docx", "PK");
    await expect(extractDocText(p)).rejects.toThrow(/parse/);
  });

  it("Office 输出超 maxBytes → 截断", async () => {
    const p = write("big.xlsx", "PK");
    const r = await extractDocText(p, { parse: fakeParse("y".repeat(500)), maxBytes: 50 });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(50);
  });
});

describe("extractDocText 不支持类型", () => {
  it("未知扩展名 → 抛错", async () => {
    const p = write("a.bin", "x");
    await expect(extractDocText(p)).rejects.toThrow(/不支持/);
  });
});
