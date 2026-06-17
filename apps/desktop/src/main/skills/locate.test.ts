// pluginSkillRoots / expandTilde 单测。electron(app) mock。
import { homedir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "/app", getPath: () => "/userData" } }));

import { expandTilde, pluginSkillRoots } from "./locate";

describe("expandTilde", () => {
  it("展开 ~ 与 ~/...", () => {
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("~/.agents/skills")).toBe(join(homedir(), ".agents/skills"));
  });
  it("非 ~ 路径原样返回", () => {
    expect(expandTilde("/abs/path")).toBe("/abs/path");
    expect(expandTilde("relative/path")).toBe("relative/path");
  });
});

describe("pluginSkillRoots", () => {
  const cfg = { globalRoots: ["~/.agents/skills", "~/.cortex-desktop/skills"], userGlobalRoots: ["~/extra"], workspaceEnabled: true };

  it("全局根 expand 标 scope=global,含用户自增根", () => {
    const roots = pluginSkillRoots({ ...cfg, workspaceEnabled: false });
    expect(roots).toEqual([
      { path: join(homedir(), ".agents/skills"), scope: "global" },
      { path: join(homedir(), ".cortex-desktop/skills"), scope: "global" },
      { path: join(homedir(), "extra"), scope: "global" },
    ]);
  });

  it("workspaceEnabled && workspaceDir → 追加工作区根 scope=workspace", () => {
    const roots = pluginSkillRoots(cfg, "/proj");
    expect(roots).toContainEqual({ path: join("/proj", ".cortex-desktop", "skills"), scope: "workspace" });
  });

  it("workspaceEnabled=false → 不含工作区根", () => {
    const roots = pluginSkillRoots({ ...cfg, workspaceEnabled: false }, "/proj");
    expect(roots.some((r) => r.scope === "workspace")).toBe(false);
  });

  it("workspaceEnabled=true 但无 workspaceDir → 不含工作区根", () => {
    const roots = pluginSkillRoots(cfg);
    expect(roots.some((r) => r.scope === "workspace")).toBe(false);
  });
});
