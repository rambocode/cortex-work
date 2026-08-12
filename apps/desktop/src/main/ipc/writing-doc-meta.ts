// 写作左栏「文稿列表」元信息 IPC 域：批量取一批文档的创建/修改时间 + 正文概要。
// 用途：左栏可配置的列表显示模式（显示创建时间 / 显示概要）与按时间排序，都需要文件树之外的信息。
//
// 只读：只 stat + 读文件头（8KB），不写盘；每条路径仍过 assertAllowed 白名单（越权路径静默跳过，
// 不整批抛错——树里混进一条越权路径不该让整个左栏空掉）。
// 摘要抽取是纯函数（writingDocExcerpt），就近单测；结果按 path+mtime+size 缓存，
// 文件没变时重复展开/刷新不再读盘。

import { ipcMain } from "electron";
import { open, stat } from "node:fs/promises";
import { extname } from "node:path";
import { assertAllowed } from "./fs";
import type {
  WritingDocMetaItem,
  WritingDocMetaRequest,
  WritingDocMetaResult,
} from "./writing-doc-meta-types";

// ── 规模上限 ────────────────────────────────────────────────────────────
const MAX_PATHS = 800; // 单次请求路径上限（超出截断，左栏本就不该有这么多文档）
const HEAD_BYTES = 8 * 1024; // 抽摘要只读文件头，正文首段一定落在这里
const EXCERPT_MAX_CHARS = 50; // 概要长度上限（产品口径：50 字符内）
const EXCERPT_CACHE_MAX = 600; // 摘要缓存条目上限，超出整表清空（简单 LRU 替代）

// 参与摘要抽取的扩展名：只有 markdown 系有「正文」概念；pdf 等直接给空摘要。
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);

// 摘要缓存：path → { key: `${mtimeMs}:${size}`, excerpt }。文件变动即 key 不匹配，自动重算。
const excerptCache = new Map<string, { key: string; excerpt: string }>();

// 常见 HTML 实体 → 字符（概要是纯文本，留着 &nbsp; 这类转义在列表里就是噪音）。
const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

// 行内标记清理：概要只保留纯文本，所有标记类符号一律剥掉。
// 顺序有讲究：图片必须先于链接处理（`![]()` 也匹配链接规则，先跑链接会留下一个孤零零的 `!`）；
// 实体解码放最后，避免解出的 `<`/`&` 又被前面的标签规则二次吃掉。
function stripInlineMarkdown(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // ![alt](src) 图片：无正文价值，整段去掉
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "") // ![alt][ref] 引用式图片
    .replace(/\[\^[^\]]*\]/g, "") // [^1] 脚注引用
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1") // [text][ref] → text
    .replace(/<!--[\s\S]*?-->/g, "") // HTML 注释
    .replace(/<[^>]*>/g, "") // HTML / 自动链接标签（<br>、<https://…>）
    .replace(/\{[^{}]*\}/g, "") // {#anchor}、{.class} 之类的属性块
    .replace(/\$\$?/g, "") // 行内/块级公式定界符
    .replace(/[`~*_]+/g, "") // 行内代码、强调、删除线
    .replace(/\|/g, " ") // 表格单元格分隔符 → 空格
    .replace(/&[a-zA-Z#0-9]{2,7};/g, (m) => HTML_ENTITIES[m.toLowerCase()] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// 从 markdown 原文抽正文概要（纯函数，供单测）：
// 跳过 frontmatter、围栏代码块、标题（标题通常与文件名重复，无信息量）、表格分隔线、引用/列表记号，
// 取剩下的正文行拼接，压缩空白后截到 max 个字符（按码点计，避免截断中文/emoji）。
export function writingDocExcerpt(raw: string, max: number = EXCERPT_MAX_CHARS): string {
  const text = raw.replace(/^\uFEFF/, ""); // 去 BOM，否则首行 --- 匹配不上、frontmatter 会被当正文
  const lines = text.split(/\r?\n/);
  let i = 0;
  // YAML frontmatter：仅当首行就是 --- 时成立，找到闭合行后从其下一行开始。
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
    i = close > 0 ? close + 1 : lines.length;
  }
  const parts: string[] = [];
  let inFence = false;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!trimmed) continue;
    if (/^#{1,6}\s/.test(trimmed)) continue; // 标题
    if (/^[-*_]{3,}$/.test(trimmed)) continue; // 分隔线
    if (/^:{3,}/.test(trimmed)) continue; // :::note 之类的容器指令行
    if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(trimmed) && trimmed.includes("|")) continue; // 表格分隔行
    // 引用 / 无序列表 / 有序列表 / 任务项的行首记号：去掉记号保留内容。
    const body = trimmed
      .replace(/^>+\s*/, "")
      .replace(/^([-*+]|\d+\.)\s+/, "")
      .replace(/^\[[ xX]\]\s*/, "");
    const cleaned = stripInlineMarkdown(body);
    if (cleaned) parts.push(cleaned);
    // 已够长就停：不必把整个文件都清洗一遍。
    if (Array.from(parts.join(" ")).length >= max) break;
  }
  const merged = parts.join(" ").replace(/\s+/g, " ").trim();
  const chars = Array.from(merged);
  return chars.length <= max ? merged : `${chars.slice(0, max).join("")}…`;
}

// 读文件头（HEAD_BYTES）并抽摘要。读失败（权限/竞态删除）回空串，不阻断整批。
async function readExcerpt(path: string, cacheKey: string): Promise<string> {
  const hit = excerptCache.get(path);
  if (hit && hit.key === cacheKey) return hit.excerpt;
  let excerpt = "";
  try {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      excerpt = writingDocExcerpt(buf.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
  if (excerptCache.size >= EXCERPT_CACHE_MAX) excerptCache.clear();
  excerptCache.set(path, { key: cacheKey, excerpt });
  return excerpt;
}

// 单条路径 → 元信息；越权 / stat 失败（列举后被删）回 null，由调用方剔除。
async function docMetaFor(path: string, withExcerpt: boolean): Promise<WritingDocMetaItem | null> {
  try {
    await assertAllowed(path);
  } catch {
    return null;
  }
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const isMarkdown = MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase());
  const excerpt =
    withExcerpt && isMarkdown ? await readExcerpt(path, `${st.mtimeMs}:${st.size}`) : "";
  return {
    path,
    mtimeMs: st.mtimeMs,
    // birthtime 在部分文件系统上为 0（不支持），回落 mtime 免得 UI 显示 1970。
    birthtimeMs: st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs,
    excerpt,
  };
}

export function registerWritingDocMetaHandlers(): void {
  ipcMain.handle(
    "writing:docMeta",
    async (_e, req: WritingDocMetaRequest): Promise<WritingDocMetaResult> => {
      const paths = Array.from(new Set(req?.paths ?? [])).slice(0, MAX_PATHS);
      const withExcerpt = req?.withExcerpt === true;
      // 并发读一批小文件头对磁盘友好，但仍分批（16 并发）避免大空间打满 fd。
      const items: WritingDocMetaItem[] = [];
      for (let i = 0; i < paths.length; i += 16) {
        const batch = await Promise.all(
          paths.slice(i, i + 16).map((p) => docMetaFor(p, withExcerpt)),
        );
        for (const it of batch) if (it) items.push(it);
      }
      return { items };
    },
  );
}
