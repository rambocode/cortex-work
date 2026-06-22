// 插件 manifest 解析（第一期，只读）。按回退链把一个插件包目录归一为 InstalledPlugin：
//   1. .codex-plugin/plugin.json  （字段最全：interface{displayName,category,capabilities,defaultPrompt} + skills）
//   2. .claude-plugin/plugin.json （精简字段，回退）
//   3. SKILL.md frontmatter        （第一方单 skill 兼容，回退）
// 任一档 JSON 非法 → 容错降级到下一档；全失败 → null。复用现有 skills/frontmatter 解析 SKILL.md。

import { promises as fsp } from "fs";
import { basename, extname, isAbsolute, join, resolve, sep } from "path";
import { parseFrontmatter } from "../skills/frontmatter";
import type { InstalledPlugin, PluginManifest, PluginManifestKind } from "../ipc/plugin-types";

// 路径包含校验：child 必须等于 parent 或在其子树内（防 manifest 的 skills 字段用 ../ 指向包外）。
function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

// 读 JSON 文件 → 对象；文件缺失 / JSON 非法 / 非对象 → null（容错，不抛）。
async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v.filter((x): x is string => typeof x === "string");
  return list.length ? list : undefined;
}

// defaultPrompt 在真实 OpenAI 插件中是字符串数组（如 ["Design a landing page."]），
// 也兼容单字符串。取首个非空项。
function asPromptString(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v;
  if (Array.isArray(v)) return v.find((x): x is string => typeof x === "string" && x.trim().length > 0);
  return undefined;
}

// author 可为 { name } 对象或字符串。
function asAuthorName(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v;
  if (v && typeof v === "object" && !Array.isArray(v)) return asString((v as Record<string, unknown>).name);
  return undefined;
}

// 把 .codex-plugin / .claude-plugin 的 plugin.json 映射为归一 manifest。`interface` 字段（codex 最全）
// 覆盖顶层同义字段。短描述优先 interface.shortDescription（列表/头部用），长描述取 longDescription。
// 安全（ADV-001）：id **恒取目录名 basename**，不采信 manifest 声明的 json.id——后者是第三方可控值，
// 两个插件可声明相同 id 造成启停键碰撞（启用一个连带注入另一个）。目录名在 installedPluginsRoot 下
// 由文件系统保证唯一，是无法伪造碰撞的稳定身份键。
function mapJsonManifest(id: string, json: Record<string, unknown>): PluginManifest {
  const iface = (json.interface && typeof json.interface === "object" ? json.interface : {}) as Record<string, unknown>;
  return {
    id,
    name: asString(json.name) ?? id,
    displayName: asString(iface.displayName) ?? asString(json.displayName),
    version: asString(json.version),
    description: asString(iface.shortDescription) ?? asString(json.description) ?? asString(iface.description),
    longDescription: asString(iface.longDescription),
    category: asString(iface.category) ?? asString(json.category),
    capabilities: asStringArray(iface.capabilities) ?? asStringArray(json.capabilities),
    defaultPrompt: asPromptString(iface.defaultPrompt) ?? asPromptString(json.defaultPrompt),
    developer: asString(iface.developerName) ?? asAuthorName(json.author),
    website: asString(iface.websiteURL) ?? asString(json.homepage),
    privacyUrl: asString(iface.privacyPolicyURL),
    termsUrl: asString(iface.termsOfServiceURL),
    license: asString(json.license),
    keywords: asStringArray(json.keywords),
  };
}

