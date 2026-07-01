// 内置 skill 注册表:浅扫 <root>/<skill>/SKILL.md,解析 frontmatter → SkillMeta。
// 结构固定（目录名 == name）,不复用 fs:scanDirTree（有 assertAllowed 白名单拦截）;
// 主进程自解析 skill root 无越权风险。无项目深化低频,每次重扫即可,不加缓存。

import { promises as fsp } from "fs";
import type { Dirent } from "fs";
import { basename, extname, join } from "path";
import type { AgentKind, PluginSkill, SkillDoc, SkillMeta, SkillScope } from "../ipc/types";
import { parseFrontmatter } from "./frontmatter";

// 校验 frontmatter 声明的 supported-agents:仅保留合法 agent 名;全非法 → undefined(=全 agent),
// 避免拼写错误误把 skill 完全禁掉。
const AGENT_KINDS = new Set<AgentKind>(["claude", "codex", "pi"]);
function normalizeSupportedAgents(raw: string[] | undefined): AgentKind[] | undefined {
  if (!raw) return undefined;
  const valid = raw.filter((a): a is AgentKind => AGENT_KINDS.has(a as AgentKind));
  return valid.length ? valid : undefined;
}
import { skillsRoots } from "./locate";

// 配套文档白名单后缀（U5）:仅列文档型文件,排除二进制/图片等噪声。SKILL.md 单独排除。
const DOC_EXTS = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml"]);

// 单 root 浅扫一层目录 → 读各 SKILL.md → 原始 skill 记录。root 不存在 / 读取失败一律
// 跳过,不抛（userData / 用户配置根不存在是常态）。scanRoot 与 scanSkillRoots 共用。
interface RawSkill {
  name: string;
  description: string;
  argumentHint?: string;
  supportedAgents?: AgentKind[]; // frontmatter 声明的适用 agent;缺省=全 agent（注入时过滤）
  dir: string;
  skillMdPath: string;
  docs: SkillDoc[]; // 同目录配套文档（U5,仅展示;不影响注入集合）
}

// 浅层枚举 skill 目录内的配套文档（除 SKILL.md 外的白名单后缀文件,按名排序）。
// 读失败 → 空数组（不影响 skill 本身收录）。不递归子目录（深目录延后）。
async function readSkillDocs(dir: string): Promise<SkillDoc[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (e) => e.isFile() && e.name !== "SKILL.md" && DOC_EXTS.has(extname(e.name).toLowerCase()),
    )
    .map((e) => ({ name: e.name, path: join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// 读单个 skill 目录的 SKILL.md → RawSkill;无 SKILL.md / 读失败 → null（目录里没有 SKILL.md
// 如杂项 / LICENSE → 跳过）。name 取 frontmatter,缺则兜底 fallbackName。
async function readSkillDir(dir: string, fallbackName: string): Promise<RawSkill | null> {
  const skillMdPath = join(dir, "SKILL.md");
  let content: string;
  try {
    content = await fsp.readFile(skillMdPath, "utf8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(content);
  return {
    name: fm.name ?? fallbackName,
    description: fm.description ?? "",
    argumentHint: fm.argumentHint,
    supportedAgents: normalizeSupportedAgents(fm.supportedAgents),
    dir,
    skillMdPath,
    docs: await readSkillDocs(dir),
  };
}

async function readRoot(root: string): Promise<RawSkill[]> {
  // 自适应(U2 修复):root 顶层直接含 SKILL.md → 把 root 自身当作单个 skill。用户常把「某个 skill
  // 文件夹本身」当作根添加,旧逻辑只扫 <root>/<子目录>/SKILL.md 会扫不到 → 表现为「添加后不生效」。
  // 顶层含 SKILL.md 时按单 skill 处理(不再展开子目录,子目录视为该 skill 的配套资源);否则按
  // 多 skill 根浅扫一层子目录。
  const rootSkill = await readSkillDir(root, basename(root));
  if (rootSkill) return [rootSkill];

  const out: RawSkill[] = [];
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const s = await readSkillDir(join(root, entry.name), entry.name);
    if (s) out.push(s);
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
  roots: { path: string; scope: SkillScope; origin?: "shared" | "agent" }[],
): Promise<PluginSkill[]> {
  const out: PluginSkill[] = [];
  for (const { path, scope, origin } of roots) {
    for (const s of await readRoot(path)) {
      out.push({
        name: s.name,
        description: s.description,
        argumentHint: s.argumentHint,
        supportedAgents: s.supportedAgents,
        dir: s.dir,
        rootPath: path,
        scope,
        origin: origin ?? "shared", // Design B(plan 002):缺省视为 shared(旧扫描/插件根)
        enabled: true,
        trusted: scope === "global",
        docs: s.docs,
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
