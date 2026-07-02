import { describe, it, expect } from "vitest";
import type { TaskProject } from "../desktop/tasks-types";
import {
  buildProjectTree,
  descendantProjectIds,
  isDescendant,
  onlyProjects,
  projectKind,
  subtreeNodeIds,
} from "./taskProjectTree";

// 便捷构造：p(id, parentId?, kind?)。
const p = (id: string, parentId?: string, kind?: "folder" | "project"): TaskProject => ({
  id,
  name: id,
  parentId,
  kind,
});

// 示意图对应的三层树：临时(folder) → 智慧冷链(folder) → v0.3.2/v0.3.0(project)；另有顶层叶子 project。
const sample: TaskProject[] = [
  p("linshi", undefined, "folder"), // 临时
  p("zhihui", "linshi", "folder"), // 智慧冷链（folder，含版本子项目）
  p("v032", "zhihui", "project"),
  p("v030", "zhihui", "project"),
  p("gongsi", undefined, "folder"), // 公司
  p("luer", "gongsi", "project"), // 鲁尔冷库节能（叶子 project）
  p("orphan-task-parent"), // 顶层裸 project（无 kind → 默认 project）
];

describe("buildProjectTree", () => {
  it("正确嵌套三层（folder→folder→project）", () => {
    const roots = buildProjectTree(sample);
    const linshi = roots.find((r) => r.id === "linshi")!;
    expect(linshi.children.map((c) => c.id)).toContain("zhihui");
    const zhihui = linshi.children.find((c) => c.id === "zhihui")!;
    expect(zhihui.children.map((c) => c.id).sort()).toEqual(["v030", "v032"]);
  });

  it("悬空 parentId（父不存在）兜底为顶层、不丢节点", () => {
    const roots = buildProjectTree([p("a", "ghost"), p("b")]);
    expect(roots.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("自指 parentId 兜底为顶层、不成环", () => {
    const roots = buildProjectTree([p("a", "a")]);
    expect(roots.map((r) => r.id)).toEqual(["a"]);
    expect(roots[0]!.children).toEqual([]);
  });

  it("空输入 → 空树", () => {
    expect(buildProjectTree([])).toEqual([]);
  });
});

describe("descendantProjectIds", () => {
  it("选中 folder → 全部后代 project（跨多层）、排除 folder 自身类型", () => {
    // 临时(folder) 子树内的 project 应为 v032/v030（智慧冷链 folder 不计入）。
    expect(descendantProjectIds(sample, "linshi").sort()).toEqual(["v030", "v032"]);
  });

  it("选中含子项目的父 project → 自身 + 后代 sub-project", () => {
    const nested: TaskProject[] = [
      p("parentProj", undefined, "project"),
      p("subA", "parentProj", "project"),
      p("subB", "parentProj", "project"),
    ];
    expect(descendantProjectIds(nested, "parentProj").sort()).toEqual(["parentProj", "subA", "subB"]);
  });

  it("选中叶子 project → 仅自身", () => {
    expect(descendantProjectIds(sample, "luer")).toEqual(["luer"]);
  });

  it("对损坏的环不无限递归", () => {
    const cyclic: TaskProject[] = [p("a", "b", "project"), p("b", "a", "project")];
    // 不抛错、返回有限集合。
    expect(() => descendantProjectIds(cyclic, "a")).not.toThrow();
  });
});

describe("subtreeNodeIds", () => {
  it("单 project（无子孙）→ 仅自身", () => {
    expect(subtreeNodeIds(sample, "luer")).toEqual(new Set(["luer"]));
  });

  it("folder 含多层子孙 → 含自身 + 全部 folder/project 后代", () => {
    // 临时(folder) 子树：linshi + zhihui(folder) + v032/v030(project)。
    expect(subtreeNodeIds(sample, "linshi")).toEqual(
      new Set(["linshi", "zhihui", "v032", "v030"]),
    );
  });

  it("悬空 parentId 不影响子树收集", () => {
    const withOrphan: TaskProject[] = [
      p("root", undefined, "folder"),
      p("child", "root", "project"),
      p("ghostchild", "does-not-exist", "project"), // 悬空父，不应混入 root 子树
    ];
    expect(subtreeNodeIds(withOrphan, "root")).toEqual(new Set(["root", "child"]));
  });

  it("parentId 成环 → 止损不死循环", () => {
    const cyclic: TaskProject[] = [p("a", "b", "project"), p("b", "a", "project")];
    let result: Set<string> | undefined;
    expect(() => {
      result = subtreeNodeIds(cyclic, "a");
    }).not.toThrow();
    expect(result).toEqual(new Set(["a", "b"]));
  });

  it("id 不存在 → 空集", () => {
    expect(subtreeNodeIds(sample, "nope")).toEqual(new Set<string>());
  });
});

describe("isDescendant（reparent 防环）", () => {
  it("把节点挂到其后代下 → true（应拒绝）", () => {
    // 把 zhihui 挂到它的后代 v032 下 → 成环。
    expect(isDescendant(sample, "zhihui", "v032")).toBe(true);
  });

  it("挂到自身 → true（拒绝）", () => {
    expect(isDescendant(sample, "zhihui", "zhihui")).toBe(true);
  });

  it("挂到无关节点 → false（允许）", () => {
    expect(isDescendant(sample, "luer", "linshi")).toBe(false);
  });
});

describe("onlyProjects / projectKind", () => {
  it("过滤掉所有 folder", () => {
    const ids = onlyProjects(sample).map((x) => x.id).sort();
    expect(ids).toEqual(["luer", "orphan-task-parent", "v030", "v032"]);
  });

  it("kind 缺省的旧 project 按 project 处理", () => {
    expect(projectKind({ kind: undefined })).toBe("project");
    expect(projectKind({ kind: "folder" })).toBe("folder");
    // 旧档无 kind 的节点不会被 onlyProjects 误滤。
    expect(onlyProjects([p("legacy")]).map((x) => x.id)).toEqual(["legacy"]);
  });
});
