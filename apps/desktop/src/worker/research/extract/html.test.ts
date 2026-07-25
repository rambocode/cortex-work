// html 抽取单测：纯函数，入参是 HTML 字符串，表驱动。
import { describe, expect, it } from "vitest";
import { chunkStructuredText } from "@cortex-work/core/research/chunking";
import { extractHtmlDocument } from "./html";

/// 造一篇「导航 + 正文 + 页脚」的典型页面。
function pageWith(body: string, head = ""): string {
  return `<!DOCTYPE html><html><head><title>示例标题</title>${head}</head><body>${body}</body></html>`;
}

describe("extractHtmlDocument 噪声剔除", () => {
  it("script / style / noscript / iframe 的内容不进正文", () => {
    const html = pageWith(`
      <article><p>真正的正文段落，长度足够作为主块被选中，用于验证噪声不会混进来。</p></article>
      <script>var tracker = "SCRIPT_NOISE";</script>
      <style>.a { color: red } /* STYLE_NOISE */</style>
      <noscript>NOSCRIPT_NOISE</noscript>
      <iframe src="//ads.example/x">IFRAME_NOISE</iframe>
    `);
    const result = extractHtmlDocument(html);
    expect(result.text).toContain("真正的正文段落");
    for (const noise of ["SCRIPT_NOISE", "STYLE_NOISE", "NOSCRIPT_NOISE", "IFRAME_NOISE"]) {
      expect(result.text).not.toContain(noise);
    }
  });

  it("nav / header / footer / aside 的内容不进正文", () => {
    const html = pageWith(`
      <nav>NAV_NOISE 首页 关于 联系</nav>
      <header>HEADER_NOISE</header>
      <main><p>正文主体在 main 里，这段文字足够长以便被选为主块使用。</p></main>
      <aside>ASIDE_NOISE 相关阅读</aside>
      <footer>FOOTER_NOISE 版权所有</footer>
    `);
    const result = extractHtmlDocument(html);
    expect(result.text).toContain("正文主体在 main 里");
    for (const noise of ["NAV_NOISE", "HEADER_NOISE", "ASIDE_NOISE", "FOOTER_NOISE"]) {
      expect(result.text).not.toContain(noise);
    }
  });
});

describe("extractHtmlDocument 主块选择", () => {
  it("<article> 优先于兄弟节点", () => {
    const html = pageWith(`
      <div>侧栏杂项，内容不多。</div>
      <article><p>文章正文，应当成为唯一的抽取结果主体。</p></article>
    `);
    expect(extractHtmlDocument(html).text).toContain("文章正文");
    expect(extractHtmlDocument(html).text).not.toContain("侧栏杂项");
  });

  it("[role=main] 与 <main> 等效", () => {
    const html = pageWith(`
      <div>短侧栏</div>
      <div role="main"><p>role=main 标注的容器同样是主块，正文应从这里抽取出来。</p></div>
    `);
    expect(extractHtmlDocument(html).text).toContain("role=main 标注的容器");
  });

  it("没有语义标签时按文本密度选主块：长正文胜过链接堆", () => {
    const links = Array.from({ length: 25 }, (_, i) => `<a href="/p${i}">链接${i}</a>`).join(" ");
    const prose = "这是真正的正文段落。".repeat(30);
    const html = pageWith(`<div id="sidebar">${links}</div><div id="content"><p>${prose}</p></div>`);
    const result = extractHtmlDocument(html);
    expect(result.text).toContain("这是真正的正文段落");
    expect(result.text).not.toContain("链接7");
  });

  it("完全没有正文时返回空文本而不是抛错", () => {
    expect(extractHtmlDocument("<html><body></body></html>").text).toBe("");
    expect(extractHtmlDocument("").text).toBe("");
  });
});

