// 从 .md 文本里剥离开头的 YAML frontmatter(--- … ---),供预览渲染成元数据卡片。
// 只解析「平铺 key: value」这一层(plan/任务文档的元数据都是这种形态),不引第三方 YAML 依赖。
// 解析失败或没有 frontmatter 时,原样返回正文,绝不吞掉内容。

export type FrontmatterEntry = { key: string; value: string };

export type SplitMarkdown = {
  meta: FrontmatterEntry[] | null;
  body: string;
};

// 仅当文档以 --- 独占一行开头,且后面能找到闭合的 --- / ... 独占行时,才认定为 frontmatter。
const OPEN_RE = /^---[ \t]*\r?\n/;

function stripQuotes(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    return v.slice(1, -1);
  }
  return v;
}

export function splitFrontmatter(content: string): SplitMarkdown {
  if (!OPEN_RE.test(content)) return { meta: null, body: content };

  const lines = content.split(/\r?\n/);
  // lines[0] 是开头的 ---;从第 2 行起找闭合行。
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  if (end === -1) return { meta: null, body: content };

  const meta: FrontmatterEntry[] = [];
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    if (!key) continue;
    meta.push({ key, value: stripQuotes(line.slice(sep + 1)) });
  }

  // 闭合行之后即正文;去掉紧跟的一个空行,避免正文顶部多一段空白。
  const body = lines.slice(end + 1).join("\n").replace(/^\r?\n/, "");
  return { meta: meta.length ? meta : null, body };
}
