// 内置 skill 注册表:浅扫 <root>/<skill>/SKILL.md,解析 frontmatter → SkillMeta。
// 结构固定（目录名 == name）,不复用 fs:scanDirTree（有 assertAllowed 白名单拦截）;
// 主进程自解析 skill root 无越权风险。无项目深化低频,每次重扫即可,不加缓存。

import { promises as fsp } from "fs";
import type { Dirent } from "fs";
import { join } from "path";
import type { PluginSkill, SkillMeta, SkillScope } from "../ipc/types";
import { parseFrontmatter } from "./frontmatter";
import { skillsRoots } from "./locate";

// 单 root 浅扫一层目录 → 读各 SKILL.md → 原始 skill 记录。root 不存在 / 读取失败一律
// 跳过,不抛（userData / 用户配置根不存在是常态）。scanRoot 与 scanSkillRoots 共用。
interface RawSkill {
  name: string;
  description: string;
  argumentHint?: string;
  dir: string;
  skillMdPath: string;
}

async function readRoot(root: string): Promise<RawSkill[]> {
  const out: RawSkill[] = [];
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const skillMdPath = join(dir, "SKILL.md");
    let content: string;
    try {
      content = await fsp.readFile(skillMdPath, "utf8");
    } catch {
      continue; // 目录里没有 SKILL.md（如 LICENSE 之外的杂项）→ 跳过
    }
    const fm = parseFrontmatter(content);
    out.push({
      name: fm.name ?? entry.name, // frontmatter 缺 name 兜底用目录名
      description: fm.description ?? "",
      argumentHint: fm.argumentHint,
      dir,
      skillMdPath,
    });
  }
  return out;
}

// 单 root → SkillMeta（按 name 键,同 root 内同名后者覆盖）。
async function scanRoot(root: string): Promise<Map<string, SkillMeta>> {
  const map = new Map<string, SkillMeta>();
  for (const s of await readRoot(root)) {
    map.set(s.name, {
      name: s.name,
      description: s.description,
      argumentHint: s.argumentHint,
      skillMdPath: s.skillMdPath,
      dir: s.dir,
    });
  }
  return map;
}

// 插件管理:扫描带 scope 的多根 → PluginSkill[]。跨根不去重（各 scope 各一项,UI 各一张卡）;
// enabled 恒 true（渲染端据 disabledSkills 叠加）;trusted = scope==="global"
// （工作区由 trustedWorkspaceSkillDirs 在装配 / UI 层覆盖）。注入前去重在 U5 装配层做。
export async function scanSkillRoots(
  roots: { path: string; scope: SkillScope }[],
): Promise<PluginSkill[]> {
  const out: PluginSkill[] = [];
  for (const { path, scope } of roots) {
    for (const s of await readRoot(path)) {
      out.push({
        name: s.name,
        description: s.description,
        argumentHint: s.argumentHint,
        dir: s.dir,
        rootPath: path,
        scope,
        enabled: true,
        trusted: scope === "global",
      });
    }
  }
  return out;
}

// 全部 skill（双源去重,userData 优先覆盖内置）。
export async function listSkills(): Promise<SkillMeta[]> {
  const merged = new Map<string, SkillMeta>();
  // 反序遍历:内置先入,userData 后入覆盖（skillsRoots 顺序 = [userData, builtin]）。
  for (const root of [...skillsRoots()].reverse()) {
    for (const [name, meta] of await scanRoot(root)) merged.set(name, meta);
  }
  return [...merged.values()];
}

// 按 name 取单个 skill;不存在返回 null。
export async function getSkill(name: string): Promise<SkillMeta | null> {
  return (await listSkills()).find((s) => s.name === name) ?? null;
}
