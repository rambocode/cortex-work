// scanSkillRoots 多根扫描单测。electron(app) mock,fs 用真实临时目录写 SKILL.md。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "/app", getPath: () => "/userData" } }));

import { scanSkillRoots } from "./registry";

// 在 root 下建一个 skill 目录（含 SKILL.md frontmatter）。
function makeSkill(root: string, dirName: string, fm: { name?: string; description?: string }): void {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const lines = ["---"];
  if (fm.name !== undefined) lines.push(`name: ${fm.name}`);
  if (fm.description !== undefined) lines.push(`description: ${fm.description}`);
  lines.push("---", "", "# body");
  writeFileSync(join(dir, "SKILL.md"), lines.join("\n"));
}

let base: string;
let globalRoot: string;
let wsRoot: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "skills-test-"));
  globalRoot = join(base, "global");
  wsRoot = join(base, "ws");
  makeSkill(globalRoot, "code-review", { name: "code-review", description: "审查代码" });
  makeSkill(globalRoot, "bug-hunt", { name: "bug-hunt", description: "找 bug" });
  makeSkill(globalRoot, "no-frontmatter-name", { description: "缺 name" }); // name 兜底目录名
  mkdirSync(join(globalRoot, "not-a-skill"), { recursive: true }); // 无 SKILL.md → 跳过
  makeSkill(wsRoot, "code-review", { name: "code-review", description: "工作区同名" }); // 跨根同名
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("scanSkillRoots", () => {
  it("扫描单根,产出 scope/dir/rootPath,跳过无 SKILL.md 目录", async () => {
    const skills = await scanSkillRoots([{ path: globalRoot, scope: "global" }]);
    expect(skills).toHaveLength(3);
    const cr = skills.find((s) => s.name === "code-review")!;
    expect(cr.scope).toBe("global");
    expect(cr.dir).toBe(join(globalRoot, "code-review"));
    expect(cr.rootPath).toBe(globalRoot);
    expect(cr.enabled).toBe(true);
    expect(cr.trusted).toBe(true); // global 恒 true
  });

  it("frontmatter 缺 name → 兜底用目录名", async () => {
    const skills = await scanSkillRoots([{ path: globalRoot, scope: "global" }]);
    expect(skills.some((s) => s.name === "no-frontmatter-name")).toBe(true);
  });

  it("根不存在 → 跳过不抛,返回 0 项", async () => {
    const skills = await scanSkillRoots([{ path: join(base, "missing"), scope: "global" }]);
    expect(skills).toEqual([]);
  });

  it("全局 + 工作区同名 → 不去重,各一项(scope 各异),工作区 trusted=false", async () => {
    const skills = await scanSkillRoots([
      { path: globalRoot, scope: "global" },
      { path: wsRoot, scope: "workspace" },
    ]);
    const crs = skills.filter((s) => s.name === "code-review");
    expect(crs).toHaveLength(2);
    expect(crs.map((s) => s.scope).sort()).toEqual(["global", "workspace"]);
    const ws = crs.find((s) => s.scope === "workspace")!;
    expect(ws.trusted).toBe(false); // 工作区默认未授信
  });
});
