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
import { DEFAULT_PI_SKILLS, DEFAULT_PLUGIN_ENABLE, type AgentKind, type PluginSkill } from "../desktop/types";
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
    // 安全（ADV-003）:dir 也去换行——插件/skill 目录名理论上可含字面换行（readdir 原样返回），
    // 若原样插入会从「指令文件」行越界注入新行。含换行的路径本就不可 Read,清洗不损失有效路径。
    const dir = s.dir.replace(/[\r\n]+/g, " ");
    return `- **${name}**${tail}\n  指令文件:${dir}/SKILL.md(需要时用 Read 工具查看完整指令)`;
  });
  return [
    "## 已启用的 Skills",
    "用户启用了以下 skill,请在本次任务中遵循它们的指令。需要细节时按路径 Read 对应 SKILL.md:",
    "",
    ...lines,
  ].join("\n");
}

// 解析输入是否为「/skill:<name> [args]」形态(claude/codex 的 slash skill 触发)。命中返回
// { name, args };否则 null。pi 会话不用它(pi CLI 自行展开 /skill:name),仅 claude/codex 发送侧
// 拦截后转定向 prompt(见 renderSkillInvocation / PersonalChatArea onSend)。
export function parseSkillSlash(text: string): { name: string; args: string } | null {
  const m = text.trim().match(/^\/skill:(\S+)\s*([\s\S]*)$/);
  const name = m?.[1];
  if (!name) return null; // 不匹配 / 无 name(\S+ 理论保证非空,此处兜底满足类型收窄)
  return { name, args: (m[2] ?? "").trim() };
}

// U5:claude 原生 slash 命令名清洗。claude 的 `/<name>` 展开取自 skill 目录名 —— 桥接层(U1)以
// sanitize 后的名字建 symlink 目录,渲染端(renderClaudeSkillSlash)据同一算法生成裸 slash,两处必须
// 一致,否则「菜单显示名」与「claude 实际认得的命令名」漂移,用户点了却不触发(R7)。
// 规则:小写化 + 换行/空格/路径分隔符/`..`/控制字符等一切非 [a-z0-9] 归一为连字符 + 折叠并去首尾连字符;
// 全部被清空(如纯非 ASCII 名)时兜底 "skill",避免产出空 slash。
// ⚠️ 跨进程契约:U1 的 symlink 目录命名必须复现同一算法(主进程不能 import core,故各持一份逻辑)。
export function sanitizeSkillCommandName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "skill";
}

// U5:把「/skill:<name> [args]」渲染成 claude CLI 认得的裸 slash「/<command-name> [args]」。
// claude 在 CLI 输入层原生展开 `/<name>`(前提:桥接目录已让它发现该 skill,见 U1/U2),cortex 不再
// 把 skill 改写成「请自行 Read SKILL.md」的 prose。name 经 sanitizeSkillCommandName 对齐 claude 的
// 命令名派生(R7);args 是用户输入(本就要发给 agent),不清洗。无 args → 无尾随空格。
export function renderClaudeSkillSlash(skill: InjectableSkill, args: string): string {
  const name = sanitizeSkillCommandName(skill.name);
  const trimmed = args.trim();
  return trimmed ? `/${name} ${trimmed}` : `/${name}`;
}

// 渲染「定向调用单个 skill」的 prompt:claude/codex 无原生 /skill 展开时,发送侧用它把 /skill:name
// 替换成一段让 agent「读该 SKILL.md 再执行」的指令。复用 renderSkillBlock 的「元数据 + 路径自读」
// 范式,只针对被选中的这一个 skill + 用户附带参数。name/description/dir 经 sanitize 防注入;
// args 是用户自己的输入(本就要发给 agent),不清洗。
export function renderSkillInvocation(skill: InjectableSkill, args: string): string {
  const name = sanitize(skill.name);
  const desc = sanitize(skill.description);
  const dir = skill.dir.replace(/[\r\n]+/g, " ");
  const lines = [
    `请使用 skill「${name}」完成本次任务${desc ? `(${desc})` : ""}。`,
    `指令文件:${dir}/SKILL.md —— 请先用 Read 工具查看完整指令,再据此执行。`,
  ];
  if (args) lines.push(`本次参数:${args}`);
  return lines.join("\n");
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
  // U6:已启用 ∩ 已授信插件的 skills 根作为额外全局扫描根并入（主进程 append 进 scanSkillRoots）。
  // 插件级启停/信任是注入 gate——在这里按 store 过滤要送哪些根，主进程不读 store（KTD3）。
  const pluginSkillDirs = await resolveEnabledPluginSkillDirs(bridge);
  let skills: PluginSkill[];
  try {
    skills = await bridge.piSkillsList({
      globalRoots: cfg.globalRoots,
      userGlobalRoots: cfg.userGlobalRoots,
      workspaceEnabled: cfg.workspaceEnabled,
      workspaceDir: projectPath,
      pluginSkillDirs,
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

// 解析「已启用 ∩ 已授信」插件的 skills 根目录(U6)。插件级 gate(语义见 PluginEnableSettings)：
//   enabled.has(id) && !distrusted.has(id) && 该插件有 skillsDir。
// 缺 bridge.pluginList(web/旧壳) / 无启用插件 / 扫描失败 → []（降级，不阻断发送）。
// 这些根以 scope=global 并入 scanSkillRoots（主进程），随后流入与第一方 skill 同一注入链。
export async function resolveEnabledPluginSkillDirs(bridge: DesktopBridge): Promise<string[]> {
  if (!bridge.pluginList) return [];
  const cfg = { ...DEFAULT_PLUGIN_ENABLE, ...usePersonalStore.getState().generalSettings.plugins };
  if (!cfg.enabled.length) return [];
  const enabled = new Set(cfg.enabled);
  const distrusted = new Set(cfg.distrusted);
  try {
    const { items } = await bridge.pluginList();
    return items
      .filter((p) => enabled.has(p.manifest.id) && !distrusted.has(p.manifest.id) && p.skillsDir)
      .map((p) => p.skillsDir as string);
  } catch {
    return [];
  }
}
