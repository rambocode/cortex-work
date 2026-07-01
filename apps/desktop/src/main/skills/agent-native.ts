// agent 自身「已装插件 / vendor 内置」skill 根发现(Design B 增量,plan 002 后续)。
// 目的:让 Cortex 面板/下拉也展示 claude/codex CLI 自己带的插件与内置 skill(用户明确要求「内置 skill
// 也显示出来」),不止用户目录(~/.claude/skills / ~/.codex/skills 已由 resolveAgentSkillRoots 覆盖)。
//
// 这些是各 CLI 的**内部目录布局**,可能随 CLI 版本变化——因此:
//   · 全部读取都容错,任何失败降级为「不追加」,绝不抛出、不阻断发送;
//   · 标 origin="shared"(经 Cortex 正常注入/桥接),保证「面板里能看到 == 调用时真的可用」,不依赖各 CLI
//     在 headless(-p / exec / app-server)下是否会自动加载自己的插件(该行为未逐版本核实)。
//
// 为什么放主进程:插件清单(如 ~/.claude/plugins/installed_plugins.json)需读文件系统,渲染端无 fs;
// 故由 pi-skills:list handler 按传入的 agent 调用本模块,追加进扫描根(与 pluginSkillRoots 同层)。

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import type { AgentKind } from "../ipc/types";
import type { ScanRoot } from "./locate";

// 目录存在且为目录 → 一个 global/shared 扫描根;否则 null(容错跳过)。
function dirRoot(path: string): ScanRoot | null {
  try {
    return existsSync(path) && statSync(path).isDirectory() ? { path, scope: "global", origin: "shared" } : null;
  } catch {
    return null;
  }
}

// 受限深度收集 <root> 下所有名为 "skills" 的目录(用于无 manifest 的插件 cache,如 codex
// plugins/cache/<catalog>/<plugin>/<version>/skills)。命中 "skills" 即收集、不再深入其内部;
// maxDepth 限制避免误入 node_modules 等深目录。读失败一律跳过(容错)。
function findSkillsDirs(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name === ".git") continue;
      const full = join(dir, e.name);
      if (e.name === "skills") out.push(full); // 收集,不深入 skills 内部
      else walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

// claude:~/.claude/plugins/installed_plugins.json(v2:{ plugins: { key: [{ installPath }] } })→
// 每个已装插件 installPath 下的 skills/ 子目录(内含 <skill>/SKILL.md)。installPath 去重(同插件多版本记录)。
function claudePluginSkillRoots(home: string): ScanRoot[] {
  const jsonPath = join(home, ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(jsonPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch {
    return [];
  }
  const plugins = (parsed as { plugins?: Record<string, { installPath?: string }[]> } | null)?.plugins;
  if (!plugins || typeof plugins !== "object") return [];
  const roots: ScanRoot[] = [];
  const seen = new Set<string>();
  for (const entries of Object.values(plugins)) {
    for (const e of entries ?? []) {
      const ip = e?.installPath;
      if (!ip || seen.has(ip)) continue;
      seen.add(ip);
      const r = dirRoot(join(ip, "skills"));
      if (r) roots.push(r);
    }
  }
  return roots;
}

// codex 内置/插件 skill 源(codex-cli 内部布局,无 installed manifest → 已装插件用受限 glob):
//   · ~/.codex/skills/.system   —— 系统内置(imagegen / plugin-creator / skill-creator 等,嵌在隐藏子目录)
//   · ~/.codex/plugins/cache/<catalog>/<plugin>/<version>/skills —— 已装插件(documents/pdf/canva…)
//   · ~/.codex/vendor_imports/skills/skills/.curated —— vendor 精选
//   · ~/.codex/memories/skills —— memories
// 固定目录用 dirRoot(存在才收);plugins/cache 用 findSkillsDirs 深度受限收集。全部容错。
function codexPluginSkillRoots(home: string): ScanRoot[] {
  const fixed = [
    join(home, ".codex", "skills", ".system"),
    join(home, ".codex", "vendor_imports", "skills", "skills", ".curated"),
    join(home, ".codex", "memories", "skills"),
  ]
    .map(dirRoot)
    .filter((r): r is ScanRoot => !!r);
  // cache/<catalog>/<plugin>/<version>/skills:skills 出现在深度 3(处理 version 目录时),maxDepth=3 即可命中且不深入 node_modules。
  const cached: ScanRoot[] = findSkillsDirs(join(home, ".codex", "plugins", "cache"), 3).map((path) => ({
    path,
    scope: "global",
    origin: "shared",
  }));
  return [...fixed, ...cached];
}

// 按 agent 发现其自身插件/内置 skill 根。pi 走自身原生发现(--skill),此处不额外追加。
// home 可注入(默认真实 homedir),便于单测用临时目录,不必 mock os。
export function agentNativePluginRoots(agent: AgentKind, home: string = homedir()): ScanRoot[] {
  try {
    if (agent === "claude") return claudePluginSkillRoots(home);
    if (agent === "codex") return codexPluginSkillRoots(home);
    return [];
  } catch {
    return [];
  }
}