describe("extractHtmlDocument 标题层级", () => {
  const html = pageWith(`
    <article>
      <h1>顶级标题</h1>
      <p>顶级标题下的引言段落，需要足够长以免被当作碎片丢弃处理掉。</p>
      <h2>第一节</h2>
      <p>第一节的正文内容，同样写得足够长以便切块时不会被合并掉。</p>
      <h3>第一节之一</h3>
      <p>更深一层的内容，用于验证 heading 层级栈的行为是否正确无误。</p>
      <h2>第二节</h2>
      <p>第二节的正文内容，用于验证同级标题会让层级栈正确回退一层。</p>
    </article>
  `);

  it("产出 level / title / offset 三元组，层级取自 h1..h6", () => {
    const result = extractHtmlDocument(html);
    expect(result.headings.map((h) => [h.level, h.title])).toEqual([
      [1, "顶级标题"],
      [2, "第一节"],
      [3, "第一节之一"],
      [2, "第二节"],
    ]);
  });

  it("offset 指向正文中该标题的真实位置（可直接喂 chunkStructuredText）", () => {
    const result = extractHtmlDocument(html);
    for (const heading of result.headings) {
      expect(result.text.slice(heading.offset, heading.offset + heading.title.length)).toBe(
        heading.title,
      );
    }
    expect(result.headings.map((h) => h.offset)).toEqual(
      [...result.headings].sort((a, b) => a.offset - b.offset).map((h) => h.offset),
    );
  });

  it("与 core 的 chunkStructuredText 协作后每块都带 headingPath", () => {
    const result = extractHtmlDocument(html);
    const chunks = chunkStructuredText(
      { text: result.text, headings: result.headings },
      { maxChars: 60, minChars: 10 },
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.headingPath.length > 0)).toBe(true);
    // 三级标题下的块必须带完整路径。
    const deep = chunks.find((chunk) => chunk.text.includes("更深一层"));
    expect(deep?.headingPath).toEqual(["顶级标题", "第一节", "第一节之一"]);
  });
});

describe("extractHtmlDocument 元数据", () => {
  it("抽 title / canonical / og:published_time", () => {
    const html = pageWith("<article><p>正文内容够长，保证主块选择稳定不受影响。</p></article>", [
      '<link rel="canonical" href="https://example.com/canonical">',
      '<meta property="og:published_time" content="2026-06-01T10:00:00Z">',
    ].join(""));
    const result = extractHtmlDocument(html);
    expect(result.title).toBe("示例标题");
    expect(result.canonicalUrl).toBe("https://example.com/canonical");
    expect(result.publishedAt).toBe("2026-06-01T10:00:00Z");
  });

  it("article:published_time 与 time[datetime] 作为回退", () => {
    const a = extractHtmlDocument(
      pageWith(
        "<article><p>正文内容够长，保证主块选择稳定不受影响。</p></article>",
        '<meta property="article:published_time" content="2026-05-02T00:00:00Z">',
      ),
    );
    const b = extractHtmlDocument(
      pageWith(
        '<article><time datetime="2026-04-03">四月三日</time><p>正文内容够长，保证主块稳定。</p></article>',
      ),
    );
    expect(a.publishedAt).toBe("2026-05-02T00:00:00Z");
    expect(b.publishedAt).toBe("2026-04-03");
  });

  it("缺元数据时字段为 undefined，title 回退到 og:title", () => {
    const html =
      '<html><head><meta property="og:title" content="OG 标题"></head><body><article><p>正文内容够长，保证主块选择稳定。</p></article></body></html>';
    const result = extractHtmlDocument(html);
    expect(result.title).toBe("OG 标题");
    expect(result.canonicalUrl).toBeUndefined();
    expect(result.publishedAt).toBeUndefined();
  });
});

describe("extractHtmlDocument 文本细节", () => {
  it("解码 HTML 实体", () => {
    const html = pageWith(
      "<article><p>A &amp; B &lt;tag&gt; &quot;q&quot; &#39;s&#39; &nbsp;末尾，这段文字足够长。</p></article>",
    );
    const text = extractHtmlDocument(html).text;
    expect(text).toContain('A & B <tag> "q" \'s\'');
  });

  it("块级元素之间产生段落边界，<br> 产生换行", () => {
    const html = pageWith(
      "<article><p>第一段内容写得足够长以免被并块处理。</p><p>第二段内容同样足够长以免被并块。</p><p>第三行上<br>第三行下，这一段也要够长。</p></article>",
    );
    const text = extractHtmlDocument(html).text;
    expect(text).toContain("第一段内容写得足够长以免被并块处理。\n\n第二段内容");
    expect(text).toContain("第三行上\n第三行下");
  });

  it("正文已按 core 的 normalizeExtractedText 归一（无 \\r、无 3 连换行、无行尾空格）", () => {
    const html = pageWith(
      "<article><p>  含有   多余空白   的段落，长度足够。  </p>\r\n\r\n\r\n<p>第二段落也足够长了。</p></article>",
    );
    const text = extractHtmlDocument(html).text;
    expect(text).not.toMatch(/\r/);
    expect(text).not.toMatch(/\n{3,}/);
    expect(text).not.toMatch(/ \n/);
    expect(text).toContain("含有 多余空白 的段落");
  });

  it("畸形 HTML（未闭合标签）不抛错且仍能抽到文本", () => {
    const html = "<html><body><div><p>未闭合的段落内容，长度足够作为主块被选中。<div>另一段</body>";
    expect(() => extractHtmlDocument(html)).not.toThrow();
    expect(extractHtmlDocument(html).text).toContain("未闭合的段落内容");
  });
});
