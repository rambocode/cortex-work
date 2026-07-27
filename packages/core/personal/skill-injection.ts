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
import type { ConversationArtifactKind, ConversationArtifactRef } from "../desktop/types";
import { usePersonalStore } from "../store/personal";
import { resolveAgentSkillRoots } from "./skill-roots";

// 注入用的精简 skill 记录(name/description/dir)。
export interface InjectableSkill {
  name: string;
  description?: string;
  dir: string; // skill 根目录绝对路径
  // Design B(plan 002):根来源。"agent" = 来自会话 agent 私有原生根(agent 自身会发现,U6 去重时不重复注入);
  // "shared"/缺省 = 共享根 / 插件根 / 旧扫描(仍需 Cortex 注入)。
  origin?: "shared" | "agent";
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

// U6(修复):单发/圆桌编排路由判断的单一来源。原先 messages.ts 内联判断与
// PersonalChatArea.tsx 各写一份「subagentOrchestration && startOrchestration && !hasDelegateMentions」,
// 靠注释手工保持一致——一旦其中一处的路由条件调整,另一处会静默漂移,导致「该走原生 skill 调用的
// 组合悄悄退回 prose」或「该退回 prose 的组合却发了裸 slash/invokedSkill 到编排路径」(见 code review:
// maintainability/agent-native 交叉确认)。现在两处都从这里导入,不再各自复刻判断逻辑。
export function isOrchestrationSend(
  subagentOrchestration: boolean | undefined,
  hasStartOrchestration: boolean,
  hasDelegateMentions: boolean,
): boolean {
  return subagentOrchestration === true && hasStartOrchestration && !hasDelegateMentions;
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

// U5:claude 原生 slash 命令名的「纯 slug 化」步骤(无兜底/无碰撞消歧)。规则:小写化 + 换行/空格/
// 路径分隔符/`..`/控制字符等一切非 [a-z0-9] 归一为连字符 + 折叠并去首尾连字符。可能产出空串
// (如纯非 ASCII 名),空串兜底与同批次碰撞消歧交给 resolveClaudeSlashName(不能在此处独立兜底——
// 见下方修复说明)。
function slugifyClaudeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
// 向后兼容导出(单测/外部若已引用旧名):等价于 slugifyClaudeSkillName。
export const sanitizeSkillCommandName = slugifyClaudeSkillName;

// 不依赖 Node crypto(core 需可在浏览器/渲染端运行):纯算术短哈希,仅用于「空 slug 兜底」与「同批次
// 命名碰撞消歧」的后缀,不要求密码学强度,只要求确定性——且必须与主进程
// apps/desktop/src/main/skills/claude-bridge.ts 的同名函数逐字算法一致(⚠️ 跨进程契约,见下)。
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

// 为一条记录算出「本批次内不冲突」的命令名——逐字复现主进程 claude-bridge.ts 的 resolveLinkName:
// 空 slug 兜底为 `skill-<hash>`;与已占用名冲突(如 `my/skill` 与 `my-skill` 都归一到 `my-skill`)
// 对后到者追加短 hash 后缀消歧;极端同名多次再叠加递增序号。
function resolveCommandName(name: string, used: Set<string>): string {
  const base = slugifyClaudeSkillName(name) || `skill-${shortHash(name)}`;
  if (!used.has(base)) return base;
  const suffixed = `${base}-${shortHash(name)}`;
  if (!used.has(suffixed)) return suffixed;
  let i = 2;
  while (used.has(`${suffixed}-${i}`)) i++;
  return `${suffixed}-${i}`;
}

// U5(修复):claude 桥接目录的 symlink 命名(主进程 buildClaudeSkillBridge)按 records 顺序做
// 「空 slug 兜底 + 同批次碰撞消歧」,单条 sanitizeSkillCommandName(skill.name) 无法复现这一批次级
// 结果——之前渲染端只对单条 skill 独立清洗,在(a)清洗后为空(纯非 ASCII/纯符号名)、(b)两条 skill
// 归一到同一 slug 这两种边界下,产出的裸 slash 与桥接目录名不一致,导致 claude 侧「Unknown command」
// 或「点了 A 却触发 B」(见 code review:correctness/maintainability/adversarial 交叉确认)。
// 修复:按与主进程完全相同的算法,基于同一批 records(渲染端与主进程各自调用
// resolveEnabledSkillRecords 取到的应为同一确定性排序结果)逐条推导命令名,取 target 命中的那个。
export function resolveClaudeSlashName(records: InjectableSkill[], target: InjectableSkill): string {
  const used = new Set<string>();
  let matched: string | undefined;
  for (const rec of records) {
    const commandName = resolveCommandName(rec.name, used);
    used.add(commandName);
    if (rec === target || (rec.name === target.name && rec.dir === target.dir)) matched = commandName;
  }
  // 兜底:target 若不在 records 里(理论不达,调用方应保证 target ∈ records),独立推导一个安全命令名。
  return matched ?? resolveCommandName(target.name, used);
}

// U5:把「/skill:<name> [args]」渲染成 claude CLI 认得的裸 slash「/<command-name> [args]」。
// claude 在 CLI 输入层原生展开 `/<name>`(前提:桥接目录已让它发现该 skill,见 U1/U2),cortex 不再
// 把 skill 改写成「请自行 Read SKILL.md」的 prose。name 经 resolveClaudeSlashName 对齐主进程桥接目录
// 的实际命名(R7,含批次级碰撞消歧,见上);args 是用户输入(本就要发给 agent),不清洗。无 args →
// 无尾随空格。allRecords 须是本轮已启用的完整 skill 记录集(与 cli.ts 建桥接目录用的同一份数据源)。
export function renderClaudeSkillSlash(skill: InjectableSkill, args: string, allRecords: InjectableSkill[]): string {
  const name = resolveClaudeSlashName(allRecords, skill);
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

/** 同类型 Skill 继续编辑当前产物；无绑定或类型变化时创建新产物。 */
export function resolveArtifactTarget(
  kind: ConversationArtifactKind,
  current?: Pick<ConversationArtifactRef, "kind" | "documentId">,
): { mode: "create" } | { mode: "edit"; artifact: typeof current } {
  return current?.kind === kind ? { mode: "edit", artifact: current } : { mode: "create" };
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
  // Design B(plan 002 U4):按会话 agent 解析扫描根(与下拉 usePiEnabledSkills 共用 resolveAgentSkillRoots),
  // 保证「菜单可见 == 实际注入」。主进程据 rootSpecs 扫描,PluginSkill 带回 origin 供 U6 去重。
  const rootSpecs = resolveAgentSkillRoots(cfg, agent, projectPath);
  // U6:已启用 ∩ 已授信插件的 skills 根作为额外全局扫描根并入（主进程 append 进 scanSkillRoots）。
  // 插件级启停/信任是注入 gate——在这里按 store 过滤要送哪些根，主进程不读 store（KTD3）。
  const pluginSkillDirs = await resolveEnabledPluginSkillDirs(bridge);
  let skills: PluginSkill[];
  try {
    skills = await bridge.piSkillsList({ rootSpecs, workspaceDir: projectPath, pluginSkillDirs, agent });
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
  const put = (s: PluginSkill) => byName.set(s.name, { name: s.name, description: s.description, dir: s.dir, origin: s.origin });
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
