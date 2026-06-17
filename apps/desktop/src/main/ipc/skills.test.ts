// pi-skills:list / pi-skills:open-dir IPC handler 单测。electron(ipcMain/shell/app) mock,
// fs 用真实临时目录。重点验证 open-dir 的白名单路径校验（杜绝路径遍历）。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { PluginSkill } from "./types";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  openPath: vi.fn(async (_p: string) => ""),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(ch, fn) },
  shell: { openPath: h.openPath },
  app: { isPackaged: false, getAppPath: () => "/app", getPath: () => "/userData" },
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

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "skills-ipc-"));
  globalRoot = join(base, "global");
  proj = join(base, "proj");
  makeSkill(globalRoot, "code-review");
  makeSkill(join(proj, ".cortex-desktop", "skills"), "ws-skill");
  registerSkillsHandlers();
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const list = (args: unknown) => h.handlers.get("pi-skills:list")!({}, args) as Promise<PluginSkill[]>;
const openDir = (args: unknown) =>
  h.handlers.get("pi-skills:open-dir")!({}, args) as Promise<{ ok: boolean; error?: string }>;

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
