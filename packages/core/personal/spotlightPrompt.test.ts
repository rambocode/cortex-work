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
  it("无当前项目时保留「不在任何项目目录下」的说明", () => {
    const out = buildProjectSystemPrompt([proj({ path: "/code/alpha" })]);
    expect(out).toContain("not working inside any project directory");
  });
  // 全局约定:发给 LLM 的系统提示一律英文。
  it("正文不含中日韩字符（系统提示只用英文）", () => {
    expect(buildProjectSystemPrompt([proj({ path: "/code/alpha" })], "/code/alpha")).not.toMatch(/[一-鿿]/u);
  });
  // 回归：项目会话此前也会被告知「不在任何项目目录下工作」，与 agent 实际 cwd 直接矛盾。
  // 只把这句改成事实陈述，**不额外加范围限制**（那会削掉 agent 跨项目工作的能力）。
  it("已绑定项目时改说当前工作目录，且不附加范围限制", () => {
    const out = buildProjectSystemPrompt(
      [proj({ id: "a", name: "alpha", path: "/code/alpha" }), proj({ id: "b", name: "beta", path: "/code/beta" })],
      "/code/alpha",
    );
    expect(out).not.toContain("not working inside any project directory");
    expect(out).toContain("This session works in the project directory /code/alpha");
    expect(out?.toLowerCase()).not.toContain("do not");
    // 其它项目照常列出，进不进去由模型自己判断。
    expect(out).toContain("- beta: /code/beta");
  });
  it("空白路径按未绑定项目处理", () => {
    expect(buildProjectSystemPrompt([proj({ path: "/code/alpha" })], "   ")).toContain(
      "not working inside any project directory",
    );
  });
});
