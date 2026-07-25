// HTML 正文抽取（spec §12.4 的 readable text 环节）——**自研启发式，首版**。
//
// ⚠️ 已知限制（有意的取舍，写在这里避免后来者误以为它是完整实现）：
// 本模块是不引第三方依赖的启发式实现，抽取质量**低于 Readability**。它对「语义标签清晰的
// 文章页」表现良好，对 SPA 骨架页、评论区混排、多栏杂志式布局会出错。之所以自研：
//   1) Worker 产物要求自包含（见 electron.worker.config.ts），少一个依赖少一份 asar 风险；
//   2) readability 依赖 DOM 实现（jsdom / linkedom），把整个 DOM 引擎打进 Worker 代价过大。
// 后续若抽取质量成为瓶颈，替换点只在本文件的 extractHtmlDocument 一个导出上。
//
// 纯函数：入参是 HTML 字符串，出参是「已归一的正文 + 标题锚点 + 元数据」，可直接表驱动测试。
// 本文件跑在 utilityProcess Worker 里，**禁止 import electron**。
import { normalizeExtractedText, type HeadingAnchor } from "@cortex-work/core/research/chunking";

/// 抽取结果。text 已经过 core 的 normalizeExtractedText，headings 的 offset 相对该文本，
/// 因此可以直接喂 chunkStructuredText（切块的 offset 不变量见 core/research/chunking 头部）。
export interface HtmlExtraction {
  title: string;
  canonicalUrl?: string;
  publishedAt?: string;
  text: string;
  headings: HeadingAnchor[];
}

/// 内容不是标记语言、必须连同标签整体丢弃的元素。
/// svg/math 会产生大量无语义文本节点；template 是未激活内容；iframe 是第三方内容。
const RAW_DROP_TAGS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "math",
  "template",
  "canvas",
];

/// 页面装饰性区块：导航、页眉、页脚、边栏。它们的文本对「这篇文章说了什么」没有贡献，
/// 且常含大量链接文字，留着会把密度打分带偏。
const CHROME_TAGS: ReadonlySet<string> = new Set(["nav", "header", "footer", "aside"]);

/// HTML 空元素（无闭合标签）。
const VOID_TAGS: ReadonlySet<string> = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/// 需要在前后产生段落边界的块级元素。
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address", "article", "blockquote", "details", "div", "dd", "dl", "dt",
  "fieldset", "figcaption", "figure", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "li", "main", "ol", "p", "pre", "section", "summary", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

/// 主块候选容器。语义标签之外只考虑通用容器，避免把 <li> 之类的碎片选成主块。
const CANDIDATE_TAGS: ReadonlySet<string> = new Set(["div", "section", "td", "body"]);

const HEADING_LEVELS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

// ---------------------------------------------------------------------------
// 极简 HTML 解析
// ---------------------------------------------------------------------------

interface ElementNode {
  kind: "element";
  tag: string;
  attrs: string;
  children: DomNode[];
}

interface TextNode {
  kind: "text";
  value: string;
}

type DomNode = ElementNode | TextNode;

/// 命名实体表。只覆盖高频项；其余走数字实体解码，未知实体保持原样（宁可留字面量也不猜）。
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", ldquo: "“", rdquo: "”",
  lsquo: "‘", rsquo: "’", middot: "·", copy: "©", reg: "®", trade: "™",
};

/// 解码 HTML 实体（命名 + 十进制 + 十六进制）。
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/// 剥掉注释、doctype，以及内容不是标记的整块元素（script/style/svg…）。
/// 必须先于 tokenize：这些元素的内容里可能出现 `<` 之类会把 tokenizer 带偏的字符。
function stripRawBlocks(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!doctype[^>]*>/gi, "");
  for (const tag of RAW_DROP_TAGS) {
    out = out
      .replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ")
      // 未闭合的同类标签（截断的页面很常见）：连开标签一起丢，避免其后全部内容被误当正文。
      .replace(new RegExp(`<${tag}\\b[^>]*>`, "gi"), " ");
  }
  return out;
}

/// 遇到这些开标签时，若栈顶是「同级不可嵌套」的元素，先隐式闭合它。
/// 处理 `<p>a<p>b` 与 `<li>a<li>b` 这类合法但省略闭合标签的写法。
const IMPLICIT_CLOSE: Record<string, ReadonlySet<string>> = {
  p: new Set(["p"]),
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  td: new Set(["td", "th"]),
  th: new Set(["td", "th"]),
  tr: new Set(["td", "th", "tr"]),
  option: new Set(["option"]),
};