// 计算插件 skills 注入根（交给 scanSkillRoots）：
//   - codex/claude：manifest.skills（缺省 "./skills"）resolve 到包内目录，存在且 isInside 才置；
//   - skill-fallback：插件目录本身即单个 skill（SKILL.md 在 <dir>/SKILL.md），根 = dir。
async function resolveSkillsDir(
  dir: string,
  kind: PluginManifestKind,
  skillsField: unknown,
): Promise<string | undefined> {
  if (kind === "skill-fallback") return dir;
  const rel = asString(skillsField) ?? "./skills";
  const candidate = isAbsolute(rel) ? rel : resolve(dir, rel);
  if (!isInside(dir, candidate)) return undefined; // 防 ../ 越界
  try {
    const st = await fsp.stat(candidate);
    return st.isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

// 图标 mime 白名单（按扩展名）。无法识别的扩展 → 不内联。
const ICON_MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const MAX_ICON_BYTES = 256 * 1024; // 超过则回退首字母,避免把大图(如 computer-use 的 923KB)内联

// 把一个包内相对图标路径读盘内联为 data URL。isInside 防 ../ 越界;≤256KiB;mime 按扩展白名单;
// 任何失败/缺路径 → undefined（UI 回退首字母）。candidates 按序取首个存在且可内联者。
async function inlineIcon(dir: string, candidates: (string | undefined)[]): Promise<string | undefined> {
  for (const rel of candidates) {
    if (!rel) continue;
    const abs = isAbsolute(rel) ? rel : resolve(dir, rel);
    if (!isInside(dir, abs)) continue;
    const mime = ICON_MIME[extname(abs).toLowerCase()];
    if (!mime) continue;
    try {
      const st = await fsp.stat(abs);
      if (!st.isFile() || st.size > MAX_ICON_BYTES) continue;
      const buf = await fsp.readFile(abs);
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      // 试下一个候选
    }
  }
  return undefined;
}

// 解析两类图标:管理 UI 用 logo（回退 icon/composerIcon），composer pill 用 composerIcon（回退 logo）。
async function resolveIcons(
  dir: string,
  json: Record<string, unknown>,
): Promise<{ iconDataUrl?: string; composerIconDataUrl?: string }> {
  const iface = (json.interface && typeof json.interface === "object" ? json.interface : {}) as Record<string, unknown>;
  const logo = asString(iface.logo) ?? asString(iface.icon) ?? asString(json.logo) ?? asString(json.icon);
  const composer = asString(iface.composerIcon);
  const [iconDataUrl, composerIconDataUrl] = await Promise.all([
    inlineIcon(dir, [logo, composer]), // 管理:logo 优先
    inlineIcon(dir, [composer, logo]), // 对话:composerIcon 优先
  ]);
  return { iconDataUrl, composerIconDataUrl };
}

// 解析单个插件包目录 → InstalledPlugin；目录无任何可识别 manifest → null。
export async function parsePluginManifest(dir: string): Promise<InstalledPlugin | null> {
  const id = basename(dir);

  // 1. .codex-plugin/plugin.json
  const codex = await readJsonObject(join(dir, ".codex-plugin", "plugin.json"));
  if (codex) {
    const manifest = mapJsonManifest(id, codex);
    return {
      manifest,
      installPath: dir,
      manifestKind: "codex",
      skillsDir: await resolveSkillsDir(dir, "codex", codex.skills),
      ...(await resolveIcons(dir, codex)),
    };
  }

  // 2. .claude-plugin/plugin.json
  const claude = await readJsonObject(join(dir, ".claude-plugin", "plugin.json"));
  if (claude) {
    const manifest = mapJsonManifest(id, claude);
    return {
      manifest,
      installPath: dir,
      manifestKind: "claude",
      skillsDir: await resolveSkillsDir(dir, "claude", claude.skills),
      ...(await resolveIcons(dir, claude)),
    };
  }

  // 3. SKILL.md frontmatter（第一方单 skill 兼容）
  let skillMd: string;
  try {
    skillMd = await fsp.readFile(join(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(skillMd);
  const manifest: PluginManifest = {
    id,
    name: fm.name ?? id,
    description: fm.description,
  };
  return { manifest, installPath: dir, manifestKind: "skill-fallback", skillsDir: dir };
}
