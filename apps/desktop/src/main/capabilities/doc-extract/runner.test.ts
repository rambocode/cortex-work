// runExtraction(主进程内抽取)单测:纯文本直读、注入 parse 的 Office 路径、best-effort 超时。
// 不加载真实 officeParser/wasm —— Office 路径用注入 parse;纯文本路径本就不经 parse。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runExtraction } from "./runner";
import type { ParseOffice } from "./extract";

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
  it("纯文本(.txt)→ 直读返回(不经 officeParser)", async () => {
    const p = write("a.txt", "你好,文档");
    const r = await runExtraction(p, { parse: (() => { throw new Error("不应调用 parse"); }) as unknown as ParseOffice });
    expect(r.text).toBe("你好,文档");
    expect(r.empty).toBe(false);
  });

  it("Office(注入 parse)→ 返回解析文本", async () => {
    const p = write("a.docx", "PK");
    const parse: ParseOffice = async () => ({ toText: () => "解析正文" });
    const r = await runExtraction(p, { parse });
    expect(r.text).toBe("解析正文");
  });

  it("超时 → reject", async () => {
    const p = write("slow.docx", "PK");
    const parse: ParseOffice = () => new Promise((res) => setTimeout(() => res({ toText: () => "x" }), 500));
    await expect(runExtraction(p, { parse, timeoutMs: 50 })).rejects.toThrow(/超时/);
  });
});