/// 把 HTML 解析成一棵宽容的 DOM 树。
///
/// 容错策略：闭标签在栈中找不到匹配就**直接忽略**（而不是清空栈），未闭合的元素在文档结束时
/// 由栈自然收尾。这让截断页面、错配标签仍能产出可用的树——启发式抽取的输入本就大多不合规。
function parseDom(html: string): ElementNode {
  const root: ElementNode = { kind: "element", tag: "#root", attrs: "", children: [] };
  const stack: ElementNode[] = [root];
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  const top = (): ElementNode => stack[stack.length - 1]!;
  const pushText = (value: string): void => {
    if (value.length > 0) top().children.push({ kind: "text", value });
  };

  while ((match = tagPattern.exec(html)) !== null) {
    pushText(html.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const isClose = match[1] === "/";
    const tag = match[2]!.toLowerCase();
    const attrs = match[3] ?? "";

    if (isClose) {
      const index = stack.findLastIndex((node) => node.tag === tag);
      if (index > 0) stack.length = index;
      continue;
    }

    const implicit = IMPLICIT_CLOSE[tag];
    if (implicit && implicit.has(top().tag)) stack.pop();

    const element: ElementNode = { kind: "element", tag, attrs, children: [] };
    top().children.push(element);
    if (!VOID_TAGS.has(tag) && !attrs.trimEnd().endsWith("/")) stack.push(element);
  }
  pushText(html.slice(cursor));

  return root;
}

/// 取属性值（大小写不敏感，支持双引号/单引号/裸值）。
function attrValue(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = pattern.exec(attrs);
  if (!match) return undefined;
  return match[2] ?? match[3] ?? match[4];
}

// ---------------------------------------------------------------------------
// 主块选择
// ---------------------------------------------------------------------------

interface BlockStats {
  textLength: number;
  linkTextLength: number;
  tagCount: number;
}

/// 统计一个子树的文本量、链接文本量与标签数（文本密度打分的三个输入）。
function measure(node: DomNode, insideLink: boolean): BlockStats {
  if (node.kind === "text") {
    const length = decodeEntities(node.value).replace(/\s+/g, " ").trim().length;
    return { textLength: length, linkTextLength: insideLink ? length : 0, tagCount: 0 };
  }
  if (CHROME_TAGS.has(node.tag)) return { textLength: 0, linkTextLength: 0, tagCount: 0 };

  const stats: BlockStats = { textLength: 0, linkTextLength: 0, tagCount: 1 };
  const childInsideLink = insideLink || node.tag === "a";
  for (const child of node.children) {
    const childStats = measure(child, childInsideLink);
    stats.textLength += childStats.textLength;
    stats.linkTextLength += childStats.linkTextLength;
    stats.tagCount += childStats.tagCount;
  }
  return stats;
}

/// 文本密度打分：净文本量（扣掉链接文字）× 每标签平均文本量。
/// 两个因子缺一不可——只看总量会选中「整页 body」，只看密度会选中一个短句子的 <p>。
function densityScore(stats: BlockStats): number {
  const netText = stats.textLength - stats.linkTextLength;
  if (netText <= 0) return 0;
  return netText * (stats.textLength / (1 + stats.tagCount));
}

/// 深度优先收集所有元素。
function collectElements(node: ElementNode, out: ElementNode[] = []): ElementNode[] {
  for (const child of node.children) {
    if (child.kind !== "element" || CHROME_TAGS.has(child.tag)) continue;
    out.push(child);
    collectElements(child, out);
  }
  return out;
}

/// 选出正文主块：语义标签（article / main / [role=main]）优先，否则按文本密度打分选。
function selectMainBlock(root: ElementNode): ElementNode {
  const elements = collectElements(root);

  const semantic = elements.filter(
    (el) =>
      el.tag === "article" ||
      el.tag === "main" ||
      attrValue(el.attrs, "role")?.toLowerCase() === "main",
  );
  if (semantic.length > 0) {
    // 同页多个 <article>（列表页）时取文本最多的那个。
    return semantic.reduce((best, el) =>
      measure(el, false).textLength > measure(best, false).textLength ? el : best,
    );
  }

  let best: ElementNode = root;
  let bestScore = 0;
  for (const element of elements) {
    if (!CANDIDATE_TAGS.has(element.tag)) continue;
    const score = densityScore(measure(element, false));
    if (score > bestScore) {
      bestScore = score;
      best = element;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 正文渲染
// ---------------------------------------------------------------------------

interface RawHeading {
  rawOffset: number;
  level: number;
  title: string;
}

/// 把主块渲染成纯文本，同时记录标题在**原始拼接串**中的位置。
function renderText(node: ElementNode): { raw: string; headings: RawHeading[] } {
  const parts: string[] = [];
  const headings: RawHeading[] = [];
  let length = 0;

  const push = (value: string): void => {
    if (value.length === 0) return;
    parts.push(value);
    length += value.length;
  };
  /// 段落边界：只在尾部还不是空行时补，避免堆出十几个换行。
  const breakParagraph = (): void => {
    const tail = parts.length > 0 ? parts[parts.length - 1]! : "";
    if (parts.length > 0 && !tail.endsWith("\n\n")) push("\n\n");
  };

  const walk = (current: DomNode): void => {
    if (current.kind === "text") {
      push(decodeEntities(current.value));
      return;
    }
    if (CHROME_TAGS.has(current.tag) || RAW_DROP_TAGS.includes(current.tag)) return;
    if (current.tag === "br") {
      push("\n");
      return;
    }

    const level = HEADING_LEVELS[current.tag];
    const isBlock = BLOCK_TAGS.has(current.tag);
    if (isBlock) breakParagraph();
    const start = length;

    for (const child of current.children) walk(child);

    if (level) {
      // 标题文本取渲染后的片段本身，保证它与正文里的字符逐字一致（后面才好定位 offset）。
      const title = parts.join("").slice(start).replace(/\s+/g, " ").trim();
      if (title.length > 0) headings.push({ rawOffset: start, level, title });
    }
    if (isBlock) breakParagraph();
  };

  walk(node);
  return { raw: parts.join(""), headings };
}

/// 把标题的原始 offset 映射到归一后正文的 offset。
///
/// 为什么要重新定位而不是直接换算：normalizeExtractedText 会折叠空白、删零宽字符、压缩空行，
/// 长度变化不是线性的，任何「按比例换算」都会错位。标题在正文中本就按出现顺序排列，
/// 用一个单调前进的游标顺序查找既准确又避免了同名标题相互抢位。找不到的标题直接丢弃——
/// 宁可少一个标题路径，也不能给出错误的 offset（错误 offset 会让引用指向别的句子）。
function relocateHeadings(text: string, headings: RawHeading[]): HeadingAnchor[] {
  const anchors: HeadingAnchor[] = [];
  let cursor = 0;
  for (const heading of headings) {
    const offset = text.indexOf(heading.title, cursor);
    if (offset < 0) continue;
    anchors.push({ offset, level: heading.level, title: heading.title });
    cursor = offset + heading.title.length;
  }
  return anchors;
}

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

/// 从 <meta> 中按 property/name 取 content。
function metaContent(html: string, key: string): string | undefined {
  const pattern = new RegExp(
    `<meta\\b(?=[^>]*\\b(?:property|name|itemprop)\\s*=\\s*["']?${key}["']?)([^>]*)>`,
    "i",
  );
  const match = pattern.exec(html);
  return match ? attrValue(match[1] ?? "", "content")?.trim() : undefined;
}

/// 抽取标题：<title> 优先，回退 og:title。
function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = match?.[1];
  const title = raw ? decodeEntities(raw).replace(/\s+/g, " ").trim() : "";
  if (title.length > 0) return title;
  return metaContent(html, "og:title") ?? "";
}

/// 抽取 canonical link。
function extractCanonical(html: string): string | undefined {
  const match = /<link\b(?=[^>]*\brel\s*=\s*["']?canonical["']?)([^>]*)>/i.exec(html);
  return match ? attrValue(match[1] ?? "", "href")?.trim() : undefined;
}

/// 抽取发布时间：og → article → itemprop → 首个 <time datetime>。
/// 顺序即可信度：站点自报的 meta 比正文里的 <time> 更可能是「本文」的时间。
function extractPublishedAt(html: string): string | undefined {
  const fromMeta =
    metaContent(html, "og:published_time") ??
    metaContent(html, "article:published_time") ??
    metaContent(html, "datePublished") ??
    metaContent(html, "pubdate");
  if (fromMeta) return fromMeta;
  const time = /<time\b([^>]*)>/i.exec(html);
  return time ? attrValue(time[1] ?? "", "datetime")?.trim() : undefined;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/// 从 HTML 抽取正文、标题锚点与元数据。输入可以是任意畸形 HTML，不会抛错。
export function extractHtmlDocument(html: string): HtmlExtraction {
  // 元数据必须从**原始 HTML** 取：它们都在 <head> 里，而正文抽取走的是 body 的主块。
  const title = extractTitle(html);
  const canonicalUrl = extractCanonical(html);
  const publishedAt = extractPublishedAt(html);

  const dom = parseDom(stripRawBlocks(html));
  const main = selectMainBlock(dom);
  const rendered = renderText(main);
  const text = normalizeExtractedText(rendered.raw);

  return {
    title,
    ...(canonicalUrl ? { canonicalUrl } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    text,
    headings: relocateHeadings(text, rendered.headings),
  };
}
