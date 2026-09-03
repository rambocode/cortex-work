// htmlToText 纯函数单测:逐条覆盖剔除容器 / 注释 / title 首行 / 块级换行 / li 前缀 / 实体解码 / 空白折叠,
// 外加一个含 script/style/svg 与中文正文的完整页面样例。
import { describe, expect, it } from "vitest";
import { htmlToText } from "./html-to-text";

describe("htmlToText 剔除不可见容器", () => {
  it("script / style / svg / noscript / template 整块删除(含大小写、带属性)", () => {
    const html =
      "<p>前</p>" +
      '<SCRIPT type="module">const x = "<b>不是标签</b>";</SCRIPT>' +
      "<style>.a{color:red}</style>" +
      '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>' +
      "<noscript>请启用 JS</noscript>" +
      "<template><p>模板</p></template>" +
      "<p>后</p>";
    expect(htmlToText(html)).toBe("前\n\n后");
  });

  it("HTML 注释删除,注释里的半个标签不影响后续匹配", () => {
    expect(htmlToText("<p>a</p><!-- <script> 不应打开容器 --><p>b</p>")).toBe("a\n\nb");
  });
});

describe("htmlToText title 处理", () => {
  it("<title> 作为首行,与正文空一行", () => {
    expect(htmlToText("<html><head><title> 标题 &amp; 副标 </title></head><body><p>正文</p></body></html>")).toBe(
      "标题 & 副标\n\n正文",
    );
  });
  it("无正文时只返回 title;无 title 时只返回正文", () => {
    expect(htmlToText("<title>只有标题</title>")).toBe("只有标题");
    expect(htmlToText("<p>只有正文</p>")).toBe("只有正文");
  });
});

describe("htmlToText 标签处理", () => {
  it("块级标签换行:同一块开+闭 → 段落间空一行;br → 单换行;多层嵌套不会叠出 3 个以上换行", () => {
    expect(htmlToText("<h1>一</h1><div>二<br>三</div><section><p>四</p></section>")).toBe("一\n\n二\n三\n\n四");
  });
  it("源码里标签之间的换行/缩进按空格处理,不产生空行", () => {
    expect(htmlToText("<ul>\n  <li>甲</li>\n  <li>乙</li>\n</ul>")).toBe("- 甲\n- 乙");
    expect(htmlToText("<p>一行\n  被源码\n  折行</p>")).toBe("一行 被源码 折行");
  });
  it("<pre> 内的换行保留为行结构", () => {
    expect(htmlToText("<pre>第一行\n第二行</pre>")).toBe("第一行\n第二行");
  });
  it("<li> 前加 '- '", () => {
    expect(htmlToText("<ul><li>甲</li><li>乙</li></ul>")).toBe("- 甲\n- 乙");
  });
  it("表格:行换行,单元格之间用空格分隔", () => {
    expect(htmlToText("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>")).toBe("a b\nc d");
  });
  it("行内标签直接剥掉,文本不断开", () => {
    expect(htmlToText('<p>点<a href="/x">这里</a>看<strong>详情</strong><img src="a.png"></p>')).toBe("点这里看详情");
  });
});

describe("htmlToText 实体解码", () => {
  it("常见命名实体与数字实体", () => {
    expect(htmlToText("<p>&lt;a&gt; &amp; &quot;q&quot; &#39;s&#39; &#20013;&#x6587;</p>")).toBe("<a> & \"q\" 's' 中文");
  });
  it("&nbsp; 解成空格并参与折叠", () => {
    expect(htmlToText("<p>a&nbsp;&nbsp;&nbsp;b</p>")).toBe("a b");
  });
  it("单趟解码:&amp;lt; 只解一层,得到字面 &lt;", () => {
    expect(htmlToText("<p>&amp;lt;</p>")).toBe("&lt;");
  });
  it("解码出的 < 不会被再次当成标签剥掉", () => {
    expect(htmlToText("<p>&lt;script&gt;x&lt;/script&gt;</p>")).toBe("<script>x</script>");
  });
});

describe("htmlToText 空白折叠", () => {
  it("行内多空格 / 制表合一并去首尾", () => {
    expect(htmlToText("<p>  a \t\t b   </p>")).toBe("a b");
  });
  it("连续 3 个以上换行折成 2 个", () => {
    expect(htmlToText("<p>a</p>\n\n\n\n<div></div><div></div><p>b</p>")).toBe("a\n\nb");
  });
  it("整页无可见文本 → 空串", () => {
    expect(htmlToText("<html><head><style>.x{}</style></head><body><script>1</script>  </body></html>")).toBe("");
  });
});

describe("htmlToText 完整页面样例", () => {
  it("含 script/style/svg 与中文正文的页面 → 干净正文", () => {
    const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>季度报告 &mdash; 2026 Q2</title>
  <link rel="stylesheet" href="a.css">
  <style>body { font-family: sans-serif; } .hidden { display: none; }</style>
  <script>window.dataLayer = []; document.write("<p>脚本注入</p>");</script>
</head>
<body>
  <!-- 页头 -->
  <header><nav><a href="/">首页</a> <a href="/about">关于</a></nav></header>
  <main>
    <h1>季度报告</h1>
    <p>本季度营收同比增长 <strong>12%</strong>，主要来自&nbsp;海外市场。</p>
    <svg width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>
    <h2>要点</h2>
    <ul>
      <li>新客户数 <em>翻倍</em></li>
      <li>成本下降 &lt;5%</li>
    </ul>
    <table>
      <tr><th>指标</th><th>数值</th></tr>
      <tr><td>营收</td><td>1.2 亿</td></tr>
    </table>
  </main>
  <footer><p>&copy; 2026 Cortex</p></footer>
  <script src="app.js"></script>
</body>
</html>`;
    const out = htmlToText(page);
    expect(out).not.toMatch(/dataLayer|脚本注入|font-family|circle|app\.js/);
    expect(out.split("\n")[0]).toBe("季度报告 &mdash; 2026 Q2"); // 不认识的命名实体保留原文
    expect(out).toContain("首页 关于");
    expect(out).toContain("本季度营收同比增长 12%，主要来自 海外市场。");
    expect(out).toContain("- 新客户数 翻倍\n- 成本下降 <5%");
    expect(out).toContain("指标 数值\n营收 1.2 亿");
    expect(out).not.toMatch(/\n{3,}/);
  });
});
