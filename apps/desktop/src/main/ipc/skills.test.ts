// pi-skills:list / pi-skills:open-dir IPC handler 单测。electron(ipcMain/shell/app) mock,
// fs 用真实临时目录。重点验证 open-dir 的白名单路径校验（杜绝路径遍历）。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { PluginSkill } from "./types";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  openPath: vi.fn(async (_p: string) => ""),
  // builtinSkillsRoot() dev 态 = <appPath>/resources/skills。测试里指向临时目录,
  // 故 getAppPath 不能写死常量,由 beforeAll 赋值。
  appPath: "/app",
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(ch, fn) },
  shell: { openPath: h.openPath },
  app: { isPackaged: false, getAppPath: () => h.appPath, getPath: () => "/userData" },
}));

import { registerSkillsHandlers } from "./skills";

function makeSkill(root: string, name: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} 描述\n---\n# body`);
}

let base: string;
let globalRoot: string;
let proj: string;
let builtinRoot: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "skills-ipc-"));
  globalRoot = join(base, "global");
  proj = join(base, "proj");
  makeSkill(globalRoot, "code-review");
  makeSkill(join(proj, ".cortex-desktop", "skills"), "ws-skill");

  // 内置默认 skill 根（= resources/skills）。放两个白名单内的、两个白名单外的,
  // 用来验证「只并入白名单」而非整根并入。
  h.appPath = join(base, "app");
  builtinRoot = join(h.appPath, "resources", "skills");
  makeSkill(builtinRoot, "incident-apology-report");
  makeSkill(builtinRoot, "contract-review-report");
  makeSkill(builtinRoot, "ce-work");
  makeSkill(builtinRoot, "design");

  registerSkillsHandlers();
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const list = (args: unknown) => h.handlers.get("pi-skills:list")!({}, args) as Promise<PluginSkill[]>;
const openDir = (args: unknown) =>
  h.handlers.get("pi-skills:open-dir")!({}, args) as Promise<{ ok: boolean; error?: string }>;
const create = (args: unknown) =>
  h.handlers.get("pi-skills:create")!({}, args) as { ok: boolean; error?: string; dir?: string };

describe("pi-skills:list", () => {
  it("扫描全局根 → 返回带 scope 的 PluginSkill", async () => {
    const skills = await list({ globalRoots: [globalRoot], workspaceEnabled: false });
    expect(skills.map((s) => s.name)).toContain("code-review");
    expect(skills.find((s) => s.name === "code-review")!.scope).toBe("global");
  });

  it("workspaceEnabled + workspaceDir → 含工作区 skill", async () => {
    const skills = await list({ globalRoots: [globalRoot], workspaceEnabled: true, workspaceDir: proj });
    expect(skills.some((s) => s.scope === "workspace" && s.name === "ws-skill")).toBe(true);
  });

  it("workspaceEnabled=false → 不含工作区 skill", async () => {
    const skills = await list({ globalRoots: [globalRoot], workspaceEnabled: false, workspaceDir: proj });
    expect(skills.some((s) => s.scope === "workspace")).toBe(false);
  });
});

