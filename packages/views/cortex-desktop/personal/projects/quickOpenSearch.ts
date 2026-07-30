// 「快速入口」命令面板的纯匹配逻辑（无 React/IO 依赖，便于表驱动单测）。
// 提供子序列模糊评分 fuzzyScore 与全量任务 + 项目/文件夹匹配 quickOpenSearch。
import type { TaskMeta, TaskProject } from "@cortex-work/core/desktop/types";
import { projectKind } from "@cortex-work/core/personal/taskProjectTree";

// 一条命令面板结果：任务 / 项目 / 文件夹三类。
export interface QuickOpenResult {
  kind: "task" | "project" | "folder";
  id: string;
  label: string; // 任务标题 / 项目·文件夹名
  sublabel?: string; // 任务:所属项目名或「收件箱」;项目/文件夹无
}

// 计分梯度基座:不同命中方式落在相隔极远的档位,保证「档位」始终压过「同档内的长度微调」。
// 4=前缀 > 3=词边界 > 2=连续子串 > 1=离散子序列;档位间距 1e6,远大于任何现实标题长度。
const TIER_STEP = 1_000_000;

// 判断 q 是否为 t 的离散子序列(字符顺序一致但可不连续)。
function isSubsequence(t: string, q: string): boolean {
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++;
  }
  return i === q.length;
}

// 判断 t 中是否存在从「词边界」起始的 q 连续出现:出现位置前一个字符是非字母数字(空格/连字符/标点/CJK 标点等)即视为词边界。
// 前缀(index 0)由调用方先行判定,此处只关心「非行首的词边界」。
function hasWordBoundaryMatch(t: string, q: string): boolean {
  let from = t.indexOf(q);
  while (from > 0) {
    const prev = t[from - 1]!;
    // 前一字符非字母数字 → 该处是词边界(如空格/标点后的首词)。
    if (!/[\p{L}\p{N}]/u.test(prev)) return true;
    from = t.indexOf(q, from + 1);
  }
  return false;
}

// 子序列模糊评分:命中返回分值(越大越靠前),不命中返回 null。大小写不敏感。
// 计分梯度:前缀命中 > 词边界命中 > 连续子串 > 离散子序列;同档下目标越短越靠前(减去长度做微调)。
export function fuzzyScore(text: string, query: string): number | null {
  const q = query.toLowerCase();
  if (!q) return null; // 空 query 无意义匹配(空/全空白由 quickOpenSearch 提前短路)
  const t = text.toLowerCase();

  let tier: number;
  if (t.startsWith(q)) tier = 4; // 前缀
  else if (hasWordBoundaryMatch(t, q)) tier = 3; // 词边界
  else if (t.includes(q)) tier = 2; // 连续子串(非词边界内嵌)
  else if (isSubsequence(t, q)) tier = 1; // 离散子序列
  else return null;

  // 同档内目标越短分越高;text.length 远小于 TIER_STEP,不会跨档。
  return tier * TIER_STEP - text.length;
}

// done/dropped 任务的降权系数:仍参与搜索但同分下排到后面(简单实现,分值乘 0.5)。
const DONE_PENALTY = 0.5;

// 全量任务 + 项目/文件夹匹配。分降序;同分时「项目/文件夹类」优先于任务(tie-break);截断 limit(默认 30)。
// 空/全空白 query 直接返回 []。task 的 sublabel:projectId 能解析到存活项目 → 项目名,否则「收件箱」。
export function quickOpenSearch(
  tasks: TaskMeta[],
  projects: TaskProject[],
  query: string,
  limit = 30,
): QuickOpenResult[] {
  const q = query.trim();
  if (!q) return [];

  // 存活项目 id → 名称,供任务 sublabel 解析(id 不在表中 = 悬空 → 收件箱)。
  const nameById = new Map<string, string>();
  for (const p of projects) nameById.set(p.id, p.name);

  // 收集时同时记下 score 与 isProjectLike(项目/文件夹类),排序阶段做降序 + tie-break。
  const scored: { result: QuickOpenResult; score: number; isProjectLike: boolean }[] = [];

  for (const p of projects) {
    const s = fuzzyScore(p.name, q);
    if (s == null) continue;
    const kind = projectKind(p) === "folder" ? "folder" : "project";
    scored.push({ result: { kind, id: p.id, label: p.name }, score: s, isProjectLike: true });
  }

  for (const t of tasks) {
    const base = fuzzyScore(t.title, q);
    if (base == null) continue;
    // done/dropped 降权:同分靠后。
    const score = t.status === "done" || t.status === "dropped" ? base * DONE_PENALTY : base;
    const sublabel = t.projectId && nameById.has(t.projectId) ? nameById.get(t.projectId)! : "收件箱";
    scored.push({ result: { kind: "task", id: t.id, label: t.title, sublabel }, score, isProjectLike: false });
  }

  // 分降序;同分时项目/文件夹类(isProjectLike)优先。
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.isProjectLike !== b.isProjectLike) return a.isProjectLike ? -1 : 1;
    return 0;
  });

  return scored.slice(0, limit).map((s) => s.result);
}
