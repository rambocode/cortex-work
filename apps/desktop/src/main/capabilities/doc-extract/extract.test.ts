// extractDocText 纯逻辑单测:纯文本直读 / HTML 剥标签 / 二进制文档走注入 convert / 输出截断 / 扫描件空提示 / 不支持类型。
// 不依赖 anydoc 真实原生模块 —— 二进制路径用注入的 fake convert 验证分派与封装。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { extractDocText, type ConvertToMarkdown } from "./extract";

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

const fakeConvert = (text: string): ConvertToMarkdown => async () => text;

describe("extractDocText 纯文本类(直读,不过 anydoc)", () => {
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

describe("extractDocText HTML 类(剥标签取正文,不过 anydoc)", () => {
  it(".html/.htm → 去掉 script/style 后的正文,title 作首行,empty=false", async () => {
    for (const ext of ["html", "htm"]) {
      const p = write(
        `page.${ext}`,
        `<html><head><title>标题-${ext}</title><style>p{}</style><script>alert(1)</script></head><body><p>正文</p></body></html>`,
      );
      const r = await extractDocText(p); // 不需要 convert 注入
      expect(r.text).toBe(`标题-${ext}\n\n正文`);
      expect(r.empty).toBe(false);
      expect(r.truncated).toBe(false);
      expect(r.note).toBeUndefined();
    }
  });

  it("只有 script/style 无可见正文 → empty=true + HTML 提示", async () => {
    const p = write("shell.html", "<html><head><style>.a{}</style></head><body><script>render()</script></body></html>");
    const r = await extractDocText(p);
    expect(r.empty).toBe(true);
    expect(r.note).toMatch(/HTML 无可见正文/);
  });

  it("正文超 maxBytes → 截断", async () => {
    const p = write("big.html", `<p>${"z".repeat(1000)}</p>`);
    const r = await extractDocText(p, { maxBytes: 100 });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(100);
  });
});

describe("extractDocText 二进制文档类(注入 convert)", () => {
  it("pdf 有文本 → 返回 Markdown,empty=false", async () => {
    const p = write("doc.pdf", "%PDF-fake"); // 内容不被读,convert 被注入替换
    const r = await extractDocText(p, { convert: fakeConvert("# 解析出的正文") });
    expect(r.text).toBe("# 解析出的正文");
    expect(r.empty).toBe(false);
  });

  it("抽取为空(扫描件) → empty=true + 扫描件提示", async () => {
    const p = write("scan.pdf", "%PDF-fake");
    const r = await extractDocText(p, { convert: fakeConvert("   ") });
    expect(r.empty).toBe(true);
    expect(r.note).toMatch(/扫描件/);
  });

  it("新增格式(doc/rtf/epub/odt 等)也走 convert 分支", async () => {
    for (const ext of ["doc", "xls", "ppt", "rtf", "epub", "odt", "ods", "odp", "docm", "ppsx"]) {
      const p = write(`n.${ext}`, "bin");
      const r = await extractDocText(p, { convert: fakeConvert(`md-${ext}`) });
      expect(r.text).toBe(`md-${ext}`);
    }
  });

  it("二进制类缺 convert 注入 → 抛错", async () => {
    const p = write("x.docx", "PK");
    await expect(extractDocText(p)).rejects.toThrow(/convert/);
  });

  it("输出超 maxBytes → 截断", async () => {
    const p = write("big.xlsx", "PK");
    const r = await extractDocText(p, { convert: fakeConvert("y".repeat(500)), maxBytes: 50 });
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
