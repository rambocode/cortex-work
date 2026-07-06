import { describe, expect, it } from "vitest";
import {
  computeWritingDocumentStats,
  isMarkdownFile,
  markdownToVisibleText,
} from "./doc-stats";

// 便捷断言:直接取字符数。
const count = (md: string, isMarkdown = true): number =>
  computeWritingDocumentStats(md, isMarkdown).characterCount;

// 这些期望值是用 Kun 的真实实现(tiptap/marked 解析 + text 节点收集 + 去空白按
// code point 计)对每个样例跑出来的 ground truth,逐一锁死本仓库复刻口径与 Kun 一致。
describe("computeWritingDocumentStats — Kun 口径对齐", () => {
  it("标题 + 列表 + 强调(Kun 原测样例)", () => {
    expect(count("# 标题\n\n- 第一项\n- 第二项 **加粗**\n")).toBe(10);
  });

  it("多级标题只计标题文字", () => {
    expect(count("## H2 title\n### H3 title")).toBe(14);
  });

  it("粗体与斜体剥标记保留正文", () => {
    expect(count("**bold** and *italic* text")).toBe(17);
  });

  it("嵌套 ***粗斜*** 正确剥离", () => {
    expect(count("***both*** kinds")).toBe(9);
  });

  it("删除线剥标记保留正文", () => {
    expect(count("~~gone~~ stay")).toBe(8);
  });

  it("链接保留可见文字、丢弃 URL", () => {
    expect(count("see [Cortex docs](https://example.com/page) here")).toBe(17);
  });

  it("自动链接保留 URL 文本", () => {
    expect(count("<https://example.com>")).toBe(19);
  });

  it("图片 alt 不计数(整体不可见)", () => {
    expect(count("![alt text](img/a.png)")).toBe(0);
  });

  it("行内图片只计前后正文、不计 alt", () => {
    expect(count("before ![描述文字](img/a.png) after")).toBe(11);
  });

  it("链接与图片混排:只保留链接文字", () => {
    expect(count("[link](u) and ![alt](i.png)")).toBe(7);
  });

  it("围栏代码块保留正文、丢弃语言标识", () => {
    expect(count("```js\nconst a = 1;\nfoo(a);\n```")).toBe(16);
  });

  it("行内代码保留代码正文", () => {
    expect(count("use `npm run test` now")).toBe(16);
  });

  it("表格只计单元格文字、丢弃竖线与分隔行", () => {
    expect(count("| A | B |\n|---|---|\n| 1 | 2 |\n")).toBe(4);
  });

  it("任务列表剥掉复选框只计条目文字", () => {
    expect(count("- [ ] todo one\n- [x] done two\n")).toBe(14);
  });

  it("有序列表剥掉序号", () => {
    expect(count("1. first\n2. second\n")).toBe(11);
  });

  it("引用剥掉 > 标记", () => {
    expect(count("> quoted line\n> second")).toBe(16);
  });

  it("水平线不产生可见文字", () => {
    expect(count("text\n\n---\n\nmore")).toBe(8);
  });
});

describe("computeWritingDocumentStats — 边界", () => {
  it("空文为 0", () => {
    expect(count("")).toBe(0);
  });

  it("纯空白为 0", () => {
    expect(count("   \n\n  \t ")).toBe(0);
  });

  it("非 Markdown 文件按原文去空白计", () => {
    // 与 Kun 的 isMarkdown=false 分支一致:不解析,仅去空白按 code point 计。
    expect(count("Hello world\n  2026  ", false)).toBe(14);
  });

  it("code point 计数:emoji / 星球等超 BMP 字符按 1 计", () => {
    // 「𝕏」为超 BMP 字符(2 个 UTF-16 单元),Array.from 保证按 1 个 code point 计。
    expect(count("a𝕏b", false)).toBe(3);
  });
});

describe("markdownToVisibleText — 与旧口径的差异", () => {
  it("旧口径(仅去空白)会把语法字符计入,新口径剥离标记后更少", () => {
    const md = "# 标题 **加粗** [链接](http://x.com)";
    // 旧口径:整段去空白按 code point 计(含 # * [ ] ( ) 与 URL)。
    const oldStyle = Array.from(md.replace(/\s+/g, "")).length;
    const next = computeWritingDocumentStats(md, true).characterCount;
    expect(next).toBeLessThan(oldStyle);
    // 新口径 = 标题(2) + 加粗(2) + 链接(2) = 6。
    expect(next).toBe(6);
  });

  it("markdownToVisibleText 暴露为可复用的纯函数", () => {
    expect(markdownToVisibleText("**x**").replace(/\s+/g, "")).toBe("x");
  });
});

describe("isMarkdownFile", () => {
  it("识别 md / markdown / mdx(大小写不敏感)", () => {
    expect(isMarkdownFile("a.md")).toBe(true);
    expect(isMarkdownFile("a.MARKDOWN")).toBe(true);
    expect(isMarkdownFile("a.mdx")).toBe(true);
  });

  it("非 Markdown 扩展名返回 false", () => {
    expect(isMarkdownFile("a.txt")).toBe(false);
    expect(isMarkdownFile("a.pdf")).toBe(false);
    expect(isMarkdownFile("noext")).toBe(false);
  });
});
