// slash 命令组装(内建 + 已启用 skill),会话页(PersonalComposer)与新会话落地页(NewSessionLanding)
// 共用,保证两处 slash 一致——之前落地页传空数组、无 slash,与会话页不一致(修复)。
//
// session 可为草稿态最小对象(落地页尚无真实会话):usePiEnabledSkills 仅读 agent/useOwnSkills/projectId。

import { usePiEnabledSkills } from "@cortex-work/core";
import type { SessionMeta } from "@cortex-work/core";
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
const ARTIFACT_SKILL_COMMANDS: SlashCommand[] = [
  {
    cmd: "/skill:design",
    displayName: "Design",
    tag: "系统",
    desc: "在会话中创建设计稿，并在右栏继续编辑",
    kind: "skill",
  },
  {
    cmd: "/skill:slides",
    displayName: "Slides",
    tag: "系统",
    desc: "在会话中创建演示文稿，并在右栏继续编辑",
    kind: "skill",
  },
];

export function useSlashCommands(session: SessionMeta | undefined): SlashCommand[] {
  // 已启用 skill(hook 内按 agent/useOwnSkills/桥门控;useOwnSkills!==true 或非 pi/claude/codex → [])。
  const piSkills = usePiEnabledSkills(session);
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
  const artifactSkills = session && session.useOwnSkills !== false ? ARTIFACT_SKILL_COMMANDS : [];
  const artifactSkillNames = new Set(ARTIFACT_SKILL_COMMANDS.map((command) => command.cmd));
  return [
    ...builtins,
    ...artifactSkills,
    ...skillCommands.filter((command) => !artifactSkillNames.has(command.cmd)),
  ];
}
