// runExtraction(主进程内抽取)单测:纯文本直读、注入 convert 的二进制路径、best-effort 超时。
// 不加载真实 anydoc 原生模块 —— 二进制路径用注入 convert;纯文本路径本就不经 convert。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runExtraction } from "./runner";
import type { ConvertToMarkdown } from "./extract";

let base: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "doc-runner-"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

function write(name: string, content: string): string {
  const p = join(base, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("runExtraction", () => {
  it("纯文本(.txt)→ 直读返回(不经 anydoc)", async () => {
    const p = write("a.txt", "你好,文档");
    const convert: ConvertToMarkdown = () => {
      throw new Error("不应调用 convert");
    };
    const r = await runExtraction(p, { convert });
    expect(r.text).toBe("你好,文档");
    expect(r.empty).toBe(false);
  });

  it("二进制文档(注入 convert)→ 返回 Markdown", async () => {
    const p = write("a.docx", "PK");
    const convert: ConvertToMarkdown = async () => "# 解析正文";
    const r = await runExtraction(p, { convert });
    expect(r.text).toBe("# 解析正文");
  });

  it("超时 → reject", async () => {
    const p = write("slow.docx", "PK");
    const convert: ConvertToMarkdown = () => new Promise((res) => setTimeout(() => res("x"), 500));
    await expect(runExtraction(p, { convert, timeoutMs: 50 })).rejects.toThrow(/超时/);
  });
});
