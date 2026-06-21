// 跨 agent skill 注入(U1/U2)。把已启用 skill 归一为一段系统提示文本,经 appendSystemPrompt
// 缝注入 claude/codex;pi 仍走 --skill(见 messages.ts 发送派发分支)。两路互斥 → 同一 SKILL.md
// 不双注入(R3)。
//
// 对齐 cortex 既有内置 skill 注入:给「元数据 + SKILL.md 路径」让 agent 自读,**不把正文塞进
// 系统提示**(避免 prompt 膨胀)。纯函数渲染、不读盘(路径由记录提供)。
//
// 过滤链(resolveEnabledSkillRecords)与 resolveEnabledSkillPaths 同源:本模块是唯一实现,
// messages.ts 的 resolveEnabledSkillPaths 委托到这里取 .dir,避免在已超 1200 行上限的 messages.ts
// 继续堆叠、也避免两份过滤规则漂移。
import type { DesktopBridge } from "../desktop/bridge";
import { DEFAULT_PI_SKILLS, type AgentKind, type PluginSkill } from "../desktop/types";
import { usePersonalStore } from "../store/personal";

// 注入用的精简 skill 记录(name/description/dir)。
export interface InjectableSkill {
  name: string;
  description?: string;
  dir: string; // skill 根目录绝对路径
}

// 安全清洗(RISK-5):name/description 来自工作区 SKILL.md frontmatter,是进入 claude/codex
// system prompt 的攻击面(pi 由 agent 自读 SKILL.md,无此面)。去除换行与前导 `#` —— 防恶意仓库
// 借多行/标题从 bullet 越界、注入伪 system-prompt 段。
function sanitize(s: string | undefined): string {
  if (!s) return "";
  return s.replace(/[\r\n]+/g, " ").replace(/^#+\s*/, "").trim();
}

// 渲染注入块。空输入 → 空串(无启用 skill 时不注入,行为同现状 R5)。纯函数、不读盘。
export function renderSkillBlock(skills: InjectableSkill[]): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => {
    const name = sanitize(s.name);
    const desc = sanitize(s.description);
    const tail = desc ? ` — ${desc}` : "";
    return `- **${name}**${tail}\n  指令文件:${s.dir}/SKILL.md(需要时用 Read 工具查看完整指令)`;
  });
  return [
    "## 已启用的 Skills",
    "用户启用了以下 skill,请在本次任务中遵循它们的指令。需要细节时按路径 Read 对应 SKILL.md:",
    "",
    ...lines,
  ].join("\n");
}

// 解析已启用 skill 的注入记录(U2)。复用与 resolveEnabledSkillPaths 同一过滤链:
// 禁用(`scope:name`) + 工作区未授信剔除 → 按 supportedAgents 过滤(U5) → name 去重(全局覆盖
// 工作区,防恶意工作区同名劫持) → 按 dir 排序(与旧 resolveEnabledSkillPaths 输出一致)。
// useOwnSkills===false(会话级一键关) / 无 bridge.piSkillsList(web/旧壳) / 扫描失败 → []
// (降级,不阻断发送)。
// agent(U5):当前会话 agent;skill 声明了 supportedAgents 且不含该 agent → 跳过(缺省/不传 = 不过滤)。
export async function resolveEnabledSkillRecords(
  bridge: DesktopBridge,
  projectPath: string,
  useOwnSkills: boolean | undefined,
  agent?: AgentKind,
): Promise<InjectableSkill[]> {
  if (useOwnSkills === false) return [];
  if (!bridge.piSkillsList) return [];
  const cfg = { ...DEFAULT_PI_SKILLS, ...usePersonalStore.getState().generalSettings.piSkills };
  let skills: PluginSkill[];
  try {
    skills = await bridge.piSkillsList({
      globalRoots: cfg.globalRoots,
      userGlobalRoots: cfg.userGlobalRoots,
      workspaceEnabled: cfg.workspaceEnabled,
      workspaceDir: projectPath,
    });
  } catch {
    return [];
  }
  const disabled = new Set(cfg.disabledSkills);
  const trusted = new Set(cfg.trustedWorkspaceSkillDirs);
  const enabled = skills.filter((s) => {
    if (disabled.has(`${s.scope}:${s.name}`)) return false; // 已禁用
    if (s.scope === "workspace" && !trusted.has(s.dir)) return false; // 工作区未授信不注入
    if (agent && s.supportedAgents && !s.supportedAgents.includes(agent)) return false; // 不适用当前 agent
    return true;
  });
  // name 去重:先放工作区、后放全局覆盖 → 同名时全局胜出。
  const byName = new Map<string, InjectableSkill>();
  const put = (s: PluginSkill) => byName.set(s.name, { name: s.name, description: s.description, dir: s.dir });
  for (const s of enabled) if (s.scope === "workspace") put(s);
  for (const s of enabled) if (s.scope === "global") put(s);
  // 按 dir 字典序排序(与旧实现的 [...paths].sort() 等价,保持调用方稳定顺序)。
  return [...byName.values()].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}
