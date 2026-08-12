// 写作左栏「文稿列表」的纯展示/排序工具：隐藏 md 后缀、重命名回填后缀、按偏好排序、时间格式化。
// 放在 core 是因为这些规则同时被左栏渲染与重命名提交两条路径消费，且必须可单测（无 DOM/无 fs）。
import type { PromptNode } from "../desktop/types";
import type { WritingDocMetaItem } from "../desktop/writing-doc-meta-types";
import type { WritingDocSortKey, WritingDocSortOrder } from "../desktop/writing-types";

// 左栏隐藏的扩展名：写作空间默认就是 md，后缀是纯噪音且让重命名变麻烦。
// pdf 等非编辑格式**不隐藏**——它们与可编辑文档行为不同，保留后缀是必要的区分信号。
const HIDDEN_EXT_RE = /\.(md|markdown|mdx)$/i;

// 文件名 → 左栏展示名（隐藏 md 系后缀）。目录名原样返回（目录名不带后缀语义）。
export function writingDisplayName(name: string): string {
  return name.replace(HIDDEN_EXT_RE, "");
}

// 取被隐藏的后缀（含点）；未隐藏后缀时回空串。重命名提交时用它把后缀补回去。
export function writingHiddenExt(name: string): string {
  const m = HIDDEN_EXT_RE.exec(name);
  return m ? m[0] : "";
}

// 重命名回填：左栏展示的是去后缀名，用户输入的自然也是去后缀名，提交时必须把原后缀补回，
// 否则 `笔记` 会把 `笔记.md` 改成无后缀文件（编辑器与树都不再认它）。
// 用户主动输入了 md 系后缀（如 `笔记.mdx`）则尊重输入，不再叠加。
export function applyWritingRenameName(originalName: string, input: string): string {
  const trimmed = input.trim();
  const ext = writingHiddenExt(originalName);
  if (!trimmed || !ext) return trimmed; // 空输入交给上层的 invalid 校验；非 md 文件/目录原样提交
  return HIDDEN_EXT_RE.test(trimmed) ? trimmed : `${trimmed}${ext}`;
}

// 排序取值：created→创建时间、updated→修改时间；缺元信息（未拉到/非文件）按 0，保证有确定次序。
function timeOf(
  path: string,
  key: WritingDocSortKey,
  metaByPath: Record<string, WritingDocMetaItem | undefined>,
): number {
  const meta = metaByPath[path];
  if (!meta) return 0;
  return key === "created" ? meta.birthtimeMs : meta.mtimeMs;
}

// 名称比较：数值感知 + 中文本地序（`第2章` 排在 `第10章` 前）。
function compareName(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hans", { numeric: true, sensitivity: "base" });
}

// 按左栏偏好排序整棵树（递归，返回新节点，不改原树）。
// 约定：目录恒在文件之前（与主进程扫描口径一致，时间排序不该把目录冲散到文件中间）；
// 目录之间始终按名称排（目录没有「文稿创建时间」语义），只有文件参与时间排序；
// 时间相同 / 缺元信息时按名称兜底，避免顺序在两次扫描间抖动。
export function sortWritingTree(
  node: PromptNode,
  opts: {
    key: WritingDocSortKey;
    order: WritingDocSortOrder;
    metaByPath: Record<string, WritingDocMetaItem | undefined>;
  },
): PromptNode {
  const children = node.children;
  if (!children || children.length === 0) return node;
  const dir = opts.order === "desc" ? -1 : 1;
  const sorted = [...children].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    if (a.kind === "dir" || opts.key === "name") return dir * compareName(a.name, b.name);
    const ta = timeOf(a.path, opts.key, opts.metaByPath);
    const tb = timeOf(b.path, opts.key, opts.metaByPath);
    if (ta !== tb) return dir * (ta - tb);
    return compareName(a.name, b.name);
  });
  return { ...node, children: sorted.map((c) => sortWritingTree(c, opts)) };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// 时间戳 → 左栏展示文本 `YYYY/MM/DD HH:mm`（本地时区）。非法/缺失回空串。
export function formatWritingDocTime(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 按绝对路径在树里找目录节点（左栏「进入子目录」只渲染该节点的直接子级）。
// 找不到（目录已被删/改名）回 null，调用方据此回落到上级或空间根。
export function findWritingDirNode(
  node: PromptNode | null | undefined,
  path: string,
): PromptNode | null {
  if (!node) return null;
  if (node.path === path) return node.kind === "dir" ? node : null;
  // 只往「路径前缀命中」的分支下钻，避免整树遍历。
  if (!path.startsWith(`${node.path}/`)) return null;
  for (const child of node.children ?? []) {
    if (child.kind !== "dir") continue;
    const hit = findWritingDirNode(child, path);
    if (hit) return hit;
  }
  return null;
}

// 相对空间根的层级片段（面包屑用）：root=/a、path=/a/b/c → ["b", "c"]；path===root → []。
export function writingCrumbSegments(root: string, path: string): string[] {
  const base = root.replace(/[/\\]+$/, "");
  if (path === base) return [];
  if (!path.startsWith(`${base}/`)) return [];
  return path.slice(base.length + 1).split("/").filter(Boolean);
}

// 目录内的文档数（递归含子目录）。左栏目录行显示它，让用户不进去也知道里面有没有东西。
// 树本身已按 filterWritingTree 只留写作文件（md 系 + pdf），故这里数到的就是「文档数」。
export function countWritingDocs(node: PromptNode | null | undefined): number {
  if (!node) return 0;
  if (node.kind === "file") return 1;
  return (node.children ?? []).reduce((sum, c) => sum + countWritingDocs(c), 0);
}

// 收集树内全部文件的绝对路径（拉 writing:docMeta 用）。
export function collectWritingFilePaths(node: PromptNode | null | undefined): string[] {
  if (!node) return [];
  const out: string[] = [];
  const walk = (n: PromptNode): void => {
    if (n.kind === "file") {
      out.push(n.path);
      return;
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return out;
}
