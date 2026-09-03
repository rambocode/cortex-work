// HTML → 可读纯文本(供 extract_document 返回 .html/.htm 附件正文)。
//
// 为什么自己写而不引 cheerio / jsdom / html-to-text:
//  - 主进程不想再加依赖(每个新包都要过 asar 打包态验证与 electron-builder 排除表,见 docs/lessons.md);
//  - 抽取跑在 runner fork 的独立 worker 里,启动越轻越好,jsdom 级别的 DOM 实现完全是浪费;
//  - 目标只是「给 agent 一份能读的正文」,不需要精确 DOM 语义(CSS 可见性、脚本渲染等一概不管)。
//  正则 + 顺序替换足够:先整块剔除不可见容器,再把块级标签换成换行,最后剥掉所有标签并解码实体。
//
// 换行规则(与 Markdown 观感对齐):源码里的换行按 HTML 语义当空格(否则「标签间的排版换行」会变成空行);
// 块级标签开/闭各出一个换行 → 段落之间空一行;<li> / <tr> 只在开标签处换行,列表项与表格行之间不空行。
//
// 已知限制(可接受):属性值里含 `>` 的标签会被截错;`<pre>` 只保留行结构、缩进会被折叠;实体只解码常见几种 + 数字实体。

// 整块剔除的容器:内容对阅读无意义(脚本 / 样式 / 矢量图 / 无脚本回退 / 模板)。
const DROP_CONTAINER_TAGS = ["script", "style", "svg", "noscript", "template"] as const;

// 块级标签:开/闭都换成换行,保证前后文本不粘连,且同一块的开+闭合起来正好让段落之间空一行。
// li / tr 不在此列(单独处理:只在开标签处换行,项与项之间不空行)。
const BLOCK_TAGS =
  "p|div|br|h[1-6]|section|article|header|footer|nav|aside|main|table|thead|tbody|tfoot|caption|blockquote|pre|ul|ol|dl|dt|dd|hr|form|fieldset|figure|figcaption|address|details|summary";

// 常见命名实体;数字实体(&#NNN; / &#xHH;)在 decodeEntities 里按码点解码。
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ", // 直接解成普通空格,后续空白折叠才能把它并掉
};

// 单趟解码,避免 `&amp;lt;` 被两次解码成 `<`(先 amp 再 lt)——一次 replace 只看原文里的实体。
// 非法码点(超出 Unicode 范围)保留原文,不抛。
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, body: string) => {
    const lower = body.toLowerCase();
    if (lower in NAMED_ENTITIES) return NAMED_ENTITIES[lower];
    const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return m;
    }
  });
}

// 把 HTML 源码转成可读纯文本:<title> 作首行;去 script/style/svg/noscript/template/注释;
// 块级标签换行、<li> 前加 "- ",其余标签剥掉;解码常见实体;折叠空白。
export function htmlToText(html: string): string {
  let s = html;

  // 1) 注释先删:注释里可能藏着 `<script>` 或半个标签,留着会干扰后面的容器匹配。
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  // 2) 整块剔除不可见容器(非贪婪匹配到对应闭合标签;大小写不敏感)。
  for (const tag of DROP_CONTAINER_TAGS) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "");
  }

  // 3) 抽出 <title> 作首行(只取第一个),然后从正文里移除,避免重复出现。
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(s);
  const title = titleMatch ? collapseInline(decodeEntities(titleMatch[1].replace(/<[^>]*>/g, ""))) : "";
  s = s.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, "");

  // 4) <pre> 内的源码换行是内容的一部分,先换成 <br> 保住行结构;其余源码换行按 HTML 语义当空格
  //    (标签之间的排版换行不是内容,不这么做的话每个标签间的换行都会变成一个空行)。
  s = s.replace(/<pre\b[^>]*>[\s\S]*?<\/pre\s*>/gi, (m) => m.replace(/\r\n|\r|\n/g, "<br>"));
  s = s.replace(/\r\n|\r|\n/g, " ");

  // 5) 列表项 / 表格行:只在开标签处换行(li 再加 "- " 前缀),闭标签直接删,项与项之间不留空行。
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<tr\b[^>]*>/gi, "\n");
  s = s.replace(/<\/(?:li|tr)\s*>/gi, "");

  // 6) 块级标签(开/闭/自闭合)→ 换行;表格单元格 → 单个空格,避免相邻单元格文字粘连。
  s = s.replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*\\/?>`, "gi"), "\n");
  s = s.replace(/<\/?(?:td|th)\b[^>]*>/gi, " ");

  // 7) 剥掉其余所有标签(行内标签 a/span/strong/img/meta/link 等)。
  s = s.replace(/<[^>]*>/g, "");

  // 8) 实体解码放在剥标签之后:解码出的 `<` 是文本,不会被当成标签再剥一次。
  s = decodeEntities(s);

  // 9) 折叠空白:每行行内多空格合一并去首尾;连续 3 个以上换行折成 2 个。
  const body = s
    .split(/\r\n|\r|\n/)
    .map(collapseInline)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!title) return body;
  return body ? `${title}\n\n${body}` : title;
}

// 行内空白折叠:空格/制表/nbsp 等合成一个空格,并去首尾。
function collapseInline(line: string): string {
  // \u00a0 用转义而非字面 NBSP:eslint no-irregular-whitespace 会把字面 NBSP 判为错误。
  return line.replace(/[ \t\f\v\u00a0]+/g, " ").trim();
}
