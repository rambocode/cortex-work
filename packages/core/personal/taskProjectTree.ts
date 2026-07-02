// 项目层级派生纯函数（U1）。无 React/IO 依赖，便于表驱动单测。
// 数据类型见 ../desktop/tasks-types。层级语义（KTD2）：
//   - project 可嵌于 folder 或另一 project（子项目）之下；folder 仅分组、任务只挂 project。
//   - kind 缺省视为 "project"（读时由 store normalizeData 补默认，纯函数这里对 undefined 容错）。
import type { TaskProject, TaskProjectKind } from "../desktop/tasks-types";

// 树节点：TaskProject + 子节点数组。
export interface TaskProjectNode extends TaskProject {
  children: TaskProjectNode[];
}

// kind 读时默认 project（与 store U2 normalizeData 一致；纯函数对旧档 undefined 容错）。
export function projectKind(p: Pick<TaskProject, "kind">): TaskProjectKind {
  return p.kind ?? "project";
}

// 按 parentId 组树。规则：无 parentId = 顶层；parentId 指向不存在的父（悬空）或指向自身 → 兜底为顶层，绝不丢节点。
export function buildProjectTree(projects: TaskProject[]): TaskProjectNode[] {
  const byId = new Map<string, TaskProjectNode>();
  for (const p of projects) byId.set(p.id, { ...p, children: [] });
  const roots: TaskProjectNode[] = [];
  for (const p of projects) {
    const node = byId.get(p.id)!;
    const parent = p.parentId && p.parentId !== p.id ? byId.get(p.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node); // 顶层 / 悬空 parentId / 自指 → 兜底顶层
  }
  return roots;
}

// 该节点子树内全部「可容纳任务的 project」id 集合，供中列统一聚合（U7）：
//   - 选中节点为 project → 含其自身 + 后代 sub-project；
//   - 选中节点为 folder → 仅后代 project（folder 自身 id 不计入，任务不挂 folder）。
// 深度优先遍历，去重返回。
export function descendantProjectIds(projects: TaskProject[], id: string): string[] {
  const childrenOf = new Map<string, TaskProject[]>();
  for (const p of projects) {
    if (!p.parentId || p.parentId === p.id) continue;
    const arr = childrenOf.get(p.parentId);
    if (arr) arr.push(p);
    else childrenOf.set(p.parentId, [p]);
  }
  const out = new Set<string>();
  const self = projects.find((p) => p.id === id);
  if (self && projectKind(self) === "project") out.add(self.id);
  const seen = new Set<string>();
  const visit = (nodeId: string) => {
    if (seen.has(nodeId)) return; // 环止损
    seen.add(nodeId);
    for (const child of childrenOf.get(nodeId) ?? []) {
      if (projectKind(child) === "project") out.add(child.id);
      visit(child.id);
    }
  };
  visit(id);
  return [...out];
}

// 聚焦子树全部节点 id 集合（含自身 + 所有后代 folder/project），供「聚焦某节点」时统一收拢整棵子树。
// 与 descendantProjectIds 的区别：后者只返回可容纳任务的 project 后代（排除 folder、按选中类型决定是否含自身）；
// 本函数不区分 kind，返回自身 + 全部后代（folder 与 project 都计入）的 id。
// DFS + seen 环止损；对悬空/自指 parentId 天然容错（childrenOf 不含自指边，悬空父不产生子边）。id 不存在返回空集。
export function subtreeNodeIds(projects: TaskProject[], id: string): Set<string> {
  const childrenOf = new Map<string, TaskProject[]>();
  for (const p of projects) {
    if (!p.parentId || p.parentId === p.id) continue; // 自指边忽略，避免自成环
    const arr = childrenOf.get(p.parentId);
    if (arr) arr.push(p);
    else childrenOf.set(p.parentId, [p]);
  }
  const out = new Set<string>();
  if (!projects.some((p) => p.id === id)) return out; // id 不存在 → 空集
  const visit = (nodeId: string) => {
    if (out.has(nodeId)) return; // 已收录即已访问，兼作环止损
    out.add(nodeId);
    for (const child of childrenOf.get(nodeId) ?? []) visit(child.id);
  };
  visit(id);
  return out;
}

// reparent 防环（U2/U6）：把 nodeId 挂到 candidateParentId 之下是否会成环。
// 成环当且仅当 candidateParentId 是 nodeId 自身或其后代——等价于从 candidate 向上走能抵达 nodeId。
// 从 candidate 沿 parentId 上溯到根，若途经 nodeId 则拒绝。带 seen 防已损坏的环。
export function isDescendant(projects: TaskProject[], nodeId: string, candidateParentId: string): boolean {
  if (nodeId === candidateParentId) return true;
  const byId = new Map(projects.map((p) => [p.id, p]));
  const seen = new Set<string>();
  let cur: string | undefined = candidateParentId;
  while (cur) {
    if (cur === nodeId) return true;
    if (seen.has(cur)) break; // 已存在的环，止损
    seen.add(cur);
    cur = byId.get(cur)?.parentId;
  }
  return false;
}

// 过滤出可容纳任务的 project 节点（排除 folder），供右栏扁平 Projects tab / 详情 select / 结构化建议接受（U9）。
export function onlyProjects(projects: TaskProject[]): TaskProject[] {
  return projects.filter((p) => projectKind(p) === "project");
}
