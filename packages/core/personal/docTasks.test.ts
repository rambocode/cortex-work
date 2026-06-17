import { describe, expect, it } from "vitest";
import type { DocFileRaw } from "../desktop/types";
import {
  assembleDocTasks,
  brainstormDocPath,
  docTasksKeys,
  nextSkillForKind,
} from "./docTasks";

function raw(over: Partial<DocFileRaw> & { name: string; kind: DocFileRaw["kind"]; head: string }): DocFileRaw {
  return { path: `/repo/docs/${over.kind}/${over.name}`, mtimeMs: 0, ...over };
}

describe("docTasksKeys", () => {
  it("按 root 命名空间，不同 root 隔离", () => {
    expect(docTasksKeys.byRoot("/a")).toEqual(["personal", "doc-tasks", "/a"]);
    expect(docTasksKeys.byRoot("/a")).not.toEqual(docTasksKeys.byRoot("/b"));
  });
});

describe("assembleDocTasks", () => {
  it("解析 + 归一状态 + 标签 + 血缘一体组装", () => {
    const list: DocFileRaw[] = [
      raw({
        name: "shanji-notes-requirements.md",
        kind: "brainstorm",
        head: "---\ntopic: shanji-notes\ndate: 2026-06-15\n---\n# 闪记需求",
      }),
      raw({
        name: "2026-06-15-001-feat-flash-notes-plan.md",
        kind: "plan",
        head: [
          "---",
          'title: "feat: 闪记"',
          "type: feat",
          "status: completed",
          "origin: docs/brainstorms/shanji-notes-requirements.md",
          "---",
        ].join("\n"),
      }),
      raw({
        name: "2026-06-17-002-feat-pi-rpc-robustness-plan.md",
        kind: "plan",
        head: ["# feat: pi RPC 阶段 4", "- 类型：feat", "- 状态：待执行（U0 已完成）", "- 深度：Deep"].join("\n"),
      }),
    ];
    const { docs, pipelines, orphans } = assembleDocTasks(list);

    const flashPlan = docs.find((d) => d.name.includes("flash-notes"))!;
    expect(flashPlan.status).toBe("done"); // completed → done
    expect(flashPlan.tags.find((t) => t.dim === "stage")?.value).toBe("plan");

    const piPlan = docs.find((d) => d.name.includes("pi-rpc"))!;
    expect(piPlan.status).toBe("todo"); // 待执行（…）→ todo
    expect(piPlan.tags.find((t) => t.dim === "depth")?.label).toBe("Deep");

    // brainstorm ← plan 成一条血缘；孤立的 pi-rpc plan 入孤儿。
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]?.map((d) => d.kind)).toEqual(["brainstorm", "plan"]);
    expect(orphans.map((d) => d.name)).toContain("2026-06-17-002-feat-pi-rpc-robustness-plan.md");
  });

  it("空列表 → 空结果，不抛", () => {
    expect(assembleDocTasks([])).toEqual({ docs: [], pipelines: [], orphans: [] });
  });
});

describe("nextSkillForKind", () => {
  it("按 kind 路由下一步 skill", () => {
    expect(nextSkillForKind("ideation")).toMatchObject({ name: "ce-brainstorm", produces: "brainstorm" });
    expect(nextSkillForKind("brainstorm")).toMatchObject({ name: "ce-plan", produces: "plan" });
    expect(nextSkillForKind("plan")).toMatchObject({ name: "ce-work", produces: null });
  });
});

describe("brainstormDocPath", () => {
  it("形如 docs/brainstorms/<id>-brainstorm.md，去尾斜杠", () => {
    expect(brainstormDocPath("/repo/", "sess-1")).toBe("/repo/docs/brainstorms/sess-1-brainstorm.md");
    expect(brainstormDocPath("/repo", "sess-1")).toBe("/repo/docs/brainstorms/sess-1-brainstorm.md");
  });
});
