// 内置 skill 注册表:浅扫 <root>/<skill>/SKILL.md,解析 frontmatter → SkillMeta。
// 结构固定（目录名 == name）,不复用 fs:scanDirTree（有 assertAllowed 白名单拦截）;
// 主进程自解析 skill root 无越权风险。无项目深化低频,每次重扫即可,不加缓存。

import { promises as fsp } from "fs";
import type { Dirent } from "fs";
import { join } from "path";
import type { SkillMeta } from "../ipc/types";
import { parseFrontmatter } from "./frontmatter";
import { skillsRoots } from "./locate";

// 单 root 浅扫一层目录 → 读各 SKILL.md → SkillMeta（按 name 键）。root 不存在 /
// 读取失败一律跳过,不抛（userData 第一阶段不存在是常态）。
async function scanRoot(root: string): Promise<Map<string, SkillMeta>> {
  const map = new Map<string, SkillMeta>();
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return map;
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
    const name = fm.name ?? entry.name; // frontmatter 缺 name 兜底用目录名
    map.set(name, {
      name,
      description: fm.description ?? "",
      argumentHint: fm.argumentHint,
      skillMdPath,
      dir,
    });
  }
  return map;
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
