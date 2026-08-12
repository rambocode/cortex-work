// 写作左栏文稿元信息单测：概要抽取纯函数（frontmatter / 标题 / 代码块 / 列表记号剥离与 50 字符截断）
// + writing:docMeta handler 在真实临时目录上的行为（时间、withExcerpt 闸门、不存在路径剔除）。
// 模块顶层 import electron 与 ./fs（白名单校验），故都存根；ipcMain.handle 存根用来取回 handler 直接调。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipcMain } from "electron";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
vi.mock("./fs", () => ({ assertAllowed: vi.fn(async () => {}) }));

import { registerWritingDocMetaHandlers, writingDocExcerpt } from "./writing-doc-meta";

describe("writingDocExcerpt", () => {
  it("跳过 frontmatter 与标题，取正文首段", () => {
    const raw = ["---", "title: 起床时间", "---", "", "# 起床时间", "", "7:10 分左右醒来。"].join("\n");
    expect(writingDocExcerpt(raw)).toBe("7:10 分左右醒来。");
  });

  it("跳过围栏代码块内容", () => {
    const raw = ["```ts", "const a = 1;", "```", "", "正文在代码块之后。"].join("\n");
    expect(writingDocExcerpt(raw)).toBe("正文在代码块之后。");
  });

  it("剥离列表/引用记号与行内 markdown", () => {
    const raw = ["- **加粗**项", "> 引用行", "[链接](https://a.b) 与 `代码`"].join("\n");
    expect(writingDocExcerpt(raw)).toBe("加粗项 引用行 链接 与 代码");
  });

  it("图片整段丢弃，不把 alt/src 当正文", () => {
    expect(writingDocExcerpt("![封面](img/a.png)\n\n真正的正文")).toBe("真正的正文");
  });

  it("剥掉 HTML 标签/注释、脚注、公式定界符与属性块，只留纯文本", () => {
    const raw = [
      "<!-- 内部备注 -->",
      "<div class=\"x\">带标签的正文</div><br/>",
      "脚注这里[^1]，公式 $E=mc^2$。",
      "锚点标题 {#sec-1}",
    ].join("\n");
    expect(writingDocExcerpt(raw)).toBe("带标签的正文 脚注这里，公式 E=mc^2。 锚点标题");
  });

  it("HTML 实体解码，表格行去掉竖线", () => {
    expect(writingDocExcerpt("a&nbsp;b &amp; c")).toBe("a b & c");
    expect(writingDocExcerpt("| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 20 |")).toBe(
      "姓名 年龄 张三 20",
    );
  });

  it("跳过 ::: 容器指令行", () => {
    expect(writingDocExcerpt(":::note\n提示内容\n:::")).toBe("提示内容");
  });

  it("超过上限按码点截断并加省略号（中文按字计）", () => {
    const raw = "一".repeat(80);
    const out = writingDocExcerpt(raw, 50);
    expect(Array.from(out)).toHaveLength(51); // 50 字 + 省略号
    expect(out.endsWith("…")).toBe(true);
  });

  it("空文档 / 只有标题时回空串", () => {
    expect(writingDocExcerpt("")).toBe("");
    expect(writingDocExcerpt("# 只有标题\n\n## 二级标题")).toBe("");
  });

  it("未闭合的 frontmatter 不会把整篇正文当成 frontmatter 之外的内容误取", () => {
    // 首行是 --- 但没有闭合行：整篇视为 frontmatter，回空串（宁可无摘要，不可把 YAML 当正文）。
    expect(writingDocExcerpt("---\ntitle: x\nbody: y")).toBe("");
  });
});

describe("writing:docMeta handler", () => {
  let ws = "";
  // 从 ipcMain.handle 存根里取回注册的 handler，直接以 (event, req) 调用。
  type Handler = (e: unknown, req: unknown) => Promise<{ items: { path: string; excerpt: string; mtimeMs: number; birthtimeMs: number }[] }>;
  let handler: Handler;

  beforeAll(async () => {
    ws = await mkdtemp(join(tmpdir(), "cortex-doc-meta-"));
    await writeFile(join(ws, "a.md"), "# 标题\n\n正文一段。", "utf8");
    await writeFile(join(ws, "b.pdf"), "%PDF-1.4", "utf8");
    registerWritingDocMetaHandlers();
    const calls = (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls;
    handler = calls.find(([ch]) => ch === "writing:docMeta")![1];
  });
  afterAll(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("返回时间与摘要；pdf 无摘要；不存在的路径被剔除", async () => {
    const res = await handler(null, {
      paths: [join(ws, "a.md"), join(ws, "b.pdf"), join(ws, "missing.md")],
      withExcerpt: true,
    });
    expect(res.items.map((i) => i.path)).toEqual([join(ws, "a.md"), join(ws, "b.pdf")]);
    expect(res.items[0]!.excerpt).toBe("正文一段。");
    expect(res.items[1]!.excerpt).toBe(""); // pdf 不抽摘要
    expect(res.items[0]!.mtimeMs).toBeGreaterThan(0);
    expect(res.items[0]!.birthtimeMs).toBeGreaterThan(0);
  });

  it("withExcerpt=false 时只 stat 不读盘（摘要为空但时间仍有）", async () => {
    const res = await handler(null, { paths: [join(ws, "a.md")] });
    expect(res.items[0]!.excerpt).toBe("");
    expect(res.items[0]!.mtimeMs).toBeGreaterThan(0);
  });
});
