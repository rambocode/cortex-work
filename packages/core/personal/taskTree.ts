// 子任务层级派生纯函数（U1）。无 React/IO 依赖，便于表驱动单测。
// 数据类型见 ../desktop/tasks-types。层级语义（KTD1/KTD2）：
//   - TaskMeta.parentTaskId 单指针指向父任务，缺省/悬空 = 顶层；任意深度嵌套。
//   - 建树用「两遍 Map 法」即时组装：父在当前 scope 内则子缩进嵌入、父不在则子升为顶层。
//     于是项目视图（父子同在）自然成树、计算视图（Today/Inbox 扁平结果集，父多半不在）自然扁平，
//     零按视图特判（借鉴 IFocus TaskList 建树器）。
import type { TaskMeta, TaskStatus } from "../desktop/tasks-types";

// 树节点：TaskMeta + 子节点数组 + 相对本 scope 的缩进深度（顶层 = 0）。
export interface TaskTreeNode extends TaskMeta {
  children: TaskTreeNode[];
  depth: number;
}

// 终态：进入这两个状态视为「已完结」，用于完成 rollup 判定。
const TERMINAL_STATUS: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "dropped"]);

// 按 parentTaskId 组树（两遍 Map 法）。规则：
//   - 第一遍把每个 task 包成节点入 Map；
//   - 第二遍遍历，父在 Map 内 → push 到父的 children、depth = 父.depth + 1；
//     无 parentTaskId / 父不在 scope / 自指 → 作为顶层根（depth 0），绝不丢节点。
// 兄弟顺序 = 输入顺序（调用方通常先按 compareTasks 排好序再建树，故输出即有序）。
// 注意：depth 依赖父先于子被赋值。父可能在数组中位于子之后，故第二遍先建立父子链接、
// 再对每棵根子树做一次 DFS 回填 depth，避免「父在后」时深度算错。
export function buildTaskTree(tasks: TaskMeta[]): TaskTreeNode[] {
  const byId = new Map<string, TaskTreeNode>();
  for (const t of tasks) byId.set(t.id, { ...t, children: [], depth: 0 });
  const roots: TaskTreeNode[] = [];
  for (const t of tasks) {
    const node = byId.get(t.id)!;
    const parent = t.parentTaskId && t.parentTaskId !== t.id ? byId.get(t.parentTaskId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node); // 顶层 / 悬空 parentTaskId / 自指 → 兜底顶层
  }
  // DFS 回填 depth（带 seen 防已损坏的环导致的无限递归）。
  const seen = new Set<string>();
  const assignDepth = (node: TaskTreeNode, depth: number) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    node.depth = depth;
    for (const child of node.children) assignDepth(child, depth + 1);
  };
  for (const root of roots) assignDepth(root, 0);
  return roots;
}

// 该任务子树内全部后代 id（不含自身），DFS 去重返回。供级联删除（U2）与后代计数（U4 删除确认）。
export function taskDescendantIds(tasks: TaskMeta[], id: string): string[] {
  const childrenOf = new Map<string, TaskMeta[]>();
  for (const t of tasks) {
    if (!t.parentTaskId || t.parentTaskId === t.id) continue;
    const arr = childrenOf.get(t.parentTaskId);
    if (arr) arr.push(t);
    else childrenOf.set(t.parentTaskId, [t]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (nodeId: string) => {
    for (const child of childrenOf.get(nodeId) ?? []) {
      if (seen.has(child.id)) continue; // 环止损
      seen.add(child.id);
      out.push(child.id);
      visit(child.id);
    }
  };
  visit(id);
  return out;
}

// reparent 防环（U2/U4）：把 nodeId 挂到 candidateParentId 之下是否会成环。
// 成环当且仅当 candidateParentId 是 nodeId 自身或其后代——从 candidate 沿 parentTaskId 上溯，
// 若途经 nodeId 则拒绝。带 seen 防已损坏的环。（补上 IFocus indent 缺失的环检测）
export function isTaskDescendant(tasks: TaskMeta[], nodeId: string, candidateParentId: string): boolean {
  if (nodeId === candidateParentId) return true;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  let cur: string | undefined = candidateParentId;
  while (cur) {
    if (cur === nodeId) return true;
    if (seen.has(cur)) break; // 已存在的环，止损
    seen.add(cur);
    cur = byId.get(cur)?.parentTaskId;
  }
  return false;
}

// 完成 rollup 派生（U4/R5，KTD4）：某任务是否「全部直属子任务已完结」。
// = 该任务有 ≥1 个直属子且全部直属子 status ∈ {done, dropped}。无子返回 false（无子不触发建议）。
// 纯派生、不落库、不改状态；中列据此在父行浮现「完成此任务」入口，用户确认才置父 done（绝不自动）。
export function areAllChildrenDone(tasks: TaskMeta[], parentId: string): boolean {
  let hasChild = false;
  for (const t of tasks) {
    if (t.parentTaskId !== parentId) continue;
    hasChild = true;
    if (!TERMINAL_STATUS.has(t.status)) return false;
  }
  return hasChild;
}

// 是否为某任务的直属父（有 ≥1 直属子）。供渲染层判定是否显示折叠箭头。
export function hasChildren(tasks: TaskMeta[], id: string): boolean {
  return tasks.some((t) => t.parentTaskId === id);
}
