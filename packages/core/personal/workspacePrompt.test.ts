import { describe, expect, it } from "vitest";
import { buildWorkspaceSystemPrompt } from "./workspacePrompt";

describe("buildWorkspaceSystemPrompt", () => {
  it("写出工作目录与相对路径基准", () => {
    const out = buildWorkspaceSystemPrompt("/code/alpha");
    expect(out).toContain("<workspace>");
    expect(out).toContain("Current working directory (workspace root): /code/alpha");
    expect(out).toContain("Relative paths resolve against this directory.");
    expect(out).toContain("</workspace>");
  });

  // 全局约定:发给 LLM 的系统提示一律英文。锁死,防止后续改动顺手翻回中文。
  it("正文不含中日韩字符（系统提示只用英文）", () => {
    expect(buildWorkspaceSystemPrompt("/code/alpha")).not.toMatch(/[一-鿿]/u);
  });

  // 这块只陈述事实，不得再长出范围限制：写「只在该目录内」会削掉 agent 跨目录查找、
  // 读系统配置、访问用户点名的其它路径等本来就该有的能力。
  it("不包含任何限制检索范围的措辞", () => {
    const out = (buildWorkspaceSystemPrompt("/code/alpha") ?? "").toLowerCase();
    for (const forbidden of ["only", "do not", "don't", "never", "must not", "restrict", "outside"]) {
      expect(out).not.toContain(forbidden);
    }
  });

  // 空 cwd 时最终目录由主进程 resolveSpawnCwd 兜底，渲染端并不知道落在哪；
  // 与其写一个错的路径，不如不写。
  it("cwd 缺失或空白时返回 undefined", () => {
    expect(buildWorkspaceSystemPrompt(undefined)).toBeUndefined();
    expect(buildWorkspaceSystemPrompt("")).toBeUndefined();
    expect(buildWorkspaceSystemPrompt("   ")).toBeUndefined();
  });

  it("路径两侧空白被裁掉", () => {
    expect(buildWorkspaceSystemPrompt("  /code/alpha  ")).toContain(
      "workspace root): /code/alpha",
    );
  });
});
