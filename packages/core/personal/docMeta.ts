// 把 ce-ideate / ce-brainstorm / ce-plan 生成、落在 docs/{ideation,brainstorms,plans}/*.md
// 的文档头部文本归一为 ParsedDocMeta。三级抽取，优先级递降：
//   (a) YAML frontmatter（--- 独占行包裹的平铺 key: value）
//   (b) inline 块（# 标题之后、首个空行之前的 `- 字段：值` / `- 字段: 值`，兼容中英文冒号）
//   (c) 文件名兜底：YYYY-MM-DD-NNN-<type>-<slug>-<plan|deepen|brainstorm>.md
// 纯函数，无 IO。状态归一(docStatus)、标签(docTags)、血缘(docLineage) 各自消费本结果。
// 解析失败/损坏输入：返回带 kind 的最小 ParsedDocMeta，绝不抛、绝不吞正文。

export type DocKind = "ideation" | "brainstorm" | "plan";

// 文档变更类型（与 plan frontmatter 的 type 字段一致；非枚举，留 string 容未来值）
export type DocType = string;

export interface ParsedDocMeta {
  path: string; // repo-relative
  name: string; // 文件名
  kind: DocKind; // 由所在目录决定（最权威，调用方传入）
  title: string; // frontmatter title → 首个 # 行 → slug 兜底
  type?: DocType; // feat/fix/chore/docs/style
  statusRaw?: string; // 原始 status 文本（归一交给 docStatus）
  date?: string;
  seq?: number; // 文件名序号
  depth?: string; // Deep/Standard（多见于 plan inline）
  topic?: string;
  origin: string[]; // 原样收集的 origin 值（抽路径交给 docLineage）
}

// 仅当文本以 --- 独占一行开头时才认定为 YAML frontmatter（与 views 侧 splitFrontmatter 同义）。
const YAML_OPEN_RE = /^---[ \t]*\r?\n/;

// inline 元数据行：`- 字段：值` / `- 字段: 值`（中英文冒号皆可）。
const INLINE_RE = /^-\s+([^:：]+?)\s*[:：]\s*(.+?)\s*$/;

// 文件名结构：日期-序号-类型-slug-种类.md
const FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2})-(\d{3})-(feat|fix|chore|docs|style|refactor)-(.+)-(plan|deepen|brainstorm)\.md$/;

function stripQuotes(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

// 把一组 key:value 收进 map，键统一小写以便中英文别名查找（中文键原样保留小写无副作用）。
type MetaMap = Map<string, string[]>;

function pushMeta(map: MetaMap, key: string, value: string): void {
  const k = key.trim().toLowerCase();
  if (!k) return;
  const list = map.get(k);
  if (list) list.push(value);
  else map.set(k, [value]);
}

function pick(map: MetaMap, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const list = map.get(key.toLowerCase());
    if (list && list.length && list[0]?.trim()) return list[0]?.trim();
  }
  return undefined;
}

function pickAll(map: MetaMap, ...keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const list = map.get(key.toLowerCase());
    if (list) out.push(...list.filter((v) => v.trim()));
  }
  return out;
}

// (a) 解析 YAML frontmatter 块，返回 [metaMap, 是否命中]。
function parseYamlBlock(lines: string[]): [MetaMap, boolean] {
  const map: MetaMap = new Map();
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  if (end === -1) return [map, false];
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    if (!key) continue;
    pushMeta(map, key, stripQuotes(line.slice(sep + 1)));
  }
  return [map, true];
}

// (b) 解析 # 标题之后、首个空行前的 inline `- 字段：值` 块。返回 [metaMap, 标题文本|undefined]。
function parseInlineBlock(lines: string[]): [MetaMap, string | undefined] {
  const map: MetaMap = new Map();
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i] ?? "")) {
      headingIdx = i;
      break;
    }
  }
  const title = headingIdx >= 0 ? (lines[headingIdx] ?? "").replace(/^#\s+/, "").trim() : undefined;
  if (headingIdx >= 0) {
    for (let i = headingIdx + 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!line.trim()) break; // 首个空行终止 inline 块
      const m = INLINE_RE.exec(line);
      if (!m) {
        // 允许块内偶有非匹配行（如续行）；遇到新标题/分隔线则终止
        if (/^(#|-{3,})/.test(line.trimStart())) break;
        continue;
      }
      pushMeta(map, m[1] ?? "", stripQuotes(m[2] ?? ""));
    }
  }
  return [map, title];
}

// slug：从文件名剥掉 日期-序号-类型 前缀与 -plan/-deepen/-brainstorm.md 后缀。
function slugFromName(name: string): string {
  const m = FILENAME_RE.exec(name);
  if (m) return (m[4] ?? "").replace(/-/g, " ");
  return name.replace(/\.(md|markdown)$/i, "").replace(/-/g, " ");
}

export function parseDocMeta(head: string, path: string, kind: DocKind): ParsedDocMeta {
  const name = basename(path);
  const base: ParsedDocMeta = { path, name, kind, title: slugFromName(name), origin: [] };
  try {
    const lines = (head ?? "").split(/\r?\n/);
    const isYaml = YAML_OPEN_RE.test(head ?? "");

    const [yamlMap] = isYaml ? parseYamlBlock(lines) : [new Map<string, string[]>(), false];
    // inline 块在正文里（YAML 文件也可能在 frontmatter 之后有 # 标题），都扫一遍取标题与 inline 元数据。
    const [inlineMap, headingTitle] = parseInlineBlock(lines);

    // 合并：YAML 优先，inline 补缺。
    const get = (...keys: string[]) => pick(yamlMap, ...keys) ?? pick(inlineMap, ...keys);
    const getAll = (...keys: string[]) => {
      const y = pickAll(yamlMap, ...keys);
      return y.length ? y : pickAll(inlineMap, ...keys);
    };

    // 文件名兜底字段
    const fm = FILENAME_RE.exec(name);
    const fnDate = fm?.[1];
    const fnSeq = fm?.[2] ? Number(fm[2]) : undefined;
    const fnType = fm?.[3];

    const title = get("title") || headingTitle || slugFromName(name);
    const type = get("type", "类型") || fnType || undefined;
    const statusRaw = get("status", "状态") || undefined;
    const date = get("date", "日期") || fnDate || undefined;
    const depth = get("深度", "depth") || undefined;
    const topic = get("topic", "主题") || undefined;
    const origin = getAll("origin", "来源");

    return {
      ...base,
      title,
      type,
      statusRaw,
      date,
      depth,
      topic,
      seq: fnSeq, // seq 始终来自文件名
      origin,
    };
  } catch {
    return base; // 损坏输入：返回最小 DocMeta，不抛
  }
}
