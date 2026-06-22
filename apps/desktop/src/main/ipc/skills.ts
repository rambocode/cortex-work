// 内置 skill IPC:渲染端经 bridge.skillGet / skillsList 拉 skill 元数据
//（深化注入 ce-ideate / 生成 plan 注入 ce-plan 用）。main 只返回 frontmatter 源数据 +
// 文件路径,不读全文——全文由 agent 自己 Read（见 core/personal/notes.ts 的注入文案）。
//
// 插件管理（U3）:pi-skills:list 扫描多根、pi-skills:open-dir 打开/创建范围根。
// main 不读 store——根列表由渲染端从 piSkills 配置传入（与 cli.ts「主进程不读设置文件」一致）。
// open-dir 自带白名单校验:目标必须落在已配置的某个根内（expand+resolve 后比对）,杜绝路径遍历。

import { ipcMain, shell } from "electron";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve, sep } from "path";
import { getSkill, listSkills, scanSkillRoots } from "../skills/registry";
import { expandTilde, pluginSkillRoots } from "../skills/locate";
import type { PluginSkill, SkillMeta } from "./types";

// pi-skills:list 入参(渲染端从 piSkills 配置拍平传入)。
interface PiSkillsListArgs {
  globalRoots: string[];
  userGlobalRoots?: string[];
  workspaceEnabled: boolean;
  workspaceDir?: string;
  // U6:已启用 ∩ 已授信插件的 skills 根（绝对路径）。渲染端按 store 过滤后传入（main 不读 store）;
  // 以 scope=global 并入扫描根，使插件内 skill 与第一方 skill 走同一注入链与去重。
  pluginSkillDirs?: string[];
}

// pi-skills:open-dir 入参:dir = 要打开的根;allowedRoots = 全部已配置根（白名单,可含 ~）。
interface OpenSkillDirArgs {
  dir: string;
  allowedRoots: string[];
}

// pi-skills:create 入参:在 dir 根下新建 <name>/SKILL.md。allowedRoots 白名单校验。
interface CreateSkillArgs {
  dir: string;
  name: string;
  description: string;
  body: string;
  allowedRoots: string[];
}

function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

// pi skill 名约束（与 pi loadSkills 校验对齐）:小写字母数字 + 单连字符,首尾非连字符。
function isValidSkillName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

// 转义 frontmatter 标量值（含冒号/引号时加引号）。
function yamlScalar(v: string): string {
  const s = v.replace(/\r?\n/g, " ").trim();
  if (s === "" || /[:#"']/.test(s)) return JSON.stringify(s);
  return s;
}

export function registerSkillsHandlers(): void {
  ipcMain.handle("skills:get", (_e, name: string): Promise<SkillMeta | null> => getSkill(name));
  ipcMain.handle("skills:list", (): Promise<SkillMeta[]> => listSkills());

  // 插件管理:按配置扫描多根 → PluginSkill[]（enabled 恒 true,启用/授信态由渲染端叠加）。
  ipcMain.handle("pi-skills:list", (_e, args: PiSkillsListArgs): Promise<PluginSkill[]> => {
    const roots = pluginSkillRoots(args, args.workspaceDir);
    // U6:已启用插件的 skills 根以 scope=global 并入（渲染端已按启停/信任过滤要送哪些）。
    for (const dir of args.pluginSkillDirs ?? []) {
      roots.push({ path: expandTilde(dir), scope: "global" });
    }
    return scanSkillRoots(roots);
  });

  // 插件管理:打开范围根目录。白名单校验 + 不存在则在白名单内创建。
  ipcMain.handle(
    "pi-skills:open-dir",
    async (_e, args: OpenSkillDirArgs): Promise<{ ok: boolean; error?: string }> => {
      const target = resolve(expandTilde(args.dir));
      const allowed = (args.allowedRoots ?? []).map((r) => expandTilde(r));
      if (!allowed.some((root) => isInside(root, target))) {
        return { ok: false, error: "路径不在允许范围内" };
      }
      try {
        mkdirSync(target, { recursive: true }); // 仅白名单内创建,方便用户放 skill
        const err = await shell.openPath(target); // 返回非空字符串即失败
        return err ? { ok: false, error: err } : { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  // 插件管理:在选定根下新建 skill。白名单校验 + 名称合法性 + 不覆盖已存在。
  ipcMain.handle("pi-skills:create", (_e, args: CreateSkillArgs): { ok: boolean; error?: string; dir?: string } => {
    const name = args.name.trim();
    if (!isValidSkillName(name)) {
      return { ok: false, error: "名称只能用小写字母、数字和连字符（如 my-plugin）" };
    }
    if (!args.description.trim()) return { ok: false, error: "请填写基础描述" };
    if (!args.body.trim()) return { ok: false, error: "请填写 Skill 指令" };
    const root = resolve(expandTilde(args.dir));
    const allowed = (args.allowedRoots ?? []).map((r) => expandTilde(r));
    if (!allowed.some((r) => isInside(r, root))) return { ok: false, error: "目标目录不在允许范围内" };
    const skillDir = join(root, name);
    const skillMd = join(skillDir, "SKILL.md");
    if (existsSync(skillMd)) return { ok: false, error: `已存在同名 skill：${name}` };
    try {
      mkdirSync(skillDir, { recursive: true });
      const content = `---\nname: ${yamlScalar(name)}\ndescription: ${yamlScalar(args.description)}\n---\n\n${args.body.trim()}\n`;
      writeFileSync(skillMd, content, "utf8");
      return { ok: true, dir: skillDir };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
