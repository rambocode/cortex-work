import { describe, it, expect } from "vitest";
import { buildProjectSystemPrompt } from "./messages";
import type { ProjectMeta } from "../desktop/types";

const proj = (over: Partial<ProjectMeta>): ProjectMeta => ({
  id: "p", name: "n", path: "/p", addedAt: 0, ...over,
});

describe("buildProjectSystemPrompt", () => {
  it("空项目列表返回 undefined", () => {
    expect(buildProjectSystemPrompt([])).toBeUndefined();
  });
  it("全部归档返回 undefined", () => {
    expect(buildProjectSystemPrompt([proj({ archivedAt: 1 })])).toBeUndefined();
  });
  it("列出未归档项目的名称与路径,排除归档", () => {
    const out = buildProjectSystemPrompt([
      proj({ id: "a", name: "alpha", path: "/code/alpha" }),
      proj({ id: "b", name: "beta", path: "/code/beta", archivedAt: 123 }),
    ]);
    expect(out).toContain("<personal_workspace_projects>");
    expect(out).toContain("- alpha: /code/alpha");
    expect(out).not.toContain("beta");
  });
});
