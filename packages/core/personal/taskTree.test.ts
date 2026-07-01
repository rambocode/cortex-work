import { describe, it, expect } from "vitest";
import type { TaskMeta, TaskStatus } from "../desktop/tasks-types";
import { areAllChildrenDone, buildTaskTree, isTaskDescendant, taskDescendantIds } from "./taskTree";

// 便捷构造：t(id, parentTaskId?, status?)。其余必填字段填默认。
const t = (id: string, parentTaskId?: string, status: TaskStatus = "active"): TaskMeta => ({
  id,
  title: id,
  status,
  tags: [],
  source: "manual",
  createdAt: 0,
  updatedAt: 0,
  parentTaskId,
});

// 图片对应场景：父「app 支持 642」→ 子「扫描设备/读取设备数据」→ 孙（读取设备数据 下再嵌一层）。
const sample: TaskMeta[] = [
  t("root"), // app 支持 642
  t("scan", "root"), // 扫描设备
  t("read", "root"), // 读取设备数据
  t("readHist", "read"), // 读取历史数据（孙级）
  t("solo"), // 顶层独立任务
];

describe("buildTaskTree", () => {
  it("正确嵌套三层（父→子→孙）且 depth 递增", () => {
    const roots = buildTaskTree(sample);
    const root = roots.find((r) => r.id === "root")!;
    expect(root.depth).toBe(0);
    expect(root.children.map((c) => c.id).sort()).toEqual(["read", "scan"]);
    const read = root.children.find((c) => c.id === "read")!;
    expect(read.depth).toBe(1);
    expect(read.children.map((c) => c.id)).toEqual(["readHist"]);
    expect(read.children[0]!.depth).toBe(2);
  });

  it("父在数组中位于子之后时 depth 仍正确（回填）", () => {
    const reordered: TaskMeta[] = [t("child", "parent"), t("parent")];
    const roots = buildTaskTree(reordered);
    const parent = roots.find((r) => r.id === "parent")!;
    expect(parent.depth).toBe(0);
    expect(parent.children.map((c) => c.id)).toEqual(["child"]);
    expect(parent.children[0]!.depth).toBe(1);
  });

  it("父不在 scope（Today 场景）→ 子升为顶层扁平", () => {
    // 仅到期集合里只有子任务，父不在 → 子应作为 root 出现。
    const scope: TaskMeta[] = [t("scan", "root"), t("readHist", "read")];
    const roots = buildTaskTree(scope);
    expect(roots.map((r) => r.id).sort()).toEqual(["readHist", "scan"]);
    expect(roots.every((r) => r.depth === 0)).toBe(true);
  });

  it("悬空 parentTaskId 兜底顶层、不丢节点", () => {
    const roots = buildTaskTree([t("a", "ghost"), t("b")]);
    expect(roots.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("自指 parentTaskId 兜底顶层、不成环", () => {
    const roots = buildTaskTree([t("a", "a")]);
    expect(roots.map((r) => r.id)).toEqual(["a"]);
    expect(roots[0]!.children).toEqual([]);
  });

  it("空输入 → 空树", () => {
    expect(buildTaskTree([])).toEqual([]);
  });

  it("双向环（a↔b）不丢节点：两节点仍出现（兜底提升为顶层）", () => {
    const roots = buildTaskTree([t("a", "b"), t("b", "a")]);
    // 节点守恒：a、b 都能从树里访问到（不因互指环整体消失）。
    const ids = new Set<string>();
    const walk = (ns: typeof roots) => ns.forEach((n) => { ids.add(n.id); walk(n.children); });
    walk(roots);
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(true);
  });
});

describe("taskDescendantIds", () => {
  it("多层子树返回全部后代（含孙）", () => {
    expect(taskDescendantIds(sample, "root").sort()).toEqual(["read", "readHist", "scan"]);
  });

  it("叶子 → 空", () => {
    expect(taskDescendantIds(sample, "solo")).toEqual([]);
    expect(taskDescendantIds(sample, "scan")).toEqual([]);
  });

  it("对损坏的环不无限递归", () => {
    const cyclic: TaskMeta[] = [t("a", "b"), t("b", "a")];
    expect(() => taskDescendantIds(cyclic, "a")).not.toThrow();
  });
});

describe("isTaskDescendant（reparent 防环）", () => {
  it("把任务挂到其后代下 → true（应拒绝）", () => {
    expect(isTaskDescendant(sample, "root", "readHist")).toBe(true);
  });

  it("挂到自身 → true（拒绝）", () => {
    expect(isTaskDescendant(sample, "read", "read")).toBe(true);
  });

  it("挂到无关节点 → false（允许）", () => {
    expect(isTaskDescendant(sample, "solo", "root")).toBe(false);
  });
});

describe("areAllChildrenDone（完成 rollup 派生）", () => {
  it("全部直属子已完结 → true", () => {
    const tasks: TaskMeta[] = [t("p"), t("c1", "p", "done"), t("c2", "p", "dropped")];
    expect(areAllChildrenDone(tasks, "p")).toBe(true);
  });

  it("含一个未完结子 → false", () => {
    const tasks: TaskMeta[] = [t("p"), t("c1", "p", "done"), t("c2", "p", "active")];
    expect(areAllChildrenDone(tasks, "p")).toBe(false);
  });

  it("无子 → false（不触发建议）", () => {
    expect(areAllChildrenDone(sample, "solo")).toBe(false);
  });

  it("只看直属子，不看孙", () => {
    // root 的直属子 scan(active) 未完结 → false，即使 read 子树情况不同。
    const tasks: TaskMeta[] = [t("root"), t("scan", "root", "done"), t("read", "root", "active"), t("g", "read", "done")];
    expect(areAllChildrenDone(tasks, "root")).toBe(false);
  });
});
