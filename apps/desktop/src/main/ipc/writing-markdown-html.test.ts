// 写作导出(U6)Markdown → HTML 渲染 + 本地图片内联的就近单测。
// 覆盖计划 Test scenarios:标题/表格/代码块/图片相对路径内联;另加内联转义、链接 URL 保真、
// 任务列表、引用/水平线/列表等结构,以及纯文本降级。渲染器纯函数、无 electron,不需 mock。
import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  inlineLocalImagesInHtml,
  isMarkdownPath,
  renderInline,
  renderMarkdownToHtml,
  renderPlainTextFragment,
} from "./writing-markdown-html";

describe("renderMarkdownToHtml 结构", () => {
  it("渲染 ATX 各级标题", () => {
    expect(renderMarkdownToHtml("# 一级\n\n## 二级")).toBe("<h1>一级</h1>\n<h2>二级</h2>");
  });

  it("围栏代码块:保留正文并转义,带语言 class", () => {
    const md = "```ts\nconst a = 1 < 2 && 3 > 2;\n```";
    expect(renderMarkdownToHtml(md)).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; 3 &gt; 2;</code></pre>',
    );
  });

  it("GFM 表格:表头/分隔对齐/数据行", () => {
    const md = ["| 名称 | 值 |", "| :--- | ---: |", "| a | 1 |", "| b | 2 |"].join("\n");
    const html = renderMarkdownToHtml(md);
    expect(html).toContain('<th style="text-align:left">名称</th>');
    expect(html).toContain('<th style="text-align:right">值</th>');
    expect(html).toContain('<td style="text-align:left">a</td><td style="text-align:right">1</td>');
    expect(html).toContain("<tbody><tr>");
  });

  it("图片相对路径:src 原样保留(供后续内联),alt 转义", () => {
    const html = renderMarkdownToHtml("![封面 <x>](./img/a.png)");
    expect(html).toBe('<p><img src="./img/a.png" alt="封面 &lt;x&gt;" /></p>');
  });

  it("有序/无序/任务列表", () => {
    expect(renderMarkdownToHtml("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdownToHtml("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
    const task = renderMarkdownToHtml("- [x] 完成\n- [ ] 未完");
    expect(task).toContain('<li class="task-list-item"><input type="checkbox" disabled checked /> 完成</li>');
    expect(task).toContain('<li class="task-list-item"><input type="checkbox" disabled /> 未完</li>');
  });

  it("引用块与水平线", () => {
    expect(renderMarkdownToHtml("> 引用文本")).toBe("<blockquote><p>引用文本</p></blockquote>");
    expect(renderMarkdownToHtml("---")).toBe("<hr />");
  });

  it("段落内硬换行", () => {
    expect(renderMarkdownToHtml("第一行\n第二行")).toBe("<p>第一行<br />第二行</p>");
  });
});

describe("renderInline 内联", () => {
  it("粗/斜/删除线/行内代码", () => {
    expect(renderInline("**粗** *斜* ~~删~~ `code`")).toBe(
      "<strong>粗</strong> <em>斜</em> <del>删</del> <code>code</code>",
    );
  });

  it("行内代码内容转义、且其中的 * 不被当强调", () => {
    expect(renderInline("`a < b && *c*`")).toBe("<code>a &lt; b &amp;&amp; *c*</code>");
  });

  it("链接:URL 含下划线不被误当斜体、text 仍可强调", () => {
    expect(renderInline("[**站点**](https://a_b_c.com/x)")).toBe(
      '<a href="https://a_b_c.com/x"><strong>站点</strong></a>',
    );
  });

  it("escapeHtml 覆盖五个字符", () => {
    expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("inlineLocalImagesInHtml", () => {
  it("相对路径基于 baseDir 内联为 dataURI(注入 readFile)", async () => {
    const html = '<p><img src="./img/a.png" alt="a" /></p>';
    const reads: string[] = [];
    const out = await inlineLocalImagesInHtml(html, "/space/docs", async (p) => {
      reads.push(p);
      return Buffer.from([1, 2, 3]);
    });
    // 基于文档目录解析出的绝对路径
    expect(reads).toEqual(["/space/docs/img/a.png"]);
    expect(out).toBe(`<p><img src="data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}" alt="a" /></p>`);
  });

  it("远程 http src 不内联(保持原样)", async () => {
    const html = '<p><img src="https://x.com/a.png" alt="a" /></p>';
    const out = await inlineLocalImagesInHtml(html, "/space", async () => Buffer.from([9]));
    expect(out).toBe(html);
  });

  it("读文件失败:跳过该图不抛,保持原 src", async () => {
    const html = '<p><img src="./missing.png" alt="a" /></p>';
    const out = await inlineLocalImagesInHtml(html, "/space", async () => {
      throw new Error("ENOENT");
    });
    expect(out).toBe(html);
  });
});

describe("辅助判定", () => {
  it("isMarkdownPath", () => {
    expect(isMarkdownPath("a.md")).toBe(true);
    expect(isMarkdownPath("a.markdown")).toBe(true);
    expect(isMarkdownPath("a.txt")).toBe(false);
  });

  it("纯文本片段转义并包 pre", () => {
    expect(renderPlainTextFragment("a < b")).toBe('<pre class="plain-text">a &lt; b</pre>');
  });
});