describe("内置默认 skill 并入", () => {
  it("白名单内的内置 skill 以 global scope 并入;白名单外的(ce-*/design/slides)不并入", async () => {
    const skills = await list({ rootSpecs: [], workspaceEnabled: false });
    const names = skills.map((s) => s.name);
    expect(names).toContain("incident-apology-report");
    expect(names).toContain("contract-review-report");
    // ce-* 与 design/slides 只走「按名硬编码取用」(notes.ts / artifactDispatch.ts),
    // 不该出现在 /skill: 菜单里 —— design/slides 是 artifact 派发专用 stub,手选无意义。
    expect(names).not.toContain("ce-work");
    expect(names).not.toContain("design");
    expect(skills.find((s) => s.name === "incident-apology-report")!.scope).toBe("global");
  });

  it("用户根有同名 skill 时,内置版排在前面(渲染端 last-global-wins → 用户版胜出)", async () => {
    // 顺序契约:filterEnabledPiSkills / resolveEnabledSkillRecords 都是「后扫到的 global 覆盖前者」。
    // 内置根若排在用户根之后,就会反过来盖掉用户的自定义版本,用户改不掉。
    const userRoot = join(base, "user-override");
    makeSkill(userRoot, "incident-apology-report");
    const skills = await list({
      rootSpecs: [{ path: userRoot, scope: "global", origin: "shared" }],
      workspaceEnabled: false,
    });
    const hits = skills
      .map((s, i) => ({ i, dir: s.dir, name: s.name }))
      .filter((x) => x.name === "incident-apology-report");
    expect(hits).toHaveLength(2);
    expect(hits[0].dir).toBe(join(builtinRoot, "incident-apology-report"));
    expect(hits[1].dir).toBe(join(userRoot, "incident-apology-report"));
  });
});

describe("pi-skills:open-dir 白名单校验", () => {
  it("白名单内目录不存在 → 创建并打开,ok", async () => {
    const target = join(globalRoot, "newly-created");
    expect(existsSync(target)).toBe(false);
    const res = await openDir({ dir: target, allowedRoots: [globalRoot] });
    expect(res.ok).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(h.openPath).toHaveBeenCalledWith(target);
  });

  it("白名单外路径 → 拒绝,不创建、不打开（路径遍历防护）", async () => {
    h.openPath.mockClear();
    const evil = join(base, "evil-outside");
    const res = await openDir({ dir: evil, allowedRoots: [globalRoot] });
    expect(res.ok).toBe(false);
    expect(existsSync(evil)).toBe(false);
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it("打开白名单根自身 → ok", async () => {
    const res = await openDir({ dir: globalRoot, allowedRoots: [globalRoot] });
    expect(res.ok).toBe(true);
  });
});

describe("pi-skills:create", () => {
  it("合法入参 → 写 <dir>/<name>/SKILL.md（frontmatter + 正文）", () => {
    const res = create({
      dir: globalRoot,
      name: "my-plugin",
      description: "我的插件",
      body: "你是一个助手。",
      allowedRoots: [globalRoot],
    });
    expect(res.ok).toBe(true);
    const md = readFileSync(join(globalRoot, "my-plugin", "SKILL.md"), "utf8");
    expect(md).toContain("name: my-plugin");
    expect(md).toContain("description: 我的插件");
    expect(md).toContain("你是一个助手。");
  });

  it("非法名称 → 拒绝", () => {
    const res = create({ dir: globalRoot, name: "Bad Name", description: "d", body: "b", allowedRoots: [globalRoot] });
    expect(res.ok).toBe(false);
    expect(existsSync(join(globalRoot, "Bad Name"))).toBe(false);
  });

  it("缺描述/正文 → 拒绝", () => {
    expect(create({ dir: globalRoot, name: "x1", description: "", body: "b", allowedRoots: [globalRoot] }).ok).toBe(false);
    expect(create({ dir: globalRoot, name: "x2", description: "d", body: "", allowedRoots: [globalRoot] }).ok).toBe(false);
  });

  it("同名已存在 → 拒绝（不覆盖）", () => {
    create({ dir: globalRoot, name: "dup-skill", description: "d", body: "b", allowedRoots: [globalRoot] });
    const res = create({ dir: globalRoot, name: "dup-skill", description: "d2", body: "b2", allowedRoots: [globalRoot] });
    expect(res.ok).toBe(false);
  });

  it("白名单外目标 → 拒绝（路径遍历防护）", () => {
    const evil = join(base, "evil-root");
    const res = create({ dir: evil, name: "x", description: "d", body: "b", allowedRoots: [globalRoot] });
    expect(res.ok).toBe(false);
    expect(existsSync(join(evil, "x"))).toBe(false);
  });
});
