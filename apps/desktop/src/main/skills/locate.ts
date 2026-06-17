// 内置 skill 目录定位。仿 agents/pi-locate.ts 的打包态 / dev 态解析。
// 第一阶段:只有内置 resources/skills（随安装包,extraResources 落 Contents/Resources/skills）。
// 第二阶段:下载的官方库落 userData/skills,registry 双源去重时 userData 优先覆盖内置。

import { app } from "electron";
import { homedir } from "os";
import { join } from "path";

import type { SkillScope } from "../ipc/types";

// 内置 skill 根:打包态 = Contents/Resources/skills;dev 态 = apps/desktop/resources/skills。
export function builtinSkillsRoot(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "skills");
  }
  return join(app.getAppPath(), "resources", "skills");
}

// 第二阶段:下载的官方 skill 库根（userData/skills）。第一阶段该目录通常不存在,
// registry.scanRoot 容错跳过。
export function userSkillsRoot(): string {
  return join(app.getPath("userData"), "skills");
}

// 扫描优先级:userData 优先（覆盖同名内置）,内置兜底。registry 据此按 name 去重。
export function skillsRoots(): string[] {
  return [userSkillsRoot(), builtinSkillsRoot()];
}

// ── 插件管理：多目录 skill 根 ─────────────────────────────────────────────────

// `~` / `~/...` 展开为 homedir 绝对路径;其余原样返回。
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

// 据 piSkills 配置算出带 scope 的扫描根（已 expand 为绝对路径）：
//   全局 = globalRoots ∪ userGlobalRoots（scope=global）;
//   workspaceEnabled && workspaceDir → 追加 <workspaceDir>/.cortex-desktop/skills（scope=workspace）。
export function pluginSkillRoots(
  cfg: { globalRoots: string[]; userGlobalRoots?: string[]; workspaceEnabled: boolean },
  workspaceDir?: string,
): { path: string; scope: SkillScope }[] {
  const roots: { path: string; scope: SkillScope }[] = [];
  for (const r of [...cfg.globalRoots, ...(cfg.userGlobalRoots ?? [])]) {
    roots.push({ path: expandTilde(r), scope: "global" });
  }
  if (cfg.workspaceEnabled && workspaceDir) {
    roots.push({ path: join(workspaceDir, ".cortex-desktop", "skills"), scope: "workspace" });
  }
  return roots;
}
