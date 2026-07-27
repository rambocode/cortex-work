// slash 命令组装(内建 + 已启用 skill),会话页(PersonalComposer)与新会话落地页(NewSessionLanding)
// 共用,保证两处 slash 一致——之前落地页传空数组、无 slash,与会话页不一致(修复)。
//
// session 可为草稿态最小对象(落地页尚无真实会话):usePiEnabledSkills 仅读 agent/useOwnSkills/projectId。

import { useDesktopBridge, usePersonalStore, usePiEnabledSkills } from "@cortex-work/core";
import type { SessionMeta } from "@cortex-work/core";
import { normalizeResearchEngineSettings } from "@cortex-work/core/research/settings";
import type { SlashCommand } from "./ComposerShell";
import { skillTitleCase, skillSourceTag } from "./skillDisplay";

// 内建 slash 命令(发送拦截在 PersonalChatArea.onSend）。kind:"builtin" = 选中即执行。
const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: "/clear", desc: "隐藏当前历史记录（可展开）", kind: "builtin" },
];
// /compact 仅 pi 会话有（压缩走 pi RPC）。
const PI_SLASH_COMMANDS: SlashCommand[] = [
  { cmd: "/compact", desc: "压缩当前会话上下文", kind: "builtin" },
];

/// 深度研究 skill 的命令字面量。派发侧（researchDispatch）按它识别与构造 pill，
/// 从这里导出而不是各处写字符串——两处写死迟早漂移成「pill 套上了但派发不认」。
export const RESEARCH_SKILL_CMD = "/skill:research";

/// 输入框 skill pill 的最小形状。「转为深度研究」菜单项套 pill 时用它，
/// 与 slash 菜单同一份 cmd/displayName——否则会出现 pill 上写一个名字、菜单里叫另一个。
export const RESEARCH_SKILL_PILL = { cmd: RESEARCH_SKILL_CMD, displayName: "深度研究" };

// 产物类系统 skill(设计稿 / 演示文稿):走 agent 一轮对话产出产物,因此**受会话级 skills 开关约束**。
const ARTIFACT_SKILL_COMMANDS: SlashCommand[] = [
  {
    cmd: "/skill:design",
    // 展示名用中文:它会原样出现在输入框的 skill pill 上,与 desc/tag 的中文保持一致。
    displayName: "设计稿",
    tag: "系统",
    desc: "在会话中创建设计稿，并在右栏继续编辑",
    kind: "skill",
  },
  {
    cmd: "/skill:slides",
    displayName: "演示文稿",
    tag: "系统",
    desc: "在会话中创建演示文稿，并在右栏继续编辑",
    kind: "skill",
  },
];

// 深度研究 skill。**门控与产物类不同**:研究不经 agent(活由 CRE 引擎干,不消耗 skill 上下文),
// 所以不受会话级 useOwnSkills 约束——用户关掉「skills」是不想让 agent 加载 SKILL.md,
// 与「能不能发起一次研究」无关。它看的是研究引擎自己的三个条件(见 researchSkillAvailable)。
const RESEARCH_SKILL_COMMAND: SlashCommand = {
  ...RESEARCH_SKILL_PILL,
  tag: "系统",
  desc: "在会话中发起深度研究，结果在右栏查看",
  kind: "skill",
};

// 全部系统 skill 定义。**与门控无关**,给落地页场景 chip 按 cmd 反查展示名用
// (chip 预置 pill 时要拿到与 slash 菜单一致的 displayName,避免两处双写漂移)。
export const SYSTEM_SKILL_COMMANDS: SlashCommand[] = [
  ...ARTIFACT_SKILL_COMMANDS,
  RESEARCH_SKILL_COMMAND,
];

/// 深度研究入口此刻是否可用。三个条件缺一不可:
///   - 桥有 research 子域(Web 端无桥 / 旧壳无该子域);
///   - 研究引擎总开关已开;
///   - 深度研究这一档也已开(总开关开着但这档关掉时,发起研究后端会直接拒)。
///
/// **住在这里而不是各调用方各写一遍**:slash 菜单、composer 的「转为深度研究」菜单项、
/// 落地页 chip 都要用同一份判定,漂移会导致「菜单里有、点了没反应」。
export function useResearchSkillAvailable(): boolean {
  const bridge = useDesktopBridge();
  const researchEngine = usePersonalStore((s) => s.generalSettings.researchEngine);
  const settings = normalizeResearchEngineSettings(researchEngine);
  return !!bridge?.research && settings.enabled && settings.deepResearchEnabled;
}

export function useSlashCommands(session: SessionMeta | undefined): SlashCommand[] {
  // 已启用 skill(hook 内按 agent/useOwnSkills/桥门控;useOwnSkills!==true 或非 pi/claude/codex → [])。
  const piSkills = usePiEnabledSkills(session);
  const researchAvailable = useResearchSkillAvailable();
  const skillCommands: SlashCommand[] = piSkills.map((s) => ({
    cmd: `/skill:${s.name}`,
    // 菜单展示 Title-Case 友好名 + 来源标签(个人/系统/工作区),cmd 仍保留供匹配/插入。
    displayName: skillTitleCase(s.name),
    tag: skillSourceTag(s.scope, s.system),
    desc: s.description,
    argHint: s.argumentHint,
    kind: "skill",
  }));
  const builtins = session?.agent === "pi" ? [...SLASH_COMMANDS, ...PI_SLASH_COMMANDS] : SLASH_COMMANDS;
  const systemSkills = [
    ...(session && session.useOwnSkills !== false ? ARTIFACT_SKILL_COMMANDS : []),
    ...(researchAvailable ? [RESEARCH_SKILL_COMMAND] : []),
  ];
  // 去重集合按**实际启用的**系统 skill 算,不是按全量定义算:某个系统 skill 这会儿没上菜单时,
  // 用户自己那个同名 skill 就该正常出现,而不是被一个看不见的条目挡住。
  const systemSkillNames = new Set(systemSkills.map((command) => command.cmd));
  return [
    ...builtins,
    ...systemSkills,
    ...skillCommands.filter((command) => !systemSkillNames.has(command.cmd)),
  ];
}
